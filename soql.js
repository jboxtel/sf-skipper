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

var _describeCache = {}; // apiName → { fields, ts }

function soqlScoreObject(prompt, obj) {
  var p = prompt.toLowerCase();
  var label = (obj.label || '').toLowerCase();
  var apiName = (obj.apiName || '').toLowerCase();
  var apiBase = apiName.replace(/__c$/, '').replace(/_/g, ' ');
  var labelSingular = label.replace(/s$/, '');
  var apiSingular = apiBase.replace(/s$/, '');

  var score = 0;
  var candidates = [label, apiBase, labelSingular, apiSingular];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (!c) continue;
    if (p.indexOf(c) !== -1) {
      // Whole-word matches outweigh substring matches
      var re = new RegExp('\\b' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      score += re.test(p) ? c.length * 3 : c.length;
    }
  }
  return score;
}

function pickCandidateObjects(prompt, max) {
  var all = getAllObjects();
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

  var resp = await fetch(pre.apiBase + pre.basePath + '/sobjects/' + encodeURIComponent(apiName) + '/describe', { headers: pre.headers });
  if (!resp.ok) throw new Error('describe failed: ' + resp.status);
  var data = await resp.json();

  var fields = (data.fields || []).map(function (f) {
    var compact = { name: f.name, label: f.label, type: f.type };
    if (f.referenceTo && f.referenceTo.length) compact.referenceTo = f.referenceTo;
    if (f.picklistValues && f.picklistValues.length) {
      compact.values = f.picklistValues.slice(0, 50).map(function (v) { return v.value; });
    }
    return compact;
  });

  _describeCache[apiName] = { fields: fields, ts: Date.now() };
  return fields;
}

function buildSystemPrompt() {
  return [
    'You generate Salesforce SOQL queries from natural language.',
    'You MUST use only the objects and fields provided in the user message — do not invent any.',
    'Field names are case-sensitive and must match the API name exactly.',
    'Only generate SELECT queries. Never DML, never anonymous Apex.',
    'For picklist filters, use the exact picklist value if provided; otherwise use a sensible literal in single quotes.',
    'Respond with ONLY a JSON object on a single line, no prose, no code fences:',
    '{"soql":"SELECT ...","objectName":"...","explanation":"one short sentence"}'
  ].join('\n');
}

function buildUserMessage(prompt, schemaObjects) {
  var lines = [];
  lines.push('User request: ' + prompt);
  lines.push('');
  lines.push('Available schema:');
  for (var i = 0; i < schemaObjects.length; i++) {
    var o = schemaObjects[i];
    lines.push('Object: ' + o.apiName + (o.label ? ' (' + o.label + ')' : ''));
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
  var all = getAllObjects();
  var lines = [];
  lines.push('User request: ' + prompt);
  lines.push('');
  lines.push('I could not match an object from the prompt. Pick the most likely object from this list and reply ONLY with its api name (no JSON, no prose):');
  for (var i = 0; i < all.length; i++) {
    lines.push('- ' + all[i].apiName + (all[i].label && all[i].label !== all[i].apiName ? ' (' + all[i].label + ')' : ''));
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

async function generateSoql(prompt) {
  if (!prompt || !prompt.trim()) throw new Error('Empty prompt');

  var candidates = pickCandidateObjects(prompt, 3);

  // No heuristic match — ask the model to pick from the object list, then re-run with that schema
  if (candidates.length === 0) {
    var pickerText = await callClaude(
      'You map natural-language requests to a single Salesforce object api name. Reply with ONLY the api name, nothing else.',
      buildObjectListMessage(prompt)
    );
    var chosen = pickerText.trim().split(/\s+/)[0].replace(/[`'"]/g, '');
    var match = getAllObjects().find(function (o) { return o.apiName === chosen; });
    if (!match) throw new Error('Could not identify object for this prompt');
    candidates = [match];
  }

  // Fetch describes in parallel — degrade gracefully if some fail
  var schemaObjects = await Promise.all(candidates.map(async function (obj) {
    try {
      var fields = await fetchDescribe(obj.apiName);
      return { apiName: obj.apiName, label: obj.label, fields: fields };
    } catch (err) {
      console.warn('sfnav: describe failed for', obj.apiName, err.message);
      return { apiName: obj.apiName, label: obj.label, fields: null };
    }
  }));

  var text = await callClaude(buildSystemPrompt(), buildUserMessage(prompt, schemaObjects));
  return parseSoqlResponse(text);
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
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ type: 'openOptions' });
  }
}
