// IsOwnedByProfile = true is the hidden permset that backs each Profile — we
// want only real, admin-managed permission sets here.
var _permsetsCache = createSfCache({
  name: 'permsets',
  storageKey: 'sfnavPermsets',
  errorLabel: 'Permission Set',
  soql:
    'SELECT Id, Name, Label, Description, IsCustom, NamespacePrefix ' +
    'FROM PermissionSet WHERE IsOwnedByProfile = false ' +
    'ORDER BY Label LIMIT 2000',
  parse: function (records) {
    return records.map(function (r) {
      return {
        id: r.Id,
        name: r.Name,
        label: r.Label || r.Name,
        description: r.Description,
        isCustom: r.IsCustom,
        namespace: r.NamespacePrefix
      };
    }).sort(function (a, b) { return (a.label || '').localeCompare(b.label || ''); });
  }
});

function getAllPermsets()   { return _permsetsCache.getAll(); }
function getPermsetsState() { return _permsetsCache.getState(); }
function getPermsetsError() { return _permsetsCache.getError(); }
function loadPermsets()     { return _permsetsCache.load(); }
function initPermsets()     { _permsetsCache.init(); }
