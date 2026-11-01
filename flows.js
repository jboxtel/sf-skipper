// FlowDefinitionView is queryable via the standard REST query endpoint.
var _flowsCache = createSfCache({
  name: 'flows',
  storageKey: 'sfnavFlows',
  errorLabel: 'Flow',
  soql: 'SELECT Id, Label, ApiName, ActiveVersionId, LatestVersionId FROM FlowDefinitionView ORDER BY Label LIMIT 2000',
  parse: function (records) {
    return records.map(function (r) {
      return {
        id: r.Id,
        versionId: r.ActiveVersionId || r.LatestVersionId,
        label: r.Label,
        apiName: r.ApiName,
        isActive: !!r.ActiveVersionId
      };
    });
  }
});

function getAllFlows()   { return _flowsCache.getAll(); }
function getFlowsState() { return _flowsCache.getState(); }
function getFlowsError() { return _flowsCache.getError(); }
function loadFlows()     { return _flowsCache.load(); }
function initFlows()     { _flowsCache.init(); }

// The cached version id can be stale for up to the cache TTL — a flow the user
// activated or recreated moments ago still points at the old version. Resolve
// the current active/latest version id just-in-time so we always land on the
// right version. ApiName is the stable, unique key.
//
// The lookup starts as soon as a flow row is highlighted (prefetchFlowVersion),
// so by the time the user presses Enter it has usually finished. At open time
// we wait at most FLOW_VERSION_TIMEOUT_MS, then fall back to the cached id so a
// slow org never blocks navigation.
var FLOW_VERSION_TIMEOUT_MS = 1000;
var FLOW_VERSION_REUSE_MS = 30 * 1000;
var _flowVersionLookups = {}; // apiName → { promise, ts }

async function fetchFlowVersionId(flow) {
  var t0 = Date.now();
  var pre = await sfRestPreamble();
  var t1 = Date.now();
  var soql = "SELECT ActiveVersionId, LatestVersionId FROM FlowDefinitionView WHERE ApiName = '" +
    escapeSoqlLiteral(flow.apiName) + "'";
  var resp = await sfFetch(pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent(soql), { headers: pre.headers });
  if (!resp.ok) throw new Error('FlowDefinitionView lookup ' + resp.status);
  var data = await resp.json();
  if (DEV_MODE) console.log('sfnav: flow version lookup — auth ' + (t1 - t0) + 'ms, query ' + (Date.now() - t1) + 'ms (' + flow.apiName + ')');
  var rec = (data.records || [])[0];
  if (!rec) throw new Error('No FlowDefinitionView for ' + flow.apiName);
  return rec.ActiveVersionId || rec.LatestVersionId || flow.versionId || flow.id;
}

// Start the lookup for a flow, or reuse one started in the last few seconds.
function prefetchFlowVersion(flow) {
  var hit = _flowVersionLookups[flow.apiName];
  if (hit && (Date.now() - hit.ts) < FLOW_VERSION_REUSE_MS) return hit.promise;
  var promise = fetchFlowVersionId(flow);
  _flowVersionLookups[flow.apiName] = { promise: promise, ts: Date.now() };
  promise.catch(function () { delete _flowVersionLookups[flow.apiName]; });
  return promise;
}

// Never rejects: resolves to the current version id, or the cached one if the
// lookup fails or takes longer than FLOW_VERSION_TIMEOUT_MS.
function resolveFlowVersionId(flow) {
  var fallback = flow.versionId || flow.id;
  var t0 = Date.now();
  return new Promise(function (resolve) {
    var timer = setTimeout(function () {
      console.warn('sfnav: flow version lookup took over ' + FLOW_VERSION_TIMEOUT_MS + 'ms — opening the cached version');
      resolve(fallback);
    }, FLOW_VERSION_TIMEOUT_MS);
    prefetchFlowVersion(flow).then(function (id) {
      clearTimeout(timer);
      if (DEV_MODE) console.log('sfnav: flow open waited ' + (Date.now() - t0) + 'ms');
      resolve(id);
    }, function (err) {
      clearTimeout(timer);
      console.warn('sfnav: flow version lookup failed —', err.message);
      resolve(fallback);
    });
  });
}
