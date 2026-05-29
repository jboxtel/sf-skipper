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
  return scored.slice(0, max || 3).map(function (x) { return x.obj; });
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

function buildUserMessage(prompt, schemaObjects) {
  var lines = [];
  lines.push('User request: ' + prompt);
  lines.push('');
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
        if (f.referenceTo) {
          meta += ' → ' + f.referenceTo.join('|');
          if (f.relationshipName) meta += ' [dot-walk: ' + f.relationshipName + '.<field>]';
        }
        if (f.values) meta += ' [' + f.values.join(',') + ']';
        var line = '  - ' + f.name + ' : ' + meta + (f.label && f.label !== f.name ? ' (' + f.label + ')' : '');
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
  // Find the JSON object even if there's surrounding prose
  var start = cleaned.indexOf('{');
  var end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Could not parse response: ' + text.slice(0, 120));
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
    return result;
  }));
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

  var systemPrompt = buildSystemPrompt();
  var baseUserMessage = buildUserMessage(prompt, schemaObjects);
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

// Run extractors and fan out observations to the org glossary. Phase 1 is
// write-only — nothing reads these entries yet, the v1.1 read-side will. By
// the time the inspector + reads ship, early users already have populated
// glossaries from organic v1.0 use.
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

  var candidates = extractObjectAliasCandidates(prompt, chosenObject, schemaEntry, recordTypes);
  if (!candidates.length) return;
  var observations = candidates.map(function (c) {
    return {
      type: c.type,
      feature: 'soql',
      term: c.term,
      target: c.target,
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
