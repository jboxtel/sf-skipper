// Sign in with ChatGPT — OAuth (Authorization Code + PKCE) against
// auth.openai.com so Plus/Pro users can run Skipper on their ChatGPT plan
// instead of an API key. See developers.openai.com/siwc/token-sharing-open-source.
//
// Loaded in two places:
//   - the Options page (script tag) runs chatgptSignIn / chatgptSignOut — the
//     sign-in waits minutes for the user, which an MV3 service worker can't be
//     relied on to survive;
//   - background.js (importScripts) calls chatgptAccessToken before each
//     model request, refreshing when needed.
//
// OpenAI only accepts an HTTP loopback redirect (http://127.0.0.1:{port}/auth/callback).
// An extension can't listen on a port, so the authorize page opens in a normal
// tab and we watch that tab's URL: once it reaches the callback we read the
// code from the URL and close the tab. Nothing needs to answer on the port.
//
// Needs the optional host permission http://127.0.0.1/* so tabs.onUpdated
// reports the callback URL without the "tabs" permission. Optional, so adding
// it in an update doesn't disable the extension for existing users (see the
// OpenRouter note in providers.js). auth.openai.com needs no host permission:
// its token and revoke endpoints answer CORS with Access-Control-Allow-Origin: *.

var CHATGPT_AUTH_KEY = 'chatgptAuth';
var CHATGPT_ISSUER = 'https://auth.openai.com';
var CHATGPT_AUTHORIZE_URL = CHATGPT_ISSUER + '/api/accounts/authorize';
var CHATGPT_TOKEN_URL = CHATGPT_ISSUER + '/api/accounts/oauth/token';
var CHATGPT_REVOKE_URL = CHATGPT_ISSUER + '/api/accounts/oauth/revoke';
var CHATGPT_RESOURCE = 'https://api.openai.com/v1';
var CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
var CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
var CHATGPT_APP_NAME = 'Skipper for Salesforce';
var CHATGPT_SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;
var CHATGPT_PERMISSIONS = { origins: ['http://127.0.0.1/*'] };

// ─── Storage ────────────────────────────────────────────────────────────────
// { hostId, clientId, sub, email, idToken, accessToken, refreshToken,
//   expiresAt, scopes }. hostId and clientId outlive sign-out so the next
// sign-in reuses this install's registration.

async function chatgptLoadAuth() {
  var data = await chrome.storage.local.get(CHATGPT_AUTH_KEY);
  return data[CHATGPT_AUTH_KEY] || {};
}

async function chatgptSaveAuth(auth) {
  await chrome.storage.local.set({ [CHATGPT_AUTH_KEY]: auth });
  return auth;
}

function chatgptIsSignedIn(auth) {
  return !!(auth && auth.refreshToken);
}

function chatgptHasPlanScope(auth) {
  return !!(auth && (' ' + (auth.scopes || '') + ' ').indexOf(' ' + CHATGPT_PLAN_SCOPE + ' ') > -1);
}

// ─── Small crypto helpers ───────────────────────────────────────────────────

function chatgptB64url(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function chatgptRandom(n) {
  return chatgptB64url(crypto.getRandomValues(new Uint8Array(n || 32)));
}

async function chatgptPkceChallenge(verifier) {
  var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return chatgptB64url(new Uint8Array(digest));
}

// Claims only — no signature check. The id_token comes straight from the
// token endpoint over TLS in response to our own code + PKCE verifier, so
// there's no third party in between whose token we'd need to verify.
function chatgptJwtClaims(jwt) {
  try {
    var part = String(jwt || '').split('.')[1] || '';
    part = part.replace(/-/g, '+').replace(/_/g, '/');
    while (part.length % 4) part += '=';
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch (_) {
    return {};
  }
}

// ─── Token endpoint ─────────────────────────────────────────────────────────

async function chatgptTokenRequest(params) {
  var res = await fetch(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  var raw = await res.text();
  var parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!res.ok) {
    var err = new Error((parsed && (parsed.error_description || parsed.error)) || raw || ('HTTP ' + res.status));
    err.code = parsed && parsed.error;
    throw err;
  }
  return parsed || {};
}

// Merge a token response into the stored auth. Refresh tokens rotate, so
// access token, refresh token, expiry and scopes are replaced together.
function chatgptApplyTokens(auth, tok) {
  var next = Object.assign({}, auth, {
    accessToken: tok.access_token,
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000
  });
  if (tok.refresh_token) next.refreshToken = tok.refresh_token;
  if (tok.scope) next.scopes = tok.scope;
  if (tok.id_token) next.idToken = tok.id_token;
  return next;
}

// ─── Sign in (Options page) ─────────────────────────────────────────────────

// Must be called from a user gesture (it may prompt for the optional host
// permissions). Resolves with the stored auth once the user has approved
// Skipper in ChatGPT; rejects if they close the tab, deny, or time out.
async function chatgptSignIn() {
  var granted = await chrome.permissions.request(CHATGPT_PERMISSIONS);
  if (!granted) throw new Error('Skipper needs this permission to finish signing you in to ChatGPT.');

  var auth = await chatgptLoadAuth();
  if (!auth.hostId) {
    auth.hostId = 'urn:uuid:' + crypto.randomUUID();
    await chatgptSaveAuth(auth);
  }

  var state = chatgptRandom(24);
  var nonce = chatgptRandom(24);
  var verifier = chatgptRandom(48);
  var port = 20000 + Math.floor(Math.random() * 40000);
  var redirectUri = 'http://127.0.0.1:' + port + '/auth/callback';

  var q = new URLSearchParams({
    response_type: 'code',
    client_id: auth.clientId || 'dynamic_agent_client',
    ext_agent_host_id: auth.hostId,
    redirect_uri: redirectUri,
    scope: CHATGPT_SCOPES,
    resource: CHATGPT_RESOURCE,
    state: state,
    nonce: nonce,
    code_challenge_method: 'S256',
    code_challenge: await chatgptPkceChallenge(verifier)
  });
  if (!auth.clientId) q.set('agent_name_hint', CHATGPT_APP_NAME);
  if (auth.idToken) q.set('id_token_hint', auth.idToken);
  if (auth.email) q.set('login_hint', auth.email);

  var callback = await chatgptAwaitCallback(CHATGPT_AUTHORIZE_URL + '?' + q.toString(), redirectUri);
  if (callback.get('error')) {
    throw new Error(callback.get('error_description') || callback.get('error'));
  }
  if (callback.get('state') !== state) throw new Error('Sign-in failed (state mismatch). Please try again.');
  var code = callback.get('code');
  if (!code) throw new Error('Sign-in failed (no authorization code). Please try again.');

  // A first sign-in registers this install and hands back its own client id.
  var clientId = callback.get('client_id') || auth.clientId;
  var tok = await chatgptTokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId || 'dynamic_agent_client',
    code: code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource: CHATGPT_RESOURCE
  });

  var claims = chatgptJwtClaims(tok.id_token);
  if (!clientId) clientId = tok.client_id || (Array.isArray(claims.aud) ? claims.aud[0] : claims.aud);
  if (claims.nonce !== nonce) throw new Error('Sign-in failed (nonce mismatch). Please try again.');
  if (claims.iss && claims.iss !== CHATGPT_ISSUER) throw new Error('Sign-in failed (unexpected issuer).');
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new Error('Sign-in failed (expired token). Check your computer clock.');

  var next = chatgptApplyTokens(auth, tok);
  next.clientId = clientId;
  next.sub = claims.sub || next.sub;
  next.email = claims.email || next.email;
  await chatgptSaveAuth(next);
  return next;
}

