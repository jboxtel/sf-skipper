// User is queryable via the standard REST query endpoint.
var _usersCache = createSfCache({
  name: 'users',
  storageKey: 'sfnavUsers',
  errorLabel: 'User',
  soql:
    'SELECT Id, Name, Username, Email, IsActive, Profile.Name ' +
    'FROM User ORDER BY Name LIMIT 2000',
  parse: function (records) {
    return records.map(function (r) {
      return {
        id: r.Id,
        name: r.Name,
        username: r.Username,
        email: r.Email,
        isActive: r.IsActive,
        profile: r.Profile ? r.Profile.Name : null
      };
    });
  }
});

function getAllUsers()   { return _usersCache.getAll(); }
function getUsersState() { return _usersCache.getState(); }
function getUsersError() { return _usersCache.getError(); }
function loadUsers()     { return _usersCache.load(); }
function initUsers()     { _usersCache.init(); }
