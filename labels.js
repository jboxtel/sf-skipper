var _labels = [];
var _labelsState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
var _labelsError = '';
var _labelsLoadedAt = 0;
var LABELS_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getAllLabels() { return _labels; }
function getLabelsState() { return _labelsState; }
function getLabelsError() { return _labelsError; }

async function loadLabels() {
  _labelsState = 'loading';

  var pre = await sfRestPreamble();

  // ExternalString = the sObject behind Custom Labels. Tooling API only.
  var q = encodeURIComponent('SELECT Id, Name, MasterLabel, Value, Language, Category FROM ExternalString ORDER BY MasterLabel LIMIT 2000');
  var resp = await sfFetch(pre.apiBase + pre.basePath + '/tooling/query/?q=' + q, { headers: pre.headers });
  if (!resp.ok) {
    var body = await resp.text();
    throw new Error('Custom Label query ' + resp.status + ': ' + body.slice(0, 120));
  }
  var data = await resp.json();

  // ExternalString returns one row per translation. Prefer en_US, fall back to
  // the first row seen, so the picker shows each label once.
  var byName = {};
  (data.records || []).forEach(function (r) {
    var existing = byName[r.Name];
    if (!existing || (r.Language === 'en_US' && existing.language !== 'en_US')) {
      byName[r.Name] = {
        id: r.Id,
        name: r.Name,
        label: r.MasterLabel,
        value: r.Value,
        language: r.Language,
        category: r.Category,
      };
    }
  });
  _labels = Object.keys(byName).map(function (k) { return byName[k]; })
    .sort(function (a, b) { return (a.label || '').localeCompare(b.label || ''); });
  _labelsState = 'ready';
  _labelsLoadedAt = Date.now();

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var payload = {};
    payload[getOrgCacheKey('sfnavLabels')] = _labels;
    payload[getOrgCacheKey('sfnavLabelsLoadedAt')] = _labelsLoadedAt;
    chrome.storage.local.set(payload);
  }

  document.dispatchEvent(new CustomEvent('sfnav:labels-loaded'));
  return _labels.length;
}

function initLabels() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var labelsKey = getOrgCacheKey('sfnavLabels');
    var loadedAtKey = getOrgCacheKey('sfnavLabelsLoadedAt');
    chrome.storage.local.get([labelsKey, loadedAtKey], function (data) {
      if (data[labelsKey] && data[labelsKey].length) {
        _labels = data[labelsKey];
        _labelsLoadedAt = data[loadedAtKey] || 0;
        _labelsState = 'ready';
        document.dispatchEvent(new CustomEvent('sfnav:labels-loaded'));
      }

      var fresh = _labelsLoadedAt && (Date.now() - _labelsLoadedAt) < LABELS_TTL_MS;
      if (!fresh && typeof window !== 'undefined') {
        loadLabels().catch(function (err) {
          _labelsState = 'error';
          _labelsError = err.message;
          console.warn('sfnav: custom label query failed —', err.message);
          document.dispatchEvent(new CustomEvent('sfnav:labels-loaded'));
        });
      }
    });
  } else if (typeof window !== 'undefined') {
    loadLabels().catch(function (err) {
      _labelsState = 'error';
      _labelsError = err.message;
      console.warn('sfnav: custom label query failed —', err.message);
      document.dispatchEvent(new CustomEvent('sfnav:labels-loaded'));
    });
  }
}
