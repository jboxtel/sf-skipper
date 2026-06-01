// Skipper Account auth — talks to Supabase Auth REST directly.
//
// We use email-OTP (the user types an 8-digit code they get in email) rather
// than a click-through magic link. That avoids needing a redirect landing page
// for the Chrome extension and works identically across browsers.
//
// Storage lives under `sfnavOptions.skipper`:
//   { accessToken, refreshToken, email, userId, expiresAt (unix seconds) }
//
// Both SUPABASE_URL and SUPABASE_ANON are intended to be public (the anon key
// is published in client apps by design — RLS / Auth / API key blocklists are
// what gate access on the Supabase side).

var SKIPPER_SUPABASE_URL = 'https://bdfndqbnuganvfdgtvcg.supabase.co';
var SKIPPER_SUPABASE_ANON = 'sb_publishable_Kt9RftY4MGU_QAkdjCzx-A_qij1Zl4F';

function skipperAuthHeaders() {
  return { 'apikey': SKIPPER_SUPABASE_ANON, 'Content-Type': 'application/json' };
}

async function skipperSendOtp(email) {
  var r = await fetch(SKIPPER_SUPABASE_URL + '/auth/v1/otp', {
    method: 'POST',
    headers: skipperAuthHeaders(),
    body: JSON.stringify({ email: email, create_user: true })
  });
  if (!r.ok) {
    var err = await r.json().catch(function () { return {}; });
    throw new Error(err.msg || err.error_description || ('Send code failed (' + r.status + ')'));
  }
  return true;
}

async function skipperVerifyOtp(email, token) {
  var r = await fetch(SKIPPER_SUPABASE_URL + '/auth/v1/verify', {
    method: 'POST',
    headers: skipperAuthHeaders(),
    body: JSON.stringify({ email: email, token: String(token).trim(), type: 'email' })
  });
  var body = await r.json().catch(function () { return {}; });
  if (!r.ok || !body.access_token) {
    throw new Error(body.msg || body.error_description || ('Verify failed (' + r.status + ')'));
  }
  await skipperStoreSession({
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    email: (body.user && body.user.email) || email,
    userId: body.user && body.user.id,
    expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in || 3600)
  });
  return body.user || { email: email };
}

async function skipperRefreshSession(refreshToken) {
  var r = await fetch(SKIPPER_SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: skipperAuthHeaders(),
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  var body = await r.json().catch(function () { return {}; });
  if (!r.ok || !body.access_token) {
    // Refresh failed — wipe the local session so the UI prompts a fresh sign-in.
    await skipperStoreSession(null);
    throw new Error(body.msg || body.error_description || ('Refresh failed (' + r.status + ')'));
  }
  await skipperStoreSession({
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    email: body.user && body.user.email,
    userId: body.user && body.user.id,
    expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in || 3600)
  });
  return body.access_token;
}

// Returns a valid (non-expired) access token, refreshing if needed.
// Returns null if the user isn't signed in or refresh fails.
async function skipperGetAccessToken() {
  var session = await skipperGetSession();
  if (!session || !session.accessToken) return null;
  var now = Math.floor(Date.now() / 1000);
  // Refresh 60s before expiry to avoid a token that's about to expire mid-request.
  if (session.expiresAt && session.expiresAt - now > 60) return session.accessToken;
  if (!session.refreshToken) return null;
  try { return await skipperRefreshSession(session.refreshToken); }
  catch (e) { return null; }
}

async function skipperSignOut() {
  var session = await skipperGetSession();
  if (session && session.accessToken) {
    // Best-effort server-side revoke; ignore network failures.
    fetch(SKIPPER_SUPABASE_URL + '/auth/v1/logout', {
      method: 'POST',
      headers: { 'apikey': SKIPPER_SUPABASE_ANON, 'Authorization': 'Bearer ' + session.accessToken }
    }).catch(function () { /* ignore */ });
  }
  await skipperStoreSession(null);
}

function skipperGetSession() {
  return new Promise(function (resolve) {
    chrome.storage.local.get('sfnavOptions', function (data) {
      resolve((data && data.sfnavOptions && data.sfnavOptions.skipper) || null);
    });
  });
}

function skipperStoreSession(session) {
  return new Promise(function (resolve) {
    chrome.storage.local.get('sfnavOptions', function (data) {
      var next = Object.assign({}, (data && data.sfnavOptions) || {});
      if (session) next.skipper = session;
      else delete next.skipper;
      chrome.storage.local.set({ sfnavOptions: next }, function () { resolve(); });
    });
  });
}
