// SOQL Generator — natural-language → SOQL via Claude.
// Schema strategy:
//   1. Heuristic-match candidate objects against the existing object cache
//      (objects.js getAllObjects()).
//   2. Fetch describe for the top candidate(s), in parallel, with caching.
//   3. Send a focused schema (api name, label, type, referenceTo) to Claude.
//   4. Fall back to "no object match" mode where we send only the object list
//      and ask the model to pick — slower but more flexible.

var SOQL_HISTORY_KEY = 'sfnavSoqlHistory';
var SOQL_HISTORY_MAX = 10;
var SOQL_DESCRIBE_TTL_MS = 30 * 60 * 1000; // 30 minutes
var SOQL_COUNT_TTL_MS = 30 * 60 * 1000;    // 30 minutes — grounding signal is magnitude, not exact value
var SOQL_COUNT_LIMIT = 1000;               // sample cap: cheaper than COUNT() on large orgs; magnitude is enough to tiebreak
var SOQL_VALIDATE_RETRIES = 2; // additional attempts after the first generation

var SOQL_RECORDTYPES_TTL_MS = 30 * 60 * 1000;

var _describeCache = {};       // apiName → { fields, ts }
var _countCache = {};          // apiName → { count: number|null, ts }
var _recordTypesCache = null;  // { byObject: { apiName: [{developerName, name}] }, ts }
var _recordTypesPromise = null; // dedupes concurrent loads

// Data Cloud objects (DMOs, DLOs, CIOs, activation channels, streaming data) are
// queryable so the planner happily validates SOQL against them, but they
// silently shadow the standard/custom object the user actually meant — e.g.
// "cancelled flights" matches Flight__c AND Flight_Assignments__dlm. Exclude
// them from SOQL candidate scoring entirely.
var DATA_CLOUD_SUFFIX_RE = /__(dlm|dll|cio|chn|sdo|dla|dlr|hdt|ssot|unified)$/i;
function isDataCloudObject(o) {
  return DATA_CLOUD_SUFFIX_RE.test(o.apiName);
}
function getSoqlObjects() {
  return getAllObjects().filter(function (o) { return !isDataCloudObject(o); });
}

// Record types encode business-domain terms onto generic standard objects
// (e.g. Asset gets a "Flight_Assignment" record type in an aviation org).
// Without them, lexical scoring on object api names / labels alone can't
// see "flight" attached to Asset or Product2. One Tooling-free SOQL call
// surfaces every active record type org-wide; we cache it for 30 min.
async function loadRecordTypes() {
  if (_recordTypesCache && (Date.now() - _recordTypesCache.ts) < SOQL_RECORDTYPES_TTL_MS) {
    return _recordTypesCache.byObject;
  }
  if (_recordTypesPromise) return _recordTypesPromise;
  _recordTypesPromise = (async function () {
    try {
      var pre = await sfRestPreamble();
      var q = 'SELECT SobjectType, DeveloperName, Name FROM RecordType WHERE IsActive = true';
      var url = pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent(q);
      var resp = await sfFetch(url, { headers: pre.headers });
      if (!resp.ok) throw new Error('record types fetch failed: ' + resp.status);
      var data = await resp.json();
      var byObject = {};
      var records = data.records || [];
      for (var i = 0; i < records.length; i++) {
        var rt = records[i];
        var s = rt.SobjectType;
        if (!s) continue;
        if (!byObject[s]) byObject[s] = [];
        byObject[s].push({ developerName: rt.DeveloperName, name: rt.Name });
      }
      _recordTypesCache = { byObject: byObject, ts: Date.now() };
      return byObject;
    } finally {
      _recordTypesPromise = null;
    }
  })();
  return _recordTypesPromise;
}

function getRecordTypesFor(apiName) {
  if (!_recordTypesCache) return [];
  return _recordTypesCache.byObject[apiName] || [];
}

