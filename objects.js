var STANDARD_OBJECTS = STANDARD_OBJECTS || [
  { label: "Account",                   apiName: "Account" },
  { label: "Contact",                   apiName: "Contact" },
  { label: "Lead",                      apiName: "Lead" },
  { label: "Opportunity",               apiName: "Opportunity" },
  { label: "Case",                      apiName: "Case" },
  { label: "Task",                      apiName: "Task" },
  { label: "Event",                     apiName: "Event" },
  { label: "Campaign",                  apiName: "Campaign" },
  { label: "Product",                   apiName: "Product2" },
  { label: "Pricebook",                 apiName: "Pricebook2" },
  { label: "Order",                     apiName: "Order" },
  { label: "Contract",                  apiName: "Contract" },
  { label: "Asset",                     apiName: "Asset" },
  { label: "User",                      apiName: "User" },
  { label: "Profile",                   apiName: "Profile" },
  { label: "Group",                     apiName: "Group" },
  { label: "ContentDocument",           apiName: "ContentDocument" },
  { label: "ContentVersion",            apiName: "ContentVersion" },
  { label: "Attachment",                apiName: "Attachment" },
  { label: "Note",                      apiName: "Note" },
  { label: "EmailMessage",              apiName: "EmailMessage" },
  { label: "CampaignMember",            apiName: "CampaignMember" },
  { label: "OpportunityLineItem",       apiName: "OpportunityLineItem" },
  { label: "OpportunityContactRole",    apiName: "OpportunityContactRole" },
  { label: "AccountContactRelation",    apiName: "AccountContactRelation" },
  { label: "Solution",                  apiName: "Solution" },
  { label: "PricebookEntry",            apiName: "PricebookEntry" },
  { label: "Quote",                     apiName: "Quote" },
  { label: "QuoteLineItem",             apiName: "QuoteLineItem" },
  { label: "WorkOrder",                 apiName: "WorkOrder" },
  { label: "WorkOrderLineItem",         apiName: "WorkOrderLineItem" },
  { label: "ServiceAppointment",        apiName: "ServiceAppointment" },
  { label: "Entitlement",               apiName: "Entitlement" },
  { label: "ServiceContract",           apiName: "ServiceContract" },
  { label: "FeedItem",                  apiName: "FeedItem" },
  { label: "CollaborationGroup",        apiName: "CollaborationGroup" },
  { label: "Individual",                apiName: "Individual" },
  { label: "BusinessHours",             apiName: "BusinessHours" },
  { label: "Holiday",                   apiName: "Holiday" },
];

// Custom-object cache. This doesn't use createSfCache because it has three
// sources (storage / URL / describeGlobal) that merge into one in-memory list,
// and entries are mutated in place by cmdt.js to memoize entityId/keyPrefix
// after the first lookup.
var _customObjects = [];

function apiNameToLabel(apiName) {
  return apiName.replace(/__c$/i, '').replace(/__mdt$/i, ' (MDT)').replace(/_/g, ' ').trim();
}

// e.g. /lightning/setup/ObjectManager/Claim__c/FieldsAndRelationships/view → "Claim__c"
function getObjectApiNameFromUrl() {
  var match = window.location.pathname.match(/\/ObjectManager\/([^/]+)/);
  if (!match) return null;
  var name = match[1];
  if (name === 'home' || name === 'search' || name === '') return null;
  return name;
}

// Incoming objects win — they're fresher than what's already cached.
function mergeIntoCache(incoming) {
  var map = {};
  _customObjects.forEach(function (o) { map[o.apiName] = o; });
  incoming.forEach(function (o) { map[o.apiName] = o; });
  _customObjects = Object.values(map);
}

function persistCache() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var payload = {};
    payload[getOrgCacheKey('sfnavCustomObjects')] = _customObjects;
    chrome.storage.local.set(payload);
  }
}

// Public mutation hook for cmdt.js (or future siblings) that need to memoize
// derived data (entityId, keyPrefix) into an existing cache entry.
function updateCachedObject(apiName, patch) {
  var match = _customObjects.find(function (o) { return o.apiName === apiName; });
  if (!match) return;
  Object.keys(patch).forEach(function (k) { match[k] = patch[k]; });
  persistCache();
}

// Look up a cached entry without exposing the array (read-only access for cmdt.js etc.).
function findCachedObject(apiName) {
  return _customObjects.find(function (o) { return o.apiName === apiName; }) || null;
}

async function loadObjectsFromPage() {
  var pre = await sfRestPreamble();

  var sobjResp = await sfFetch(pre.apiBase + pre.basePath + '/sobjects/', { headers: pre.headers });
  if (!sobjResp.ok) throw new Error('describeGlobal failed: ' + sobjResp.status);
  var data = await sobjResp.json();

  var objects = (data.sobjects || [])
    .filter(function (s) { return s.name && s.label; })
    .map(function (s) { return { label: s.label, apiName: s.name, isCustom: !!s.custom, keyPrefix: s.keyPrefix || null }; });
  if (!objects.length) return 0;
  mergeIntoCache(objects);
  persistCache();
  return objects.length;
}

function initCustomObjects() {
  // Source 1: stored cache (instant — gives the user something to search before the API call returns)
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    var key = getOrgCacheKey('sfnavCustomObjects');
    chrome.storage.local.get(key, function (data) {
      if (data[key] && data[key].length) {
        mergeIntoCache(data[key]);
      }
    });
  }

  // Source 2: current URL — works on any ObjectManager sub-page
  var urlApiName = getObjectApiNameFromUrl();
  if (urlApiName) {
    var existing = _customObjects.find(function (o) { return o.apiName === urlApiName; });
    if (!existing) {
      var isCustom = urlApiName.indexOf('__') !== -1;
      mergeIntoCache([{ label: apiNameToLabel(urlApiName), apiName: urlApiName, isCustom: isCustom }]);
      persistCache();
    }
  }

  // Source 3: REST API describeGlobal. Fire-and-forget; failures are non-fatal.
  if (typeof window !== 'undefined') {
    loadObjectsFromPage().catch(function (err) {
      console.warn('sfnav: describeGlobal failed —', err.message);
    });
  }
}

function getAllObjects() {
  var standardApiNames = new Set(STANDARD_OBJECTS.map(function (o) { return o.apiName; }));
  var customs = _customObjects.filter(function (o) { return !standardApiNames.has(o.apiName); });
  return STANDARD_OBJECTS.concat(customs);
}
