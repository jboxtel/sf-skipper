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
// the current active/latest version id just-in-time at open time so we always
// land on the right version. Falls back to the cached id on any failure so a
// hiccup never blocks navigation. ApiName is the stable, unique key.
async function resolveFlowVersionId(flow) {
  try {
    var pre = await sfRestPreamble();
    var soql = "SELECT ActiveVersionId, LatestVersionId FROM FlowDefinitionView WHERE ApiName = '" +
      escapeSoqlLiteral(flow.apiName) + "'";
    var resp = await sfFetch(pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent(soql), { headers: pre.headers });
    if (!resp.ok) throw new Error('FlowDefinitionView lookup ' + resp.status);
    var data = await resp.json();
    var rec = (data.records || [])[0];
    if (!rec) throw new Error('No FlowDefinitionView for ' + flow.apiName);
    return rec.ActiveVersionId || rec.LatestVersionId || flow.versionId || flow.id;
  } catch (err) {
    console.warn('sfnav: flow version lookup failed —', err.message);
    return flow.versionId || flow.id;
  }
}