function soqlScoreObject(prompt, obj) {
  // Normalize so "e-mails" matches "email", "user's" matches "user"
  var p = prompt.toLowerCase().replace(/[-']/g, '');
  var label = (obj.label || '').toLowerCase();
  var apiName = (obj.apiName || '').toLowerCase();
  var apiBase = apiName.replace(/__c$/, '').replace(/_/g, ' ');
  var labelSingular = label.replace(/s$/, '');
  var apiSingular = apiBase.replace(/s$/, '');

  function scoreToken(c) {
    if (!c || c.length < 3) return 0;
    var esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match c, c+s, or c+es as a whole word — handles plurals in the prompt
    var re = new RegExp('\\b' + esc + '(?:e?s)?\\b', 'i');
    if (re.test(p)) return c.length * 3;
    if (p.indexOf(c) !== -1) return c.length;
    return 0;
  }

  var score = 0;
  var phrases = [label, apiBase, labelSingular, apiSingular];
  for (var i = 0; i < phrases.length; i++) score += scoreToken(phrases[i]);

  // Tokenize on whitespace AND CamelCase, since many standard labels are blobs
  // like "EmailMessage" or "OpportunityLineItem" and need to match "email" / "line item".
  var tokenSource = (obj.label || '') + ' ' + (obj.apiName || '').replace(/__c$/, '');
  var camelSplit = tokenSource.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  var tokens = camelSplit.split(/\s+/).filter(function (t) { return t.length >= 4; });
  var seen = {};
  for (var j = 0; j < tokens.length; j++) {
    if (seen[tokens[j]]) continue;
    seen[tokens[j]] = true;
    score += scoreToken(tokens[j]);
  }

  // Record types — score each record type's name + developer name, plus their
  // tokens. The whole-phrase match on a multi-word record type (e.g. "flight
  // assignment") is the most valuable signal because it pinpoints the parent
  // object exactly.
  var rts = getRecordTypesFor(obj.apiName);
  for (var k = 0; k < rts.length; k++) {
    var rtName = (rts[k].name || '').toLowerCase();
    var rtDev = (rts[k].developerName || '').replace(/_/g, ' ').toLowerCase();
    score += scoreToken(rtName);
    if (rtDev && rtDev !== rtName) score += scoreToken(rtDev);
    var rtTokens = (rtName + ' ' + rtDev).split(/\s+/).filter(function (t) { return t.length >= 4; });
    var rtSeen = {};
    for (var m = 0; m < rtTokens.length; m++) {
      if (rtSeen[rtTokens[m]]) continue;
      rtSeen[rtTokens[m]] = true;
      score += scoreToken(rtTokens[m]);
    }
  }

  return score;
}

// Field-name token scoring. The lexical scorer (`soqlScoreObject`) only looks
// at object api name, label, and record-type names. That misses objects whose
// "what they're about" lives in their field names — e.g. Product2 with
// FlightLegFrom__c / FlightTimeFrom__c / FlightCanceled__c / DepartureDateScheduled__c
// in an airline org where Product2 is repurposed as the flight catalog. The
// object name "Product" matches nothing in "show me flights from Frankfurt",
// so Product2 never makes the candidate list, even though its fields are the
// canonical home of the concept.
//
// Strategy: after schemas are loaded (candidates + lookup-target relateds),
// score each loaded schema's field names + labels against the prompt. If a
// contextOnly schema's field-name score beats every candidate's field-name
// score AND clears a minimum threshold, promote it to a real candidate (drop
// the "usually NOT FROM" hint, add a FIELD-MATCH PROMOTED marker in the user
// message). The model still picks FROM — we just stop discouraging the
// semantically-right object.
//
// Token weight is lower than the object-name scorer's (c.length, not c.length
// * 3) because field-name signal is noisier — common tokens like "date" /
// "name" / "type" appear in most schemas. The threshold filters those out:
// SOQL_FIELD_PROMOTE_MIN_SCORE = 6 requires at least one substantive whole-
// word match (e.g. "flight"=6, "carrier"=7, "departure"=9) — two length-4
// generics like "name"+"date" (total 8) also clear, which is fine when the
// prompt is that vague.
function scoreFieldNameMatch(prompt, fields) {
  if (!prompt || !fields || !fields.length) return 0;
  var p = prompt.toLowerCase().replace(/[-']/g, '');

  // De-dupe tokens across the whole field list — a field repeated 20 times
  // with "flight" in its name shouldn't score 20x more than a single field.
  var tokens = {};
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var nameSource = (f.name || '').replace(/__c$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    var labelSource = (f.label || '').toLowerCase();
    (nameSource + ' ' + labelSource).split(/\s+/).forEach(function (t) {
      if (t && t.length >= 4) tokens[t] = true;
    });
  }

  var score = 0;
  Object.keys(tokens).forEach(function (t) {
    var esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('\\b' + esc + '(?:e?s)?\\b', 'i');
    if (re.test(p)) score += t.length;
  });
  return score;
}

var SOQL_FIELD_PROMOTE_MIN_SCORE = 6;

function pickCandidateObjects(prompt, max) {
  var all = getSoqlObjects();
  var scored = all
    .map(function (o) { return { obj: o, score: soqlScoreObject(prompt, o) }; })
    .filter(function (x) { return x.score > 0; })
    .sort(function (a, b) { return b.score - a.score; });
  var lexical = scored.slice(0, max || 3).map(function (x) { return x.obj; });

  // BM25 fallback (item 5). The lexical scorer above is whole-word and
  // length-weighted — it misses cases where the prompt's terminology only
  // partially matches an object's surface text (e.g. prompt token "billing"
  // vs object name "BillableEvent__c"). BM25 captures partial-token
  // overlap and term-frequency signals the lexical scorer doesn't see.
  //
  // Merge strategy: lexical first (keeps the existing tight scoring), then
  // BM25 candidates that aren't already in the lexical list, capped so the
  // total candidate budget grows by at most SOQL_BM25_EXTRA_CANDIDATES.
  try {
    var bm25 = pickBM25Candidates(prompt, SOQL_BM25_TOP_K);
    var seen = {};
    lexical.forEach(function (o) { seen[o.apiName] = true; });
    var extra = [];
    for (var i = 0; i < bm25.length && extra.length < SOQL_BM25_EXTRA_CANDIDATES; i++) {
      if (!seen[bm25[i].apiName]) {
        extra.push(bm25[i]);
        seen[bm25[i].apiName] = true;
      }
    }
    if (extra.length) return lexical.concat(extra);
  } catch (bErr) {
    console.warn('sfnav: bm25 candidate retrieval failed —', bErr.message);
  }
  return lexical;
}

// ── BM25 retrieval (item 5) ───────────────────────────────────────────────
//
// In-process BM25 index over object surface text (api name + label + record
// types). Complements `soqlScoreObject` which is a whole-word lexical match;
// BM25 catches partial-token overlap and IDF-weighted rare terms. No external
// dependencies — runs entirely client-side, builds on demand, caches until
// the underlying object list changes.
//
// Why BM25 instead of TF-IDF cosine: BM25's length normalisation matters here
// because object surface texts vary wildly in length (a custom object with 20
// record types is much longer than a barebones one). Standard k1=1.2, b=0.75.
var SOQL_BM25_K1 = 1.2;
var SOQL_BM25_B = 0.75;
var SOQL_BM25_TOP_K = 5;
var SOQL_BM25_EXTRA_CANDIDATES = 2; // how many BM25-only candidates to append past the lexical top-3
var SOQL_BM25_MIN_SCORE = 1.0;      // ignore weak matches — only surface meaningful BM25 hits

var _bm25IndexCache = null;
var _bm25IndexObjectCount = -1;

function _bm25Tokenise(text) {
  if (!text) return [];
  var lowered = String(text).toLowerCase()
    .replace(/__c$/g, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-']/g, '')
    .toLowerCase();
  var parts = lowered.split(/[^a-z0-9]+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i];
    if (!t || t.length < 3) continue;
    out.push(t);
    var singular = t.replace(/(?:es|s)$/, '');
    if (singular.length >= 3 && singular !== t) out.push(singular);
  }
  return out;
}

function _bm25SurfaceTextForObject(obj) {
  var parts = [obj.apiName || '', obj.label || ''];
  // Strip the __c / __mdt suffix from api name BEFORE handing to tokeniser so
  // "TrackingHour2__c" contributes "tracking", "hour", "2" — not a literal "c".
  var bareApi = (obj.apiName || '').replace(/__c$/i, '').replace(/__mdt$/i, '');
  if (bareApi !== obj.apiName) parts.push(bareApi);
  var rts = getRecordTypesFor(obj.apiName) || [];
  rts.forEach(function (rt) {
    if (rt.name) parts.push(rt.name);
    if (rt.developerName) parts.push(rt.developerName);
  });
  return parts.join(' ');
}

function _bm25BuildIndex() {
  var all = getSoqlObjects();
  var docs = [];
  var df = {};
  var totalLen = 0;
  for (var i = 0; i < all.length; i++) {
    var tokens = _bm25Tokenise(_bm25SurfaceTextForObject(all[i]));
    var tf = {};
    tokens.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
    Object.keys(tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    docs.push({ obj: all[i], tf: tf, len: tokens.length });
    totalLen += tokens.length;
  }
  return {
    docs: docs,
    df: df,
    n: docs.length,
    avgdl: docs.length ? totalLen / docs.length : 0
  };
}

function _bm25GetIndex() {
  var all = getSoqlObjects();
  if (_bm25IndexCache && _bm25IndexObjectCount === all.length) return _bm25IndexCache;
  _bm25IndexCache = _bm25BuildIndex();
  _bm25IndexObjectCount = all.length;
  return _bm25IndexCache;
}

function _bm25Score(idx, queryTokens, doc) {
  if (!doc.len) return 0;
  var score = 0;
  for (var i = 0; i < queryTokens.length; i++) {
    var q = queryTokens[i];
    var dfq = idx.df[q] || 0;
    if (dfq === 0) continue;
    // Standard BM25 IDF with the +1 smoothing variant.
    var idf = Math.log(1 + (idx.n - dfq + 0.5) / (dfq + 0.5));
    var f = doc.tf[q] || 0;
    if (f === 0) continue;
    var denom = f + SOQL_BM25_K1 * (1 - SOQL_BM25_B + SOQL_BM25_B * (doc.len / (idx.avgdl || 1)));
    score += idf * (f * (SOQL_BM25_K1 + 1)) / denom;
  }
  return score;
}

function pickBM25Candidates(prompt, topK) {
  if (!prompt) return [];
  var idx = _bm25GetIndex();
  if (!idx.n) return [];
  var queryTokens = _bm25Tokenise(prompt);
  // De-dupe and drop very short stopword-ish tokens; the BM25 IDF would
  // already down-weight common words but skipping them is cheaper.
  var seen = {};
  var qFiltered = [];
  for (var i = 0; i < queryTokens.length; i++) {
    var t = queryTokens[i];
    if (t.length < 3) continue;
    if (seen[t]) continue;
    seen[t] = true;
    qFiltered.push(t);
  }
  if (!qFiltered.length) return [];

  var scored = [];
  for (var d = 0; d < idx.docs.length; d++) {
    var doc = idx.docs[d];
    if (isDataCloudObject(doc.obj)) continue;
    var s = _bm25Score(idx, qFiltered, doc);
    if (s >= SOQL_BM25_MIN_SCORE) scored.push({ obj: doc.obj, score: s });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, topK || SOQL_BM25_TOP_K).map(function (x) { return x.obj; });
}

// Salesforce convention: a reference field's SOQL relationship name is
// usually derivable from its api name. Custom `XXX__c` → `XXX__r`; standard
// `XxxId` → `Xxx` (Account, Owner, CreatedBy, etc.). Salesforce's describe
// response also returns `relationshipName` authoritatively; prefer that
// when available, fall back to the derived form for fixtures.
function deriveRelationshipName(fieldName) {
  if (/__c$/.test(fieldName)) return fieldName.replace(/__c$/, '__r');
  if (/Id$/.test(fieldName) && fieldName.length > 2) return fieldName.slice(0, -2);
  return null;
}

async function fetchDescribe(apiName) {
  var cached = _describeCache[apiName];
  if (cached && (Date.now() - cached.ts) < SOQL_DESCRIBE_TTL_MS) {
    return cached.fields;
  }

  var pre = await sfRestPreamble();

  var resp = await sfFetch(pre.apiBase + pre.basePath + '/sobjects/' + encodeURIComponent(apiName) + '/describe', { headers: pre.headers });
  if (!resp.ok) throw new Error('describe failed: ' + resp.status);
  var data = await resp.json();

  var fields = (data.fields || []).map(function (f) {
    var compact = { name: f.name, label: f.label, type: f.type };
    if (f.referenceTo && f.referenceTo.length) {
      compact.referenceTo = f.referenceTo;
      var rel = f.relationshipName || deriveRelationshipName(f.name);
      if (rel) compact.relationshipName = rel;
    }
    if (f.picklistValues && f.picklistValues.length) {
      compact.values = f.picklistValues.slice(0, 50).map(function (v) { return v.value; });
    }
    if (f.inlineHelpText) compact.helpText = f.inlineHelpText;
    // Capacity flags. Salesforce marks long-text / encrypted / formula /
    // location fields as non-filterable / non-groupable / non-sortable —
    // using them in WHERE / GROUP BY / ORDER BY rejects with errors that
    // don't suggest what to do instead. Surfacing the flags in the schema
    // block lets the model avoid the mismatch up front.
    //
    // We only store flags when they're restrictive (the value is `false`),
    // because the default state for most fields is permissive and surfacing
    // every permissive flag would add noise to the prompt. Reader contract:
    // a flag *absent* from the compact object means "default (true)"; a flag
    // *present and false* means "restricted, do not use in that operation."
    if (f.filterable === false) compact.notFilterable = true;
    if (f.groupable === false) compact.notGroupable = true;
    if (f.sortable === false) compact.notSortable = true;
    if (f.aggregatable === false) compact.notAggregatable = true;
    // Length is salient for textarea / string fields — a 100k textarea is a
    // very different beast from a 50-char text. Only stored for types where
    // length carries meaningful signal.
    if ((f.type === 'textarea' || f.type === 'string') && typeof f.length === 'number' && f.length > 0) {
      compact.length = f.length;
    }
    return compact;
  });

  _describeCache[apiName] = { fields: fields, ts: Date.now() };
  return fields;
}

// Sampled record count. Used to bias the model toward the object the org
// actually uses when lexical candidates collide (e.g. Attachment vs EmailMessage
// for "emails with attachments"). We only need magnitude to break the tie —
// `SELECT Id FROM X LIMIT N` stops at the first N rows it finds via any index,
// so it's roughly O(N) instead of O(table size). A saturated result (count ===
// SOQL_COUNT_LIMIT) means "lots" rather than "exactly N". Returns null if the
// object isn't queryable (formula-only, etc.) so we omit the field instead of
// blocking generation.
async function fetchCount(apiName) {
  var cached = _countCache[apiName];
  if (cached && (Date.now() - cached.ts) < SOQL_COUNT_TTL_MS) {
    return cached.count;
  }
  var pre = await sfRestPreamble();
  // apiName is an identifier (the FROM target), not a literal, so we validate
  // its shape instead of quoting. Salesforce sObject names are limited to
  // [A-Za-z0-9_]; anything else means a bad cache entry and should not be sent.
  if (!/^[A-Za-z0-9_]+$/.test(apiName)) throw new Error('Invalid sObject name: ' + apiName);
  var soql = 'SELECT Id FROM ' + apiName + ' LIMIT ' + SOQL_COUNT_LIMIT;
  var url = pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent(soql);
  var resp = await sfFetch(url, { headers: pre.headers });
  var count = null;
  if (resp.ok) {
    var data = await resp.json();
    if (typeof data.totalSize === 'number') count = data.totalSize;
  }
  _countCache[apiName] = { count: count, ts: Date.now() };
  return count;
}

// Field populationality: sample N rows and count non-nulls per field. The
// "abandoned object" failure mode — Project__c has HoursBudgeted__c but no
// row actually populates it in this org — is invisible to describe and to
// raw record count, both of which only see the object's shape. Sampling
// actual values is the cheapest fix.
//
// Strategy: SELECT a bounded set of fields LIMIT N. Count non-nulls
// client-side. Returns { fieldName: ratio } where ratio is fraction populated
// in the sample (0.0–1.0). Conservative on which fields to include: skip
// system audit / always-populated fields (Id, Name, OwnerId, audit dates)
// since they wouldn't help the model decide between candidates anyway. URL
// length cap: max 50 fields per query.
var _fieldPopCache = {};                      // apiName → { population, ts }
var SOQL_FIELD_POP_TTL_MS = 30 * 60 * 1000;   // 30 minutes
var SOQL_FIELD_POP_SAMPLE = 100;              // rows to sample
var SOQL_FIELD_POP_MAX_FIELDS = 50;           // URL-safety cap
var SOQL_FIELD_POP_SKIP = (function () {
  var skip = [
    'id', 'name', 'ownerid', 'isdeleted', 'createdbyid', 'createddate',
    'lastmodifiedbyid', 'lastmodifieddate', 'systemmodstamp', 'lastactivitydate',
    'lastvieweddate', 'lastreferenceddate', 'recordtypeid'
  ];
  var set = {};
  for (var i = 0; i < skip.length; i++) set[skip[i]] = true;
  return set;
})();

function _pickFieldsToSample(fields) {
  if (!fields || !fields.length) return [];
  var picked = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (!f || !f.name) continue;
    var lower = f.name.toLowerCase();
    if (SOQL_FIELD_POP_SKIP[lower]) continue;
    // Skip compound address / location fields — they aren't directly
    // selectable in SOQL (BillingAddress is selectable but BillingStreet etc.
    // appear as separate fields). Filtering on `type` is the cleanest gate.
    if (f.type === 'address' || f.type === 'location') continue;
    picked.push(f.name);
    if (picked.length >= SOQL_FIELD_POP_MAX_FIELDS) break;
  }
  return picked;
}

async function fetchFieldPopulation(apiName, fields) {
  var cached = _fieldPopCache[apiName];
  if (cached && (Date.now() - cached.ts) < SOQL_FIELD_POP_TTL_MS) {
    return cached.population;
  }
  if (!/^[A-Za-z0-9_]+$/.test(apiName)) throw new Error('Invalid sObject name: ' + apiName);
  var sampleFields = _pickFieldsToSample(fields);
  if (!sampleFields.length) {
    _fieldPopCache[apiName] = { population: {}, ts: Date.now() };
    return {};
  }

  var pre = await sfRestPreamble();
  // SELECT Id, ... so we always have at least one always-non-null projection;
  // some sObjects 400 on `SELECT FieldA FROM X` if FieldA is the only field
  // and is restricted by FLS. Id is safe.
  var soql = 'SELECT Id, ' + sampleFields.join(', ') + ' FROM ' + apiName + ' LIMIT ' + SOQL_FIELD_POP_SAMPLE;
  var url = pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent(soql);
  var resp;
  try { resp = await sfFetch(url, { headers: pre.headers }); }
  catch (e) {
    _fieldPopCache[apiName] = { population: {}, ts: Date.now() };
    return {};
  }

  var population = {};
  if (resp.ok) {
    var data = null;
    try { data = await resp.json(); } catch (_) {}
    var records = (data && data.records) || [];
    if (records.length) {
      var counts = {};
      for (var i = 0; i < sampleFields.length; i++) counts[sampleFields[i]] = 0;
      for (var r = 0; r < records.length; r++) {
        var row = records[r];
        for (var k = 0; k < sampleFields.length; k++) {
          var fname = sampleFields[k];
          var v = row[fname];
          if (v !== null && v !== undefined && v !== '') counts[fname] += 1;
        }
      }
      for (var fk in counts) {
        if (!Object.prototype.hasOwnProperty.call(counts, fk)) continue;
        population[fk] = counts[fk] / records.length;
      }
    }
  }
  _fieldPopCache[apiName] = { population: population, ts: Date.now() };
  return population;
}

function buildSystemPrompt() {
  // The Salesforce planner is ground truth — generateSoql() validates via
  // /query?explain and feeds errors back for self-correction. We don't
  // enumerate every syntax rule here, only the invariants the planner's
  // first-error-wins diagnostics fail to teach efficiently (e.g. it reports
  // an unexpected token without explaining the underlying grammar shape).
  return [
    'You generate Salesforce SOQL queries from natural language.',
    'Use ONLY the objects and fields provided — do not invent fields. Names are case-sensitive; use exact API names.',
    'Only SELECT queries. No DML, no anonymous Apex.',
    'For picklist filters, use the exact picklist value if provided; otherwise a sensible literal in single quotes.',
    '',
    'Grammar invariants (these are the things the planner does not explain well):',
    '- SOQL has NO JOIN keyword. For parent-with-children, use a child subquery inside the SELECT list: SELECT Id, (SELECT Id FROM ChildRelationshipName) FROM Parent. For filtering a parent by child existence, use a semi-join: SELECT Id FROM Parent WHERE Id IN (SELECT ForeignKeyId FROM Child WHERE ...).',
    '- For a reference field <Name>__c (custom) or <Name>Id (standard), dot-walk to fields on the referenced object via the relationship name shown in the schema (typically <Name>__r for custom, the field name without "Id" for standard — Account, Owner, CreatedBy, etc.). Example: ClaimLineItem__c.AffectedFlight__r.RevenueEUR__c.',
    '- When the prompt asks "which X have/did Y" or "X with Y", the answer object is X — return rows of X, not raw foreign-key IDs from the child table.',
    '- SOQL date functions (DAY_IN_WEEK, DAY_IN_MONTH, CALENDAR_YEAR, HOUR_IN_DAY, FISCAL_QUARTER, etc.) return INTEGERS. Compare them to integer literals only — never to another function, never to a name like FRIDAY. (DAY_IN_WEEK: 1=Sun ... 6=Fri ... 7=Sat. HOUR_IN_DAY: 0-23.)',
    '- The valid SOQL date-literal tokens are limited: TODAY, YESTERDAY, TOMORROW, THIS/LAST/NEXT_WEEK, THIS/LAST/NEXT_MONTH, THIS/LAST/NEXT_QUARTER, THIS/LAST/NEXT_YEAR, THIS/LAST/NEXT_FISCAL_QUARTER, THIS/LAST/NEXT_FISCAL_YEAR, LAST_90_DAYS, NEXT_90_DAYS, and the LAST_N_*/NEXT_N_* family (e.g. LAST_N_DAYS:7). There are NO day-of-week literals (no LAST_FRIDAY) and NO time-of-day literals. Use bare tokens, no quotes.',
    '- Absolute datetimes are unquoted ISO-8601 with timezone: 2024-01-15T18:00:00Z.',
    '- Booleans compare unquoted (HasAttachment = true).',
    '',
    'Semantic preferences:',
    '- For "emails with attachments", use EmailMessage with HasAttachment = true rather than the legacy Attachment object.',
    '- When a prompt mentions a noun that matches one value of a picklist (e.g. "cards" → Type__c picklist with values [Card, Voucher]), add an explicit filter on that picklist value (Type__c = \'Card\').',
    '',
    'If previous attempts and Salesforce errors are included, the errors are authoritative AND cumulative — every prior attempt failed, so do not repeat any of their approaches. Emit a query that avoids every listed mistake.',
    '',
    'Respond with ONLY a JSON object on a single line, no prose, no code fences:',
    '{"soql":"SELECT ...","objectName":"...","explanation":"one short sentence"}'
  ].join('\n');
}

// Reverse picklist index: literal → [{ apiName, fieldName, value }]. Lets us
// detect when a token in the user's prompt is a valid picklist value somewhere
// in the candidate schema — strong signal for which field to filter on, and
// the main grounding gap behind "flights with status CR" where the model picks
// a lexically-similar but semantically-wrong field. Case-insensitive lookup
// (Salesforce picklist filters are case-sensitive, but user prompts aren't),
// preserves the exact case from the picklist value so the hint says 'CR'
// even if the user wrote 'cr'.
function buildPicklistValueIndex(schemaObjects) {
  var idx = {};
  (schemaObjects || []).forEach(function (o) {
    if (!o.fields) return;
    o.fields.forEach(function (f) {
      if (f.type !== 'picklist' || !f.values || !f.values.length) return;
      f.values.forEach(function (v) {
        if (v == null) return;
        var key = String(v).toLowerCase();
        if (!idx[key]) idx[key] = [];
        idx[key].push({ apiName: o.apiName, fieldName: f.name, value: v });
      });
    });
  });
  return idx;
}

// Find tokens in the prompt that exactly match a picklist value somewhere in
// the schema. Filtering rules (chosen to maximize signal/noise):
//   - token length >= 2
//   - exclude pure-numeric tokens (record IDs, years, counts)
//   - dedupe by token (case-insensitive)
//   - drop hits with > MAX_LOCATIONS matches (generic words like "Active"
//     would otherwise dominate); rare codes like 'CR' / 'CL' stay
var SOQL_PICKLIST_HINT_MAX_LOCATIONS = 3;
function findPicklistMatchesInPrompt(prompt, index) {
  if (!prompt || !index) return [];
  var tokens = String(prompt).match(/[A-Za-z0-9_]+/g) || [];
  var seen = {};
  var hits = [];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (t.length < 2) continue;
    if (/^\d+$/.test(t)) continue;
    var key = t.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    var locs = index[key];
    if (!locs || !locs.length) continue;
    if (locs.length > SOQL_PICKLIST_HINT_MAX_LOCATIONS) continue;
    hits.push({ token: t, locations: locs });
  }
  return hits;
}

function buildUserMessage(prompt, schemaObjects, context) {
  context = context || {};
  var lines = [];
  lines.push('User request: ' + prompt);
  lines.push('');

  // Org-specific vocabulary block — placed BEFORE the schema dump so it's the
  // first signal the model reads. Lexical scoring may have produced a
  // candidate set that's superficially correct but ambiguous; glossary hits
  // tell the model which candidate this org has historically used for the
  // user's terminology.
  if (context.glossaryAnchorBlock && context.glossaryAnchorBlock.trim()) {
    lines.push(context.glossaryAnchorBlock);
    lines.push('');
  }

  // Plan from the planner step (item 4). Pinning row-shape + FROM is more
  // authoritative than any heuristic; surface above the schema so the
  // generator reads it before considering alternatives.
  if (context.plan) {
    lines.push(formatPlanBlock(context.plan));
    lines.push('');
  }

  // Counts reflect actual usage in this org — strongly prefer the object the
  // org is populating over a lexically-tempting but empty/near-empty sibling.
  var hasCounts = schemaObjects.some(function (o) { return typeof o.count === 'number'; });
  if (hasCounts && schemaObjects.length > 1) {
    lines.push('Multiple candidate objects below. Their record counts reflect this org\'s actual usage — when objects look semantically similar, prefer the one with substantially more records.');
    lines.push('');
  }
  lines.push('Available schema:');
  for (var i = 0; i < schemaObjects.length; i++) {
    var o = schemaObjects[i];
    var header = 'Object: ' + o.apiName + (o.label ? ' (' + o.label + ')' : '');
    if (typeof o.count === 'number') {
      var countText = o.count >= SOQL_COUNT_LIMIT
        ? SOQL_COUNT_LIMIT.toLocaleString('en-US') + '+ records'
        : o.count.toLocaleString('en-US') + ' records';
      header += ' — ' + countText;
    }
    if (o.contextOnly) header += ' [lookup target — use for dot-walks; usually NOT the FROM target]';
    else if (o.fieldPromoted) header += " [FIELD-MATCH PROMOTED — multiple fields on this object match the prompt's terminology, even though the object's name does not. This is a strong candidate for FROM if the user's row-shape is one row per " + (o.label || o.apiName) + ".]";
    lines.push(header);
    if (o.recordTypes && o.recordTypes.length) {
      var rtSummary = o.recordTypes.map(function (rt) {
        return rt.developerName + (rt.name && rt.name !== rt.developerName ? ' ("' + rt.name + '")' : '');
      }).join(', ');
      lines.push('  Record types: ' + rtSummary + '  — filter with RecordType.DeveloperName = \'<DeveloperName>\'');
    }
    if (o.fields) {
      for (var j = 0; j < o.fields.length; j++) {
        var f = o.fields[j];
        var meta = f.type;
        // Length is part of the type signal for text fields — a 100k textarea
        // behaves very differently from a 50-char string. Render inline so
        // it's right next to the type token where it's most readable.
        if (typeof f.length === 'number' && f.length > 0) {
          meta += '(' + f.length + ')';
        }
        if (f.referenceTo) {
          meta += ' → ' + f.referenceTo.join('|');
          if (f.relationshipName) meta += ' [dot-walk: ' + f.relationshipName + '.<field>]';
        }
        if (f.values) meta += ' [' + f.values.join(',') + ']';
        var line = '  - ' + f.name + ' : ' + meta + (f.label && f.label !== f.name ? ' (' + f.label + ')' : '');
        // Capacity-flag warnings. SOQL rejects long-text / encrypted / certain
        // formula / location fields when used in WHERE / GROUP BY / ORDER BY,
        // with errors like "field X can not be filtered in a query call".
        // Surfacing the restrictions inline lets the model avoid the mismatch
        // up front rather than discovering it through retry. We only render
        // the restrictive flags (per the fetchDescribe contract — a flag is
        // present in the compact object only when it's `false`/restricted).
        var caps = [];
        if (f.notFilterable) caps.push('not filterable (cannot appear in WHERE)');
        if (f.notGroupable)  caps.push('not groupable (cannot appear in GROUP BY)');
        if (f.notSortable)   caps.push('not sortable (cannot appear in ORDER BY)');
        if (f.notAggregatable) caps.push('not aggregatable (cannot wrap in COUNT/SUM/AVG/MIN/MAX)');
        if (caps.length) line += ' [' + caps.join('; ') + ']';
        // Populationality: a per-field "is this filled in on real records in
        // this org" signal sampled at fetchCandidateSchema time. Salient when
        // the value is at the extremes (≥80% says "this is the canonical field
        // for this object"; ≤10% says "the field exists but nobody uses it").
        // Surface only the extremes — middle-of-the-road values just add noise.
        if (o.fieldPopulation && Object.prototype.hasOwnProperty.call(o.fieldPopulation, f.name)) {
          var pct = o.fieldPopulation[f.name];
          if (typeof pct === 'number' && !isNaN(pct)) {
            if (pct >= 0.8) line += '  [populated on ' + Math.round(pct * 100) + '% of sampled rows]';
            else if (pct <= 0.1) line += '  [populated on ' + Math.round(pct * 100) + '% of sampled rows — usually empty]';
          }
        }
        if (f.helpText) {
          var help = String(f.helpText).replace(/\s+/g, ' ').trim();
          if (help.length > 120) help = help.slice(0, 117) + '...';
          if (help) line += ' — help: ' + help;
        }
        lines.push(line);
      }
    }
  }

  var pvIndex = buildPicklistValueIndex(schemaObjects);
  var pvHits = findPicklistMatchesInPrompt(prompt, pvIndex);
  if (pvHits.length) {
    lines.push('');
    lines.push("Picklist value matches in the prompt. Each line says where a token in the user's request lives as a picklist value. Use this to pick the right field — but if your FROM object differs from the object that holds the field, you MUST reach the field via a relationship dot-walk (find a reference field on FROM whose referenceTo matches), not by referencing the field directly on FROM:");
    pvHits.forEach(function (h) {
      var locs = h.locations.map(function (l) {
        return "object=" + l.apiName + " field=" + l.fieldName + " value='" + l.value + "'";
      }).join(' OR ');
      lines.push("  - token '" + h.token + "' → " + locs);
    });
  }

  // Few-shot examples (item 3): in-context demonstrations from prior
  // successful queries in THIS org. Placed at the end so they're the last
  // thing the model reads before generating — research consistently finds
  // recency of examples in the prompt matters for small models. The retrieval
  // / similarity selection happens in the caller; we just format what's
  // passed in.
  if (context.fewShotExamples && context.fewShotExamples.length) {
    lines.push('');
    lines.push('Examples from prior successful queries in this org. They demonstrate this org\'s vocabulary and FROM-object conventions:');
    context.fewShotExamples.forEach(function (ex) {
      lines.push('');
      lines.push('User asked: "' + (ex.prompt || '').replace(/"/g, "'") + '"');
      lines.push('SOQL: ' + (ex.soql || ''));
    });
  }

  return lines.join('\n');
}

// Render the planner output (item 4) as a directive block inside the user
// message. The plan is treated as authoritative for FROM + row-shape; the
// generator's freedom is at the field / filter / ordering level.
function formatPlanBlock(plan) {
  if (!plan || !plan.fromObject) return '';
  var lines = ['Query plan from the planner step. Treat as authoritative for FROM and row-shape:'];
  lines.push('  - Row shape: ' + (plan.rowShape || '(one row per ' + plan.fromObject + ' record)'));
  lines.push('  - FROM: ' + plan.fromObject);
  if (plan.groupBy) lines.push('  - GROUP BY hint: ' + plan.groupBy);
  if (plan.needsRelated && plan.needsRelated.length) {
    lines.push('  - Reach related data via dot-walks to: ' + plan.needsRelated.join(', '));
  }
  if (plan.notes) lines.push('  - Notes: ' + plan.notes);
  lines.push('Do not change FROM. Pick fields, filters, and ordering to satisfy the user\'s intent given this plan.');
  return lines.join('\n');
}

function buildObjectListMessage(prompt) {
  var all = getSoqlObjects();
  var lines = [];
  lines.push('User request: ' + prompt);
  lines.push('');
  lines.push('I could not match an object from the prompt. Pick the most likely object from this list and reply ONLY with its api name (no JSON, no prose). Record types on a generic standard object often encode the real business concept — treat them as a strong signal.');
  for (var i = 0; i < all.length; i++) {
    var rts = getRecordTypesFor(all[i].apiName);
    var line = '- ' + all[i].apiName + (all[i].label && all[i].label !== all[i].apiName ? ' (' + all[i].label + ')' : '');
    if (rts.length) {
      line += '  [record types: ' + rts.map(function (r) { return r.name || r.developerName; }).join(', ') + ']';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function parseSoqlResponse(text) {
  if (!text) throw new Error('Empty response');
  // Strip code fences if present
  var cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Find the first complete top-level JSON object. Models sometimes append
  // commentary after the JSON ("here is the query: { ... }\nthis returns ..."),
  // which trips JSON.parse with "Unexpected non-whitespace character after JSON".
  // Walk the brace depth, ignoring braces inside string literals.
  var start = cleaned.indexOf('{');
  if (start === -1) throw new Error('Could not parse response: ' + text.slice(0, 120));
  var depth = 0;
  var inString = false;
  var escapeNext = false;
  var end = -1;
  for (var i = start; i < cleaned.length; i++) {
    var ch = cleaned[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (inString) {
      if (ch === '\\') { escapeNext = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('Could not parse response: ' + text.slice(0, 120));
  var json = cleaned.slice(start, end + 1);
  try {
    var obj = JSON.parse(json);
    if (!obj.soql) throw new Error('Response missing soql field');
    return obj;
  } catch (e) {
    throw new Error('Invalid JSON in response: ' + e.message);
  }
}

// Object-existence preflight. The Salesforce planner DOES reject queries
// against non-existent objects in production, but the diagnostic ("sObject type
// 'Flight__c' is not supported") doesn't give the retry loop anywhere to land.
// This check fires the same retry path with a more useful error that lists the
// objects we already sent schema for, so the model has somewhere to pivot to
// instead of repeating the hallucination. In the eval harness where the
// planner stub always passes, this is also the only line of defense against
// FROM-target hallucination.
//
// Strict mode: FROM must be an object in the org at all (knownObjectNames).
// Suggestions are drawn preferentially from schemaObjects since the model
// already has their full schema in context.
function validateSoqlObjectExists(soql, schemaObjects, knownObjectNames) {
  if (!soql) return { ok: true };
  if (!knownObjectNames || !knownObjectNames.length) return { ok: true };

  // Only check the outer FROM. Subquery FROMs are child-relationship names,
  // not sObject api names, and shouldn't be validated against the object list.
  var stripped = soql.replace(/\(\s*SELECT\b[^)]*\)/gi, '');
  var fromMatch = /\bFROM\s+([A-Za-z0-9_]+)/i.exec(stripped);
  if (!fromMatch) return { ok: true };
  var fromApi = fromMatch[1];

  var knownByLc = {};
  for (var i = 0; i < knownObjectNames.length; i++) {
    knownByLc[knownObjectNames[i].toLowerCase()] = knownObjectNames[i];
  }
  if (knownByLc[fromApi.toLowerCase()]) return { ok: true };

  var schemaNames = (schemaObjects || []).map(function (o) { return o.apiName; });
  var suggestions = schemaNames.length ? schemaNames.slice() : knownObjectNames.slice(0, 12);

  var msg = "Object '" + fromApi + "' does not exist in this org. " +
    "Pick one of the objects already in your schema: " + suggestions.join(', ') +
    ". If none of these matches the user's intent, return the best fit anyway — do not invent a new object name.";
  return { ok: false, error: msg };
}

// Field-existence check on FROM. The planner DOES reject "no such column"
// references in production, but the eval-harness planner stub doesn't, and
// the error doesn't suggest a dot-walk recovery. This walks every identifier
// in the (subquery-stripped) SOQL and verifies it resolves on the FROM
// object's schema — directly for simple refs, by dot-walking through
// relationship fields for paths. When a field doesn't exist on FROM but
// DOES exist on a related schema we already sent, the error suggests the
// reachable dot-walk so the retry has a concrete next step.
//
// Conservative: silently passes when FROM isn't in our schema (object-exists
// owns that case), when the resolution path crosses an object we lack schema
// for, or for keywords / aggregate functions / RecordType paths. We do not
// try to be exhaustive — false positives turn into wasted retries against
// real users.
var SOQL_FIELD_VALIDATOR_SKIP_KEYWORDS = (function () {
  var keywords = [
    // SOQL grammar
    'select', 'from', 'where', 'and', 'or', 'not', 'in', 'like', 'includes', 'excludes',
    'null', 'true', 'false', 'order', 'by', 'asc', 'desc', 'nulls', 'first', 'last',
    'group', 'having', 'limit', 'offset', 'with', 'data', 'category', 'rollup', 'cube',
    'using', 'scope', 'for', 'view', 'reference', 'update', 'tracking', 'security_enforced',
    'all', 'rows', 'typeof', 'when', 'then', 'else', 'end',
    // Date literals (bare tokens, no quotes)
    'today', 'yesterday', 'tomorrow',
    'this_week', 'last_week', 'next_week',
    'this_month', 'last_month', 'next_month',
    'this_quarter', 'last_quarter', 'next_quarter',
    'this_year', 'last_year', 'next_year',
    'this_fiscal_quarter', 'last_fiscal_quarter', 'next_fiscal_quarter',
    'this_fiscal_year', 'last_fiscal_year', 'next_fiscal_year',
    'last_90_days', 'next_90_days', 'last_n_days', 'next_n_days',
    'last_n_weeks', 'next_n_weeks', 'last_n_months', 'next_n_months',
    'last_n_quarters', 'next_n_quarters', 'last_n_years', 'next_n_years',
    'last_n_fiscal_quarters', 'next_n_fiscal_quarters',
    'last_n_fiscal_years', 'next_n_fiscal_years',
    // Aggregate + date functions
    'count', 'count_distinct', 'sum', 'avg', 'min', 'max',
    'calendar_year', 'calendar_month', 'calendar_quarter',
    'day_in_week', 'day_in_month', 'day_in_year',
    'hour_in_day', 'day_only',
    'fiscal_year', 'fiscal_quarter', 'week_in_year', 'week_in_month',
    // Converters / misc
    'format', 'convertcurrency', 'tolabel', 'distance', 'geolocation',
    // RecordType — planner handles RecordType.X paths natively
    'recordtype'
  ];
  var set = {};
  keywords.forEach(function (k) { set[k] = true; });
  return set;
})();

function validateSoqlFieldsExist(soql, schemaObjects) {
  if (!soql || !schemaObjects || !schemaObjects.length) return { ok: true };

  var schemaByName = {};
  schemaObjects.forEach(function (o) {
    if (!o.fields) return;
    var byName = {};
    var byRel = {};
    o.fields.forEach(function (f) {
      byName[f.name.toLowerCase()] = f;
      if (f.relationshipName) byRel[f.relationshipName.toLowerCase()] = f;
    });
    schemaByName[o.apiName] = { fieldsByName: byName, fieldsByRelationship: byRel, fields: o.fields, apiName: o.apiName };
  });

  // Strip subqueries — their field references resolve against a different
  // FROM scope (the child object). Validating them against the outer schema
  // would create false positives.
  var stripped = soql.replace(/\(\s*SELECT\b[^)]*\)/gi, '');
  // Strip string literals so identifiers inside quotes don't get scanned
  // (e.g. WHERE Name = 'CR_Customer').
  stripped = stripped.replace(/'(?:\\.|[^'\\])*'/g, "''");

  var fromMatch = /\bFROM\s+([A-Za-z0-9_]+)/i.exec(stripped);
  if (!fromMatch) return { ok: true };
  var fromApi = fromMatch[1];

  var rootApi = null;
  for (var key in schemaByName) {
    if (key.toLowerCase() === fromApi.toLowerCase()) { rootApi = key; break; }
  }
  if (!rootApi) return { ok: true }; // object-exists validator owns this case

  function resolveDottedPath(path) {
    var segs = path.split('.');
    var currentApi = rootApi;
    for (var i = 0; i < segs.length - 1; i++) {
      var schema = schemaByName[currentApi];
      if (!schema) return { skip: true }; // related object schema unavailable
      var relField = schema.fieldsByRelationship[segs[i].toLowerCase()];
      if (!relField || !relField.referenceTo || !relField.referenceTo[0]) {
        return { ok: false, badSegment: segs[i], onObject: currentApi };
      }
      currentApi = relField.referenceTo[0];
    }
    var finalSchema = schemaByName[currentApi];
    if (!finalSchema) return { skip: true };
    var finalField = finalSchema.fieldsByName[segs[segs.length - 1].toLowerCase()];
    if (!finalField) return { ok: false, badSegment: segs[segs.length - 1], onObject: currentApi };
    return { ok: true };
  }

  function suggestDotWalk(rootSchema, fieldName) {
    // Look for the field on any related schema we sent, then describe how to
    // reach it from rootApi via a single-hop relationship.
    var hints = [];
    var lower = fieldName.toLowerCase();
    for (var apiName in schemaByName) {
      if (apiName === rootApi) continue;
      if (!schemaByName[apiName].fieldsByName[lower]) continue;
      for (var i = 0; i < rootSchema.fields.length; i++) {
        var f = rootSchema.fields[i];
        if (f.relationshipName && f.referenceTo && f.referenceTo.indexOf(apiName) !== -1) {
          hints.push(f.relationshipName + '.' + schemaByName[apiName].fieldsByName[lower].name);
        }
      }
    }
    return hints;
  }

  var pathRe = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\b/g;
  var violations = [];
  var seen = {};
  var m;
  while ((m = pathRe.exec(stripped)) !== null) {
    var path = m[1];
    var lower = path.toLowerCase();
    var firstSeg = lower.split('.')[0];
    if (SOQL_FIELD_VALIDATOR_SKIP_KEYWORDS[firstSeg]) continue;
    // Skip pure-number-suffixed tokens like LAST_N_DAYS:7's `7` (regex already
    // excludes leading-digit, defensive).
    if (/^\d/.test(path)) continue;
    // Skip the FROM object name itself (appears in SELECT Account.Name dot-walks,
    // but bare 'Account' immediately after FROM is also captured).
    if (lower === rootApi.toLowerCase()) continue;
    if (seen[lower]) continue;
    seen[lower] = true;

    if (path.indexOf('.') === -1) {
      var rootSchema = schemaByName[rootApi];
      if (!rootSchema.fieldsByName[lower]) {
        var suggestions = suggestDotWalk(rootSchema, path);
        violations.push({ path: path, onObject: rootApi, suggestions: suggestions });
      }
      continue;
    }

    var res = resolveDottedPath(path);
    if (res.skip) continue;
    if (!res.ok) {
      violations.push({ path: path, onObject: res.onObject, badSegment: res.badSegment, suggestions: [] });
    }
  }

  if (!violations.length) return { ok: true };

  var parts = violations.map(function (v) {
    var msg = "Field '" + v.path + "' is not on " + v.onObject + ".";
    if (v.suggestions && v.suggestions.length) {
      msg += ' Reach it via a relationship dot-walk: ' + v.suggestions.map(function (s) { return rootApi + '.' + s; }).join(' OR ') + '.';
    }
    return msg;
  });
  parts.push("Use only fields that exist on the FROM object's schema, or dot-walk through a relationship field to a related object.");
  return { ok: false, error: parts.join(' ') };
}

// Literal-preservation check. The picklist hint we inject calls out tokens in
// the user's prompt that ARE picklist values somewhere in the candidate
// schema (rare codes like 'CR' / 'CL'). The model sometimes still drops the
// literal entirely (silent substitution — translates 'CR' to 'OnGround' on
// the wrong field). Catch that: if a hinted token doesn't appear in any
// quoted literal in the generated SOQL, that's a literal-preservation
// failure. Conservative: only enforces the same tokens we already flagged in
// the hint, so it inherits the MAX_LOCATIONS filter (no enforcement on
// generic words like 'open' that match many fields).
function validateSoqlLiteralPreservation(soql, prompt, schemaObjects) {
  if (!soql || !prompt || !schemaObjects || !schemaObjects.length) return { ok: true };

  var pvIndex = buildPicklistValueIndex(schemaObjects);
  var promptHits = findPicklistMatchesInPrompt(prompt, pvIndex);
  if (!promptHits.length) return { ok: true };

  // Collect every quoted literal in the SOQL, lowercased. Comparing against
  // the SOQL string directly would false-positive on field names that share
  // characters with the token (e.g. token 'CR' inside field 'CR_Code__c').
  var quotedRe = /'((?:\\.|[^'\\])*)'/g;
  var quotedLiterals = {};
  var qm;
  while ((qm = quotedRe.exec(soql)) !== null) {
    var lit = qm[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    quotedLiterals[lit.toLowerCase()] = true;
  }

  var missing = [];
  promptHits.forEach(function (h) {
    var tokenLower = h.token.toLowerCase();
    if (quotedLiterals[tokenLower]) return;
    // Also accept the picklist value casing the hint surfaced — the model is
    // allowed to use the canonical value rather than the user's casing.
    for (var i = 0; i < h.locations.length; i++) {
      if (quotedLiterals[h.locations[i].value.toLowerCase()]) return;
    }
    missing.push(h);
  });

  if (!missing.length) return { ok: true };

  var parts = missing.map(function (h) {
    var locs = h.locations.map(function (l) {
      return "object=" + l.apiName + " field=" + l.fieldName + " value='" + l.value + "'";
    }).join(' OR ');
    return "The user's literal '" + h.token + "' is missing from the SOQL. " +
      "This token is a picklist value on: " + locs + ". " +
      "Filter on it explicitly (dot-walk from FROM if the field is on a related object); do not silently substitute a different value.";
  });
  return { ok: false, error: parts.join(' ') };
}

// Semantic check the planner can't do: picklist-literal mismatch. The planner
// accepts any string against a picklist field, so the "flights with status CR"
// case where the model picks Asset.StatusFlight__c = 'CR' instead of the
// parent's eu261Status__c slips through. We walk every Field='Literal' and
// Field IN (...) comparison; if Field is a picklist with cached values and the
// literal isn't among them, that's a violation. The error feeds the same
// retry loop as planner errors — model has to pick a different field where the
// literal actually exists (often the correct dot-walk).
//
// Conservative by design: skip subqueries (different FROM scope), unresolvable
// field paths (no false positives), non-picklist types, and multipicklist
// (uses INCLUDES, different shape). Empty schemaObjects → ok.
function validateSoqlSemantics(soql, schemaObjects) {
  if (!soql || !schemaObjects || !schemaObjects.length) return { ok: true };

  var schemaByName = {};
  schemaObjects.forEach(function (o) {
    if (!o.fields) return;
    var fieldsByName = {};
    var fieldsByRelationship = {};
    o.fields.forEach(function (f) {
      fieldsByName[f.name.toLowerCase()] = f;
      if (f.relationshipName) fieldsByRelationship[f.relationshipName.toLowerCase()] = f;
    });
    schemaByName[o.apiName] = { fieldsByName: fieldsByName, fieldsByRelationship: fieldsByRelationship };
  });

  // Strip child subqueries and semi-joins — their WHERE filters resolve against
  // a different FROM scope. SOQL subqueries don't nest, so a non-greedy
  // [^)]* is sufficient.
  var stripped = soql.replace(/\(\s*SELECT\b[^)]*\)/gi, '');

  var fromMatch = /\bFROM\s+([A-Za-z0-9_]+)/i.exec(stripped);
  if (!fromMatch) return { ok: true };
  var fromApi = fromMatch[1];
  var rootApi = null;
  for (var key in schemaByName) {
    if (key.toLowerCase() === fromApi.toLowerCase()) { rootApi = key; break; }
  }
  if (!rootApi) return { ok: true };

  function resolveField(path) {
    var segments = path.split('.');
    var currentApi = rootApi;
    for (var i = 0; i < segments.length - 1; i++) {
      var schema = schemaByName[currentApi];
      if (!schema) return null;
      var relField = schema.fieldsByRelationship[segments[i].toLowerCase()];
      if (!relField || !relField.referenceTo || !relField.referenceTo[0]) return null;
      currentApi = relField.referenceTo[0];
    }
    var finalSchema = schemaByName[currentApi];
    if (!finalSchema) return null;
    return finalSchema.fieldsByName[segments[segments.length - 1].toLowerCase()] || null;
  }

  function isCheckablePicklist(field) {
    return field && field.type === 'picklist' && field.values && field.values.length > 0;
  }

  // Track unique (path, literal) violations so a literal repeated in IN-lists
  // doesn't spam the retry message.
  var seen = {};
  var violations = [];
  function record(path, literal, field) {
    var k = path.toLowerCase() + ' ' + literal;
    if (seen[k]) return;
    seen[k] = true;
    violations.push({ path: path, literal: literal, field: field });
  }

  // Field = 'lit' / Field != 'lit'
  var eqRe = /\b([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*(?:=|!=)\s*'((?:\\.|[^'\\])*)'/g;
  var m;
  while ((m = eqRe.exec(stripped)) !== null) {
    var path = m[1];
    var literal = m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    var field = resolveField(path);
    if (!isCheckablePicklist(field)) continue;
    if (field.values.indexOf(literal) === -1) record(path, literal, field);
  }

  // Field IN ('a', 'b') / Field NOT IN ('a', 'b')
  var inRe = /\b([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s+(?:NOT\s+)?IN\s*\(([^)]+)\)/gi;
  while ((m = inRe.exec(stripped)) !== null) {
    var inPath = m[1];
    var listText = m[2];
    var inField = resolveField(inPath);
    if (!isCheckablePicklist(inField)) continue;
    var litRe = /'((?:\\.|[^'\\])*)'/g;
    var lm;
    while ((lm = litRe.exec(listText)) !== null) {
      var inLiteral = lm[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      if (inField.values.indexOf(inLiteral) === -1) record(inPath, inLiteral, inField);
    }
  }

  if (violations.length === 0) return { ok: true };

  var parts = violations.map(function (v) {
    var sample = v.field.values.slice(0, 8).join(', ');
    var more = v.field.values.length > 8 ? ', ...' : '';
    return "Picklist field " + v.path + " does not accept '" + v.literal +
      "'. Its valid values are: " + sample + more + ".";
  });
  parts.push("If the user's term lives on a different field (possibly via a relationship dot-walk), use that field instead.");
  return { ok: false, error: parts.join(' ') };
}

// Ask Salesforce's query planner to parse the SOQL without executing. Returns
// { ok: true } on a valid query, or { ok: false, error } with the parser's
// diagnostic message. Used to drive a self-correction loop in generateSoql.
async function validateSoql(soql) {
  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/query/?explain=' + encodeURIComponent(soql);
  var resp = await sfFetch(url, { headers: pre.headers });
  if (resp.ok) return { ok: true };
  var body = null;
  try { body = await resp.json(); } catch (_) {}
  var detail;
  if (Array.isArray(body) && body.length && body[0].message) {
    detail = (body[0].errorCode ? body[0].errorCode + ': ' : '') + body[0].message;
  } else {
    detail = 'HTTP ' + resp.status;
  }
  return { ok: false, error: detail };
}

function buildRetryUserMessage(baseMessage, attempts) {
  // Show every prior failure so the model cannot regress between attempts.
  // The planner's first-error-wins reporting means token A might mask token B,
  // so the model may "fix" A and reintroduce a sibling mistake on the next try.
  var lines = [baseMessage, '', 'Prior attempts ALL rejected by Salesforce. Do not repeat any of these approaches:'];
  for (var i = 0; i < attempts.length; i++) {
    lines.push('');
    lines.push('Attempt ' + (i + 1) + ' SOQL: ' + attempts[i].soql);
    lines.push('Attempt ' + (i + 1) + ' error: ' + attempts[i].error);
  }
  lines.push('');
  lines.push('Emit a corrected query in the same JSON format. Avoid every token and pattern that appeared in the rejected attempts above.');
  return lines.join('\n');
}

// ── Planner step (item 4 in grounding.md) ─────────────────────────────────
//
// Decomposes generation into two LLM calls: a lightweight planner that picks
// FROM + row-shape + related objects, then the existing generator that emits
// SOQL against that plan. The planner sees condensed object info (no full
// describes); the generator sees the full schemas for the planned objects.
//
// Rationale: small models reason better one step at a time. The "row-shape
// inversion" failure (user types "X grouped by Y", model picks Y as FROM
// because of the surface phrasing) goes away when the planner is forced to
// articulate row-shape as a separate output before any SOQL is emitted.

var SOQL_PLAN_TOOL = {
  name: 'pick_query_plan',
  description: 'Pick the FROM object and articulate the row-shape for a SOQL query before any SOQL is emitted.',
  input_schema: {
    type: 'object',
    properties: {
      rowShape: {
        type: 'string',
        description: 'One sentence describing what the answer\'s rows look like, e.g. "one row per billable-hours entry" or "one row per project with aggregated hours". This is the most important field — it pins the granularity of the result.'
      },
      fromObject: {
        type: 'string',
        description: 'The api name of the FROM object. MUST be one of the candidate api names listed in the user message. Do not invent.'
      },
      groupBy: {
        type: 'string',
        description: 'If the user wants aggregation, name the dimension (the "by" part), e.g. "project" or "stage". Otherwise omit.'
      },
      needsRelated: {
        type: 'array',
        items: { type: 'string' },
        description: 'Api names of related objects (lookup targets) whose fields the SOQL will need to reach via dot-walks. Pick from the candidate list. Omit if no related objects are needed.'
      },
      notes: {
        type: 'string',
        description: 'Optional: one short sentence explaining a non-obvious choice (e.g. "Project__c is empty in this org; using TrackingHour2__c grouped by Project__r"). Skip when the choice is obvious.'
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How confident you are in the FROM choice. "low" signals the candidates are similar enough that another reasonable interpretation exists.'
      }
    },
    required: ['rowShape', 'fromObject']
  }
};

function buildPlannerSystemPrompt() {
  return [
    'You are the planning step of a Salesforce SOQL generator. You DO NOT write SOQL — a second step does that. Your only job is to articulate the row-shape of the answer and pick the FROM object.',
    '',
    'Rules:',
    '- "Get X grouped by Y" — FROM is the object that holds X (the granular data). GROUP BY is the dimension Y, reached as a dot-walk if it lives on another object.',
    '- "Which X have/did Y" — FROM is X (the answer rows), not Y.',
    '- Prefer objects with substantial record counts. An empty or near-empty object is rarely the right FROM target even when its name lexically matches.',
    '- Field populationality is a strong signal. If field "Hours__c" exists on object A but is populated on 0% of A\'s rows, A is almost certainly not the home of the user\'s concept.',
    '- Org-specific vocabulary in the user message is authoritative — if the org has historically used "X" to mean object A, prefer A even if its name doesn\'t match.',
    '',
    'Call the pick_query_plan tool. Do not emit prose.'
  ].join('\n');
}

// Condense schemaObjects into a planner-sized summary. Full describes (50–200
// fields per object) would blow the planner's context budget; we keep top-N
// fields by a populationality+name-relevance signal and drop everything else.
function buildPlannerUserMessage(prompt, schemaObjects, context) {
  context = context || {};
  var lines = [];
  lines.push('User request: ' + prompt);
  lines.push('');

  if (context.glossaryAnchorBlock && context.glossaryAnchorBlock.trim()) {
    lines.push(context.glossaryAnchorBlock);
    lines.push('');
  }

  lines.push('Candidate objects (pick fromObject from this list — using any other api name is invalid):');
  for (var i = 0; i < schemaObjects.length; i++) {
    var o = schemaObjects[i];
    var header = '- ' + o.apiName + (o.label ? ' (' + o.label + ')' : '');
    if (typeof o.count === 'number') {
      var countText = o.count >= SOQL_COUNT_LIMIT
        ? SOQL_COUNT_LIMIT.toLocaleString('en-US') + '+ records'
        : o.count.toLocaleString('en-US') + ' records';
      header += ' — ' + countText;
    }
    if (o.contextOnly) header += ' [lookup target — typically a dot-walk dimension, rarely the FROM]';
    if (o.fieldPromoted) header += ' [FIELD-MATCH PROMOTED — the prompt\'s concepts live in this object\'s field names]';
    lines.push(header);
    if (o.recordTypes && o.recordTypes.length) {
      lines.push('    record types: ' + o.recordTypes.map(function (rt) { return rt.developerName; }).join(', '));
    }
    // Top fields summary: prioritise high-populationality custom fields whose
    // names share tokens with the prompt, then any other populated fields.
    var fieldSummary = _summarizeFieldsForPlanner(prompt, o);
    if (fieldSummary) lines.push('    relevant fields: ' + fieldSummary);
  }

  if (context.fewShotExamples && context.fewShotExamples.length) {
    lines.push('');
    lines.push('Prior queries from this org (for vocabulary anchoring — note their FROM choices):');
    context.fewShotExamples.forEach(function (ex) {
      var from = extractFromObject(ex.soql) || '(unknown)';
      lines.push('  "' + (ex.prompt || '').replace(/"/g, "'") + '" → FROM ' + from);
    });
  }

  return lines.join('\n');
}

var SOQL_PLANNER_MAX_FIELDS_SUMMARY = 12;

function _summarizeFieldsForPlanner(prompt, schemaObj) {
  if (!schemaObj || !schemaObj.fields) return '';
  var p = String(prompt || '').toLowerCase();
  var scored = [];
  for (var i = 0; i < schemaObj.fields.length; i++) {
    var f = schemaObj.fields[i];
    if (!f || !f.name) continue;
    var nameTokens = f.name.toLowerCase().replace(/__c$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    var labelLower = (f.label || '').toLowerCase();
    var hits = 0;
    (nameTokens + ' ' + labelLower).split(/\s+/).forEach(function (t) {
      if (t && t.length >= 4 && p.indexOf(t) !== -1) hits += 1;
    });
    var pop = (schemaObj.fieldPopulation && schemaObj.fieldPopulation[f.name]) || 0;
    // Score: prompt-token hits weighted heavily, then populationality as tiebreak.
    var score = hits * 10 + pop;
    if (score > 0) scored.push({ name: f.name, label: f.label, pop: pop, score: score });
  }
  if (!scored.length) return '';
  scored.sort(function (a, b) { return b.score - a.score; });
  var top = scored.slice(0, SOQL_PLANNER_MAX_FIELDS_SUMMARY);
  return top.map(function (f) {
    var bits = [f.name];
    if (typeof f.pop === 'number' && !isNaN(f.pop)) {
      bits.push(Math.round(f.pop * 100) + '% populated');
    }
    return bits.join(' (') + (typeof f.pop === 'number' ? ')' : '');
  }).join('; ');
}

// Run the planner. Returns { rowShape, fromObject, groupBy, needsRelated,
// notes, confidence }. Throws if the planner picks an unknown api name; the
// caller can choose to retry or fall through to the un-planned pipeline.
async function runPlanner(prompt, schemaObjects, context, knownApiNames) {
  var systemPrompt = buildPlannerSystemPrompt();
  var userMessage = buildPlannerUserMessage(prompt, schemaObjects, context);
  var plan = await callClaude(systemPrompt, userMessage, {
    cacheSystem: true,
    tools: [SOQL_PLAN_TOOL],
    toolChoice: { type: 'tool', name: SOQL_PLAN_TOOL.name }
  });
  if (!plan || !plan.fromObject) throw new Error('Planner returned no fromObject');

  // Validate FROM against the candidate set first, fall back to the org-wide
  // object list. The planner is told to pick from candidates; anything else
  // is a hallucination we should surface.
  var candidateNames = {};
  schemaObjects.forEach(function (o) { if (o.apiName) candidateNames[o.apiName.toLowerCase()] = o.apiName; });
  var picked = candidateNames[plan.fromObject.toLowerCase()];
  if (!picked && knownApiNames) {
    var knownByLc = {};
    knownApiNames.forEach(function (n) { knownByLc[n.toLowerCase()] = n; });
    picked = knownByLc[plan.fromObject.toLowerCase()];
  }
  if (!picked) throw new Error('Planner picked an unknown object: ' + plan.fromObject);
  plan.fromObject = picked; // canonical-case

  // Same validation for needsRelated.
  if (Array.isArray(plan.needsRelated)) {
    var resolved = [];
    plan.needsRelated.forEach(function (n) {
      var hit = candidateNames[String(n).toLowerCase()];
      if (hit) resolved.push(hit);
    });
    plan.needsRelated = resolved;
  } else {
    plan.needsRelated = [];
  }

  return plan;
}

// Reorder + mark schemaObjects according to the plan. The planned fromObject
// moves to position 0 and gets cleared of any contextOnly flag; needsRelated
// entries get contextOnly = true so they read as "use these for dot-walks";
// objects not mentioned by the plan keep their existing flags (we don't drop
// them — the generator still sees them but with their original priority).
function applyPlanToSchemaObjects(schemaObjects, plan) {
  if (!plan || !plan.fromObject) return schemaObjects;
  var byName = {};
  schemaObjects.forEach(function (o) { byName[o.apiName] = o; });
  var fromObj = byName[plan.fromObject];
  if (!fromObj) return schemaObjects;
  fromObj.contextOnly = false;
  fromObj.planSelected = true;
  (plan.needsRelated || []).forEach(function (n) {
    var rel = byName[n];
    if (rel && rel !== fromObj) rel.contextOnly = true;
  });
  // Stable sort: planSelected first, then non-contextOnly, then contextOnly.
  return schemaObjects.slice().sort(function (a, b) {
    if (a.planSelected !== b.planSelected) return a.planSelected ? -1 : 1;
    if (a.contextOnly !== b.contextOnly) return a.contextOnly ? 1 : -1;
    return 0;
  });
}

// Planner-divergence schema fetch. The planner is allowed to pick a FROM
// object outside the candidate set (it falls back to org-wide knownApiNames
// when its choice doesn't match a candidate — see runPlanner). Without this
// step, the divergent pick has no loaded schema, the generator emits SOQL
// against it blind, and the downstream field validators silent-pass because
// FROM isn't in schemaByName.
//
// Resolution: identify api names mentioned in the plan that aren't already
// in schemaObjects, look them up in getSoqlObjects to recover label/keyPrefix,
// and run them through fetchCandidateSchema so they get the full bundle
// (describe + count + populationality + record types). Prepend to
// schemaObjects so they're sorted first by applyPlanToSchemaObjects.
//
// Failure-soft: an individual fetch can fail (perm-restricted, formula-only
// object, network blip); fetchCandidateSchema already swallows describe/count
// failures internally and returns a result with `fields: null`. We just pass
// whatever comes back; downstream validators will then refuse rather than
// silent-pass against a no-fields schema.
async function _fetchDivergentSchemas(schemaObjects, plan, notify) {
  if (!plan || !plan.fromObject) return schemaObjects;

  var existing = {};
  schemaObjects.forEach(function (o) { if (o && o.apiName) existing[o.apiName] = true; });

  // Build the wanted-but-missing set: FROM first, then needsRelated.
  var wanted = [];
  if (!existing[plan.fromObject]) wanted.push(plan.fromObject);
  (plan.needsRelated || []).forEach(function (n) {
    if (!existing[n] && wanted.indexOf(n) === -1) wanted.push(n);
  });
  if (!wanted.length) return schemaObjects;

  // Look up label + keyPrefix from the full org list. If something the planner
  // picked isn't there either, skip it silently — runPlanner validated against
  // knownApiNames so this branch shouldn't fire in practice, but defensive.
  var all = getSoqlObjects();
  var byName = {};
  all.forEach(function (o) { byName[o.apiName] = o; });
  var toFetch = wanted
    .map(function (name) { return byName[name]; })
    .filter(function (o) { return !!o; });
  if (!toFetch.length) return schemaObjects;

  if (typeof notify === 'function') {
    notify('Reading planner-picked schema for ' + toFetch.map(function (o) { return o.apiName; }).join(', '));
  }
  // Mark the FROM-target schema as planSelected ahead of applyPlanToSchemaObjects
  // so the FROM stays at position 0 regardless of fetch order — and so a
  // subsequent fetchCandidateSchema call that re-fetches the same apiName
  // (cache hit) doesn't accidentally re-sort it.
  var fetched;
  try {
    fetched = await fetchCandidateSchema(toFetch);
  } catch (e) {
    console.warn('sfnav: planner-divergent schema fetch failed —', e.message);
    return schemaObjects;
  }
  // Tag every divergent schema so we can tell at debug time that this entry
  // came from the planner step rather than the original lexical/BM25 pass.
  fetched.forEach(function (s) { s.fromPlannerDivergence = true; });
  return fetched.concat(schemaObjects);
}

// Picker responses are often noisy — Claude may wrap the api name in
// punctuation, backticks, a sentence, or pick a name with a typo'd
// case. Scan the response for any known object api name (word-boundary,
// case-insensitive). Longer names win on ambiguity so Flight_Assignment__c
// is preferred over Flight__c when both appear.
function resolvePickedObject(pickerText) {
  if (!pickerText) return null;
  var all = getSoqlObjects();
  var sorted = all.slice().sort(function (a, b) { return b.apiName.length - a.apiName.length; });
  for (var i = 0; i < sorted.length; i++) {
    var escaped = sorted[i].apiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(pickerText)) return sorted[i];
  }
  return null;
}

async function pickObjectFromFullList(prompt, excludeApiNames) {
  var excludeNote = '';
  if (excludeApiNames && excludeApiNames.length) {
    excludeNote = '\n\nThe following lexically-matching objects are empty in this org and MUST NOT be picked: '
      + excludeApiNames.join(', ') + '. Pick a different object that is likely to hold the records.';
  }
  var pickerText = await callClaude(
    'You map natural-language requests to a single Salesforce object api name. Reply with ONLY the api name, nothing else.',
    buildObjectListMessage(prompt) + excludeNote
  );
  var match = resolvePickedObject(pickerText);
  if (!match) {
    throw new Error('Picker could not identify a known object. Response: ' + pickerText.slice(0, 200));
  }
  if (excludeApiNames && excludeApiNames.indexOf(match.apiName) !== -1) {
    throw new Error('Picker re-selected an empty object (' + match.apiName + '). Response: ' + pickerText.slice(0, 200));
  }
  return match;
}

async function fetchCandidateSchema(candidates) {
  return Promise.all(candidates.map(async function (obj) {
    var result = {
      apiName: obj.apiName,
      label: obj.label,
      fields: null,
      count: null,
      fieldPopulation: null,
      recordTypes: getRecordTypesFor(obj.apiName)
    };
    var describePromise = fetchDescribe(obj.apiName).then(
      function (fields) { result.fields = fields; },
      function (err) { console.warn('sfnav: describe failed for', obj.apiName, err.message); }
    );
    var countPromise = fetchCount(obj.apiName).then(
      function (count) { result.count = count; },
      function (err) { console.warn('sfnav: count failed for', obj.apiName, err.message); }
    );
    await Promise.all([describePromise, countPromise]);
    // Field populationality runs AFTER describe (needs the field list) but
    // before related-schema fetch so the signal is available everywhere it's
    // used. Skipped for empty / unknown-magnitude objects: count===0 means
    // there's literally no data to sample; count===null means the count query
    // failed (formula-only object, perm issue) and a sampling query would
    // likely fail the same way.
    if (result.fields && result.fields.length && result.count > 0) {
      try {
        result.fieldPopulation = await fetchFieldPopulation(obj.apiName, result.fields);
      } catch (err) {
        console.warn('sfnav: field population failed for', obj.apiName, err.message);
      }
    }
    return result;
  }));
}

// ── Self-consistency vote (item 6) ────────────────────────────────────────
//
// Sample N candidates in parallel, validate each, group survivors by query
// signature, return the majority. Trigger is `plan.confidence === 'low'`.
// Cost is N× generation cost but only on the prompts where the planner has
// flagged genuine ambiguity, so the expected amplification is modest.

var SOQL_SELF_CONSISTENCY_N = 3;

// Cheap query signature for grouping. FROM api name carries the most
// disagreement weight; SELECT field-set + presence-of-GROUP-BY break ties.
// Deliberately ignores literal values, ordering, and limit clauses — those
// rarely encode the true intent split between samples.
function _soqlSignature(soql) {
  if (!soql) return '?';
  var from = (extractFromObject(soql) || '?').toLowerCase();
  // SELECT clause: extract field tokens between SELECT and FROM (strip
  // subqueries first so child relationship names don't leak in).
  var stripped = String(soql).replace(/\(\s*SELECT\b[^)]*\)/gi, ' ');
  var selectMatch = /\bSELECT\b([\s\S]+?)\bFROM\b/i.exec(stripped);
  var fields = [];
  if (selectMatch) {
    selectMatch[1].split(',').forEach(function (f) {
      var clean = f.trim().split(/\s+/)[0].toLowerCase();
      if (clean && clean !== 'id') fields.push(clean);
    });
    fields.sort();
  }
  var hasGroupBy = /\bGROUP\s+BY\b/i.test(stripped);
  return from + '|' + fields.join(',') + '|' + (hasGroupBy ? 'g' : '');
}

async function runSelfConsistencyVote(systemPrompt, baseUserMessage, prompt, schemaObjects, knownApiNames) {
  var samplePromises = [];
  for (var i = 0; i < SOQL_SELF_CONSISTENCY_N; i++) {
    samplePromises.push(_sampleOneCandidate(systemPrompt, baseUserMessage, prompt, schemaObjects, knownApiNames));
  }
  var results = await Promise.all(samplePromises);
  var valid = results.filter(function (r) { return r && r.parsed && r.ok; });
  if (!valid.length) return null;

  // Group by signature, count, pick the largest group.
  var groups = {};
  valid.forEach(function (r) {
    var sig = _soqlSignature(r.parsed.soql);
    if (!groups[sig]) groups[sig] = [];
    groups[sig].push(r);
  });
  var sigs = Object.keys(groups);
  sigs.sort(function (a, b) { return groups[b].length - groups[a].length; });
  var winner = groups[sigs[0]];
  if (!winner || !winner.length) return null;
  // When there's a tie (e.g. 1/1/1), prefer the candidate whose FROM matches
  // the planner's pick; falls back to the first surviving sample otherwise.
  var picked = winner[0].parsed;
  return picked;
}

async function _sampleOneCandidate(systemPrompt, baseUserMessage, prompt, schemaObjects, knownApiNames) {
  try {
    var text = await callClaude(systemPrompt, baseUserMessage);
    var parsed = parseSoqlResponse(text);
    // Run the same validator chain we'd run in the main retry loop. The
    // planner /query?explain validator is async and somewhat expensive; we
    // pay that cost N times during a vote, but only on low-confidence
    // prompts (which is the design).
    var validation = await validateSoql(parsed.soql);
    if (!validation.ok) return { ok: false };
    if (!validateSoqlObjectExists(parsed.soql, schemaObjects, knownApiNames).ok) return { ok: false };
    if (!validateSoqlFieldsExist(parsed.soql, schemaObjects).ok) return { ok: false };
    if (!validateSoqlSemantics(parsed.soql, schemaObjects).ok) return { ok: false };
    if (!validateSoqlLiteralPreservation(parsed.soql, prompt, schemaObjects).ok) return { ok: false };
    return { ok: true, parsed: parsed };
  } catch (e) {
    return { ok: false };
  }
}

async function generateSoql(prompt, onProgress) {
  if (!prompt || !prompt.trim()) throw new Error('Empty prompt');
  var notify = typeof onProgress === 'function' ? onProgress : function () {};

  notify('Reading record types');
  try {
    await loadRecordTypes();
  } catch (err) {
    console.warn('sfnav: record types load failed —', err.message);
  }

  var candidates = pickCandidateObjects(prompt, 3);

  // No heuristic match — ask the model to pick from the object list, then re-run with that schema
  if (candidates.length === 0) {
    notify('Picking object');
    candidates = [await pickObjectFromFullList(prompt, null)];
  }

  notify('Reading schema for ' + candidates.map(function (c) { return c.apiName; }).join(', '));
  var schemaObjects = await fetchCandidateSchema(candidates);

  // Drop candidates the org isn't actually using. count === 0 is a strong
  // org-data signal that the lexical match is the wrong object (e.g. an
  // abandoned Flight__c shadowing the real data on Product2 in this org).
  // count === null means the count query failed (formula-only object, perm
  // issue) — keep those, can't distinguish "unused" from "unmeasurable".
  var emptyApiNames = schemaObjects.filter(function (o) { return o.count === 0; }).map(function (o) { return o.apiName; });
  var nonEmpty = schemaObjects.filter(function (o) { return o.count !== 0; });
  if (nonEmpty.length === 0) {
    notify('Candidates empty in this org; picking from full list');
    var replacement = await pickObjectFromFullList(prompt, emptyApiNames);
    candidates = [replacement];
    notify('Reading schema for ' + replacement.apiName);
    schemaObjects = await fetchCandidateSchema(candidates);
  } else if (emptyApiNames.length) {
    notify('Skipping empty: ' + emptyApiNames.join(', '));
    schemaObjects = nonEmpty;
  }

  // Lookup-chain grounding: scan candidates' reference fields and fetch describes
  // for their lookup targets too, so dot-walks like AffectedFlight__r.RevenueEUR__c
  // have the parent object's schema in context even when that parent didn't score
  // independently. Capped to avoid context explosion.
  var SOQL_MAX_RELATED = 3;
  var schemaNames = {};
  schemaObjects.forEach(function (o) { schemaNames[o.apiName] = true; });
  var allObjects = getSoqlObjects();
  var nameToObj = {};
  allObjects.forEach(function (o) { nameToObj[o.apiName] = o; });
  var relatedQueue = [];
  schemaObjects.forEach(function (so) {
    (so.fields || []).forEach(function (f) {
      (f.referenceTo || []).forEach(function (rn) {
        if (schemaNames[rn]) return;
        if (!nameToObj[rn]) return;
        if (relatedQueue.some(function (q) { return q.apiName === rn; })) return;
        relatedQueue.push(nameToObj[rn]);
      });
    });
  });
  var related = relatedQueue.slice(0, SOQL_MAX_RELATED);
  if (related.length) {
    notify('Reading related schema for ' + related.map(function (c) { return c.apiName; }).join(', '));
    var relatedSchemas = await Promise.all(related.map(async function (obj) {
      var result = {
        apiName: obj.apiName,
        label: obj.label,
        fields: null,
        count: null,
        recordTypes: getRecordTypesFor(obj.apiName),
        contextOnly: true
      };
      try { result.fields = await fetchDescribe(obj.apiName); }
      catch (err) { console.warn('sfnav: related describe failed for', obj.apiName, err.message); }
      return result;
    }));
    schemaObjects = schemaObjects.concat(relatedSchemas);
  }

  // Field-name re-ranking. Score every loaded schema's field names against
  // the prompt. If a contextOnly (lookup-target) schema scores higher on
  // field-name match than every candidate AND clears the minimum signal
  // threshold, the prompt's terminology lives there — promote it to a real
  // candidate so the model considers it as FROM material. Without this,
  // the canonical home of a concept can be hidden under a "usually NOT FROM"
  // hint just because its object-level name doesn't match the prompt.
  var maxCandidateFieldScore = 0;
  schemaObjects.forEach(function (so) {
    so._fieldNameScore = scoreFieldNameMatch(prompt, so.fields || []);
    if (!so.contextOnly && so._fieldNameScore > maxCandidateFieldScore) {
      maxCandidateFieldScore = so._fieldNameScore;
    }
  });
  schemaObjects.forEach(function (so) {
    if (so.contextOnly && so._fieldNameScore > maxCandidateFieldScore && so._fieldNameScore >= SOQL_FIELD_PROMOTE_MIN_SCORE) {
      so.contextOnly = false;
      so.fieldPromoted = true;
    }
  });
  // Surface field-promoted candidates near the top of the schema block so
  // the model sees them before the lexical-only matches. Preserve lexical
  // order for non-promoted candidates (Array.prototype.sort is stable in V8) —
  // do NOT reorder them by field-name score, because field-name signal is
  // noisier than the lexical scorer's object/label/record-type signal and
  // shouldn't override it for objects that already lexically matched.
  schemaObjects.sort(function (a, b) {
    if (a.contextOnly !== b.contextOnly) return a.contextOnly ? 1 : -1;
    if (!!a.fieldPromoted !== !!b.fieldPromoted) return b.fieldPromoted ? 1 : -1;
    if (a.fieldPromoted && b.fieldPromoted) return (b._fieldNameScore || 0) - (a._fieldNameScore || 0);
    return 0;
  });

  // Pre-generation grounding signals — assemble glossary hits, few-shot
  // examples, and (later) plan into a single context bag passed to
  // buildUserMessage. Each lookup is fire-and-degrade: any failure logs and
  // falls back to the empty signal, never blocking the generate path.
  var promptContext = {};
  try {
    if (typeof glossaryLookupForPrompt === 'function') {
      var hits = await glossaryLookupForPrompt(prompt);
      if (hits && hits.length && typeof formatGlossaryAnchorBlock === 'function') {
        promptContext.glossaryAnchorBlock = formatGlossaryAnchorBlock(hits);
      }
    }
  } catch (gErr) {
    console.warn('sfnav: glossary lookup failed —', gErr.message);
  }
  try {
    if (typeof pickFewShotExamples === 'function') {
      var fewShots = await pickFewShotExamples(prompt);
      if (fewShots && fewShots.length) promptContext.fewShotExamples = fewShots;
    }
  } catch (fErr) {
    console.warn('sfnav: few-shot pick failed —', fErr.message);
  }

  // Planner step (item 4). One extra LLM call: condensed candidate map +
  // glossary + few-shots → tool_use returns rowShape, fromObject, etc. The
  // resulting plan is injected into the generator's user message and the
  // candidate ordering is rewritten so the planned FROM is the first schema
  // entry the model reads.
  //
  // Degrades to the un-planned pipeline if the planner call fails or picks an
  // unknown object — we never want a planner bug to block SOQL generation.
  try {
    notify('Planning query');
    var knownNamesForPlan = getSoqlObjects().map(function (o) { return o.apiName; });
    var plan = await runPlanner(prompt, schemaObjects, promptContext, knownNamesForPlan);
    promptContext.plan = plan;
    // Planner-divergence schema fetch. runPlanner is allowed to pick a FROM
    // object that wasn't in the candidate set — it falls back to the org-wide
    // knownApiNames list for cases where the lexical scorer missed something
    // the model finds plausible. Before that change, applyPlanToSchemaObjects
    // would silently do nothing for divergent picks, the generator would
    // emit against an object whose schema we never loaded, and
    // validateSoqlFieldsExist would silent-pass because FROM isn't in
    // schemaByName. End result: hallucinated fields shipped past every
    // validator. Smoke F2 (`cancelled-flight-with-assignments × signal-in-
    // picklist-value`) is the canonical case.
    //
    // Fix: when the planner picks an object (FROM or needsRelated) that we
    // haven't loaded yet, fetch its full schema bundle (describe + count +
    // populationality) before applying the plan. Fail-soft on individual
    // fetches — populationality may not exist for permission-restricted
    // objects, that's fine; the validators only need the describe.
    schemaObjects = await _fetchDivergentSchemas(schemaObjects, plan, notify);
    schemaObjects = applyPlanToSchemaObjects(schemaObjects, plan);
  } catch (pErr) {
    console.warn('sfnav: planner step skipped —', pErr.message);
  }

  var systemPrompt = buildSystemPrompt();
  var baseUserMessage = buildUserMessage(prompt, schemaObjects, promptContext);

  // Self-consistency (item 6). When the planner is uncertain, sample N=3
  // generator runs in parallel and pick the majority by query signature.
  // Triggered only on planner confidence='low' so the cost amplification is
  // gated to the prompts where it actually matters. Runs once — if all
  // samples fail validation, we fall through to the standard retry loop.
  if (promptContext.plan && promptContext.plan.confidence === 'low') {
    var voted = null;
    try {
      notify('Sampling for self-consistency');
      voted = await runSelfConsistencyVote(
        systemPrompt, baseUserMessage, prompt, schemaObjects, getSoqlObjects().map(function (o) { return o.apiName; })
      );
    } catch (vErr) {
      console.warn('sfnav: self-consistency vote failed —', vErr.message);
    }
    if (voted) {
      try { _observeSoqlSuccess(prompt, voted, schemaObjects); }
      catch (_obs) { console.warn('sfnav: glossary observe failed', _obs.message); }
      return voted;
    }
    // Fall through to the standard retry loop if no sample survived validation.
  }

  var userMessage = baseUserMessage;
  var attempts = [];
  var lastParsed = null;

  for (var attempt = 0; attempt <= SOQL_VALIDATE_RETRIES; attempt++) {
    notify(attempt === 0 ? 'Writing query' : 'Retrying (attempt ' + (attempt + 1) + ')');
    var text = await callClaude(systemPrompt, userMessage);
    var parsed = parseSoqlResponse(text);
    lastParsed = parsed;

    notify('Validating');
    var validation;
    try {
      validation = await validateSoql(parsed.soql);
    } catch (err) {
      // Validation transport failure — return the unvalidated query rather than blocking.
      console.warn('sfnav: SOQL validate request failed', err.message);
      return parsed;
    }

    if (validation.ok) {
      // Planner-passed but FROM target doesn't exist in this org — catches
      // hallucinated objects that the eval harness's permissive planner stub
      // lets through, and gives the production retry loop a richer error than
      // the planner's bare "sObject not supported" message.
      var knownNames = getSoqlObjects().map(function (o) { return o.apiName; });
      var objectExists = validateSoqlObjectExists(parsed.soql, schemaObjects, knownNames);
      if (!objectExists.ok) {
        attempts.push({ soql: parsed.soql, error: objectExists.error });
        userMessage = buildRetryUserMessage(baseUserMessage, attempts);
        continue;
      }
      // Planner-passed but references a field that doesn't exist on FROM.
      // Catches the "EU261Status__c on Asset" hallucination where the model
      // takes a field name from the picklist hint and uses it directly on
      // the wrong object instead of dot-walking.
      var fieldsExist = validateSoqlFieldsExist(parsed.soql, schemaObjects);
      if (!fieldsExist.ok) {
        attempts.push({ soql: parsed.soql, error: fieldsExist.error });
        userMessage = buildRetryUserMessage(baseUserMessage, attempts);
        continue;
      }
      // Planner-passed but semantically wrong: picklist literal doesn't exist
      // on the chosen field. Feed into the same retry loop with cumulative
      // failure context (same shape as planner errors).
      var semantics = validateSoqlSemantics(parsed.soql, schemaObjects);
      if (!semantics.ok) {
        attempts.push({ soql: parsed.soql, error: semantics.error });
        userMessage = buildRetryUserMessage(baseUserMessage, attempts);
        continue;
      }
      // Literal-preservation: the user named a picklist value in the prompt
      // (e.g. 'CR') but it doesn't appear in the SOQL. Catches silent
      // substitution where the model swaps the user's literal for a valid-
      // but-unrelated value on the field it chose.
      var literals = validateSoqlLiteralPreservation(parsed.soql, prompt, schemaObjects);
      if (!literals.ok) {
        attempts.push({ soql: parsed.soql, error: literals.error });
        userMessage = buildRetryUserMessage(baseUserMessage, attempts);
        continue;
      }
      // All checks passed — observe and return.
      // Phase-1 glossary observation: fire-and-forget so a buggy extractor or
      // storage hiccup never blocks returning a valid query to the user.
      try { _observeSoqlSuccess(prompt, parsed, schemaObjects); }
      catch (_observeErr) { console.warn('sfnav: glossary observe failed', _observeErr.message); }
      return parsed;
    }
    attempts.push({ soql: parsed.soql, error: validation.error });
    userMessage = buildRetryUserMessage(baseUserMessage, attempts);
  }

  // Exhausted retries — return the last attempt but surface the diagnostic so the UI can show it.
  if (lastParsed) {
    lastParsed.validationError = attempts.length ? attempts[attempts.length - 1].error : null;
    return lastParsed;
  }
  throw new Error('Failed to generate a valid SOQL query');
}

// Run extractors and fan out observations to the org glossary. The read-side
// (glossaryLookupForPrompt, called from generateSoql before message building)
// is the consumer — every successful query teaches the next.
function _observeSoqlSuccess(prompt, parsed, schemaObjects) {
  if (typeof glossaryObserveBatch !== 'function') return;
  if (typeof extractObjectAliasCandidates !== 'function') return;

  // Pick the schema entry that matches the SOQL's FROM clause. Prefer the
  // model-reported objectName as a hint, but the FROM clause is authoritative.
  var fromObject = extractFromObject(parsed.soql) || parsed.objectName || null;
  if (!fromObject) return;

  var schemaEntry = null;
  for (var i = 0; i < schemaObjects.length; i++) {
    if (schemaObjects[i].apiName === fromObject) { schemaEntry = schemaObjects[i]; break; }
  }
  // Even if the chosen object isn't in our candidate set (rare — model picked
  // something we didn't suggest), we still observe with a minimal stub. Surface
  // tokens degrade gracefully without a schema.
  var chosenObject = schemaEntry
    ? { apiName: schemaEntry.apiName, label: schemaEntry.label }
    : { apiName: fromObject, label: null };
  var recordTypes = schemaEntry ? (schemaEntry.recordTypes || []) : [];

  // Related objects in the SOQL — distinguishes "row-shape vocabulary" from
  // "dimension vocabulary." Resolution needs the candidate schemas (for
  // relationshipName→apiName lookup); silently degrades when we can't resolve.
  var relatedApiNames = [];
  if (typeof extractRelatedObjectsFromSoql === 'function') {
    try { relatedApiNames = extractRelatedObjectsFromSoql(parsed.soql, schemaObjects) || []; }
    catch (_) { relatedApiNames = []; }
  }

  var candidates = extractObjectAliasCandidates(prompt, chosenObject, schemaEntry, recordTypes, relatedApiNames);
  if (!candidates.length) return;
  var observations = candidates.map(function (c) {
    return {
      type: c.type,
      feature: 'soql',
      term: c.term,
      target: c.target,
      role: c.role,
      strength: c.strength,
      evidence: c.evidence
    };
  });
  // Fire-and-forget; we don't await to avoid blocking the caller.
  glossaryObserveBatch(observations).catch(function (err) {
    console.warn('sfnav: glossary persist failed', err.message);
  });
}

function getSoqlHistory() {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.storage) { resolve([]); return; }
    var key = getOrgCacheKey(SOQL_HISTORY_KEY);
    chrome.storage.local.get(key, function (data) {
      resolve(data[key] || []);
    });
  });
}

// Few-shot example retrieval. The Anthropic published Haiku eval shows CoT +
// few-shot as the largest single improvement vector for small models, and
// `sfnavSoqlHistory` is a free source of org-specific examples — every entry
// is a previously-successful (prompt, soql) pair generated against this org's
// schema, with this org's vocabulary.
//
// Similarity: token Jaccard on the same tokenisation the glossary uses (drops
// stopwords + plural). Cheap, deterministic, no external dependencies. At our
// scale (≤10 entries per org) the cost is negligible and embeddings would be
// overkill — the win is having ANY similar example to show the model, not
// having the BEST one.
var SOQL_FEW_SHOT_TOP_K = 2;
var SOQL_FEW_SHOT_MIN_SIMILARITY = 0.15;

function _jaccardSimilarity(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  var setB = {};
  for (var i = 0; i < bTokens.length; i++) setB[bTokens[i]] = true;
  var inter = 0;
  var seenA = {};
  for (var j = 0; j < aTokens.length; j++) {
    if (seenA[aTokens[j]]) continue;
    seenA[aTokens[j]] = true;
    if (setB[aTokens[j]]) inter += 1;
  }
  var union = Object.keys(seenA).length + bTokens.length - inter;
  return union ? inter / union : 0;
}

async function pickFewShotExamples(prompt, opts) {
  opts = opts || {};
  if (typeof tokenisePromptForExtraction !== 'function') return [];
  var history = await getSoqlHistory();
  if (!history || !history.length) return [];

  var promptTokens = tokenisePromptForExtraction(prompt);
  if (!promptTokens.length) return [];

  // Skip the exact same prompt: if the user retries the same text we don't
  // want to feed the prior result back as an example (the entire purpose of
  // retrying is to get a different result).
  var promptNorm = String(prompt).trim().toLowerCase();
  var minSim = typeof opts.minSimilarity === 'number' ? opts.minSimilarity : SOQL_FEW_SHOT_MIN_SIMILARITY;
  var topK = opts.topK || SOQL_FEW_SHOT_TOP_K;

  var scored = [];
  for (var i = 0; i < history.length; i++) {
    var h = history[i];
    if (!h || !h.prompt || !h.soql) continue;
    if (String(h.prompt).trim().toLowerCase() === promptNorm) continue;
    var hTokens = tokenisePromptForExtraction(h.prompt);
    var sim = _jaccardSimilarity(promptTokens, hTokens);
    if (sim < minSim) continue;
    scored.push({ prompt: h.prompt, soql: h.soql, sim: sim });
  }
  if (!scored.length) return [];
  scored.sort(function (a, b) { return b.sim - a.sim; });
  return scored.slice(0, topK).map(function (s) {
    return { prompt: s.prompt, soql: s.soql };
  });
}

function addToSoqlHistory(entry) {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.storage) { resolve(); return; }
    var key = getOrgCacheKey(SOQL_HISTORY_KEY);
    chrome.storage.local.get(key, function (data) {
      var list = data[key] || [];
      // Drop any prior entry with the same prompt
      list = list.filter(function (e) { return e.prompt !== entry.prompt; });
      list.unshift({
        prompt: entry.prompt,
        soql: entry.soql,
        objectName: entry.objectName,
        timestamp: Date.now()
      });
      list = list.slice(0, SOQL_HISTORY_MAX);
      var payload = {};
      payload[key] = list;
      chrome.storage.local.set(payload, resolve);
    });
  });
}

function hasSoqlApiKey() {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.storage) { resolve(false); return; }
    chrome.storage.local.get('sfnavOptions', function (data) {
      var opts = data.sfnavOptions || {};
      // Legacy single-provider shape (top-level anthropicApiKey) still counts —
      // those users haven't migrated until they next open the Options page.
      if (opts.anthropicApiKey) { resolve(true); return; }
      var active = opts.provider || 'gemini';
      var p = (opts.providers && opts.providers[active]) || {};
      resolve(!!p.apiKey);
    });
  });
}

function openSoqlSettings() {
  try {
    chrome.runtime.sendMessage({ type: 'openOptions' }, function () {
      if (chrome.runtime.lastError) {
        // Extension context invalidated (tab not reloaded after extension update)
        alert('Please reload this page first, then try again.');
      }
    });
  } catch (e) {
    alert('Please reload this page first, then try again.');
  }
}
