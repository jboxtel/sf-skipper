// AppDefinition is the queryable view of installed Lightning apps.
// DurableId is the value used in /lightning/app/<DurableId> URLs.
var _appsCache = createSfCache({
  name: 'apps',
  storageKey: 'sfnavApps',
  errorLabel: 'App',
  soql: 'SELECT DurableId, Label, NamespacePrefix FROM AppDefinition ORDER BY Label LIMIT 2000',
  parse: function (records) {
    return records.map(function (r) {
      return {
        durableId: r.DurableId,
        label: r.Label,
        namespace: r.NamespacePrefix || ''
      };
    });
  }
});

function getAllApps()   { return _appsCache.getAll(); }
function getAppsState() { return _appsCache.getState(); }
function getAppsError() { return _appsCache.getError(); }
function loadApps()     { return _appsCache.load(); }
function initApps()     { _appsCache.init(); }
