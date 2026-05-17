// Flow Debug Assistant — fetch the active flow's metadata via Tooling API,
// combine with the user's pasted Debug-panel output, and ask Claude to
// identify what went wrong and how to fix it.

var FLOW_DEBUG_MAX_COMPACT = 8000; // compact metadata is truncated past this size
var _flowMetadataCache = {}; // flowId → { record, ts }
var FLOW_METADATA_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isFlowBuilderPage() {
  return window.location.pathname.indexOf('/builder_platform_interaction/flowBuilder.app') !== -1
      || window.location.search.indexOf('flowId=') !== -1
      || window.location.hash.indexOf('flowId=') !== -1;
}

function getFlowIdFromUrl() {
  var search = window.location.search || '';
  var hash = window.location.hash || '';
  var combined = search + '&' + hash.replace(/^#/, '');
  var m = combined.match(/[?&]flowId=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function isManagedFlowId(flowId) {
  if (!flowId) return false;
  var isSfId = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(flowId);
  if (isSfId) return false;
  var slug = flowId.replace(/-\d+$/, '');
  return /__/.test(slug);
}

async function fetchFlowMetadata(flowId) {
  var cached = _flowMetadataCache[flowId];
  if (cached && (Date.now() - cached.ts) < FLOW_METADATA_TTL_MS) {
    return cached.record;
  }
  var pre = await sfRestPreamble();
  var safe = flowId.replace(/'/g, "\\'");
  // Salesforce record IDs are 15 or 18 alphanumeric chars starting with a
  // 3-char key prefix. Anything else (e.g. "MyFlow-1") is a version name/slug
  // that comes from the URL and needs a different query strategy.
  var isSfId = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(flowId);
  var soql;
  if (isSfId) {
    soql = "SELECT Id, DefinitionId, MasterLabel, Metadata FROM Flow WHERE Id = '" + safe + "'";
  } else {
    // The URL slug is typically "Namespace__DeveloperName-versionNumber".
    // Strip the trailing version suffix, then split namespace from name.
    var slug = flowId.replace(/-\d+$/, '');
    var nsParts = slug.match(/^(.+?)__(.+)$/);
    var devName = (nsParts ? nsParts[2] : slug).replace(/'/g, "\\'");
    var nsFilter = nsParts
      ? " AND Definition.NamespacePrefix = '" + nsParts[1].replace(/'/g, "\\'") + "'"
      : "";
    soql = "SELECT Id, DefinitionId, MasterLabel, Metadata FROM Flow WHERE Definition.DeveloperName = '" + devName + "'" + nsFilter + " AND Status = 'Active' ORDER BY VersionNumber DESC LIMIT 1";
  }
  var url = pre.apiBase + pre.basePath + '/tooling/query/?q=' + encodeURIComponent(soql);
  var resp = await sfFetch(url, { headers: pre.headers });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('No Tooling API access — your profile needs "View All Data" or Author Apex to read flow metadata.');
  }
  if (!resp.ok) {
    var body = await resp.text();
    throw new Error('Flow metadata fetch ' + resp.status + ': ' + body.slice(0, 120));
  }
  var data = await resp.json();
  if (!data.records || !data.records.length) {
    throw new Error('Flow not found for id ' + flowId);
  }
  _flowMetadataCache[flowId] = { record: data.records[0], ts: Date.now() };
  return data.records[0];
}

// Turn a Flow's Metadata JSON into a compact, human-readable text representation
// that fits comfortably in a prompt. We preserve node names, types, key fields,
// and connectors; we drop layout, schema versioning, and locale strings.
function compactFlowMetadata(meta) {
  if (!meta) return '';
  var lines = [];

  // Start
  if (meta.start) {
    var s = meta.start;
    var parts = [];
    if (s.object) parts.push('object=' + s.object);
    if (s.recordTriggerType) parts.push('trigger=' + s.recordTriggerType);
    if (s.triggerType) parts.push('triggerType=' + s.triggerType);
    if (s.flowRunAsUser) parts.push('runAs=' + s.flowRunAsUser);
    lines.push('START [' + parts.join(', ') + ']');
    if (s.connector && s.connector.targetReference) lines.push('  → ' + s.connector.targetReference);
    if (s.filters && s.filters.length) {
      lines.push('  filters:');
      s.filters.forEach(function (f) {
        lines.push('    ' + (f.field || '?') + ' ' + (f.operator || '=') + ' ' + flattenValue(f.value));
      });
    }
    lines.push('');
  }

  function pushNodes(arr, type, render) {
    if (!arr || !arr.length) return;
    arr.forEach(function (n) {
      lines.push(type + ' ' + (n.name || '?'));
      render(n);
      if (n.connector && n.connector.targetReference) {
        lines.push('  → ' + n.connector.targetReference);
      }
      if (n.faultConnector && n.faultConnector.targetReference) {
        lines.push('  fault → ' + n.faultConnector.targetReference);
      }
      lines.push('');
    });
  }

  pushNodes(meta.decisions, 'DECISION', function (d) {
    (d.rules || []).forEach(function (r) {
      var conds = (r.conditions || []).map(function (c) {
        return (c.leftValueReference || '?') + ' ' + (c.operator || '=') + ' ' + flattenValue(c.rightValue);
      }).join(' AND ');
      var target = (r.connector && r.connector.targetReference) || '?';
      lines.push('  rule "' + (r.name || '') + '": ' + conds + ' → ' + target);
    });
    if (d.defaultConnector && d.defaultConnector.targetReference) {
      lines.push('  default → ' + d.defaultConnector.targetReference);
    }
  });

  pushNodes(meta.assignments, 'ASSIGNMENT', function (a) {
    (a.assignmentItems || []).forEach(function (it) {
      lines.push('  ' + (it.assignToReference || '?') + ' ' + (it.operator || '=') + ' ' + flattenValue(it.value));
    });
  });

  pushNodes(meta.recordLookups, 'RECORD_LOOKUP', function (n) {
    var parts = [];
    if (n.object) parts.push('object=' + n.object);
    if (n.outputReference) parts.push('out=' + n.outputReference);
    if (n.getFirstRecordOnly) parts.push('first');
    if (parts.length) lines.push('  ' + parts.join(', '));
    (n.filters || []).forEach(function (f) {
      lines.push('  filter: ' + (f.field || '?') + ' ' + (f.operator || '=') + ' ' + flattenValue(f.value));
    });
  });

  pushNodes(meta.recordCreates, 'RECORD_CREATE', function (n) {
    if (n.object) lines.push('  object=' + n.object);
    (n.inputAssignments || []).forEach(function (it) {
      lines.push('  ' + (it.field || '?') + ' = ' + flattenValue(it.value));
    });
  });

  pushNodes(meta.recordUpdates, 'RECORD_UPDATE', function (n) {
    if (n.object) lines.push('  object=' + n.object);
    if (n.inputReference) lines.push('  inputReference=' + n.inputReference);
    (n.filters || []).forEach(function (f) {
      lines.push('  filter: ' + (f.field || '?') + ' ' + (f.operator || '=') + ' ' + flattenValue(f.value));
    });
    (n.inputAssignments || []).forEach(function (it) {
      lines.push('  set ' + (it.field || '?') + ' = ' + flattenValue(it.value));
    });
  });

  pushNodes(meta.recordDeletes, 'RECORD_DELETE', function (n) {
    if (n.object) lines.push('  object=' + n.object);
    (n.filters || []).forEach(function (f) {
      lines.push('  filter: ' + (f.field || '?') + ' ' + (f.operator || '=') + ' ' + flattenValue(f.value));
    });
  });

  pushNodes(meta.actionCalls, 'ACTION_CALL', function (n) {
    var parts = [];
    if (n.actionType) parts.push('type=' + n.actionType);
    if (n.actionName) parts.push('action=' + n.actionName);
    if (parts.length) lines.push('  ' + parts.join(', '));
    (n.inputParameters || []).forEach(function (p) {
      lines.push('  in ' + (p.name || '?') + ' = ' + flattenValue(p.value));
    });
  });

  pushNodes(meta.screens, 'SCREEN', function (n) {
    (n.fields || []).forEach(function (f) {
      lines.push('  field ' + (f.name || '?') + ' (' + (f.fieldType || '?') + ')');
    });
  });

  pushNodes(meta.loops, 'LOOP', function (n) {
    if (n.collectionReference) lines.push('  collection=' + n.collectionReference);
    if (n.assignNextValueToReference) lines.push('  itemVar=' + n.assignNextValueToReference);
    if (n.nextValueConnector && n.nextValueConnector.targetReference) {
      lines.push('  nextValue → ' + n.nextValueConnector.targetReference);
    }
    if (n.noMoreValuesConnector && n.noMoreValuesConnector.targetReference) {
      lines.push('  done → ' + n.noMoreValuesConnector.targetReference);
    }
  });

  // Formulas, variables, constants — names + dataType only
  if (meta.formulas && meta.formulas.length) {
    lines.push('FORMULAS');
    meta.formulas.forEach(function (f) {
      lines.push('  ' + f.name + ' (' + (f.dataType || '?') + ') = ' + (f.expression || '').replace(/\s+/g, ' ').slice(0, 200));
    });
    lines.push('');
  }

  if (meta.variables && meta.variables.length) {
    lines.push('VARIABLES');
    meta.variables.forEach(function (v) {
      var bits = [v.name, v.dataType || '?'];
      if (v.isCollection) bits.push('collection');
      if (v.isInput) bits.push('input');
      if (v.isOutput) bits.push('output');
      lines.push('  ' + bits.join(' / '));
    });
    lines.push('');
  }

  var out = lines.join('\n');
  var truncated = false;
  if (out.length > FLOW_DEBUG_MAX_COMPACT) {
    out = out.slice(0, FLOW_DEBUG_MAX_COMPACT) + '\n... [flow truncated for prompt size]';
    truncated = true;
  }
  return { text: out, truncated: truncated };
}

function flattenValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    if ('stringValue' in v) return JSON.stringify(v.stringValue);
    if ('numberValue' in v) return String(v.numberValue);
    if ('booleanValue' in v) return String(v.booleanValue);
    if ('elementReference' in v) return '{!' + v.elementReference + '}';
    if ('dateValue' in v) return v.dateValue;
    if ('dateTimeValue' in v) return v.dateTimeValue;
  }
  return JSON.stringify(v).slice(0, 80);
}

// Every object the flow reads, creates, updates, or deletes — plus the trigger
// object. Used to drive describe-grounding so the model can reference real
// fields and picklist values rather than guessing from the compact metadata.
function flowReferencedObjects(meta) {
  if (!meta) return [];
  var seen = {};
  if (meta.start && meta.start.object) seen[meta.start.object] = true;
  ['recordLookups', 'recordCreates', 'recordUpdates', 'recordDeletes'].forEach(function (key) {
    (meta[key] || []).forEach(function (n) { if (n.object) seen[n.object] = true; });
  });
  return Object.keys(seen);
}

// Field-grounding fetch. The compact flow text shows field references like
// `$Record.Industry = "Tech"`, but doesn't reveal the field's real picklist
// values, type, or whether it's a reference. With the describe in hand the
// model can spot a mismatch (e.g. "Technology" is a valid picklist value but
// "Tech" is not), and the structural validator (validateFlowFix) can reject
// fix steps that reference fields the trigger object doesn't have.
// Failures degrade silently — schema absence is better than blocking.
async function fetchFlowSchema(meta) {
  var empty = { describesByObject: {}, recordTypesByObject: {} };
  var names = flowReferencedObjects(meta);
  if (!names.length) return empty;

  var canFetchDescribe = typeof fetchDescribe === 'function';
  var canLoadRecordTypes = typeof loadRecordTypes === 'function';
  var canGetRecordTypes = typeof getRecordTypesFor === 'function';

  if (canLoadRecordTypes) {
    try { await loadRecordTypes(); } catch (_) {}
  }

  var pairs = await Promise.all(names.map(function (name) {
    if (!canFetchDescribe) return Promise.resolve([name, null]);
    return fetchDescribe(name).then(
      function (fields) { return [name, fields]; },
      function () { return [name, null]; }
    );
  }));

  var describesByObject = {};
  pairs.forEach(function (p) { describesByObject[p[0]] = p[1] ? { fields: p[1] } : { fields: null }; });

  var recordTypesByObject = {};
  if (canGetRecordTypes) {
    names.forEach(function (n) { recordTypesByObject[n] = getRecordTypesFor(n) || []; });
  }

  return { describesByObject: describesByObject, recordTypesByObject: recordTypesByObject };
}

function formatFlowSchemaAppendix(schema) {
  if (!schema) return '';
  var names = Object.keys(schema.describesByObject || {});
  if (!names.length) return '';
  if (!names.some(function (n) { return schema.describesByObject[n].fields; })) return '';

  var lines = [];
  lines.push('Schema for objects the flow touches. Use these exact field api names; quote picklist values verbatim; do not invent fields.');
  names.forEach(function (apiName) {
    var d = schema.describesByObject[apiName];
    var rts = (schema.recordTypesByObject && schema.recordTypesByObject[apiName]) || [];
    var header = apiName;
    if (rts.length) {
      header += '  [record types: ' + rts.map(function (r) { return r.developerName; }).join(', ') + ']';
    }
    lines.push(header);
    if (!d.fields) {
      lines.push('  (describe unavailable)');
      return;
    }
    d.fields.forEach(function (f) {
      var row = '  - ' + f.name + ' : ' + f.type;
      if (f.referenceTo && f.referenceTo.length) {
        row += ' → ' + f.referenceTo.join('|');
        if (f.relationshipName) row += ' [rel: ' + f.relationshipName + ']';
      }
      if (f.values && f.values.length) {
        row += ' [' + f.values.slice(0, 30).join(',') + ']';
      }
      if (f.label && f.label !== f.name) row += '  (' + f.label + ')';
      lines.push(row);
    });
  });
  return lines.join('\n');
}

// Collect every name in the flow metadata that the fix may legitimately
// reference: element names, decision-outcome rule names, wait-event names,
// screen field names, and resource names (variables, formulas, constants,
// choices, dynamic choice sets, text templates, stages).
function collectFlowNames(meta) {
  var elements = { Start: true };
  var ruleNames = {};
  var resources = {};
  if (!meta) return { names: elements, elements: elements, ruleNames: ruleNames, resources: resources };

  ['decisions', 'assignments', 'recordLookups', 'recordCreates', 'recordUpdates',
   'recordDeletes', 'actionCalls', 'screens', 'loops', 'subflows', 'waits',
   'steps', 'collectionProcessors'].forEach(function (k) {
    (meta[k] || []).forEach(function (n) { if (n && n.name) elements[n.name] = true; });
  });

  (meta.decisions || []).forEach(function (d) {
    (d.rules || []).forEach(function (r) { if (r && r.name) ruleNames[r.name] = true; });
  });
  (meta.waits || []).forEach(function (w) {
    (w.waitEvents || []).forEach(function (e) { if (e && e.name) ruleNames[e.name] = true; });
  });
  (meta.screens || []).forEach(function (s) {
    (s.fields || []).forEach(function (f) { if (f && f.name) resources[f.name] = true; });
  });

  ['variables', 'formulas', 'constants', 'choices', 'dynamicChoiceSets',
   'textTemplates', 'stages'].forEach(function (k) {
    (meta[k] || []).forEach(function (n) { if (n && n.name) resources[n.name] = true; });
  });

  var names = {};
  [elements, ruleNames, resources].forEach(function (m) {
    Object.keys(m).forEach(function (k) { names[k] = true; });
  });
  return { names: names, elements: elements, ruleNames: ruleNames, resources: resources };
}

// Structural validator for a parsed flow-debug response. Catches the kinds of
// hallucination the SOQL planner catches for @soql: references to elements,
// resources, or fields that simply don't exist in this flow. The fix may
// also reference siblings the validator can't see (record-type developer
// names on related objects, action names on standard actions, etc.), so we
// only fire on the high-confidence cases:
//
//   - Backtick-and-single-quoted names like `'Foo'` must be an element,
//     outcome, or resource defined in the metadata.
//   - {!$Record.<Field>} must be a field on the trigger object's describe.
//   - {!<Name>} (no $ prefix) must be a defined resource or element.
//
// Anything else passes — false positives here burn retries without improving
// the answer, and "missed a real error" simply leaves us where we'd be
// without the validator at all.
function validateFlowFix(parsed, meta, describesByObject) {
  if (!parsed || !meta) return { ok: true, errors: [] };
  var pieces = [];
  if (Array.isArray(parsed.fix)) {
    parsed.fix.forEach(function (s) { if (typeof s === 'string') pieces.push(s); });
  }
  if (typeof parsed.rootCause === 'string') pieces.push(parsed.rootCause);
  if (typeof parsed.summary === 'string') pieces.push(parsed.summary);
  if (!pieces.length) return { ok: true, errors: [] };
  var allText = pieces.join('\n');

  var nameSets = collectFlowNames(meta);
  var allKnown = nameSets.names;

  var triggerObject = meta.start && meta.start.object;
  var triggerFields = {};
  if (triggerObject && describesByObject && describesByObject[triggerObject] && describesByObject[triggerObject].fields) {
    describesByObject[triggerObject].fields.forEach(function (f) {
      if (f && f.name) triggerFields[f.name.toLowerCase()] = f.name;
    });
  }

  var errors = [];
  var reportedName = {};
  var reportedRef = {};

  var elementRe = /`'([A-Za-z_][A-Za-z0-9_]*)'`/g;
  var m;
  while ((m = elementRe.exec(allText)) !== null) {
    if (reportedName[m[1]]) continue;
    reportedName[m[1]] = true;
    if (!allKnown[m[1]]) {
      var knownList = Object.keys(allKnown);
      errors.push('"' + m[1] + '" is not the name of any element, outcome, or resource in this flow. Known names: ' + knownList.slice(0, 30).join(', ') + (knownList.length > 30 ? ', …' : '') + '.');
    }
  }

  var refRe = /\{!([^}\s]+)\}/g;
  while ((m = refRe.exec(allText)) !== null) {
    var ref = m[1];
    if (reportedRef[ref]) continue;
    reportedRef[ref] = true;

    if (ref.charAt(0) === '$') {
      if (ref.indexOf('$Record.') !== 0) continue;
      if (!triggerObject || !Object.keys(triggerFields).length) continue;
      var fld = ref.substring('$Record.'.length).split(/[\.\[]/)[0];
      if (!fld) continue;
      if (!triggerFields[fld.toLowerCase()]) {
        var availFields = Object.values(triggerFields);
        errors.push('{!$Record.' + fld + '} does not exist on ' + triggerObject + '. Available fields include: ' + availFields.slice(0, 30).join(', ') + (availFields.length > 30 ? ', …' : '') + '.');
      }
      continue;
    }

    var topName = ref.split(/[\.\[]/)[0];
    if (!allKnown[topName]) {
      var resList = Object.keys(allKnown);
      errors.push('{!' + topName + '} is not a defined resource or element in this flow. Defined: ' + (resList.length ? resList.slice(0, 30).join(', ') + (resList.length > 30 ? ', …' : '') : '(none)') + '.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

function buildFlowDebugRetryMessage(baseMessage, attempts) {
  var lines = [baseMessage, '', 'Your previous response(s) referenced things that do not exist in this flow. Every prior attempt is rejected — do not repeat any of these mistakes:'];
  attempts.forEach(function (a, i) {
    lines.push('');
    lines.push('Attempt ' + (i + 1) + ' problems:');
    a.errors.forEach(function (e) { lines.push('  - ' + e); });
  });
  lines.push('');
  lines.push('Re-emit the JSON. Every backtick-and-single-quoted name like `\'Foo\'` must match an existing element, outcome, or resource. Every {!Resource} must be a defined resource; every {!$Record.<Field>} must be a real api name on the trigger object.');
  return lines.join('\n');
}

function buildFlowDebugSystemPrompt() {
  return [
    'You are a Salesforce Flow expert helping a consultant fix a flow in the Flow Builder UI.',
    'You receive: (1) a compact representation of a flow\'s structure, (2) the user\'s Debug-panel output from a debug run, (3) optionally what the user expected to happen, and (4) the describe schema for every object the flow touches.',
    'Your job: identify the actual execution path, locate where the flow failed or diverged from intent, and produce a fix the consultant can apply directly in Flow Builder.',
    '',
    'GROUNDING — when the schema appendix is present:',
    '- Reference only fields that appear in the schema. Do not invent fields.',
    '- When suggesting a picklist value, use one of the values listed in the schema verbatim. If the value the flow compares to does not appear in the picklist, that mismatch itself is often the root cause.',
    '- When pointing at a record-type filter, use a DeveloperName shown in the schema.',
    '',
    'TERMINOLOGY — your fix MUST use Flow Builder vocabulary, not programming terms:',
    '- Element types: "Decision", "Assignment", "Get Records", "Create Records", "Update Records", "Delete Records", "Loop", "Screen", "Action", "Subflow", "Pause/Wait", "Start" (the trigger element). Map metadata internals (recordLookups → "Get Records", recordUpdates → "Update Records", actionCalls → "Action", etc.).',
    '- A Decision\'s branches are called "Outcomes". Each Outcome has a name and one or more conditions.',
    '- Refer to fields by their object and API name, e.g. "Account.Industry".',
    '- Refer to resources with {!ResourceName} syntax: {!$Record}, {!$User}, {!myVar}, {!myFormula}.',
    '- Use Flow Builder operator names: "Equals", "Does Not Equal", "Greater Than", "Less Than", "Is Null", "Is Changed", "Contains", "Starts With", "In" — not "==", "!=", "&&", "||".',
    '- Never write Apex, JavaScript, or pseudocode. The only exception is if the fix is to edit a Formula resource — then write the formula in Salesforce formula syntax (ISBLANK, AND, OR, IF, TEXT, etc.).',
    '',
    'FIX FORMAT — return the fix as an ARRAY of short steps. Each step is one Flow Builder action, written so a consultant can perform it without further interpretation.',
    'Use backticks around any of: resource references (e.g. `{!$Record.Industry}`), Flow Builder operator names (e.g. `Is Null`, `Equals`), Flow Builder field labels (e.g. `Resource`, `Operator`, `Value`), and quoted element names (e.g. `\'Set Segment\'`).',
    'Example fix array:',
    '["Open the `\'Set Segment\'` Decision element.", "Click `+ New Outcome` and label it `Has Industry`.", "Set `Resource` = `{!$Record.Industry}`, `Operator` = `Is Null`, `Value` = `{!$GlobalConstant.False}`.", "Drag this Outcome above the existing `Tier1` outcome.", "Connect this Outcome to the `\'Assign Tier1\'` Assignment element."]',
    'Reference real element names from the flow structure provided — do not invent names. Do NOT include numbering inside the strings; the UI numbers them.',
    '',
    'Reply with ONLY a JSON object on a single line, no prose, no code fences:',
    '{"summary":"one short sentence describing what happened","rootCause":"the specific Flow Builder element and condition that caused the issue","fix":["step1","step2","..."]}'
  ].join('\n');
}

function buildFlowDebugUserMessage(flowLabel, compactFlow, debugText, expectation, schemaAppendix) {
  var lines = [];
  lines.push('Flow: ' + (flowLabel || '(unnamed)'));
  lines.push('');
  lines.push('Flow structure:');
  lines.push(compactFlow);
  lines.push('');
  lines.push('Debug panel output:');
  lines.push(debugText || '(none provided)');
  if (expectation && expectation.trim()) {
    lines.push('');
    lines.push('User expected: ' + expectation.trim());
  }
  if (schemaAppendix && schemaAppendix.trim()) {
    lines.push('');
    lines.push(schemaAppendix);
  }
  return lines.join('\n');
}

var FLOW_DEBUG_VALIDATE_RETRIES = 2; // additional attempts after the first response

async function analyzeFlowDebug(flowId, debugText, expectation) {
  if (!flowId) throw new Error('No flowId in URL');
  if (!debugText || !debugText.trim()) throw new Error('Paste the Debug panel output first');

  var record = null;
  var compact = { text: '', truncated: false };
  try {
    record = await fetchFlowMetadata(flowId);
    compact = compactFlowMetadata(record.Metadata);
  } catch (e) {
    // Managed package flows often block metadata access — carry on with debug output only
  }

  var schema = { describesByObject: {}, recordTypesByObject: {} };
  var schemaAppendix = '';
  if (record && record.Metadata) {
    try {
      schema = await fetchFlowSchema(record.Metadata);
      schemaAppendix = formatFlowSchemaAppendix(schema);
    } catch (err) {
      console.warn('sfnav: flow schema grounding failed —', err.message);
    }
  }

  var flowLabel = record ? record.MasterLabel : flowId.replace(/-\d+$/, '');
  var sysPrompt = buildFlowDebugSystemPrompt();
  var baseUserMsg = buildFlowDebugUserMessage(flowLabel, compact.text || '(flow structure unavailable — analyze based on debug output only)', debugText, expectation, schemaAppendix);

  var userMsg = baseUserMsg;
  var attempts = [];
  var parsed = null;

  for (var attempt = 0; attempt <= FLOW_DEBUG_VALIDATE_RETRIES; attempt++) {
    var raw = await callClaude(sysPrompt, userMsg, { cacheSystem: true });
    parsed = parseFlowDebugResponse(raw);

    var validation = validateFlowFix(parsed, record && record.Metadata, schema.describesByObject);
    if (validation.ok) {
      parsed.flowLabel = flowLabel;
      parsed.truncated = compact.truncated;
      return parsed;
    }

    attempts.push({ fix: parsed.fix, errors: validation.errors });
    userMsg = buildFlowDebugRetryMessage(baseUserMsg, attempts);
  }

  // Exhausted retries — return the last response but surface the diagnostics
  // so the UI (or eval harness) can flag that the model couldn't ground.
  parsed.flowLabel = flowLabel;
  parsed.truncated = compact.truncated;
  parsed.validationErrors = attempts.length ? attempts[attempts.length - 1].errors : null;
  return parsed;
}

function parseFlowDebugResponse(text) {
  if (!text) throw new Error('Empty response');
  var cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var start = cleaned.indexOf('{');
  var end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Could not parse response: ' + text.slice(0, 120));
  var json = cleaned.slice(start, end + 1);
  try {
    var obj = JSON.parse(json);
    if (!obj.summary && !obj.rootCause && !obj.fix) throw new Error('Response missing required fields');
    // Normalize fix → array of strings. Older / fallback responses may return a single string.
    if (typeof obj.fix === 'string') {
      var s = obj.fix.trim();
      if (s) {
        // Split on patterns like "1. ", "2. " at the start or after whitespace.
        var parts = s.split(/\s*(?:\n|^)\s*\d+\.\s+/).filter(Boolean);
        if (parts.length <= 1) parts = s.split(/(?:^|\s)\d+\.\s+/).filter(Boolean);
        obj.fix = parts.length ? parts.map(function (p) { return p.trim(); }) : [s];
      } else {
        obj.fix = [];
      }
    } else if (!Array.isArray(obj.fix)) {
      obj.fix = [];
    }
    return obj;
  } catch (e) {
    throw new Error('Invalid JSON in response: ' + e.message);
  }
}
