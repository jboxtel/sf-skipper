var _flows = [];
var _flowsState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
var _flowsError = '';

function getAllFlows() { return _flows; }
function getFlowsState() { return _flowsState; }
function getFlowsError() { return _flowsError; }

async function loadFlows() {
  _flowsState = 'loading';

  var apiBase = getApiBase();
  var apiHost = apiBase.replace(/^https?:\/\//, '');
  var sid = await getSessionFromBackground(apiHost);
  var headers = { 'Accept': 'application/json' };
  if (sid) headers['Authorization'] = 'Bearer ' + sid;

  // Resolve latest API version
  var versionsResp = await fetch(apiBase + '/services/data/', { headers: headers });
  if (!versionsResp.ok) throw new Error('Version probe failed: ' + versionsResp.status);
  var versions = await versionsResp.json();
  var latest = versions[versions.length - 1];
  var basePath = (latest && latest.url) ? latest.url.replace(/\/$/, '') : '/services/data/v' + (latest && latest.version);

  // FlowDefinitionView is queryable via the standard REST query endpoint
  var q = encodeURIComponent('SELECT Id, Label, ApiName, ActiveVersionId, LatestVersionId FROM FlowDefinitionView ORDER BY Label LIMIT 2000');
  var resp = await fetch(apiBase + basePath + '/query/?q=' + q, { headers: headers });
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

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ sfnavFlows: _flows });
  }

  document.dispatchEvent(new CustomEvent('sfnav:flows-loaded'));
  return _flows.length;
}

function initFlows() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('sfnavFlows', function (data) {
      if (data.sfnavFlows && data.sfnavFlows.length) {
        _flows = data.sfnavFlows;
        _flowsState = 'ready';
        document.dispatchEvent(new CustomEvent('sfnav:flows-loaded'));
      }
    });
  }

  if (typeof window !== 'undefined') {
    loadFlows().catch(function (err) {
      _flowsState = 'error';
      _flowsError = err.message;
      console.warn('sfnav: flow query failed —', err.message);
      document.dispatchEvent(new CustomEvent('sfnav:flows-loaded'));
    });
  }
}
