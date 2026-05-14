// Ask Claude — multimodal screenshot + agentic tool-use loop.
// First turn: send the screenshot, URL context, and (on record pages) a live
// snapshot of the record from REST. Then Claude can call tools (runSoql,
// runToolingSoql, describeSObject, getFieldHistory) to investigate further
// before answering. The loop runs in the content script so tools execute with
// the user's Salesforce session.

var ASK_RECORD_FIELD_BUDGET = 6000;   // soft cap on the record-fields section
var ASK_MAX_TOOL_ITERATIONS = 6;       // safety cap on agentic loop length
var ASK_TOOL_RESULT_BYTE_CAP = 12000;  // per-tool-result JSON soft cap
var ASK_APEX_SNIPPET_PAD = 160;
var ASK_APEX_MAX_SNIPPETS_PER_HIT = 3;
var ASK_APEX_FULL_BODY_CAP = 9000;

// HARD safety gate: every Salesforce request issued by @ask MUST go through
// askFetch, which only permits GET against a small allowlist of read endpoints.
// This makes writes (DML, anonymous Apex, metadata deploys, bulk jobs, etc.)
// physically unreachable from this surface regardless of model behaviour or
// prompt drift. See security.md for the layered model.
var ASK_ALLOWED_PATHS = [
  /\/services\/data\/v\d+\.\d+\/query\/?(\?|$)/,
  /\/services\/data\/v\d+\.\d+\/tooling\/query\/?(\?|$)/,
  /\/services\/data\/v\d+\.\d+\/tooling\/search\/?(\?|$)/,
  /\/services\/data\/v\d+\.\d+\/sobjects\/[A-Za-z0-9_]+\/[A-Za-z0-9]+(\/|\?|$)/,
  /\/services\/data\/v\d+\.\d+\/composite\/sobjects\?ids=/
];

async function askFetch(url, init) {
  init = init || {};
  if (init.method && String(init.method).toUpperCase() !== 'GET') {
    throw new Error('askFetch: only GET is allowed (attempted ' + init.method + ')');
  }
  if (init.body) {
    throw new Error('askFetch: request bodies are not allowed on this surface');
  }
  var parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error('askFetch: invalid URL'); }
  var pathAndSearch = parsed.pathname + parsed.search;
  var ok = ASK_ALLOWED_PATHS.some(function (re) { return re.test(pathAndSearch); });
  if (!ok) throw new Error('askFetch: path not in read-only allowlist: ' + parsed.pathname);
  return fetch(url, Object.assign({}, init, { method: 'GET', body: undefined }));
}

function buildAskSystemPrompt() {
  return [
    'You are a senior Salesforce admin assistant helping a consultant troubleshoot what they see in their org.',
    '',
    'You receive on the first turn:',
    '1. A screenshot of the user\'s current Salesforce browser tab.',
    '2. Page context (URL, sObject, record Id, setup node, flow id, etc.) parsed from the URL.',
    '3. When the user is on a record page: a live snapshot of that record\'s fields from the Salesforce REST API — API name, label, current value, and inline help text from describe.',
    '4. When the user is on a record page: the automation surface of that sObject — Apex triggers (with their before/after events), active record-triggered Flows (with TriggerType), and active validation rules (with error messages). This list is exhaustive for these three categories on this object.',
    '',
    'You have tools to investigate further. The first-turn context covers the current record\'s direct fields plus the trigger/Flow/VR inventory on this object — everything else (field history, related records, recent jobs, other records, Apex/Flow bodies, permissions, scheduled jobs) requires a tool call. USE THE TOOLS — answers grounded in real org data are dramatically better than guesses.',
    '',
    'CONTEXT — WHAT YOU DO NOT KNOW:',
    '- You do not know this customer\'s naming conventions, business meaning, or how standard objects are repurposed. Product2 might be "Flight" in this org. A custom field name rarely tells you who populates it or when.',
    '- For ANY question that mentions a custom field, custom object, or a behaviour whose source you do not know: do NOT guess from the name. Look it up first.',
    '',
    'TOOL-USE STRATEGY:',
    '- Start from the pre-loaded context. The record snapshot may already explain the issue (a status field, an owner, a checkbox); the automation list tells you which triggers/Flows/VRs are even candidates. Cite specific names from that list before reaching for tools.',
    '- When the user mentions a custom field whose population is unclear: the automation list shows which triggers and record-triggered Flows could be responsible. To find the exact one that writes the field, call searchApex(<field API name>); if empty, searchFlows(<field API name>). readApexClass on a top hit to read the logic.',
    '- Common patterns:',
    '   "Why is field X empty / wrong?" → check the pre-loaded automation list, then searchApex("X") and/or searchFlows("X") to pin down which entry sets it. If both empty, getFieldHistory to see whether anything ever wrote it.',
    '   "What does this validation error mean?" → first check the pre-loaded validation rules; if the matching rule is listed, runToolingSoql for its full formula. If not listed (e.g. it lives on a parent object), runToolingSoql on ValidationRule against the relevant EntityDefinition.',
    '   "Why can\'t I see this record / why is X read-only?" → runToolingSoql for FieldPermissions / ObjectPermissions for the running user\'s Profile/PermissionSets, or describeSObject to check field-level metadata.',
    '   "What automation runs on save?" → the pre-loaded list IS the answer for this object. Read it back to the user; only use searchApex/searchFlows if they ask which one does a specific behaviour.',
    '   "Why did the related X not get created?" → runSoql on the child object filtering on the lookup back to this record, then searchFlows or searchApex for whatever should create it (cross-object — the pre-loaded list is for the current object only).',
    '- Cap yourself: at most 4 tool calls per question. If you still don\'t know after that, say so and ask one focused follow-up.',
    '- Tool failures are not fatal — adapt and try a different angle, or report what you couldn\'t check.',
    '',
    'KNOW YOUR LIMITS — ESCALATE:',
    '- Call escalateToDesktop when the question would need reading more than 3 Apex classes, spans multiple subsystems, asks for a refactor or design, or requires understanding code you cannot fully load. Do not half-answer; an honest escalation is better than a confident guess.',
    '',
    'READ-ONLY:',
    '- You cannot change data or metadata in this org. Do not say you will "fix" something. Describe what the user should change in the Salesforce UI.',
    '',
    'SOQL RULES:',
    '- runSoql uses the standard Data API. SELECT only — DML is rejected. Wrap string literals in single quotes. Reference fields by API name.',
    '- runToolingSoql uses the Tooling API. Use this for metadata objects: ApexTrigger, ApexClass, Flow, ValidationRule, WorkflowRule, FieldPermissions, ObjectPermissions, PermissionSet, Profile, CustomField, EntityDefinition, etc. FlowDefinitionView is NOT a Tooling object — query it via runSoql.',
    '- Always include LIMIT (≤ 50). Always include the fields you actually need — never SELECT *.',
    '',
    'ANSWER FORMAT:',
    '- Lead with the most likely root cause in 1–2 sentences, citing specific fields/values/records you observed (not generalities).',
    '- Then a concrete next step (the Setup path to take, the field to change, the automation to investigate).',
    '- Use Salesforce admin terminology (Profile, Permission Set, Validation Rule, Flow, Page Layout, Record Type, Sharing Rule, Lookup, Master-Detail, Formula, Roll-Up Summary, etc.).',
    '- No headings. No "Based on the screenshot…". No generic hedge lists. Short prose. Bullets only when the answer is genuinely a list.'
  ].join('\n');
}

