var _permsets = [];
var _permsetsState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
var _permsetsError = '';
var _permsetsLoadedAt = 0;
var PERMSETS_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getAllPermsets() { return _permsets; }
function getPermsetsState() { return _permsetsState; }
function getPermsetsError() { return _permsetsError; }

async function loadPermsets() {
  _permsetsState = 'loading';

  var pre = await sfRestPreamble();

  // IsOwnedByProfile = true is the hidden permset that backs each Profile — we
  // want only real, admin-managed permission sets here.
  var q = encodeURIComponent(
    'SELECT Id, Name, Label, Description, IsCustom, NamespacePrefix ' +
    'FROM PermissionSet WHERE IsOwnedByProfile = false ' +
    'ORDER BY Label LIMIT 2000'
  );
  var resp = await sfFetch(pre.apiBase + pre.basePath + '/query/?q=' + q, { headers: pre.headers });
  if (!resp.ok) {
    var body = await resp.text();
    throw new Error('Permission Set query ' + resp.status + ': ' + body.slice(0, 120));
  }
  var data = await resp.json();

  _permsets = (data.records || []).map(function (r) {
    return {
      id: r.Id,
      name: r.Name,
      label: r.Label || r.Name,
      description: r.Description,
      isCustom: r.IsCustom,
      namespace: r.NamespacePrefix,
    };
  }).sort(function (a, b) { return (a.label || '').localeCompare(b.label || ''); });
  _permsetsState = 'ready';
  _permsetsLoadedAt = Date.now();

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var payload = {};
    payload[getOrgCacheKey('sfnavPermsets')] = _permsets;
    payload[getOrgCacheKey('sfnavPermsetsLoadedAt')] = _permsetsLoadedAt;
    chrome.storage.local.set(payload);
  }

  document.dispatchEvent(new CustomEvent('sfnav:permsets-loaded'));
  return _permsets.length;
}

function initPermsets() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var permsetsKey = getOrgCacheKey('sfnavPermsets');
    var loadedAtKey = getOrgCacheKey('sfnavPermsetsLoadedAt');
    chrome.storage.local.get([permsetsKey, loadedAtKey], function (data) {
      if (data[permsetsKey] && data[permsetsKey].length) {
        _permsets = data[permsetsKey];
        _permsetsLoadedAt = data[loadedAtKey] || 0;
        _permsetsState = 'ready';
        document.dispatchEvent(new CustomEvent('sfnav:permsets-loaded'));
      }

      var fresh = _permsetsLoadedAt && (Date.now() - _permsetsLoadedAt) < PERMSETS_TTL_MS;
      if (!fresh && typeof window !== 'undefined') {
        loadPermsets().catch(function (err) {
          _permsetsState = 'error';
          _permsetsError = err.message;
          console.warn('sfnav: permission set query failed —', err.message);
          document.dispatchEvent(new CustomEvent('sfnav:permsets-loaded'));
        });
      }
    });
  } else if (typeof window !== 'undefined') {
    loadPermsets().catch(function (err) {
      _permsetsState = 'error';
      _permsetsError = err.message;
      console.warn('sfnav: permission set query failed —', err.message);
      document.dispatchEvent(new CustomEvent('sfnav:permsets-loaded'));
    });
  }
}
