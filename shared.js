// Cross-file utilities: session lookup + cached Salesforce REST basePath.
// Loaded as the first content script so flows.js / objects.js / soql.js can rely on it.

var _basePathCache = null; // { basePath, ts }
var BASEPATH_TTL_MS = 60 * 60 * 1000; // 1 hour

function getSessionFromBackground(sfHost) {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'getSession', sfHost: sfHost }, function (resp) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp && resp.sid ? resp.sid : null);
      });
    } catch (_) { resolve(null); }
  });
}

// Resolve and cache the Salesforce REST API base path (e.g. "/services/data/v60.0").
// Salesforce adds a new version every release, so the result is stable for the session.
async function getApiBasePath(apiBase, headers) {
  if (_basePathCache && (Date.now() - _basePathCache.ts) < BASEPATH_TTL_MS) {
    return _basePathCache.basePath;
  }
  var resp = await fetch(apiBase + '/services/data/', { headers: headers });
  if (!resp.ok) throw new Error('Version probe failed: ' + resp.status);
  var versions = await resp.json();
  var latest = versions[versions.length - 1];
  var basePath = (latest && latest.url)
    ? latest.url.replace(/\/$/, '')
    : '/services/data/v' + (latest && latest.version);
  _basePathCache = { basePath: basePath, ts: Date.now() };
  return basePath;
}

// Helper for the common "auth + basePath" preamble in REST calls
async function sfRestPreamble() {
  var apiBase = getApiBase();
  var apiHost = apiBase.replace(/^https?:\/\//, '');
  var sid = await getSessionFromBackground(apiHost);
  var headers = { 'Accept': 'application/json' };
  if (sid) headers['Authorization'] = 'Bearer ' + sid;
  var basePath = await getApiBasePath(apiBase, headers);
  return { apiBase: apiBase, headers: headers, basePath: basePath };
}
