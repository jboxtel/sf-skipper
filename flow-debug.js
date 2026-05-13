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

  var record = null;
  var compact = { text: '', truncated: false };
  try {
    record = await fetchFlowMetadata(flowId);
    compact = compactFlowMetadata(record.Metadata);
  } catch (e) {
    // Managed package flows often block metadata access — carry on with debug output only
  }

  var flowLabel = record ? record.MasterLabel : flowId.replace(/-\d+$/, '');
  var sysPrompt = buildFlowDebugSystemPrompt();
  var userMsg = buildFlowDebugUserMessage(flowLabel, compact.text || '(flow structure unavailable — analyze based on debug output only)', debugText, expectation);

  var raw = await callClaude(sysPrompt, userMsg);
  var parsed = parseFlowDebugResponse(raw);
  parsed.flowLabel = flowLabel;
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
