var _apps = [];
var _appsState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
var _appsError = '';
var _appsLoadedAt = 0;
var APPS_TTL_MS = 30 * 60 * 1000;

function getAllApps() { return _apps; }
function getAppsState() { return _appsState; }
function getAppsError() { return _appsError; }

async function loadApps() {
  _appsState = 'loading';

  var pre = await sfRestPreamble();

  // AppDefinition is the queryable view of installed Lightning apps.
  // DurableId is the value used in /lightning/app/<DurableId> URLs.
  var q = encodeURIComponent('SELECT DurableId, Label, NamespacePrefix FROM AppDefinition ORDER BY Label LIMIT 2000');
  var resp = await fetch(pre.apiBase + pre.basePath + '/query/?q=' + q, { headers: pre.headers });
  if (!resp.ok) {
    var body = await resp.text();
    throw new Error('App query ' + resp.status + ': ' + body.slice(0, 120));
  }
  var data = await resp.json();

  _apps = (data.records || []).map(function (r) {
    return {
      durableId: r.DurableId,
      label: r.Label,
      namespace: r.NamespacePrefix || '',
    };
  });
  _appsState = 'ready';
  _appsLoadedAt = Date.now();

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var payload = {};
    payload[getOrgCacheKey('sfnavApps')] = _apps;
    payload[getOrgCacheKey('sfnavAppsLoadedAt')] = _appsLoadedAt;
    chrome.storage.local.set(payload);
  }

  document.dispatchEvent(new CustomEvent('sfnav:apps-loaded'));
  return _apps.length;
}

function initApps() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var appsKey = getOrgCacheKey('sfnavApps');
    var loadedAtKey = getOrgCacheKey('sfnavAppsLoadedAt');
    chrome.storage.local.get([appsKey, loadedAtKey], function (data) {
      if (data[appsKey] && data[appsKey].length) {
        _apps = data[appsKey];
        _appsLoadedAt = data[loadedAtKey] || 0;
        _appsState = 'ready';
        document.dispatchEvent(new CustomEvent('sfnav:apps-loaded'));
      }

      var fresh = _appsLoadedAt && (Date.now() - _appsLoadedAt) < APPS_TTL_MS;
      if (!fresh && typeof window !== 'undefined') {
        loadApps().catch(function (err) {
          _appsState = 'error';
          _appsError = err.message;
          console.warn('sfnav: app query failed —', err.message);
          document.dispatchEvent(new CustomEvent('sfnav:apps-loaded'));
        });
      }
    });
  } else if (typeof window !== 'undefined') {
    loadApps().catch(function (err) {
      _appsState = 'error';
      _appsError = err.message;
      console.warn('sfnav: app query failed —', err.message);
      document.dispatchEvent(new CustomEvent('sfnav:apps-loaded'));
    });
  }
}