// Open the authorize page in a tab and resolve with the callback's query
// params once the tab navigates to redirectUri.
function chatgptAwaitCallback(authorizeUrl, redirectUri) {
  return new Promise(function (resolve, reject) {
    var tabId = null;
    var done = false;
    var timer = setTimeout(function () { finish(new Error('Sign-in timed out. Please try again.')); }, CHATGPT_SIGNIN_TIMEOUT_MS);

    function finish(err, params) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (params && tabId != null) chrome.tabs.remove(tabId).catch(function () {});
      if (err) reject(err); else resolve(params);
    }
    function onUpdated(id, changeInfo) {
      if (id !== tabId || !changeInfo.url) return;
      if (changeInfo.url.indexOf(redirectUri) !== 0) return;
      finish(null, new URL(changeInfo.url).searchParams);
    }
    function onRemoved(id) {
      if (id === tabId) finish(new Error('Sign-in was cancelled.'));
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.create({ url: authorizeUrl }).then(function (tab) { tabId = tab.id; }, finish);
  });
}

// ─── Access token (background) ──────────────────────────────────────────────

var chatgptRefreshing = null; // single flight — refresh tokens rotate, so two parallel refreshes would burn one

async function chatgptAccessToken(opts) {
  var force = !!(opts && opts.force);
  var auth = await chatgptLoadAuth();
  if (!chatgptIsSignedIn(auth)) throw new Error('Not signed in to ChatGPT. Open the extension Options and sign in.');
  if (!force && auth.accessToken && auth.expiresAt > Date.now() + 60000) return auth.accessToken;

  if (!chatgptRefreshing) {
    chatgptRefreshing = (async function () {
      try {
        var tok = await chatgptTokenRequest({
          grant_type: 'refresh_token',
          client_id: auth.clientId,
          refresh_token: auth.refreshToken,
          resource: CHATGPT_RESOURCE
        });
        var next = await chatgptSaveAuth(chatgptApplyTokens(await chatgptLoadAuth(), tok));
        return next.accessToken;
      } catch (err) {
        if (err.code === 'invalid_grant') {
          await chatgptClearTokens();
          throw new Error('Signed out of ChatGPT — sign in again in the extension Options.');
        }
        throw err;
      } finally {
        chatgptRefreshing = null;
      }
    })();
  }
  return chatgptRefreshing;
}

// ─── Sign out ───────────────────────────────────────────────────────────────

async function chatgptClearTokens() {
  var auth = await chatgptLoadAuth();
  await chatgptSaveAuth({ hostId: auth.hostId, clientId: auth.clientId, email: auth.email });
}

async function chatgptSignOut() {
  var auth = await chatgptLoadAuth();
  if (auth.refreshToken && auth.clientId) {
    // Best effort — OpenAI doesn't tell us about disconnects made in
    // ChatGPT settings either, so a failed revoke just leaves a stale grant.
    try {
      await fetch(CHATGPT_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: auth.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: auth.clientId
        }).toString()
      });
    } catch (_) {}
  }
  await chatgptClearTokens();
}

// ─── Models ─────────────────────────────────────────────────────────────────

async function chatgptListModels() {
  var token = await chatgptAccessToken();
  var res = await fetch(CHATGPT_RESOURCE + '/models', { headers: { 'Authorization': 'Bearer ' + token } });
  var parsed = await res.json().catch(function () { return null; });
  if (!res.ok) throw new Error((parsed && parsed.error && parsed.error.message) || ('HTTP ' + res.status));
  return ((parsed && (parsed.data || parsed.models)) || [])
    .filter(function (m) { return m && (m.visibility === undefined || m.visibility === 'list'); })
    .map(function (m) { return { id: m.slug || m.id, label: m.display_name || m.slug || m.id }; });
}
