// Factory for the per-org cache pattern used by apps / flows / labels /
// permsets. Each cache pulls a list from a SOQL query, persists it to
// chrome.storage.local keyed by org, hydrates from storage on init, and
// refreshes if the cache is older than its TTL. The differences between
// caches are: the SOQL string, the endpoint (standard or tooling), the
// per-row parser, and the storage / event / log label names.

var SF_CACHE_DEFAULT_TTL_MS = 30 * 60 * 1000;

function createSfCache(config) {
  var items = [];
  var state = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
  var error = '';
  var loadedAt = 0;
  var ttl = config.ttlMs || SF_CACHE_DEFAULT_TTL_MS;
  var storageKey = config.storageKey;
  var loadedAtKey = storageKey + 'LoadedAt';
  var event = 'sfnav:' + config.name + '-loaded';
  var endpointPath = config.endpoint === 'tooling' ? '/tooling/query/' : '/query/';

  function dispatch() {
    document.dispatchEvent(new CustomEvent(event));
  }

  async function load() {
    state = 'loading';
    var pre = await sfRestPreamble();
    var url = pre.apiBase + pre.basePath + endpointPath + '?q=' + encodeURIComponent(config.soql);
    var resp = await sfFetch(url, { headers: pre.headers });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error(config.errorLabel + ' query ' + resp.status + ': ' + body.slice(0, 120));
    }
    var data = await resp.json();
    items = config.parse(data.records || []);
    state = 'ready';
    loadedAt = Date.now();

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      var payload = {};
      payload[getOrgCacheKey(storageKey)] = items;
      payload[getOrgCacheKey(loadedAtKey)] = loadedAt;
      chrome.storage.local.set(payload);
    }

    dispatch();
    return items.length;
  }

  function refreshSilently() {
    load().catch(function (err) {
      state = 'error';
      error = err.message;
      console.warn('sfnav: ' + config.errorLabel.toLowerCase() + ' query failed —', err.message);
      dispatch();
    });
  }

  function init() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      var k1 = getOrgCacheKey(storageKey);
      var k2 = getOrgCacheKey(loadedAtKey);
      chrome.storage.local.get([k1, k2], function (data) {
        if (data[k1] && data[k1].length) {
          items = data[k1];
          loadedAt = data[k2] || 0;
          state = 'ready';
          dispatch();
        }
        var fresh = loadedAt && (Date.now() - loadedAt) < ttl;
        if (!fresh && typeof window !== 'undefined') refreshSilently();
      });
    } else if (typeof window !== 'undefined') {
      refreshSilently();
    }
  }

  return {
    getAll: function () { return items; },
    getState: function () { return state; },
    getError: function () { return error; },
    load: load,
    init: init
  };
}
