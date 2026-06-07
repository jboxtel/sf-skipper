// Supabase Auth REST client for Skipper. Loaded by options.html only — the
// palette banner (content.js) just reads opts.skipper from storage and links
// out to Options for the actual sign-in flow.
//
// Email-OTP flow:
//   requestOtp(email)        Supabase emails a 6-digit code
//   verifyOtp(email, code)   exchanges code for a session, persists it
//
// Session shape under sfnavOptions.skipper (matches what background.js's
// feedback handler reads): { accessToken, refreshToken, email, userId, expiresAt }.
// expiresAt is unix seconds.

(function () {
  var SUPABASE_URL = 'https://bdfndqbnuganvfdgtvcg.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_Kt9RftY4MGU_QAkdjCzx-A_qij1Zl4F';
  var AUTH = SUPABASE_URL + '/auth/v1';

  function authHeaders(extra) {
    var h = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY
    };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  async function postJson(path, body, headers) {
    var resp = await fetch(AUTH + path, {
      method: 'POST',
      headers: authHeaders(headers),
      body: JSON.stringify(body)
    });
    var text = '';
    try { text = await resp.text(); } catch (e) {}
    var json = null;
    if (text) { try { json = JSON.parse(text); } catch (e) { /* non-JSON */ } }
    if (!resp.ok) {
      var msg = (json && (json.msg || json.error_description || json.error)) || ('HTTP ' + resp.status);
      var err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    return json;
  }

  function loadOpts() {
    return new Promise(function (resolve) {
      chrome.storage.local.get('sfnavOptions', function (data) {
        resolve((data && data.sfnavOptions) || {});
      });
    });
  }

  function saveSkipper(skipper) {
    return new Promise(function (resolve) {
      chrome.storage.local.get('sfnavOptions', function (data) {
        var next = Object.assign({}, data.sfnavOptions || {});
        if (skipper) next.skipper = skipper; else delete next.skipper;
        chrome.storage.local.set({ sfnavOptions: next }, function () { resolve(next); });
      });
    });
  }

  function sessionFromResponse(resp) {
    // /verify and /token return the same shape. Older responses sometimes
    // only include expires_in — fall back to (now + expires_in) so we always
    // store an absolute time.
    var expiresAt = resp.expires_at
      || (Math.floor(Date.now() / 1000) + (resp.expires_in || 3600));
    return {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      email: (resp.user && resp.user.email) || null,
      userId: (resp.user && resp.user.id) || null,
      expiresAt: expiresAt
    };
  }

  async function requestOtp(email) {
    await postJson('/otp', { email: email, create_user: true });
    return { ok: true };
  }

  async function verifyOtp(email, token) {
    var resp = await postJson('/verify', { email: email, token: token, type: 'email' });
    var skipper = sessionFromResponse(resp);
    await saveSkipper(skipper);
    return skipper;
  }

  async function refreshSession() {
    var opts = await loadOpts();
    var skipper = opts.skipper || {};
    if (!skipper.refreshToken) throw new Error('No refresh token');
    var resp = await postJson('/token?grant_type=refresh_token', { refresh_token: skipper.refreshToken });
    var next = sessionFromResponse(resp);
    await saveSkipper(next);
    return next;
  }

  async function signOut() {
    var opts = await loadOpts();
    var skipper = opts.skipper || {};
    if (skipper.accessToken) {
      // Best-effort — if the token is already expired the /logout call 401s.
      // We still want to clear local state either way.
      try {
        await fetch(AUTH + '/logout', {
          method: 'POST',
          headers: authHeaders({ 'Authorization': 'Bearer ' + skipper.accessToken })
        });
      } catch (e) { /* ignore */ }
    }
    await saveSkipper(null);
    return { ok: true };
  }

  async function getSession() {
    var opts = await loadOpts();
    return opts.skipper || null;
  }

  window.SkipperAuth = {
    requestOtp: requestOtp,
    verifyOtp: verifyOtp,
    refreshSession: refreshSession,
    signOut: signOut,
    getSession: getSession
  };
})();
