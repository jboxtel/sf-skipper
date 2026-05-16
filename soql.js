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
var SOQL_COUNT_TTL_MS = 5 * 60 * 1000; // 5 minutes — counts drift faster than schema
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

function pickCandidateObjects(prompt, max) {
  var all = getSoqlObjects();
  var scored = all
    .map(function (o) { return { obj: o, score: soqlScoreObject(prompt, o) }; })
    .filter(function (x) { return x.score > 0; })
    .sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, max || 3).map(function (x) { return x.obj; });
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
    if (f.referenceTo && f.referenceTo.length) compact.referenceTo = f.referenceTo;
    if (f.picklistValues && f.picklistValues.length) {
      compact.values = f.picklistValues.slice(0, 50).map(function (v) { return v.value; });
    }
    if (f.inlineHelpText) compact.helpText = f.inlineHelpText;
    return compact;
  });

  _describeCache[apiName] = { fields: fields, ts: Date.now() };
  return fields;
}

// Record count for an object. Used to bias the model toward the object the org
// actually uses when lexical candidates collide (e.g. Attachment vs EmailMessage
// for "emails with attachments"). Returns null if the object isn't countable —
// some sobjects reject COUNT() (formula-only, non-queryable, etc.) and we'd
// rather omit the field than block generation.
async function fetchCount(apiName) {
  var cached = _countCache[apiName];
  if (cached && (Date.now() - cached.ts) < SOQL_COUNT_TTL_MS) {
    return cached.count;
  }
  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent('SELECT COUNT() FROM ' + apiName);
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
    '- SOQL date functions (DAY_IN_WEEK, DAY_IN_MONTH, CALENDAR_YEAR, HOUR_IN_DAY, FISCAL_QUARTER, etc.) return INTEGERS. Compare them to integer literals only — never to another function, never to a name like FRIDAY. (DAY_IN_WEEK: 1=Sun ... 6=Fri ... 7=Sat. HOUR_IN_DAY: 0-23.)',
    '- The valid SOQL date-literal tokens are limited: TODAY, YESTERDAY, TOMORROW, THIS/LAST/NEXT_WEEK, THIS/LAST/NEXT_MONTH, THIS/LAST/NEXT_QUARTER, THIS/LAST/NEXT_YEAR, THIS/LAST/NEXT_FISCAL_QUARTER, THIS/LAST/NEXT_FISCAL_YEAR, LAST_90_DAYS, NEXT_90_DAYS, and the LAST_N_*/NEXT_N_* family (e.g. LAST_N_DAYS:7). There are NO day-of-week literals (no LAST_FRIDAY) and NO time-of-day literals. Use bare tokens, no quotes.',
    '- Absolute datetimes are unquoted ISO-8601 with timezone: 2024-01-15T18:00:00Z.',
    '- Booleans compare unquoted (HasAttachment = true).',
    '',
    'Semantic preference: for "emails with attachments", use EmailMessage with HasAttachment = true rather than the legacy Attachment object.',
    '',
    'If previous attempts and Salesforce errors are included, the errors are authoritative AND cumulative — every prior attempt failed, so do not repeat any of their approaches. Emit a query that avoids every listed mistake.',
    '',
    'Respond with ONLY a JSON object on a single line, no prose, no code fences:',
    '{"soql":"SELECT ...","objectName":"...","explanation":"one short sentence"}'
  ].join('\n');
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
    if (typeof o.count === 'number') header += ' — ' + o.count.toLocaleString('en-US') + ' records';
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
        if (f.referenceTo) meta += ' → ' + f.referenceTo.join('|');
        if (f.values) meta += ' [' + f.values.join(',') + ']';
        lines.push('  - ' + f.name + ' : ' + meta + (f.label && f.label !== f.name ? ' (' + f.label + ')' : ''));
      }
    }
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

async function generateSoql(prompt) {
  if (!prompt || !prompt.trim()) throw new Error('Empty prompt');

  // Load record types first so scoring + the picker fallback both see them.
  // Failure is non-fatal — degrades to label-only scoring.
  try {
    await loadRecordTypes();
  } catch (err) {
    console.warn('sfnav: record types load failed —', err.message);
  }

  var candidates = pickCandidateObjects(prompt, 3);

  // No heuristic match — ask the model to pick from the object list, then re-run with that schema
  if (candidates.length === 0) {
    var pickerText = await callClaude(
      'You map natural-language requests to a single Salesforce object api name. Reply with ONLY the api name, nothing else.',
      buildObjectListMessage(prompt)
    );
    var chosen = pickerText.trim().split(/\s+/)[0].replace(/[`'"]/g, '');
    var match = getSoqlObjects().find(function (o) { return o.apiName === chosen; });
    if (!match) throw new Error('Could not identify object for this prompt');
    candidates = [match];
  }

  // Fetch describes + record counts in parallel — degrade gracefully if some fail.
  // Counts give Claude an org-grounded signal for picking between near-synonym
  // objects (e.g. Attachment vs EmailMessage, Note vs ContentNote).
  var schemaObjects = await Promise.all(candidates.map(async function (obj) {
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

  var systemPrompt = buildSystemPrompt();
  var baseUserMessage = buildUserMessage(prompt, schemaObjects);
  var userMessage = baseUserMessage;
  var attempts = [];
  var lastParsed = null;

  for (var attempt = 0; attempt <= SOQL_VALIDATE_RETRIES; attempt++) {
    var text = await callClaude(systemPrompt, userMessage);
    var parsed = parseSoqlResponse(text);
    lastParsed = parsed;

    var validation;
    try {
      validation = await validateSoql(parsed.soql);
    } catch (err) {
      // Validation transport failure — return the unvalidated query rather than blocking.
      console.warn('sfnav: SOQL validate request failed', err.message);
      return parsed;
    }

    if (validation.ok) return parsed;
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

function getSoqlHistory() {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.storage) { resolve([]); return; }
    chrome.storage.local.get(SOQL_HISTORY_KEY, function (data) {
      resolve(data[SOQL_HISTORY_KEY] || []);
    });
  });
}

function addToSoqlHistory(entry) {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.storage) { resolve(); return; }
    chrome.storage.local.get(SOQL_HISTORY_KEY, function (data) {
      var list = data[SOQL_HISTORY_KEY] || [];
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
      payload[SOQL_HISTORY_KEY] = list;
      chrome.storage.local.set(payload, resolve);
    });
  });
}

function hasSoqlApiKey() {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.storage) { resolve(false); return; }
    chrome.storage.local.get('sfnavOptions', function (data) {
      var opts = data.sfnavOptions || {};
      resolve(!!opts.anthropicApiKey);
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
