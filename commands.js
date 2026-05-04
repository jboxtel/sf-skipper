function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0, score = 0, lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastMatch === ti - 1 ? 2 : 1;
      lastMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

function fuzzyFilter(query, items, getLabel) {
  return items
    .map(item => ({ item, score: fuzzyScore(query, getLabel(item)) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.item);
}

function toObjectResult(obj) {
  return {
    label: obj.label,
    sublabel: obj.isCustom ? obj.apiName : 'Standard Object',
    url: `${getObjectManagerBase()}/${obj.apiName}/view`,
    type: 'object',
    object: obj,
  };
}

function toQuickLinkResult(link) {
  return {
    label: link.label,
    sublabel: 'Setup',
    url: link.url(),
    type: 'setup',
  };
}

function toAppResult(app) {
  return {
    label: app.label,
    sublabel: app.namespace ? app.namespace + '__' + app.durableId : 'Lightning App',
    url: getOrgBase() + '/lightning/app/' + app.durableId,
    type: 'app',
  };
}

function toFlowResult(flow) {
  return {
    label: flow.label,
    sublabel: flow.isActive ? 'Active Flow' : 'Inactive Flow',
    url: getOrgBase() + '/builder_platform_interaction/flowBuilder.app?flowId=' + (flow.versionId || flow.id),
    type: 'flow',
  };
}

function toSubPageResult(page, object) {
  return {
    label: page.label,
    sublabel: object.label,
    url: buildObjectSubPageUrl(object.apiName, page.segment),
    type: 'subpage',
  };
}

var SOQL_ACTION = {
  label: '@soql',
  sublabel: 'Ask a data question',
  url: '#',
  type: 'action',
  action: 'soql-generator',
};

var FLOW_DEBUG_ACTION = {
  label: '@debug',
  sublabel: 'Analyze a flow with Claude',
  url: '#',
  type: 'action',
  action: 'flow-debug',
};

function makeHeader(label) {
  return { label: label, type: 'header' };
}

function getRootResults() {
  var results = [];

  // ── Browse ──
  results.push(makeHeader('Browse'));
  results.push({ label: '@object',   sublabel: 'All standard & custom objects', url: '#', type: 'shortcut', keyword: 'object' });
  results.push({ label: '@flow',     sublabel: 'All org flows',                 url: '#', type: 'shortcut', keyword: 'flow' });
  results.push({ label: '@app',      sublabel: 'All installed Lightning apps',  url: '#', type: 'shortcut', keyword: 'app' });
  results.push({ label: '@cmd',      sublabel: 'Custom metadata types',         url: '#', type: 'shortcut', keyword: 'cmd' });

  // ── AI Tools ──
  results.push(makeHeader('AI Tools'));
  results.push(SOQL_ACTION);
  var onFlowPage = typeof isFlowBuilderPage === 'function' && isFlowBuilderPage();
  results.push({
    label: FLOW_DEBUG_ACTION.label,
    sublabel: onFlowPage ? FLOW_DEBUG_ACTION.sublabel : 'Open a flow first',
    url: FLOW_DEBUG_ACTION.url,
    type: FLOW_DEBUG_ACTION.type,
    action: FLOW_DEBUG_ACTION.action,
    disabled: !onFlowPage,
  });

  // ── Setup ──
  results.push(makeHeader('Setup'));
  SETUP_QUICK_LINKS.slice(0, 8).forEach(function (link) {
    results.push(toQuickLinkResult(link));
  });

  return results;
}

function getShortcutResults() {
  var results = [];

  results.push(makeHeader('Browse'));
  results.push({ label: '@object',   sublabel: 'All standard & custom objects', url: '#', type: 'shortcut', keyword: 'object' });
  results.push({ label: '@flow',     sublabel: 'All org flows',                 url: '#', type: 'shortcut', keyword: 'flow' });
  results.push({ label: '@app',      sublabel: 'All installed Lightning apps',  url: '#', type: 'shortcut', keyword: 'app' });
  results.push({ label: '@cmd',      sublabel: 'Custom metadata types',         url: '#', type: 'shortcut', keyword: 'cmd' });

  results.push(makeHeader('AI Tools'));
  results.push({ label: '@soql',     sublabel: 'Ask a data question',           url: '#', type: 'shortcut', keyword: 'soql' });
  results.push({ label: '@debug',    sublabel: 'Analyze a flow with Claude',    url: '#', type: 'shortcut', keyword: 'flow-debug' });

  results.push(makeHeader('Maintenance'));
  results.push({ label: '@refresh',  sublabel: 'Reload cached metadata',        url: '#', type: 'shortcut', keyword: 'refresh' });

  return results;
}

function isOnObjectManagerPage() {
  return window.location.pathname.includes('/ObjectManager');
}

// Flow picker mode: filter across all flows only
function resolveFlowPicker(filter) {
  const allFlows = getAllFlows();
  const filtered = filter
    ? fuzzyFilter(filter, allFlows, f => f.label + ' ' + f.apiName)
    : allFlows;
  const count = filtered.length;
  return {
    mode: 'flow-picker',
    results: filtered.slice(0, 30).map(toFlowResult),
    hint: getFlowsState() === 'error'
      ? 'Failed to load flows: ' + getFlowsError()
      : allFlows.length === 0
        ? 'Loading flows…'
        : filter
          ? (count === 0 ? 'No flows match' : `${count} matching flow${count === 1 ? '' : 's'}`)
          : `${allFlows.length} flow${allFlows.length === 1 ? '' : 's'} — type to filter`,
  };
}

// App picker mode: filter across all Lightning apps
function resolveAppPicker(filter) {
  var allApps = getAllApps();
  var filtered = filter
    ? fuzzyFilter(filter, allApps, function (a) { return a.label + ' ' + a.durableId; })
    : allApps;
  var count = filtered.length;
  return {
    mode: 'app-picker',
    results: filtered.slice(0, 30).map(toAppResult),
    hint: getAppsState() === 'error'
      ? 'Failed to load apps: ' + getAppsError()
      : allApps.length === 0
        ? 'Loading apps…'
        : filter
          ? (count === 0 ? 'No apps match' : count + ' matching app' + (count === 1 ? '' : 's'))
          : allApps.length + ' app' + (allApps.length === 1 ? '' : 's') + ' — type to filter',
  };
}

// CMDT picker: filter across only custom metadata types (objects ending in __mdt)
function resolveCmdtPicker(filter) {
  var all = getAllCustomMetadataTypes();
  var filtered = filter
    ? fuzzyFilter(filter, all, function (o) { return o.label + ' ' + o.apiName; })
    : all;
  var count = filtered.length;
  return {
    mode: 'cmd-picker',
    results: filtered.slice(0, 30).map(function (o) {
      return {
        label: o.label,
        sublabel: o.apiName,
        url: '#',
        type: 'cmdt',
        cmdt: o,
      };
    }),
    hint: all.length === 0
      ? 'No custom metadata types found in your org cache yet — wait a moment for it to load'
      : filter
        ? (count === 0 ? 'No CMDTs match' : count + ' matching CMDT' + (count === 1 ? '' : 's'))
        : all.length + ' custom metadata type' + (all.length === 1 ? '' : 's') + ' — type to filter',
  };
}

// CMDT-scoped: select a destination for a chosen CMDT (Manage Records or Object Definition)
var CMDT_DESTINATIONS = [
  { label: 'Manage Records',    sublabel: 'Open the records list', action: 'records' },
  { label: 'Object Definition', sublabel: 'Open in Object Manager', action: 'definition' },
];

function resolveCmdtScoped(filter, cmdt) {
  var pages = filter
    ? fuzzyFilter(filter, CMDT_DESTINATIONS, function (p) { return p.label; })
    : CMDT_DESTINATIONS;
  return {
    mode: 'cmd-scoped',
    cmdt: cmdt,
    results: pages.map(function (p) {
      return {
        label: p.label,
        sublabel: cmdt.label,
        url: '#',
        type: 'cmdt-action',
        cmdt: cmdt,
        action: p.action,
      };
    }),
    hint: cmdt.label + ' — pick a destination',
  };
}

// Object picker mode: filter across all objects only
function resolveObjectPicker(filter) {
  const allObjects = getAllObjects();
  const filtered = filter
    ? fuzzyFilter(filter, allObjects, o => o.label + ' ' + o.apiName)
    : allObjects;
  const count = filtered.length;
  return {
    mode: 'object-picker',
    results: filtered.slice(0, 30).map(toObjectResult),
    hint: filter
      ? (count === 0 ? 'No objects match' : `${count} matching object${count === 1 ? '' : 's'}`)
      : `${allObjects.length} object${allObjects.length === 1 ? '' : 's'} — type to filter`,
  };
}

// Object-scoped mode: filter sub-pages for a specific object
function resolveObjectScoped(filter, object) {
  const pages = filter
    ? fuzzyFilter(filter, OBJECT_SUB_PAGES, p => p.label)
    : OBJECT_SUB_PAGES;
  return {
    mode: 'object-scoped',
    object: object,
    results: pages.map(page => toSubPageResult(page, object)),
    hint: `${object.label} — select a section`,
  };
}

function resolveInput(rawInput) {
  // Bare "@" → show the discoverable shortcut menu
  if (rawInput === '@') {
    return {
      mode: 'shortcuts',
      results: getShortcutResults(),
      hint: 'Pick a shortcut or keep typing to search',
    };
  }

  const input = rawInput.startsWith('@') ? rawInput.slice(1) : rawInput;

  if (input === '' || input === 'help') {
    return {
      mode: 'root',
      results: getRootResults(),
      hint: 'Search objects, flows, setup pages — or pick a category below',
    };
  }

  // "@flows" — hint to press Enter
  if (input.toLowerCase() === 'flows' || input.toLowerCase() === 'flow') {
    return {
      mode: 'flow-hint',
      results: [],
      hint: 'Press Enter to browse all flows',
    };
  }

  // "@app" / "@apps" — hint to press Enter to browse Lightning apps
  if (input.toLowerCase() === 'app' || input.toLowerCase() === 'apps') {
    return {
      mode: 'app-hint',
      results: [],
      hint: 'Press Enter to browse Lightning apps',
    };
  }

  // "@object" or "@objects" — hint to press Enter
  if (input.toLowerCase() === 'object' || input.toLowerCase() === 'objects') {
    return {
      mode: 'object-hint',
      results: [],
      hint: 'Press Enter to browse all objects',
    };
  }

  // "@cmd" / "@cmdt" / "@mdt" — hint to press Enter to browse CMDTs
  var lc = input.toLowerCase();
  if (lc === 'cmd' || lc === 'cmdt' || lc === 'mdt') {
    return {
      mode: 'cmd-hint',
      results: [],
      hint: 'Press Enter to browse custom metadata types',
    };
  }

  // "@soql" — hint to press Enter
  if (input.toLowerCase() === 'soql') {
    return {
      mode: 'soql-hint',
      results: [SOQL_ACTION],
      hint: 'Press Enter to open the SOQL generator',
    };
  }

  // "@refresh" — hint to press Enter to refetch flow + object caches
  if (lc === 'refresh' || lc === 'reload') {
    return {
      mode: 'refresh-hint',
      results: [],
      hint: 'Press Enter to refresh the flow + object caches',
    };
  }

  // "@debug" or "@flow-debug" — hint to press Enter
  var lower = input.toLowerCase();
  if (lower === 'debug' || lower === 'flow-debug') {
    var onFlow = typeof isFlowBuilderPage === 'function' && isFlowBuilderPage();
    return {
      mode: 'flow-debug-hint',
      results: [FLOW_DEBUG_ACTION],
      hint: onFlow ? 'Press Enter to debug this flow' : 'Open a flow first — then press Enter to debug it',
    };
  }

  // Fallback: fuzzy search across everything
  const allObjects = getAllObjects();
  const setupResults = fuzzyFilter(input, SETUP_QUICK_LINKS, l => l.label).map(toQuickLinkResult);
  const objectResults = fuzzyFilter(input, allObjects, o => o.label + ' ' + o.apiName).map(toObjectResult);

  // Interleave: setup first (usually more specific), then objects
  const merged = [];
  const maxLen = Math.max(setupResults.length, objectResults.length);
  for (let i = 0; i < maxLen; i++) {
    if (setupResults[i]) merged.push(setupResults[i]);
    if (objectResults[i]) merged.push(objectResults[i]);
  }

  return {
    mode: 'search',
    results: merged.slice(0, 20),
    hint: merged.length === 0 ? 'No results found' : '',
  };
}