function getAskOrgContext() {
  var ctx = { url: window.location.href, host: window.location.hostname };
  var path = window.location.pathname || '';
  var search = window.location.search || '';
  var hash = window.location.hash || '';

  var m = path.match(/\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\/(view|edit|related|[^/]+)/);
  if (m) {
    ctx.pageType = 'record'; ctx.sObject = m[1]; ctx.recordId = m[2];
    return ctx;
  }
  m = path.match(/\/lightning\/r\/([a-zA-Z0-9]{15,18})\/(view|edit)/);
  if (m) {
    ctx.pageType = 'record'; ctx.recordId = m[1];
    return ctx;
  }
  m = path.match(/\/lightning\/o\/([^/]+)\/([^/]+)/);
  if (m) {
    ctx.pageType = m[2] === 'list' ? 'list-view' : m[2]; ctx.sObject = m[1];
    return ctx;
  }
  if (path.indexOf('/builder_platform_interaction/flowBuilder.app') !== -1
      || search.indexOf('flowId=') !== -1
      || hash.indexOf('flowId=') !== -1) {
    ctx.pageType = 'flow-builder';
    var fm = (search + '&' + hash.replace(/^#/, '')).match(/[?&]flowId=([^&]+)/);
    if (fm) ctx.flowId = decodeURIComponent(fm[1]);
    return ctx;
  }
  m = path.match(/\/lightning\/setup\/([^/]+)/);
  if (m) { ctx.pageType = 'setup'; ctx.setupNode = m[1]; return ctx; }
  m = path.match(/\/lightning\/app\/([^/]+)/);
  if (m) { ctx.pageType = 'app'; ctx.app = m[1]; return ctx; }
  ctx.pageType = 'other';
  return ctx;
}

async function fetchRecordSnapshot(sObject, recordId) {
  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/sobjects/'
    + encodeURIComponent(sObject) + '/' + encodeURIComponent(recordId);
  var resp = await askFetch(url, { headers: pre.headers });
  if (!resp.ok) {
    var body = await resp.text();
    throw new Error('Record fetch ' + resp.status + ': ' + body.slice(0, 200));
  }
  var data = await resp.json();
  var out = {};
  Object.keys(data).forEach(function (k) {
    if (k !== 'attributes') out[k] = data[k];
  });
  return out;
}

async function enrichAskContext(ctx) {
  if (ctx.pageType !== 'record' || !ctx.sObject || !ctx.recordId) return ctx;
  var snapshotP = fetchRecordSnapshot(ctx.sObject, ctx.recordId).catch(function (err) {
    ctx.recordFetchError = err.message;
    return null;
  });
  var describeP = (typeof fetchDescribe === 'function')
    ? fetchDescribe(ctx.sObject).catch(function (err) { ctx.describeError = err.message; return null; })
    : Promise.resolve(null);
  var automationsP = fetchObjectAutomations(ctx.sObject).catch(function (err) {
    ctx.automationsError = err.message;
    return null;
  });
  var results = await Promise.all([snapshotP, describeP, automationsP]);
  ctx.recordFields = results[0];
  ctx.fieldMetadata = results[1];
  ctx.automations = results[2];
  return ctx;
}

// Pre-load the automation surface of the current sObject so the model can
// reason about likely-responsible triggers/Flows/validation rules in turn 1
// without spending tool calls just to discover what exists. Each query is
// independent and failures are swallowed — a missing piece is better than
// failing the whole enrichment.
async function fetchObjectAutomations(sObject) {
  var pre = await sfRestPreamble();
  var safe = String(sObject).replace(/'/g, "\\'");

  var triggerSoql = "SELECT Name, Status, UsageBeforeInsert, UsageAfterInsert, "
    + "UsageBeforeUpdate, UsageAfterUpdate, UsageBeforeDelete, UsageAfterDelete "
    + "FROM ApexTrigger WHERE TableEnumOrId = '" + safe + "' "
    + "AND NamespacePrefix = null LIMIT 25";
  var vrSoql = "SELECT ValidationName, ErrorMessage, ErrorDisplayField "
    + "FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '" + safe + "' "
    + "AND Active = true LIMIT 25";
  var flowSoql = "SELECT ApiName, Label, ProcessType, TriggerType, TriggerOrder "
    + "FROM FlowDefinitionView WHERE TriggerObjectOrEvent = '" + safe + "' "
    + "AND ActiveVersionId != null LIMIT 25";

  function tryQuery(path, soql) {
    var url = pre.apiBase + pre.basePath + path + '?q=' + encodeURIComponent(soql);
    return askFetch(url, { headers: pre.headers })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { return (data && data.records) || []; })
      .catch(function () { return []; });
  }

  var results = await Promise.all([
    tryQuery('/tooling/query/', triggerSoql),
    tryQuery('/tooling/query/', vrSoql),
    tryQuery('/query/', flowSoql)
  ]);
  return { triggers: results[0], validationRules: results[1], flows: results[2] };
}

function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function formatRecordFields(record, fieldMetadata) {
  if (!record) return null;
  var metaByName = {};
  if (Array.isArray(fieldMetadata)) {
    fieldMetadata.forEach(function (f) { metaByName[f.name] = f; });
  }
  function isStatusish(name) {
    return /^(Id|Name|OwnerId|RecordTypeId|IsActive|IsDeleted)$/i.test(name)
        || /(Status|State|Stage|Sync|External|Integration)/i.test(name);
  }
  var keys = Object.keys(record);
  var statusKeys = keys.filter(function (k) { return isStatusish(k); });
  var nullKeys = keys.filter(function (k) { return record[k] === null && !isStatusish(k); });
  var otherKeys = keys.filter(function (k) { return record[k] !== null && !isStatusish(k); });
  var ordered = statusKeys.concat(nullKeys).concat(otherKeys);

  var lines = [];
  var used = 0;
  for (var i = 0; i < ordered.length; i++) {
    var k = ordered[i];
    var meta = metaByName[k];
    var label = meta && meta.label && meta.label !== k ? ' (' + meta.label + ')' : '';
    var line = '  ' + k + label + ': ' + formatScalar(record[k]);
    if (meta && meta.helpText) {
      line += '\n    help: ' + meta.helpText.replace(/\s+/g, ' ').trim();
    }
    if (used + line.length > ASK_RECORD_FIELD_BUDGET) {
      lines.push('  … (' + (ordered.length - i) + ' more fields truncated for prompt size)');
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function formatAutomations(auto, sObject) {
  if (!auto) return null;
  var lines = [];
  if (auto.triggers && auto.triggers.length) {
    lines.push('Apex triggers (' + auto.triggers.length + '):');
    auto.triggers.forEach(function (t) {
      var events = [];
      if (t.UsageBeforeInsert) events.push('before insert');
      if (t.UsageAfterInsert)  events.push('after insert');
      if (t.UsageBeforeUpdate) events.push('before update');
      if (t.UsageAfterUpdate)  events.push('after update');
      if (t.UsageBeforeDelete) events.push('before delete');
      if (t.UsageAfterDelete)  events.push('after delete');
      var status = t.Status && t.Status !== 'Active' ? ' [' + t.Status + ']' : '';
      lines.push('  ' + t.Name + status + ' — ' + (events.join(', ') || 'no events'));
    });
  }
  if (auto.flows && auto.flows.length) {
    lines.push('Active record-triggered Flows (' + auto.flows.length + '):');
    auto.flows.forEach(function (f) {
      var bits = [f.TriggerType];
      if (f.TriggerOrder != null) bits.push('order ' + f.TriggerOrder);
      lines.push('  ' + f.ApiName + ' [' + bits.join(', ') + ']');
    });
  }
  if (auto.validationRules && auto.validationRules.length) {
    lines.push('Active validation rules (' + auto.validationRules.length + '):');
    auto.validationRules.forEach(function (v) {
      var msg = (v.ErrorMessage || '').replace(/\s+/g, ' ').trim();
      if (msg.length > 100) msg = msg.slice(0, 100) + '…';
      lines.push('  ' + v.ValidationName + (msg ? ' — "' + msg + '"' : ''));
    });
  }
  if (!lines.length) {
    lines.push('No Apex triggers, active record-triggered Flows, or active validation rules found on ' + sObject + '.');
  }
  return lines.join('\n');
}

function formatAskOrgContext(ctx) {
  var lines = ['Current URL: ' + ctx.url];
  if (ctx.pageType)   lines.push('Page type: ' + ctx.pageType);
  if (ctx.sObject)    lines.push('Object: ' + ctx.sObject);
  if (ctx.recordId)   lines.push('Record Id: ' + ctx.recordId);
  if (ctx.setupNode)  lines.push('Setup node: ' + ctx.setupNode);
  if (ctx.flowId)     lines.push('Flow id: ' + ctx.flowId);
  if (ctx.app)        lines.push('Lightning app: ' + ctx.app);

  if (ctx.recordFields) {
    lines.push('');
    lines.push('Record fields (live from REST):');
    lines.push(formatRecordFields(ctx.recordFields, ctx.fieldMetadata));
  } else if (ctx.recordFetchError) {
    lines.push('');
    lines.push('Note: live record fetch failed — ' + ctx.recordFetchError);
  }

  if (ctx.automations) {
    var autoText = formatAutomations(ctx.automations, ctx.sObject);
    if (autoText) {
      lines.push('');
      lines.push('Automation on ' + ctx.sObject + ':');
      lines.push(autoText);
    }
  }
  return lines.join('\n');
}

function captureVisibleTab() {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ type: 'ask.captureVisibleTab' }, function (resp) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!resp || !resp.ok) { reject(new Error((resp && resp.error) || 'Capture failed')); return; }
      resolve({ mediaType: resp.mediaType, data: resp.data });
    });
  });
}

