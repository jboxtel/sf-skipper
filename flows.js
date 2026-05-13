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
