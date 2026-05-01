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

// In-memory cache of custom objects, populated at init and kept in sync with storage
var _customObjects = [];

// Convert an API name like "My_Custom_Object__c" → "My Custom Object"
function apiNameToLabel(apiName) {
  return apiName.replace(/__c$/i, '').replace(/__mdt$/i, ' (MDT)').replace(/_/g, ' ').trim();
}

// Extract custom object API name from the current URL if we're on an ObjectManager page.
// e.g. /lightning/setup/ObjectManager/Claim__c/FieldsAndRelationships/view → "Claim__c"
function getObjectApiNameFromUrl() {
  var match = window.location.pathname.match(/\/ObjectManager\/([^/]+)/);
  if (!match) return null;
  var name = match[1];
  if (name === 'home' || name === 'search' || name === '') return null;
  return name;
}

// Merge new objects into the cache, deduplicating by apiName.
// Incoming objects win (they're fresher/more accurate).
function mergeIntoCache(incoming) {
  var map = {};
  _customObjects.forEach(function (o) { map[o.apiName] = o; });
  incoming.forEach(function (o) { map[o.apiName] = o; });
  _customObjects = Object.values(map);
}

// Persist the current cache to chrome.storage.local
function persistCache() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ sfnavCustomObjects: _customObjects });
  }
}

// Ask background.js for the `sid` cookie of the API host. Returns null in
// non-extension contexts (tests).
function getSessionFromBackground(sfHost) {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'getSession', sfHost: sfHost }, function (resp) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp && resp.sid ? resp.sid : null);
      });
    } catch (_) { resolve(null); }
  });
}

// Pull every sObject (standard + custom) from the org's REST API and merge
// into the cache. No copy/paste required.
async function loadObjectsFromPage() {
  var apiBase = getApiBase();
  var apiHost = apiBase.replace(/^https?:\/\//, '');
  var sid = await getSessionFromBackground(apiHost);
  var headers = { 'Accept': 'application/json' };
  if (sid) headers['Authorization'] = 'Bearer ' + sid;

  var versionsResp = await fetch(apiBase + '/services/data/', { headers: headers });
  if (!versionsResp.ok) throw new Error('Version probe failed: ' + versionsResp.status);
  var versions = await versionsResp.json();
  var latest = versions[versions.length - 1];
  // The .url field is canonical (e.g. "/services/data/v60.0"), .version is just "60.0".
  var basePath = (latest && latest.url) ? latest.url.replace(/\/$/, '') : '/services/data/v' + (latest && latest.version);

  var sobjResp = await fetch(apiBase + basePath + '/sobjects/', { headers: headers });
  if (!sobjResp.ok) throw new Error('describeGlobal failed: ' + sobjResp.status);
  var data = await sobjResp.json();

  var objects = (data.sobjects || [])
    .filter(function (s) { return s.name && s.label; })
    .map(function (s) { return { label: s.label, apiName: s.name, isCustom: !!s.custom }; });
  if (!objects.length) return 0;
  mergeIntoCache(objects);
  persistCache();
  return objects.length;
}

// Called once when content scripts load. Populates _customObjects from:
//   1. chrome.storage.local (objects remembered from previous visits)
//   2. The current URL (if we're already on a specific object page)
//   3. DOM scraping (if we're on the Object Manager list page)
function initCustomObjects() {
  // Source 1: stored cache (instant — gives the user something to search before the API call returns)
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('sfnavCustomObjects', function (data) {
      if (data.sfnavCustomObjects && data.sfnavCustomObjects.length) {
        mergeIntoCache(data.sfnavCustomObjects);
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

  // Source 3: REST API describeGlobal — fetches every sObject in the org.
  // Fire-and-forget; failures are non-fatal (we still have the cache + URL).
  // No hostname guard needed — the content script manifest already limits us to Salesforce pages.
  if (typeof window !== 'undefined') {
    loadObjectsFromPage().catch(function (err) {
      console.warn('sfnav: describeGlobal failed —', err.message);
    });
  }
}

function getAllObjects() {
  var standardApiNames = new Set(STANDARD_OBJECTS.map(function (o) { return o.apiName; }));
  // Custom objects from cache that aren't already in the standard list
  var customs = _customObjects.filter(function (o) { return !standardApiNames.has(o.apiName); });
  return STANDARD_OBJECTS.concat(customs);
}