// ─── Tools ──────────────────────────────────────────────────────────────────
// Each tool runs in the content script's context, using sfRestPreamble for
// auth. Tools return JS values that are JSON-serialized into tool_result
// blocks. Errors are caught and surfaced to the model as is_error results so
// it can adapt rather than abort.

var ASK_TOOLS = [
  {
    name: 'runSoql',
    description: 'Execute a read-only SOQL SELECT query against the Salesforce Data API. Use this for record data: parent lookups, child relationships, related records, aggregate queries. DML (INSERT/UPDATE/DELETE) is rejected.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A single SOQL SELECT statement. Must include LIMIT (≤ 50).' }
      },
      required: ['query']
    }
  },
  {
    name: 'runToolingSoql',
    description: 'Execute a SOQL query against the Salesforce Tooling API. Use this for metadata: ApexTrigger, ApexClass, Flow, ValidationRule, WorkflowRule, CustomField, EntityDefinition, FieldPermissions, ObjectPermissions, PermissionSet, Profile. Note: FlowDefinitionView lives on the standard Data API — use runSoql for it.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A single Tooling SOQL SELECT statement. Must include LIMIT (≤ 50).' }
      },
      required: ['query']
    }
  },
  {
    name: 'describeSObject',
    description: 'Return the field list (API name, label, type, picklist values, help text, references) for an sObject. Use this to learn what fields exist before querying, or to read field help text.',
    input_schema: {
      type: 'object',
      properties: {
        sObject: { type: 'string', description: 'API name of the sObject, e.g. "Account" or "Product2".' }
      },
      required: ['sObject']
    }
  },
  {
    name: 'getFieldHistory',
    description: 'Return recent field-history rows for a single record. Shows when each tracked field was last changed, by whom, from what to what. Only fields with history-tracking enabled appear.',
    input_schema: {
      type: 'object',
      properties: {
        recordId: { type: 'string', description: '15- or 18-char Salesforce record Id.' },
        maxRows: { type: 'integer', description: 'Max rows to return (default 25, max 50).' }
      },
      required: ['recordId']
    }
  },
  {
    name: 'searchApex',
    description: 'Find Apex classes and triggers whose source contains a substring. Use this as the FIRST move whenever the user mentions a custom field, custom object, or behaviour whose source you do not know — it is how you discover which class populates a field or runs which logic in THIS org. Returns class/trigger names with short snippets around each match (not full bodies). Follow up with readApexClass for the full source.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal substring to search for, e.g. a field API name like "FlightId__c" or a method name. Not a regex. Minimum 3 characters.' },
        kind:  { type: 'string', enum: ['class', 'trigger', 'both'], description: 'Default "both". Restrict to ApexClass or ApexTrigger.' },
        limit: { type: 'integer', description: 'Max matches per kind (default 10, max 25).' }
      },
      required: ['query']
    }
  },
  {
    name: 'searchFlows',
    description: 'Substring-search inside active Flow definitions. Use when an automation likely lives in a Flow rather than Apex — admins increasingly implement field population, validation, and chained record updates as Flows. Returns matching Flow API names with short snippets from the metadata JSON. Up to ~25 active Flows are scanned per call; pass sObject to narrow to record-triggered Flows on a specific object.',
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Literal substring to search for, e.g. a field API name like "Product2Id" or a value like "Closed Won". Minimum 3 characters.' },
        sObject: { type: 'string', description: 'Optional. Restrict to Flows whose start object matches this API name (e.g. "Account", "Opportunity"). Filters on Metadata.start.object after fetch.' },
        limit:   { type: 'integer', description: 'Max active Flows to scan (default 25, max 50).' }
      },
      required: ['query']
    }
  },
  {
    name: 'readApexClass',
    description: 'Return the full source of one Apex class or trigger. Use after searchApex to read a specific match. Large bodies are truncated; pass lineRange to read a specific window.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact class or trigger Name.' },
        kind: { type: 'string', enum: ['class', 'trigger'], description: 'Default "class".' },
        lineRange: { type: 'string', description: 'Optional "start-end" 1-based line window, e.g. "120-180". Omit to get the whole body (may be truncated).' }
      },
      required: ['name']
    }
  },
  {
    name: 'escalateToDesktop',
    description: 'Stop investigating and recommend the user move this question to claude.ai. Call this when the question would need reading more than 3 Apex classes, spans multiple subsystems, asks for a refactor, or you otherwise cannot ground a confident answer within the tool-call budget. Do NOT call this for questions you can answer directly — only when you would otherwise have to guess.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'One sentence in admin terms: why this needs the desktop.' },
        suggestedFollowup: { type: 'string', description: 'Optional: a refined version of the user\'s question for the handoff.' }
      },
      required: ['reason']
    }
  }
];

