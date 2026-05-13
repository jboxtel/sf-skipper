// ExternalString = the sObject behind Custom Labels. Tooling API only.
// Returns one row per translation, so we dedup by Name preferring en_US.
var _labelsCache = createSfCache({
  name: 'labels',
  storageKey: 'sfnavLabels',
  errorLabel: 'Custom Label',
  endpoint: 'tooling',
  soql: 'SELECT Id, Name, MasterLabel, Value, Language, Category FROM ExternalString ORDER BY MasterLabel LIMIT 2000',
  parse: function (records) {
    var byName = {};
    records.forEach(function (r) {
      var existing = byName[r.Name];
      if (!existing || (r.Language === 'en_US' && existing.language !== 'en_US')) {
        byName[r.Name] = {
          id: r.Id,
          name: r.Name,
          label: r.MasterLabel,
          value: r.Value,
          language: r.Language,
          category: r.Category
        };
      }
    });
    return Object.keys(byName)
      .map(function (k) { return byName[k]; })
      .sort(function (a, b) { return (a.label || '').localeCompare(b.label || ''); });
  }
});

function getAllLabels()   { return _labelsCache.getAll(); }
function getLabelsState() { return _labelsCache.getState(); }
function getLabelsError() { return _labelsCache.getError(); }
function loadLabels()     { return _labelsCache.load(); }
function initLabels()     { _labelsCache.init(); }
