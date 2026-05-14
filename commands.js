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

function toLabelResult(label) {
  var displayLabel = label.label || label.name;
  var preview = (label.value || '').replace(/\s+/g, ' ').trim();
  if (preview.length > 80) preview = preview.slice(0, 77) + '…';
  // When MasterLabel == Name, the API name on the left already identifies the label;
  // surface the value. When they differ, the API name disambiguates instead.
  var sub = displayLabel === label.name ? preview : label.name;
  return {
    label: displayLabel,
    sublabel: sub,
    url: getOrgBase() + '/lightning/setup/ExternalStrings/page?address=%2F' + encodeURIComponent(label.id),
    type: 'label',
    customLabel: label,
  };
}

function toPermsetResult(ps) {
  var sub = ps.namespace ? (ps.namespace + '__' + ps.name) : ps.name;
  return {
    label: ps.label,
    sublabel: sub,
    url: getOrgBase() + '/lightning/setup/PermSets/page?address=%2F' + encodeURIComponent(ps.id),
    type: 'permset',
    permset: ps,
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

// One declarative table for every @keyword shortcut. Adding a new shortcut
// means one row here plus a case in enterShortcutMode (content.js). The
// `aliases` field is space-separated so the existing 1-word lookup stays
// trivial; `action` is set on rows that fire a panel/action (vs. opening a
// picker). `disabledHint` covers the @debug case that depends on the active
// page.
var SHORTCUTS = [
  { id: 'object',     aliases: 'object objects',         label: '@object',   sublabel: 'All standard & custom objects', group: 'browse',      hint: 'Press Enter to browse all objects' },
  { id: 'flow',       aliases: 'flow flows',             label: '@flow',     sublabel: 'All org flows',                 group: 'browse',      hint: 'Press Enter to browse all flows' },
  { id: 'app',        aliases: 'app apps',               label: '@app',      sublabel: 'All installed Lightning apps',  group: 'browse',      hint: 'Press Enter to browse Lightning apps' },
  { id: 'cmd',        aliases: 'cmd cmdt mdt',           label: '@cmd',      sublabel: 'Custom metadata types',         group: 'browse',      hint: 'Press Enter to browse custom metadata types' },
  { id: 'label',      aliases: 'label labels',           label: '@label',    sublabel: 'Custom labels',                 group: 'browse',      hint: 'Press Enter to browse custom labels' },
  { id: 'permset',    aliases: 'permset permsets ps',    label: '@permset',  sublabel: 'Permission sets',               group: 'browse',      hint: 'Press Enter to browse permission sets' },
  { id: 'setup',      aliases: 'setup',                  label: '@setup',    sublabel: 'All setup quick links',         group: 'browse',      hint: 'Press Enter to browse all setup pages' },
  { id: 'ask',        aliases: 'ask',                    label: '@ask',      sublabel: 'Ask Claude about this screen',  group: 'ai',          action: 'ask',            hint: 'Press Enter to ask Claude about this screen' },
  { id: 'soql',       aliases: 'soql',                   label: '@soql',     sublabel: 'Ask a data question',           group: 'ai',          action: 'soql-generator', hint: 'Press Enter to open the SOQL generator' },
  { id: 'flow-debug', aliases: 'debug flow-debug',       label: '@debug',    sublabel: 'Analyze a flow with Claude',    group: 'ai',          action: 'flow-debug',     hint: 'Press Enter to debug this flow', disabledHint: 'Open a flow first — then press Enter to debug it', disabledSublabel: 'Open a flow first' },
  { id: 'refresh',    aliases: 'refresh reload',         label: '@refresh',  sublabel: 'Reload cached metadata',        group: 'maintenance', action: 'refresh',        hint: 'Press Enter to refresh the flow + object caches' }
];

function sfnavFindShortcut(value) {
  var input = String(value || '').trim().replace(/^@/, '').toLowerCase();
  if (!input) return null;
  return SHORTCUTS.find(function (s) { return s.aliases.split(' ').indexOf(input) !== -1; }) || null;
}

function sfnavGetShortcutsByGroup(group) {
  return SHORTCUTS.filter(function (s) { return s.group === group; });
}

// Parse `@flow foo` / `@cmd bar` into {shortcut, filter}. Returns null if the
// keyword isn't a known shortcut.
function sfnavParseShortcutInvocation(value) {
  // Leading-only normalization — preserve the trailing space so `@object `
  // (just the keyword + space, no filter yet) still triggers the picker.
  var normalized = String(value || '').replace(/^\s+/, '').replace(/^@/, '');
  var match = normalized.match(/^(\S+)\s+(.*)$/);
  if (!match) return null;
  var shortcut = sfnavFindShortcut(match[1]);
  return shortcut ? { shortcut: shortcut, filter: match[2] } : null;
}

function makeShortcutResult(shortcut, type) {
  return {
    label: shortcut.label,
    sublabel: shortcut.sublabel,
    url: '#',
    type: type || (shortcut.action ? 'action' : 'shortcut'),
    keyword: shortcut.id,
    action: shortcut.action
  };
}

function makeHeader(label) {
  return { label: label, type: 'header' };
}

function appendShortcutGroup(results, headerLabel, group, type) {
  results.push(makeHeader(headerLabel));
  sfnavGetShortcutsByGroup(group).forEach(function (shortcut) {
    results.push(makeShortcutResult(shortcut, type));
  });
}

// Kept for backwards compat with code that imports these names directly.
var SOQL_ACTION       = makeShortcutResult(sfnavFindShortcut('soql'),       'action');
var ASK_ACTION        = makeShortcutResult(sfnavFindShortcut('ask'),        'action');
var FLOW_DEBUG_ACTION = makeShortcutResult(sfnavFindShortcut('flow-debug'), 'action');

function getRootResults() {
  var results = [];

  appendShortcutGroup(results, 'Browse', 'browse', 'shortcut');

  // AI Tools render as 'action' (Enter runs the panel, not a picker) and
  // @debug is disabled off a flow page.
  results.push(makeHeader('AI Tools'));
  sfnavGetShortcutsByGroup('ai').forEach(function (shortcut) {
    var result = makeShortcutResult(shortcut, 'action');
    if (shortcut.id === 'flow-debug') {
      var onFlowPage = typeof isFlowBuilderPage === 'function' && isFlowBuilderPage();
      if (!onFlowPage) {
        result.sublabel = shortcut.disabledSublabel || shortcut.sublabel;
        result.disabled = true;
      }
    }
    results.push(result);
  });

  results.push(makeHeader('Setup'));
  SETUP_QUICK_LINKS.slice(0, 8).forEach(function (link) {
    results.push(toQuickLinkResult(link));
  });

  return results;
}

function getShortcutResults() {
  var results = [];
  appendShortcutGroup(results, 'Browse', 'browse', 'shortcut');
  appendShortcutGroup(results, 'AI Tools', 'ai', 'shortcut');
  appendShortcutGroup(results, 'Maintenance', 'maintenance', 'shortcut');

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

// Custom Label picker mode: filter across all org Custom Labels
function resolveLabelPicker(filter) {
  var all = getAllLabels();
  var filtered = filter
    ? fuzzyFilter(filter, all, function (l) { return (l.label || '') + ' ' + l.name + ' ' + (l.value || ''); })
    : all;
  var count = filtered.length;
  return {
    mode: 'label-picker',
    results: filtered.slice(0, 30).map(toLabelResult),
    hint: getLabelsState() === 'error'
      ? 'Failed to load custom labels: ' + getLabelsError()
      : all.length === 0
        ? 'Loading custom labels…'
        : filter
          ? (count === 0 ? 'No custom labels match' : count + ' matching custom label' + (count === 1 ? '' : 's'))
          : all.length + ' custom label' + (all.length === 1 ? '' : 's') + ' — type to filter',
  };
}

// Permission Set picker mode: filter across all org Permission Sets
function resolvePermsetPicker(filter) {
  var all = getAllPermsets();
  var filtered = filter
    ? fuzzyFilter(filter, all, function (p) { return p.label + ' ' + p.name; })
    : all;
  var count = filtered.length;
  return {
    mode: 'permset-picker',
    results: filtered.slice(0, 30).map(toPermsetResult),
    hint: getPermsetsState() === 'error'
      ? 'Failed to load permission sets: ' + getPermsetsError()
      : all.length === 0
        ? 'Loading permission sets…'
        : filter
          ? (count === 0 ? 'No permission sets match' : count + ' matching permission set' + (count === 1 ? '' : 's'))
          : all.length + ' permission set' + (all.length === 1 ? '' : 's') + ' — type to filter',
  };
}

// Setup picker mode: filter across all setup quick links
function resolveSetupPicker(filter) {
  var filtered = filter
    ? fuzzyFilter(filter, SETUP_QUICK_LINKS, function (l) { return l.label; })
    : SETUP_QUICK_LINKS;
  var count = filtered.length;
  return {
    mode: 'setup-picker',
    results: filtered.slice(0, 30).map(toQuickLinkResult),
    hint: filter
      ? (count === 0 ? 'No setup pages match' : count + ' matching setup page' + (count === 1 ? '' : 's'))
      : SETUP_QUICK_LINKS.length + ' setup page' + (SETUP_QUICK_LINKS.length === 1 ? '' : 's') + ' — type to filter',
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

  const stripped = rawInput.startsWith('@') ? rawInput.slice(1) : rawInput;
  const input = stripped.trim();

  if (input === '' || input === 'help') {
    return {
      mode: 'root',
      results: getRootResults(),
      hint: 'Search objects, flows, setup pages — or pick a category below',
    };
  }

  // Exact shortcut keyword → its hint card. Action-bearing shortcuts (@soql,
  // @ask, @debug) also surface the action result so Enter has somewhere to
  // land.
  var shortcut = sfnavFindShortcut(input);
  if (shortcut) {
    var hint = shortcut.hint;
    if (shortcut.id === 'flow-debug') {
      var onFlow = typeof isFlowBuilderPage === 'function' && isFlowBuilderPage();
      hint = onFlow ? shortcut.hint : shortcut.disabledHint;
    }
    return {
      mode: shortcut.id + '-hint',
      results: shortcut.action && shortcut.id !== 'refresh'
        ? [makeShortcutResult(shortcut, 'action')]
        : [],
      hint: hint
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