function ensureSelectOnly(query) {
  var trimmed = String(query || '').trim().replace(/^\s*\(\s*/, '');
  if (!/^select\s/i.test(trimmed)) throw new Error('Only SELECT queries are allowed');
  if (/\b(insert|update|delete|upsert|merge|undelete)\b/i.test(trimmed)) {
    throw new Error('DML keywords are not allowed in SOQL');
  }
}

function capRowsForPrompt(rows) {
  if (!Array.isArray(rows)) return rows;
  var capped = rows.slice(0, 50).map(function (r) {
    if (r && typeof r === 'object' && r.attributes) {
      var copy = Object.assign({}, r);
      delete copy.attributes;
      return copy;
    }
    return r;
  });
  return capped;
}

function trimResultJson(value) {
  var json;
  try { json = JSON.stringify(value); } catch (_) { json = String(value); }
  if (json.length > ASK_TOOL_RESULT_BYTE_CAP) {
    return json.slice(0, ASK_TOOL_RESULT_BYTE_CAP) + '\n…[result truncated for prompt size]';
  }
  return json;
}

// 15-char key prefix tables for the standard FieldHistory pattern. Most
// objects use {ApiName}History (Account → AccountHistory). Custom objects
// use {ApiNameWithoutSuffix}__History. We derive the table from sObject.
async function lookupKeyPrefix(recordId) {
  var pre = await sfRestPreamble();
  var prefix = recordId.substring(0, 3);
  var soql = "SELECT QualifiedApiName FROM EntityDefinition WHERE KeyPrefix = '" + prefix.replace(/'/g, "\\'") + "' LIMIT 1";
  var url = pre.apiBase + pre.basePath + '/tooling/query/?q=' + encodeURIComponent(soql);
  var resp = await askFetch(url, { headers: pre.headers });
  if (!resp.ok) throw new Error('Tooling query for key prefix failed: ' + resp.status);
  var data = await resp.json();
  if (!data.records || !data.records.length) throw new Error('No EntityDefinition for key prefix ' + prefix);
  return data.records[0].QualifiedApiName;
}

function historyTableFor(apiName) {
  if (apiName.endsWith('__c')) return apiName.slice(0, -3) + '__History';
  return apiName + 'History';
}

async function toolRunSoql(input) {
  ensureSelectOnly(input.query);
  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent(input.query);
  var resp = await askFetch(url, { headers: pre.headers });
  var body = await resp.text();
  if (!resp.ok) throw new Error('SOQL ' + resp.status + ': ' + body.slice(0, 240));
  var data = JSON.parse(body);
  return { totalSize: data.totalSize, done: data.done, records: capRowsForPrompt(data.records) };
}

async function toolRunToolingSoql(input) {
  ensureSelectOnly(input.query);
  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/tooling/query/?q=' + encodeURIComponent(input.query);
  var resp = await askFetch(url, { headers: pre.headers });
  var body = await resp.text();
  if (!resp.ok) throw new Error('Tooling SOQL ' + resp.status + ': ' + body.slice(0, 240));
  var data = JSON.parse(body);
  return { totalSize: data.totalSize, done: data.done, records: capRowsForPrompt(data.records) };
}

async function toolDescribeSObject(input) {
  if (typeof fetchDescribe !== 'function') throw new Error('describe helper unavailable');
  var fields = await fetchDescribe(input.sObject);
  return { sObject: input.sObject, fieldCount: fields.length, fields: fields };
}

async function toolGetFieldHistory(input) {
  var recordId = input.recordId;
  if (!recordId || !/^[a-zA-Z0-9]{15,18}$/.test(recordId)) throw new Error('Invalid recordId');
  var maxRows = Math.min(Math.max(parseInt(input.maxRows || 25, 10), 1), 50);
  var apiName = await lookupKeyPrefix(recordId);
  var table = historyTableFor(apiName);
  var idField = apiName.endsWith('__c') ? 'ParentId' : apiName + 'Id';
  var soql = 'SELECT ' + idField + ', Field, OldValue, NewValue, CreatedDate, CreatedById '
    + 'FROM ' + table + " WHERE " + idField + " = '" + recordId.replace(/'/g, "\\'") + "' "
    + 'ORDER BY CreatedDate DESC LIMIT ' + maxRows;
  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent(soql);
  var resp = await askFetch(url, { headers: pre.headers });
  var body = await resp.text();
  if (!resp.ok) {
    // Field history tracking may not be enabled on this object — surface that
    // clearly instead of dumping the raw 400.
    var hint = (body.indexOf('INVALID_TYPE') !== -1 || body.indexOf("sObject type") !== -1)
      ? ' (field history tracking may not be enabled on ' + apiName + ')'
      : '';
    throw new Error('History query ' + resp.status + hint + ': ' + body.slice(0, 200));
  }
  var data = JSON.parse(body);
  return { table: table, parentId: recordId, totalSize: data.totalSize, records: capRowsForPrompt(data.records) };
}

function escapeSoqlLiteral(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// SOSL reserved characters that must be backslash-escaped inside FIND {…}.
// Source: Salesforce SOSL reference — "Quoted String Escape Sequences".
function escapeSoslLiteral(s) {
  return String(s).replace(/([\\?&|!{}\[\]()^~*:"'+\-])/g, '\\$1');
}

// Build short windows around each occurrence of `query` in `body`. We hand the
// model snippets-with-line-numbers rather than full class bodies so it can
// decide which file to readApexClass into without blowing context.
function makeApexSnippets(body, query) {
  var out = [];
  if (!body) return out;
  var lower = body.toLowerCase();
  var q = String(query).toLowerCase();
  var from = 0;
  while (out.length < ASK_APEX_MAX_SNIPPETS_PER_HIT) {
    var i = lower.indexOf(q, from);
    if (i < 0) break;
    var start = Math.max(0, i - ASK_APEX_SNIPPET_PAD);
    var end   = Math.min(body.length, i + q.length + ASK_APEX_SNIPPET_PAD);
    var line  = body.slice(0, i).split('\n').length;
    out.push({
      line: line,
      text: (start > 0 ? '… ' : '') + body.slice(start, end) + (end < body.length ? ' …' : '')
    });
    from = i + q.length;
  }
  return out;
}

async function toolingQueryRaw(soql) {
  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/tooling/query/?q=' + encodeURIComponent(soql);
  var resp = await askFetch(url, { headers: pre.headers });
  var body = await resp.text();
  if (!resp.ok) throw new Error('Tooling ' + resp.status + ': ' + body.slice(0, 240));
  return JSON.parse(body);
}

async function restQueryRaw(soql) {
  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent(soql);
  var resp = await askFetch(url, { headers: pre.headers });
  var body = await resp.text();
  if (!resp.ok) throw new Error('SOQL ' + resp.status + ': ' + body.slice(0, 240));
  return JSON.parse(body);
}

// Apex Body is queryable but not filterable in SOQL, so substring search has
// to go through SOSL (Tooling /search/), which is indexed full-text. SOSL can
// lag a few minutes behind newly-deployed code; that's accepted.
async function toolSearchApex(input) {
  if (!input.query || String(input.query).length < 3) {
    throw new Error('query must be at least 3 characters');
  }
  var kind = input.kind || 'both';
  var limit = Math.min(Math.max(parseInt(input.limit || 10, 10), 1), 25);

  var returning = [];
  if (kind === 'class' || kind === 'both')   returning.push('ApexClass(Id, Name, NamespacePrefix, Body)');
  if (kind === 'trigger' || kind === 'both') returning.push('ApexTrigger(Id, Name, NamespacePrefix, TableEnumOrId, Body)');

  var sosl = 'FIND {' + escapeSoslLiteral(input.query) + '} IN ALL FIELDS '
    + 'RETURNING ' + returning.join(', ') + ' LIMIT ' + limit;

  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/tooling/search/?q=' + encodeURIComponent(sosl);
  var resp = await askFetch(url, { headers: pre.headers });
  var bodyText = await resp.text();
  if (!resp.ok) throw new Error('Tooling SOSL ' + resp.status + ': ' + bodyText.slice(0, 240));
  var data = JSON.parse(bodyText);

  // Response shape: { searchRecords: [...] } or sometimes a bare array.
  var records = Array.isArray(data) ? data : (data.searchRecords || []);

  var hits = [];
  records.forEach(function (r) {
    var type = r.attributes && r.attributes.type;
    if (r.NamespacePrefix) return; // skip managed-package source — Body is null anyway
    if (type === 'ApexClass') {
      hits.push({ kind: 'class', name: r.Name, snippets: makeApexSnippets(r.Body || '', input.query) });
    } else if (type === 'ApexTrigger') {
      hits.push({ kind: 'trigger', name: r.Name, sObject: r.TableEnumOrId, snippets: makeApexSnippets(r.Body || '', input.query) });
    }
  });

  return { query: input.query, totalHits: hits.length, hits: hits };
}

async function toolReadApexClass(input) {
  if (!input.name) throw new Error('name is required');
  var kind = input.kind || 'class';
  var table = kind === 'trigger' ? 'ApexTrigger' : 'ApexClass';
  var soql = "SELECT Name, Body FROM " + table
    + " WHERE Name = '" + escapeSoqlLiteral(input.name) + "' "
    + "AND NamespacePrefix = null LIMIT 1";
  var data = await toolingQueryRaw(soql);
  if (!data.records || !data.records.length) {
    throw new Error(table + ' "' + input.name + '" not found (note: managed-package source is not available)');
  }
  var body = data.records[0].Body || '';
  var totalLines = body.split('\n').length;

  if (input.lineRange) {
    var m = String(input.lineRange).match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      var lines = body.split('\n');
      var s = Math.max(1, parseInt(m[1], 10)) - 1;
      var e = Math.min(lines.length, parseInt(m[2], 10));
      return {
        name: input.name, kind: kind,
        lineRange: (s + 1) + '-' + e, totalLines: totalLines,
        body: lines.slice(s, e).join('\n')
      };
    }
  }

  var truncated = body.length > ASK_APEX_FULL_BODY_CAP;
  return {
    name: input.name, kind: kind, totalLines: totalLines, truncated: truncated,
    body: truncated
      ? body.slice(0, ASK_APEX_FULL_BODY_CAP) + '\n// …[truncated — pass lineRange for the rest]'
      : body
  };
}

// Flow.Body isn't a thing — automation logic lives in the Metadata blob (a
// nested object the Tooling API returns inline). SOSL doesn't index Flow
// metadata, so substring search means: list active Flows, batch-fetch each
// version's Metadata, stringify and grep client-side. Bounded by `limit`
// (default 25) so this stays cheap even on busy orgs.
async function toolSearchFlows(input) {
  if (!input.query || String(input.query).length < 3) {
    throw new Error('query must be at least 3 characters');
  }
  var limit = Math.min(Math.max(parseInt(input.limit || 25, 10), 1), 50);

  var defsQuery = 'SELECT ApiName, Label, ProcessType, TriggerType, ActiveVersionId '
    + 'FROM FlowDefinitionView WHERE ActiveVersionId != null '
    + 'ORDER BY Label LIMIT ' + limit;
  var defsResp = await restQueryRaw(defsQuery);
  // Managed-package Flow templates surface as ActiveVersionId pseudo-IDs like
  // `SvcCopilotTmpl__AddCaseComment-1` — not real Flow record IDs, so the
  // Tooling `Flow WHERE Id IN (...)` query 400s on the whole batch. Filter to
  // true 15/18-char Salesforce IDs.
  var defs = (defsResp.records || []).filter(function (d) {
    return d.ActiveVersionId && /^[a-zA-Z0-9]{15,18}$/.test(d.ActiveVersionId);
  });
  if (!defs.length) return { query: input.query, scanned: 0, totalHits: 0, hits: [] };

  var ids = defs.map(function (d) { return "'" + escapeSoqlLiteral(d.ActiveVersionId) + "'"; }).join(',');
  var flowQuery = 'SELECT Id, MasterLabel, Metadata FROM Flow WHERE Id IN (' + ids + ')';
  var flowResp = await toolingQueryRaw(flowQuery);
  var byId = {};
  (flowResp.records || []).forEach(function (f) { byId[f.Id] = f; });

  var q = String(input.query).toLowerCase();
  var sObjFilter = input.sObject ? String(input.sObject).toLowerCase() : null;
  var hits = [];
  defs.forEach(function (d) {
    var flow = byId[d.ActiveVersionId];
    if (!flow || !flow.Metadata) return;
    var startObj = (flow.Metadata.start && flow.Metadata.start.object) || null;
    if (sObjFilter && (!startObj || String(startObj).toLowerCase() !== sObjFilter)) return;
    var blob;
    try { blob = JSON.stringify(flow.Metadata); } catch (_) { return; }
    if (blob.toLowerCase().indexOf(q) < 0) return;
    hits.push({
      apiName: d.ApiName,
      label: d.Label,
      processType: d.ProcessType,
      triggerType: d.TriggerType,
      startObject: startObj,
      snippets: makeApexSnippets(blob, input.query)
    });
  });

  return { query: input.query, scanned: defs.length, totalHits: hits.length, hits: hits };
}

// Sentinel return — runAsk's loop checks for __escalate and breaks out to the
// UI without further model calls.
async function toolEscalateToDesktop(input) {
  return {
    __escalate: true,
    reason: String(input.reason || '').trim() || 'Question is too broad for this surface.',
    suggestedFollowup: input.suggestedFollowup ? String(input.suggestedFollowup).trim() : null
  };
}

async function executeTool(name, input) {
  switch (name) {
    case 'runSoql':           return await toolRunSoql(input);
    case 'runToolingSoql':    return await toolRunToolingSoql(input);
    case 'describeSObject':   return await toolDescribeSObject(input);
    case 'getFieldHistory':   return await toolGetFieldHistory(input);
    case 'searchApex':        return await toolSearchApex(input);
    case 'searchFlows':       return await toolSearchFlows(input);
    case 'readApexClass':     return await toolReadApexClass(input);
    case 'escalateToDesktop': return await toolEscalateToDesktop(input);
    default: throw new Error('Unknown tool: ' + name);
  }
}

// ─── Anthropic transport ────────────────────────────────────────────────────

function postMessageStep(body) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ type: 'ask.messageStep', body: body }, function (resp) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!resp) { reject(new Error('No response from background')); return; }
      if (!resp.ok) { reject(new Error(resp.error || 'Unknown error')); return; }
      resolve(resp.response);
    });
  });
}

