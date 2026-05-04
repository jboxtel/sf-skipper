var _flows = [];
var _flowsState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
var _flowsError = '';
var _flowsLoadedAt = 0;
var FLOWS_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getAllFlows() { return _flows; }
function getFlowsState() { return _flowsState; }
function getFlowsError() { return _flowsError; }

async function loadFlows() {
  _flowsState = 'loading';

  var pre = await sfRestPreamble();

  // FlowDefinitionView is queryable via the standard REST query endpoint
  var q = encodeURIComponent('SELECT Id, Label, ApiName, ActiveVersionId, LatestVersionId FROM FlowDefinitionView ORDER BY Label LIMIT 2000');
  var resp = await fetch(pre.apiBase + pre.basePath + '/query/?q=' + q, { headers: pre.headers });
  if (!resp.ok) {
    var body = await resp.text();
    throw new Error('Flow query ' + resp.status + ': ' + body.slice(0, 120));
  }
  var data = await resp.json();

  _flows = (data.records || []).map(function (r) {
    return {
      id: r.Id,
      versionId: r.ActiveVersionId || r.LatestVersionId,
      label: r.Label,
      apiName: r.ApiName,
      isActive: !!r.ActiveVersionId,
    };
  });
  _flowsState = 'ready';
  _flowsLoadedAt = Date.now();

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var payload = {};
    payload[getOrgCacheKey('sfnavFlows')] = _flows;
    payload[getOrgCacheKey('sfnavFlowsLoadedAt')] = _flowsLoadedAt;
    chrome.storage.local.set(payload);
  }

  document.dispatchEvent(new CustomEvent('sfnav:flows-loaded'));
  return _flows.length;
}

function initFlows() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var flowsKey = getOrgCacheKey('sfnavFlows');
    var loadedAtKey = getOrgCacheKey('sfnavFlowsLoadedAt');
    chrome.storage.local.get([flowsKey, loadedAtKey], function (data) {
      if (data[flowsKey] && data[flowsKey].length) {
        _flows = data[flowsKey];
        _flowsLoadedAt = data[loadedAtKey] || 0;
        _flowsState = 'ready';
        document.dispatchEvent(new CustomEvent('sfnav:flows-loaded'));
      }

      // Skip the network call if the cache is fresh — saves a request per page navigation
      var fresh = _flowsLoadedAt && (Date.now() - _flowsLoadedAt) < FLOWS_TTL_MS;
      if (!fresh && typeof window !== 'undefined') {
        loadFlows().catch(function (err) {
          _flowsState = 'error';
          _flowsError = err.message;
          console.warn('sfnav: flow query failed —', err.message);
          document.dispatchEvent(new CustomEvent('sfnav:flows-loaded'));
        });
      }
    });
  } else if (typeof window !== 'undefined') {
    loadFlows().catch(function (err) {
      _flowsState = 'error';
      _flowsError = err.message;
      console.warn('sfnav: flow query failed —', err.message);
      document.dispatchEvent(new CustomEvent('sfnav:flows-loaded'));
    });
  }
}
