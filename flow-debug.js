// Flow Debug Assistant — fetch the active flow's metadata via Tooling API,
// combine with the user's pasted Debug-panel output, and ask Claude to
// identify what went wrong and how to fix it.

var FLOW_DEBUG_MAX_COMPACT = 8000; // compact metadata is truncated past this size

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

async function fetchFlowMetadata(flowId) {
  var pre = await sfRestPreamble();
  var soql = "SELECT Id, DefinitionId, MasterLabel, Metadata FROM Flow WHERE Id = '" + flowId.replace(/'/g, "\\'") + "'";
  var url = pre.apiBase + pre.basePath + '/tooling/query/?q=' + encodeURIComponent(soql);
  var resp = await fetch(url, { headers: pre.headers });
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

function buildFlowDebugSystemPrompt() {
  return [
    'You are a Salesforce Flow expert helping a consultant fix a flow in the Flow Builder UI.',
    'You receive: (1) a compact representation of a flow\'s structure, (2) the user\'s Debug-panel output from a debug run, and (3) optionally what the user expected to happen.',
    'Your job: identify the actual execution path, locate where the flow failed or diverged from intent, and produce a fix the consultant can apply directly in Flow Builder.',
    '',
    'TERMINOLOGY — your fix MUST use Flow Builder vocabulary, not programming terms:',
    '- Element types: "Decision", "Assignment", "Get Records", "Create Records", "Update Records", "Delete Records", "Loop", "Screen", "Action", "Subflow", "Pause/Wait", "Start" (the trigger element). Map metadata internals (recordLookups → "Get Records", recordUpdates → "Update Records", actionCalls → "Action", etc.).',
    '- A Decision\'s branches are called "Outcomes". Each Outcome has a name and one or more conditions.',
    '- Refer to fields by their object and API name, e.g. "Account.Industry".',
    '- Refer to resources with {!ResourceName} syntax: {!$Record}, {!$User}, {!myVar}, {!myFormula}.',
    '- Use Flow Builder operator names: "Equals", "Does Not Equal", "Greater Than", "Less Than", "Is Null", "Is Changed", "Contains", "Starts With", "In" — not "==", "!=", "&&", "||".',
    '- Never write Apex, JavaScript, or pseudocode. The only exception is if the fix is to edit a Formula resource — then write the formula in Salesforce formula syntax (ISBLANK, AND, OR, IF, TEXT, etc.).',
    '',
    'FIX FORMAT — write the fix as numbered Flow Builder steps a consultant can follow:',
    '"1. Open the \'<Element Name>\' Decision element. 2. Click \'+ New Outcome\'. 3. Label it \'<name>\'. 4. Set Resource = {!$Record.Industry}, Operator = Is Null, Value = {!$GlobalConstant.False}. 5. Connect this Outcome to \'<Next Element Name>\'."',
    'Reference real element names from the flow structure provided — do not invent names.',
    '',
    'PATH — list the actual element names traversed during the debug run (from Start to the failure or end), as they appear in the flow structure.',
    '',
    'Reply with ONLY a JSON object on a single line, no prose, no code fences:',
    '{"summary":"one short sentence","rootCause":"the specific Flow Builder element and condition that caused the issue","fix":"numbered Flow Builder steps","path":["element1","element2","..."]}'
  ].join('\n');
}

function buildFlowDebugUserMessage(flowLabel, compactFlow, debugText, expectation) {
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
  return lines.join('\n');
}

async function analyzeFlowDebug(flowId, debugText, expectation) {
  if (!flowId) throw new Error('No flowId in URL');
  if (!debugText || !debugText.trim()) throw new Error('Paste the Debug panel output first');

  var record = await fetchFlowMetadata(flowId);
  var compact = compactFlowMetadata(record.Metadata);

  var sysPrompt = buildFlowDebugSystemPrompt();
  var userMsg = buildFlowDebugUserMessage(record.MasterLabel, compact.text, debugText, expectation);

  var raw = await callClaude(sysPrompt, userMsg);
  var parsed = parseFlowDebugResponse(raw);
  parsed.flowLabel = record.MasterLabel;
  parsed.truncated = compact.truncated;
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
    if (!obj.summary && !obj.rootCause) throw new Error('Response missing required fields');
    if (!Array.isArray(obj.path)) obj.path = [];
    return obj;
  } catch (e) {
    throw new Error('Invalid JSON in response: ' + e.message);
  }
}
