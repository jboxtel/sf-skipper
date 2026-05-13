// Custom Metadata Type helpers. CMDT navigation needs two pieces of metadata
// not in the standard object cache:
//   - entityId  (01Ixx…) for the "Object Definition" Setup URL
//   - keyPrefix (3-char) for the "Manage Records" list URL
// Both are fetched on demand and memoized into the shared object cache via
// updateCachedObject (defined in objects.js).

function getAllCustomMetadataTypes() {
  return getAllObjects().filter(function (o) { return /__mdt$/i.test(o.apiName); });
}

async function getEntityIdForCmdt(apiName) {
  var match = findCachedObject(apiName);
  if (match && match.entityId) return match.entityId;

  var pre = await sfRestPreamble();
  var soql = "SELECT Id FROM CustomObject WHERE DeveloperName = '" + apiName.replace(/__mdt$/i, '').replace(/'/g, "\\'") + "' AND ManageableState != 'deleted'";
  var resp = await sfFetch(pre.apiBase + pre.basePath + '/tooling/query/?q=' + encodeURIComponent(soql), { headers: pre.headers });
  if (!resp.ok) throw new Error('Tooling query failed for ' + apiName + ': ' + resp.status);
  var data = await resp.json();
  if (!data.records || !data.records.length) throw new Error('Entity not found for ' + apiName);
  var entityId = data.records[0].Id;

  updateCachedObject(apiName, { entityId: entityId });
  return entityId;
}

// The CMDT "Manage Records" URL uses the type's key prefix (e.g. "m0u").
// describeGlobal usually supplies keyPrefix during initial load; this fallback
// covers older cached entries that pre-date the keyPrefix field.
async function getKeyPrefixForCmdt(apiName) {
  var match = findCachedObject(apiName);
  if (match && match.keyPrefix) return match.keyPrefix;

  var pre = await sfRestPreamble();
  var resp = await sfFetch(pre.apiBase + pre.basePath + '/sobjects/' + encodeURIComponent(apiName) + '/describe', { headers: pre.headers });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('No describe access for ' + apiName + ' — check your permissions.');
  }
  if (!resp.ok) throw new Error('describe failed for ' + apiName + ': ' + resp.status);
  var data = await resp.json();
  if (!data.keyPrefix) throw new Error('No key prefix for ' + apiName);

  updateCachedObject(apiName, { keyPrefix: data.keyPrefix });
  return data.keyPrefix;
}