// Build the first-turn user content (screenshot + page context + question).
function buildInitialUserContent(image, ctx, question) {
  var content = [];
  if (image && image.data) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType || 'image/jpeg', data: image.data }
    });
  }
  var text = [
    'Page context:',
    formatAskOrgContext(ctx),
    '',
    'Question: ' + question.trim()
  ].join('\n');
  // cache_control here makes the entire first-turn prefix (tools + system +
  // screenshot + page context + question) a single cached unit. The agentic
  // loop runs 2-6 turns within seconds, so every turn after the first reads
  // this prefix at ~10% of input cost.
  content.push({ type: 'text', text: text, cache_control: { type: 'ephemeral' } });
  return content;
}

// Drive the agentic loop. onActivity(event) is fired for UI updates:
//   { kind: 'captured' }
//   { kind: 'enriched', ctx }
//   { kind: 'tool_call', name, input, iteration }
//   { kind: 'tool_result', name, ok, summary, iteration }
//   { kind: 'interim_text', text }
async function runAsk(question, onActivity) {
  if (!question || !question.trim()) throw new Error('Type a question first');
  function emit(ev) { if (typeof onActivity === 'function') { try { onActivity(ev); } catch (_) {} } }

  var ctx = getAskOrgContext();
  var imageP = captureVisibleTab().then(function (img) { emit({ kind: 'captured' }); return img; });
  var ctxP = enrichAskContext(ctx).then(function (enriched) { emit({ kind: 'enriched', ctx: enriched }); return enriched; });
  var both = await Promise.all([imageP, ctxP]);
  var image = both[0];
  var enrichedCtx = both[1];

  var systemPrompt = buildAskSystemPrompt();
  var systemBlocks = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
  ];
  var messages = [
    { role: 'user', content: buildInitialUserContent(image, enrichedCtx, question) }
  ];

  var finalText = '';
  var toolCallCount = 0;
  var escalate = null;
  for (var iter = 0; iter < ASK_MAX_TOOL_ITERATIONS; iter++) {
    var response = await postMessageStep({
      system: systemBlocks,
      messages: messages,
      tools: ASK_TOOLS,
      max_tokens: 2048
    });

    var blocks = (response && response.content) || [];
    var textParts = blocks.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; });
    var toolUses = blocks.filter(function (b) { return b.type === 'tool_use'; });

    if (response.stop_reason !== 'tool_use' || !toolUses.length) {
      finalText = textParts.join('\n').trim();
      break;
    }

    // Surface any interim narration before the tool calls
    var interim = textParts.join('\n').trim();
    if (interim) emit({ kind: 'interim_text', text: interim });

    // Add the full assistant turn to history (must include the tool_use blocks)
    messages.push({ role: 'assistant', content: blocks });

    var toolResults = [];
    for (var t = 0; t < toolUses.length; t++) {
      var tu = toolUses[t];
      toolCallCount++;
      emit({ kind: 'tool_call', name: tu.name, input: tu.input, iteration: iter + 1 });
      var resultContent;
      var isError = false;
      try {
        var result = await executeTool(tu.name, tu.input || {});
        if (result && result.__escalate) {
          escalate = { reason: result.reason, suggestedFollowup: result.suggestedFollowup };
          emit({ kind: 'escalate', reason: escalate.reason, suggestedFollowup: escalate.suggestedFollowup });
          break;
        }
        resultContent = trimResultJson(result);
        emit({ kind: 'tool_result', name: tu.name, ok: true, summary: summarizeToolResult(tu.name, result), iteration: iter + 1 });
      } catch (err) {
        resultContent = 'Error: ' + err.message;
        isError = true;
        emit({ kind: 'tool_result', name: tu.name, ok: false, summary: err.message, iteration: iter + 1 });
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultContent,
        is_error: isError
      });
    }
    if (escalate) break;
    messages.push({ role: 'user', content: toolResults });
  }

  if (escalate) {
    var lines = ['This question is bigger than @ask should chew on — try claude.ai instead.'];
    lines.push('');
    lines.push('Reason: ' + escalate.reason);
    if (escalate.suggestedFollowup) {
      lines.push('');
      lines.push('Suggested question for claude.ai:');
      lines.push(escalate.suggestedFollowup);
    }
    finalText = lines.join('\n');
  } else if (!finalText) {
    finalText = '(Reached the ' + ASK_MAX_TOOL_ITERATIONS + '-iteration tool-use cap without a final answer. Try a more specific question.)';
  }

  return { text: finalText, context: enrichedCtx, toolCallCount: toolCallCount, escalate: escalate };
}

function summarizeToolResult(name, result) {
  if (!result) return 'no data';
  if (name === 'runSoql' || name === 'runToolingSoql' || name === 'getFieldHistory') {
    var n = result.records ? result.records.length : (result.totalSize || 0);
    return n + ' row' + (n === 1 ? '' : 's');
  }
  if (name === 'describeSObject') {
    return (result.fieldCount || 0) + ' fields';
  }
  if (name === 'searchApex') {
    var h = result.totalHits || 0;
    return h + ' Apex hit' + (h === 1 ? '' : 's');
  }
  if (name === 'searchFlows') {
    var fh = result.totalHits || 0;
    var fs = result.scanned || 0;
    return fh + ' Flow hit' + (fh === 1 ? '' : 's') + ' (scanned ' + fs + ')';
  }
  if (name === 'readApexClass') {
    return (result.totalLines || 0) + ' lines' + (result.truncated ? ' (truncated)' : '');
  }
  return 'ok';
}
