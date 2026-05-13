(function () {
  if (window !== window.top) return; // skip iframes
  if (window.__sfnavLoaded) { togglePalette(); return; } // already loaded — just toggle
  window.__sfnavLoaded = true;

  initCustomObjects(); // populate custom object cache from storage + URL + DOM
  initFlows();         // populate flow cache from storage + API
  initApps();          // populate Lightning app cache from storage + API
  initLabels();        // populate custom label cache from storage + Tooling API
  initPermsets();      // populate permission set cache from storage + REST API

  var paletteVisible = false;
  var selectedIndex = -1;
  var currentResults = [];
  var searchMode = 'root'; // 'root' | 'object-picker' | 'object-scoped' | 'flow-picker' | 'app-picker' | 'soql' | 'flow-debug' | 'cmd-picker' | 'cmd-scoped' | 'permset-picker'
  var scopedObject = null;
  var scopedCmdt = null;
  var objectPickerFilter = '';
  var flowPickerFilter = '';
  var appPickerFilter = '';
  var cmdtPickerFilter = '';
  var labelPickerFilter = '';
  var permsetPickerFilter = '';
  var soqlInFlight = false;
  var flowDebugInFlight = false;
  var askInFlight = false;

  function injectPalette() {
    if (document.getElementById('sfnav-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'sfnav-overlay';
    overlay.innerHTML =
      '<div id="sfnav-palette">' +
        '<div id="sfnav-breadcrumb"></div>' +
        '<input id="sfnav-input" type="text" placeholder="Search or pick a category below" autocomplete="off" spellcheck="false" />' +
        '<div id="sfnav-hint"></div>' +
        '<ul id="sfnav-results"></ul>' +
        '<div id="sfnav-soql" style="display:none">' +
          '<span id="sfnav-soql-apistat" class="sfnav-apistat"></span>' +
          '<div id="sfnav-soql-status"></div>' +
          '<pre id="sfnav-soql-output"></pre>' +
          '<div id="sfnav-soql-actions">' +
            '<button id="sfnav-soql-copy" class="sfnav-soql-btn-primary">Copy</button>' +
            '<button id="sfnav-soql-clear" class="sfnav-soql-btn-secondary">Clear</button>' +
          '</div>' +
          '<div id="sfnav-soql-history-label" class="sfnav-section-header">Recent</div>' +
          '<ul id="sfnav-soql-history"></ul>' +
        '</div>' +
        '<div id="sfnav-flowdebug" style="display:none">' +
          '<div id="sfnav-flowdebug-meta"></div>' +
          '<textarea id="sfnav-flowdebug-debug" placeholder="Paste the Debug panel output here…" spellcheck="false"></textarea>' +
          '<input id="sfnav-flowdebug-expectation" type="text" placeholder="Optional: what did you expect to happen?" autocomplete="off" />' +
          '<div id="sfnav-flowdebug-actions">' +
            '<button id="sfnav-flowdebug-run" class="sfnav-soql-btn-primary">Analyze <span class="sfnav-kbd">⌘↵</span></button>' +
            '<span id="sfnav-flowdebug-apistat" class="sfnav-apistat"></span>' +
          '</div>' +
          '<div id="sfnav-flowdebug-status"></div>' +
          '<div id="sfnav-flowdebug-output" style="display:none">' +
            '<div class="sfnav-flowdebug-section sfnav-flowdebug-summary"><span class="sfnav-flowdebug-label">Summary</span><div class="sfnav-flowdebug-body"></div></div>' +
            '<div class="sfnav-flowdebug-section sfnav-flowdebug-cause"><span class="sfnav-flowdebug-label">Root cause</span><div class="sfnav-flowdebug-body"></div></div>' +
            '<div class="sfnav-flowdebug-section sfnav-flowdebug-fix"><span class="sfnav-flowdebug-label">Suggested fix</span><ol class="sfnav-flowdebug-body sfnav-flowdebug-steps"></ol><button class="sfnav-flowdebug-copy">Copy fix</button></div>' +
          '</div>' +
        '</div>' +
        '<div id="sfnav-ask" style="display:none">' +
          '<div id="sfnav-ask-meta"></div>' +
          '<textarea id="sfnav-ask-question" placeholder="What’s happening here? Why this error? Anything you want to know about the current screen…" spellcheck="false"></textarea>' +
          '<div id="sfnav-ask-actions">' +
            '<button id="sfnav-ask-run" class="sfnav-soql-btn-primary">Ask <span class="sfnav-kbd">⌘↵</span></button>' +
            '<span id="sfnav-ask-apistat" class="sfnav-apistat"></span>' +
          '</div>' +
          '<div id="sfnav-ask-status"></div>' +
          '<ul id="sfnav-ask-activity" style="display:none"></ul>' +
          '<div id="sfnav-ask-output" style="display:none">' +
            '<div class="sfnav-ask-answer"></div>' +
            '<button class="sfnav-ask-copy">Copy answer</button>' +
          '</div>' +
        '</div>' +
        '<div id="sfnav-footer"><span id="sfnav-brand">Salesforce Commander</span><span id="sfnav-footer-hints"></span></div>' +
      '</div>';

    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) hidePalette();
    });

    var input = document.getElementById('sfnav-input');

    input.addEventListener('input', function () {
      var val = input.value;
      // From root, `@cmd foo` / `@flow foo` / `@object foo` jumps into the
      // matching picker with `foo` as the live filter. Triggers on the first
      // space after the keyword so users can keep typing without pressing Enter.
      if (searchMode === 'root') {
        var trimmed = val.replace(/^@/, '');
        var m = trimmed.match(/^(cmd|cmdt|mdt|flow|flows|object|objects|app|apps|label|labels|permset|permsets|ps|setup|soql|ask|debug|flow-debug)\s+(.*)$/i);
        if (m) {
          var kw = m[1].toLowerCase();
          var rest = m[2];
          if (kw === 'cmd' || kw === 'cmdt' || kw === 'mdt') { enterCmdPickerMode(rest); return; }
          if (kw === 'flow' || kw === 'flows')               { enterFlowPickerMode(rest); return; }
          if (kw === 'object' || kw === 'objects')           { enterObjectPickerMode(rest); return; }
          if (kw === 'app' || kw === 'apps')                 { enterAppPickerMode(rest); return; }
          if (kw === 'label' || kw === 'labels')             { enterLabelPickerMode(rest); return; }
          if (kw === 'permset' || kw === 'permsets' || kw === 'ps') { enterPermsetPickerMode(rest); return; }
          if (kw === 'setup')                                { enterSetupPickerMode(rest); return; }
          if (kw === 'soql')                                 { enterSoqlMode(); return; }
          if (kw === 'ask')                                  { enterAskMode(rest); return; }
          if (kw === 'debug' || kw === 'flow-debug')         { enterFlowDebugMode(); return; }
        }
      }
      if (searchMode === 'object-picker') {
        renderResults(resolveObjectPicker(val));
      } else if (searchMode === 'object-scoped') {
        renderResults(resolveObjectScoped(val, scopedObject));
      } else if (searchMode === 'flow-picker') {
        renderResults(resolveFlowPicker(val));
      } else if (searchMode === 'app-picker') {
        renderResults(resolveAppPicker(val));
      } else if (searchMode === 'cmd-picker') {
        renderResults(resolveCmdtPicker(val));
      } else if (searchMode === 'label-picker') {
        renderResults(resolveLabelPicker(val));
      } else if (searchMode === 'permset-picker') {
        renderResults(resolvePermsetPicker(val));
      } else if (searchMode === 'setup-picker') {
        renderResults(resolveSetupPicker(val));
      } else if (searchMode === 'cmd-scoped') {
        renderResults(resolveCmdtScoped(val, scopedCmdt));
      } else if (searchMode === 'soql') {
        // No live filtering; only react to Enter
      } else {
        renderResults(resolveInput(val));
      }
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown')       { e.preventDefault(); moveSelection(1); }
      else if (e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(-1); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); handleEnter(); }
      else if (e.key === 'Escape')     { e.preventDefault(); handleBack(); }
      else if (e.key === 'Backspace' && input.value === '') { e.preventDefault(); handleBack(); }
    });
  }

  function handleEnter() {
    if (searchMode === 'root') {
      var input = document.getElementById('sfnav-input');
      var keyword = input.value.trim().replace(/^@/, '').toLowerCase();
      if (keyword === 'object' || keyword === 'objects') {
        enterObjectPickerMode('');
        return;
      }
      if (keyword === 'flow' || keyword === 'flows') {
        enterFlowPickerMode('');
        return;
      }
      if (keyword === 'app' || keyword === 'apps') {
        enterAppPickerMode('');
        return;
      }
      if (keyword === 'soql') {
        enterSoqlMode();
        return;
      }
      if (keyword === 'ask') {
        enterAskMode('');
        return;
      }
      if (keyword === 'flow-debug' || keyword === 'debug') {
        enterFlowDebugMode();
        return;
      }
      if (keyword === 'cmd' || keyword === 'cmdt' || keyword === 'mdt') {
        enterCmdPickerMode('');
        return;
      }
      if (keyword === 'label' || keyword === 'labels') {
        enterLabelPickerMode('');
        return;
      }
      if (keyword === 'permset' || keyword === 'permsets' || keyword === 'ps') {
        enterPermsetPickerMode('');
        return;
      }
      if (keyword === 'setup') {
        enterSetupPickerMode('');
        return;
      }
      if (keyword === 'refresh' || keyword === 'reload') {
        runRefresh();
        return;
      }
    }
    if (searchMode === 'soql') {
      runSoqlGeneration();
      return;
    }
    if (searchMode === 'flow-debug') {
      // Enter inside the flow-debug panel = run the analyzer
      runFlowDebugAnalysis();
      return;
    }
    if (searchMode === 'ask') {
      runAskQuery();
      return;
    }
    navigateToSelected();
  }

  function handleBack() {
    switch (searchMode) {
      case 'object-scoped':
        enterObjectPickerMode(objectPickerFilter);
        return;
      case 'cmd-scoped':
        enterCmdPickerMode(cmdtPickerFilter);
        return;
      case 'object-picker':
      case 'flow-picker':
      case 'app-picker':
      case 'cmd-picker':
      case 'label-picker':
      case 'permset-picker':
      case 'setup-picker':
      case 'soql':
      case 'flow-debug':
      case 'ask':
        goToRoot();
        return;
      default:
        hidePalette();
    }
  }

  function goToRoot() {
    searchMode = 'root';
    scopedObject = null;
    scopedCmdt = null;
    objectPickerFilter = '';
    flowPickerFilter = '';
    appPickerFilter = '';
    cmdtPickerFilter = '';
    labelPickerFilter = '';
    permsetPickerFilter = '';
    hideSoqlPanel();
    setFooterHints('root');
    var breadcrumbEl = document.getElementById('sfnav-breadcrumb');
    if (breadcrumbEl) {
      breadcrumbEl.textContent = '';
      breadcrumbEl.style.display = 'none';
    }
    var input = document.getElementById('sfnav-input');
    if (input) {
      input.value = '';
      input.placeholder = 'Search or pick a category below';
      input.disabled = false;
      renderResults(resolveInput(''));
      input.focus();
    }
  }

  function enterObjectPickerMode(filterText) {
    searchMode = 'object-picker';
    scopedObject = null;
    var input = document.getElementById('sfnav-input');
    input.value = filterText || '';
    input.placeholder = 'Filter objects…';
    renderResults(resolveObjectPicker(filterText || ''));
    input.focus();
  }

  function enterObjectScopedMode(obj) {
    // Remember where we came from so ESC can restore it
    if (searchMode === 'object-picker') {
      objectPickerFilter = document.getElementById('sfnav-input').value;
    } else {
      objectPickerFilter = '';
    }
    searchMode = 'object-scoped';
    scopedObject = obj;
    var input = document.getElementById('sfnav-input');
    input.value = '';
    input.placeholder = 'Filter sections…';
    renderResults(resolveObjectScoped('', obj));
    input.focus();
  }

  function enterSoqlMode() {
    searchMode = 'soql';
    soqlHistoryExpanded = false;
    setFooterHints('soql');
    var input = document.getElementById('sfnav-input');
    input.value = '';
    input.placeholder = 'Describe what to query — e.g. all open cases assigned to me';
    document.getElementById('sfnav-results').style.display = 'none';
    document.getElementById('sfnav-hint').textContent = 'Press Enter to generate SOQL';
    document.getElementById('sfnav-breadcrumb').innerHTML =
      '<span class="sfnav-bc-seg">@soql</span> <span class="sfnav-bc-arrow">›</span>';
    document.getElementById('sfnav-breadcrumb').style.display = 'flex';
    document.getElementById('sfnav-soql').style.display = 'block';
    document.getElementById('sfnav-soql-status').textContent = '';
    document.getElementById('sfnav-soql-output').textContent = '';
    document.getElementById('sfnav-soql-actions').style.display = 'none';
    renderSoqlHistory();

    document.getElementById('sfnav-soql-copy').onclick = function () {
      var soql = document.getElementById('sfnav-soql-output').textContent;
      if (!soql) return;
      navigator.clipboard.writeText(soql).then(function () {
        var btn = document.getElementById('sfnav-soql-copy');
        var prev = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = prev; }, 1500);
      });
    };
    document.getElementById('sfnav-soql-clear').onclick = function () {
      document.getElementById('sfnav-input').value = '';
      document.getElementById('sfnav-soql-output').textContent = '';
      document.getElementById('sfnav-soql-status').textContent = '';
      document.getElementById('sfnav-soql-actions').style.display = 'none';
      document.getElementById('sfnav-input').focus();
    };

    hasSoqlApiKey().then(function (ok) {
      var el = document.getElementById('sfnav-soql-apistat');
      if (!el) return;
      if (ok) {
        el.textContent = 'API key connected';
        el.className = 'sfnav-apistat sfnav-apistat-ok';
      } else {
        el.innerHTML = 'No API key — <a href="#" class="sfnav-settings-link">configure in settings</a>';
        el.className = 'sfnav-apistat sfnav-apistat-missing';
        var link = el.querySelector('.sfnav-settings-link');
        if (link) link.onclick = function (e) { e.preventDefault(); openSoqlSettings(); };
      }
    });

    input.focus();
  }

  async function runSoqlGeneration() {
    if (soqlInFlight) return;
    var input = document.getElementById('sfnav-input');
    var prompt = input.value.trim();
    if (!prompt) return;

    var statusEl = document.getElementById('sfnav-soql-status');
    var outputEl = document.getElementById('sfnav-soql-output');
    var actionsEl = document.getElementById('sfnav-soql-actions');

    var hasKey = await hasSoqlApiKey();
    if (!hasKey) {
      statusEl.innerHTML = 'No API key configured. <a href="#" class="sfnav-settings-link">Open settings</a>.';
      statusEl.className = 'sfnav-soql-status-error';
      actionsEl.style.display = 'none';
      var link = statusEl.querySelector('.sfnav-settings-link');
      if (link) link.onclick = function (e) { e.preventDefault(); openSoqlSettings(); };
      return;
    }

    soqlInFlight = true;
    input.disabled = true;
    statusEl.textContent = 'Generating…';
    statusEl.className = 'sfnav-soql-status-loading';
    outputEl.textContent = '';
    actionsEl.style.display = 'none';

    try {
      var result = await generateSoql(prompt);
      outputEl.textContent = result.soql;
      statusEl.textContent = result.explanation || ('Object: ' + result.objectName);
      statusEl.className = 'sfnav-soql-status-ok';
      actionsEl.style.display = 'flex';
      addToSoqlHistory({ prompt: prompt, soql: result.soql, objectName: result.objectName }).then(renderSoqlHistory);
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.className = 'sfnav-soql-status-error';
      actionsEl.style.display = 'none';
      console.warn('sfnav: SOQL generation failed —', err);
    } finally {
      soqlInFlight = false;
      input.disabled = false;
      input.focus();
    }
  }

  var soqlHistoryExpanded = false;

  function renderSoqlHistory() {
    var listEl = document.getElementById('sfnav-soql-history');
    var labelEl = document.getElementById('sfnav-soql-history-label');
    if (!listEl || !labelEl) return;
    getSoqlHistory().then(function (history) {
      if (!history.length) {
        labelEl.style.display = 'none';
        listEl.style.display = 'none';
        listEl.innerHTML = '';
        return;
      }
      labelEl.style.display = 'block';
      listEl.style.display = 'block';
      listEl.innerHTML = '';

      var COLLAPSED = 3;
      var visible = soqlHistoryExpanded ? history : history.slice(0, COLLAPSED);

      visible.forEach(function (entry) {
        var li = document.createElement('li');
        li.className = 'sfnav-soql-history-item';
        li.innerHTML =
          '<span class="sfnav-soql-history-prompt">' + esc(entry.prompt) + '</span>' +
          '<span class="sfnav-soql-history-obj">' + esc(entry.objectName || '') + '</span>';
        li.addEventListener('click', function () {
          document.getElementById('sfnav-input').value = entry.prompt;
          document.getElementById('sfnav-soql-output').textContent = entry.soql;
          document.getElementById('sfnav-soql-status').textContent = 'From history — Enter to regenerate';
          document.getElementById('sfnav-soql-status').className = 'sfnav-soql-status-ok';
          document.getElementById('sfnav-soql-actions').style.display = 'flex';
        });
        listEl.appendChild(li);
      });

      if (history.length > COLLAPSED) {
        var moreLi = document.createElement('li');
        moreLi.className = 'sfnav-soql-history-more';
        moreLi.textContent = soqlHistoryExpanded
          ? 'Show less'
          : '… ' + (history.length - COLLAPSED) + ' more';
        moreLi.addEventListener('click', function () {
          soqlHistoryExpanded = !soqlHistoryExpanded;
          renderSoqlHistory();
        });
        listEl.appendChild(moreLi);
      }
    });
  }

  function enterFlowPickerMode(filterText) {
    searchMode = 'flow-picker';
    var input = document.getElementById('sfnav-input');
    input.value = filterText || '';
    input.placeholder = 'Filter flows…';
    renderResults(resolveFlowPicker(filterText || ''));
    input.focus();
  }

  function enterAppPickerMode(filterText) {
    searchMode = 'app-picker';
    var input = document.getElementById('sfnav-input');
    input.value = filterText || '';
    input.placeholder = 'Filter Lightning apps…';
    renderResults(resolveAppPicker(filterText || ''));
    input.focus();
  }

  function enterSetupPickerMode(filterText) {
    searchMode = 'setup-picker';
    var input = document.getElementById('sfnav-input');
    input.value = filterText || '';
    input.placeholder = 'Filter setup pages…';
    renderResults(resolveSetupPicker(filterText || ''));
    input.focus();
  }

  function enterLabelPickerMode(filterText) {
    searchMode = 'label-picker';
    var input = document.getElementById('sfnav-input');
    input.value = filterText || '';
    input.placeholder = 'Filter custom labels…';
    renderResults(resolveLabelPicker(filterText || ''));
    input.focus();
  }

  function enterPermsetPickerMode(filterText) {
    searchMode = 'permset-picker';
    var input = document.getElementById('sfnav-input');
    input.value = filterText || '';
    input.placeholder = 'Filter permission sets…';
    renderResults(resolvePermsetPicker(filterText || ''));
    input.focus();
  }

  function enterCmdPickerMode(filterText) {
    searchMode = 'cmd-picker';
    scopedCmdt = null;
    var input = document.getElementById('sfnav-input');
    input.value = filterText || '';
    input.placeholder = 'Filter custom metadata types…';
    renderResults(resolveCmdtPicker(filterText || ''));
    input.focus();
  }

  function enterCmdScopedMode(cmdt) {
    if (searchMode === 'cmd-picker') {
      cmdtPickerFilter = document.getElementById('sfnav-input').value;
    } else {
      cmdtPickerFilter = '';
    }
    searchMode = 'cmd-scoped';
    scopedCmdt = cmdt;
    var input = document.getElementById('sfnav-input');
    input.value = '';
    input.placeholder = 'Filter destinations…';
    renderResults(resolveCmdtScoped('', cmdt));
    input.focus();
  }

  function enterFlowDebugMode() {
    searchMode = 'flow-debug';
    setFooterHints('flow-debug');
    var input = document.getElementById('sfnav-input');
    var flowId = (typeof getFlowIdFromUrl === 'function') ? getFlowIdFromUrl() : null;

    input.value = '';
    input.placeholder = flowId ? 'Paste the Debug panel output below, then press ⌘↵' : 'Open a flow first to use this';
    document.getElementById('sfnav-results').style.display = 'none';
    document.getElementById('sfnav-hint').textContent = '';
    document.getElementById('sfnav-breadcrumb').innerHTML =
      '<span class="sfnav-bc-seg">@flow-debug</span> <span class="sfnav-bc-arrow">›</span>';
    document.getElementById('sfnav-breadcrumb').style.display = 'flex';
    document.getElementById('sfnav-flowdebug').style.display = 'flex';
    document.getElementById('sfnav-flowdebug-status').textContent = '';
    document.getElementById('sfnav-flowdebug-status').className = '';
    document.getElementById('sfnav-flowdebug-output').style.display = 'none';
    document.getElementById('sfnav-flowdebug-debug').value = '';
    document.getElementById('sfnav-flowdebug-expectation').value = '';

    var metaEl = document.getElementById('sfnav-flowdebug-meta');
    if (!flowId) {
      metaEl.innerHTML = '<em class="sfnav-flowdebug-warn">No flow detected on this page. Open a flow in the Flow Builder, then try again.</em>';
    } else if (typeof isManagedFlowId === 'function' && isManagedFlowId(flowId)) {
      metaEl.textContent = 'Managed package flow — paste the debug output and we\u2019ll analyze based on that alone.';
    } else {
      metaEl.textContent = 'Loading flow…';
      fetchFlowMetadata(flowId)
        .then(function (record) {
          if (searchMode !== 'flow-debug') return;
          metaEl.textContent = 'Flow: ' + (record.MasterLabel || flowId);
        })
        .catch(function (err) {
          if (searchMode !== 'flow-debug') return;
          metaEl.innerHTML = '<em class="sfnav-flowdebug-warn">Could not load flow: ' + esc(err.message) + '</em>';
        });
    }

    hasSoqlApiKey().then(function (ok) {
      var el = document.getElementById('sfnav-flowdebug-apistat');
      if (!el) return;
      if (ok) {
        el.textContent = 'API key connected';
        el.className = 'sfnav-apistat sfnav-apistat-ok';
      } else {
        el.innerHTML = 'No API key — <a href="#" class="sfnav-settings-link">configure in settings</a>';
        el.className = 'sfnav-apistat sfnav-apistat-missing';
        var link = el.querySelector('.sfnav-settings-link');
        if (link) link.onclick = function (e) { e.preventDefault(); openSoqlSettings(); };
      }
    });

    document.getElementById('sfnav-flowdebug-run').onclick = runFlowDebugAnalysis;

    // Submit on Cmd/Ctrl+Enter from inside the textarea (plain Enter keeps newline);
    // Escape steps back to root.
    var debugEl = document.getElementById('sfnav-flowdebug-debug');
    debugEl.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runFlowDebugAnalysis();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleBack();
      }
    });

    // Plain Enter from the expectation field submits (it's a single-line input);
    // Escape steps back.
    var expEl = document.getElementById('sfnav-flowdebug-expectation');
    expEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        runFlowDebugAnalysis();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleBack();
      }
    });

    debugEl.focus();
  }

  async function runFlowDebugAnalysis() {
    if (flowDebugInFlight) return;
    var debugEl = document.getElementById('sfnav-flowdebug-debug');
    var expEl = document.getElementById('sfnav-flowdebug-expectation');
    var statusEl = document.getElementById('sfnav-flowdebug-status');
    var outputEl = document.getElementById('sfnav-flowdebug-output');
    var runBtn = document.getElementById('sfnav-flowdebug-run');

    var flowId = (typeof getFlowIdFromUrl === 'function') ? getFlowIdFromUrl() : null;
    if (!flowId) {
      statusEl.textContent = 'No flow detected on this page.';
      statusEl.className = 'sfnav-flowdebug-status-error';
      return;
    }
    if (!debugEl.value.trim()) {
      statusEl.textContent = 'Paste the Debug panel output first.';
      statusEl.className = 'sfnav-flowdebug-status-error';
      return;
    }

    var hasKey = await hasSoqlApiKey();
    if (!hasKey) {
      statusEl.innerHTML = 'No API key configured. <a href="#" class="sfnav-settings-link">Open settings</a>.';
      statusEl.className = 'sfnav-flowdebug-status-error';
      var link = statusEl.querySelector('.sfnav-settings-link');
      if (link) link.onclick = function (e) { e.preventDefault(); openSoqlSettings(); };
      return;
    }

    flowDebugInFlight = true;
    runBtn.disabled = true;
    debugEl.disabled = true;
    expEl.disabled = true;
    statusEl.textContent = 'Fetching flow + analyzing…';
    statusEl.className = 'sfnav-flowdebug-status-loading';
    outputEl.style.display = 'none';

    try {
      var result = await analyzeFlowDebug(flowId, debugEl.value, expEl.value);
      renderFlowDebugResult(result);
      statusEl.textContent = result.flowLabel
        ? 'Analyzed: ' + result.flowLabel + (result.truncated ? ' (flow truncated)' : '')
        : 'Done';
      statusEl.className = 'sfnav-flowdebug-status-ok';
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.className = 'sfnav-flowdebug-status-error';
      outputEl.style.display = 'none';
      console.warn('sfnav: flow-debug analysis failed —', err);
    } finally {
      flowDebugInFlight = false;
      runBtn.disabled = false;
      debugEl.disabled = false;
      expEl.disabled = false;
    }
  }

  function renderFlowDebugResult(result) {
    var outputEl = document.getElementById('sfnav-flowdebug-output');
    var summarySec = outputEl.querySelector('.sfnav-flowdebug-summary');
    var causeSec   = outputEl.querySelector('.sfnav-flowdebug-cause');
    var fixSec     = outputEl.querySelector('.sfnav-flowdebug-fix');
    var summaryBody = summarySec.querySelector('.sfnav-flowdebug-body');
    var causeBody   = causeSec.querySelector('.sfnav-flowdebug-body');
    var fixList     = fixSec.querySelector('.sfnav-flowdebug-steps');
    var copyBtn     = fixSec.querySelector('.sfnav-flowdebug-copy');

    function setTextSection(sec, body, value) {
      var v = (value || '').trim();
      if (v) {
        body.textContent = v;
        sec.style.display = '';
      } else {
        body.textContent = '';
        sec.style.display = 'none';
      }
    }

    setTextSection(summarySec, summaryBody, result.summary);
    setTextSection(causeSec,   causeBody,   result.rootCause);

    var steps = Array.isArray(result.fix) ? result.fix.filter(function (s) { return s && s.trim(); }) : [];
    fixList.innerHTML = '';
    if (steps.length) {
      steps.forEach(function (step) {
        var li = document.createElement('li');
        li.innerHTML = renderInlineCode(step);
        fixList.appendChild(li);
      });
      fixSec.style.display = '';
    } else {
      fixSec.style.display = 'none';
    }

    copyBtn.onclick = function () {
      var text = steps.map(function (s, i) { return (i + 1) + '. ' + s.replace(/`/g, ''); }).join('\n');
      navigator.clipboard.writeText(text).then(function () {
        var prev = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = prev; }, 1500);
      });
    };

    outputEl.style.display = 'block';
  }

  function enterAskMode(initialQuestion) {
    searchMode = 'ask';
    setFooterHints('ask');
    var input = document.getElementById('sfnav-input');

    input.value = '';
    input.placeholder = 'Use the box below to describe what you’re seeing';
    input.disabled = true;
    document.getElementById('sfnav-results').style.display = 'none';
    document.getElementById('sfnav-hint').textContent = '';
    document.getElementById('sfnav-breadcrumb').innerHTML =
      '<span class="sfnav-bc-seg">@ask</span> <span class="sfnav-bc-arrow">›</span>';
    document.getElementById('sfnav-breadcrumb').style.display = 'flex';
    document.getElementById('sfnav-ask').style.display = 'flex';
    document.getElementById('sfnav-ask-status').textContent = '';
    document.getElementById('sfnav-ask-status').className = '';
    document.getElementById('sfnav-ask-output').style.display = 'none';
    var actEl = document.getElementById('sfnav-ask-activity');
    actEl.innerHTML = '';
    actEl.style.display = 'none';
    document.getElementById('sfnav-ask-question').value = initialQuestion || '';

    var metaEl = document.getElementById('sfnav-ask-meta');
    var ctx = (typeof getAskOrgContext === 'function') ? getAskOrgContext() : null;
    if (ctx) {
      var bits = [];
      if (ctx.pageType)  bits.push(ctx.pageType);
      if (ctx.sObject)   bits.push(ctx.sObject);
      if (ctx.setupNode) bits.push(ctx.setupNode);
      var line = bits.length ? 'Context: ' + bits.join(' · ') : 'Context: ' + ctx.host;
      if (ctx.pageType === 'record' && ctx.sObject && ctx.recordId) {
        line += ' · sending live record fields';
      }
      metaEl.textContent = line;
    } else {
      metaEl.textContent = '';
    }

    hasSoqlApiKey().then(function (ok) {
      var el = document.getElementById('sfnav-ask-apistat');
      if (!el) return;
      if (ok) {
        el.textContent = 'API key connected';
        el.className = 'sfnav-apistat sfnav-apistat-ok';
      } else {
        el.innerHTML = 'No API key — <a href="#" class="sfnav-settings-link">configure in settings</a>';
        el.className = 'sfnav-apistat sfnav-apistat-missing';
        var link = el.querySelector('.sfnav-settings-link');
        if (link) link.onclick = function (e) { e.preventDefault(); openSoqlSettings(); };
      }
    });

    document.getElementById('sfnav-ask-run').onclick = runAskQuery;

    var qEl = document.getElementById('sfnav-ask-question');
    qEl.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runAskQuery();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleBack();
      }
    });

    qEl.focus();
  }

  async function runAskQuery() {
    if (askInFlight) return;
    var qEl = document.getElementById('sfnav-ask-question');
    var statusEl = document.getElementById('sfnav-ask-status');
    var outputEl = document.getElementById('sfnav-ask-output');
    var runBtn = document.getElementById('sfnav-ask-run');
    var overlay = document.getElementById('sfnav-overlay');

    var question = qEl.value.trim();
    if (!question) {
      statusEl.textContent = 'Type a question first.';
      statusEl.className = 'sfnav-ask-status-error';
      return;
    }

    var hasKey = await hasSoqlApiKey();
    if (!hasKey) {
      statusEl.innerHTML = 'No API key configured. <a href="#" class="sfnav-settings-link">Open settings</a>.';
      statusEl.className = 'sfnav-ask-status-error';
      var link = statusEl.querySelector('.sfnav-settings-link');
      if (link) link.onclick = function (e) { e.preventDefault(); openSoqlSettings(); };
      return;
    }

    askInFlight = true;
    runBtn.disabled = true;
    qEl.disabled = true;
    statusEl.textContent = 'Capturing screen + loading record…';
    statusEl.className = 'sfnav-ask-status-loading';
    outputEl.style.display = 'none';

    // Hide the palette so it doesn't end up in the screenshot. We restore it as
    // soon as captureVisibleTab returns — well before the Claude round-trip.
    var prevDisplay = overlay.style.display;
    overlay.style.display = 'none';

    var restored = false;
    function restoreOverlay() {
      if (restored) return;
      restored = true;
      overlay.style.display = prevDisplay || 'flex';
    }

    var activityEl = document.getElementById('sfnav-ask-activity');
    activityEl.innerHTML = '';
    activityEl.style.display = 'none';

    try {
      // Force a paint frame so the screenshot doesn't catch a half-rendered overlay
      await new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(resolve); });
      });
      var result = await runAsk(question, function (event) {
        if (event.kind === 'captured') {
          restoreOverlay();
        } else if (event.kind === 'enriched') {
          var ctx = event.ctx;
          if (ctx && ctx.recordFields) {
            var n = Object.keys(ctx.recordFields).length;
            statusEl.textContent = 'Asking Claude (sent ' + n + ' record fields)…';
          } else {
            statusEl.textContent = 'Asking Claude…';
          }
        } else if (event.kind === 'tool_call') {
          appendAskActivity(activityEl, event);
          statusEl.textContent = 'Claude is investigating…';
        } else if (event.kind === 'tool_result') {
          updateLastAskActivity(activityEl, event);
        } else if (event.kind === 'interim_text') {
          appendAskInterim(activityEl, event.text);
        } else if (event.kind === 'escalate') {
          appendAskInterim(activityEl, 'Escalating to claude.ai — ' + event.reason);
        }
      });
      restoreOverlay();
      renderAskResult(result);
      statusEl.textContent = result.toolCallCount
        ? 'Done · ' + result.toolCallCount + ' tool call' + (result.toolCallCount === 1 ? '' : 's')
        : 'Done';
      statusEl.className = 'sfnav-ask-status-ok';
    } catch (err) {
      restoreOverlay();
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.className = 'sfnav-ask-status-error';
      outputEl.style.display = 'none';
      console.warn('sfnav: ask failed —', err);
    } finally {
      askInFlight = false;
      runBtn.disabled = false;
      qEl.disabled = false;
      qEl.focus();
    }
  }

  // Human-readable label for each tool. Kept in content.js (not ask.js) so the
  // labelling lives next to the rendering that uses it.
  var ASK_TOOL_LABELS = {
    runSoql:           'Running SOQL',
    runToolingSoql:    'Querying Tooling API',
    describeSObject:   'Describing object',
    getFieldHistory:   'Reading field history',
    searchApex:        'Searching Apex',
    readApexClass:     'Reading Apex class',
    escalateToDesktop: 'Escalating to claude.ai'
  };

  function appendAskActivity(activityEl, event) {
    activityEl.style.display = 'block';
    var label = ASK_TOOL_LABELS[event.name] || event.name;
    var detail = '';
    if (event.input) {
      if (event.input.query) detail = event.input.query;
      else if (event.input.sObject) detail = event.input.sObject;
      else if (event.input.recordId) detail = event.input.recordId;
    }
    var li = document.createElement('li');
    li.className = 'sfnav-ask-activity-item sfnav-ask-activity-pending';
    li.innerHTML =
      '<span class="sfnav-ask-activity-spinner">●</span>' +
      '<span class="sfnav-ask-activity-label">' + esc(label) + '</span>' +
      (detail ? '<code class="sfnav-ask-activity-detail">' + esc(detail) + '</code>' : '') +
      '<span class="sfnav-ask-activity-summary"></span>';
    activityEl.appendChild(li);
  }

  function updateLastAskActivity(activityEl, event) {
    var items = activityEl.querySelectorAll('.sfnav-ask-activity-pending');
    var li = items[items.length - 1];
    if (!li) return;
    li.classList.remove('sfnav-ask-activity-pending');
    li.classList.add(event.ok ? 'sfnav-ask-activity-ok' : 'sfnav-ask-activity-err');
    var sumEl = li.querySelector('.sfnav-ask-activity-summary');
    if (sumEl) sumEl.textContent = event.summary || (event.ok ? 'ok' : 'failed');
  }

  function appendAskInterim(activityEl, text) {
    if (!text) return;
    activityEl.style.display = 'block';
    var li = document.createElement('li');
    li.className = 'sfnav-ask-activity-item sfnav-ask-activity-interim';
    li.textContent = text;
    activityEl.appendChild(li);
  }

  function renderAskResult(result) {
    var outputEl = document.getElementById('sfnav-ask-output');
    var answerEl = outputEl.querySelector('.sfnav-ask-answer');
    var copyBtn  = outputEl.querySelector('.sfnav-ask-copy');
    var text = (result && result.text) || '';
    answerEl.innerHTML = renderAskMarkdown(text);
    copyBtn.onclick = function () {
      navigator.clipboard.writeText(text).then(function () {
        var prev = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = prev; }, 1500);
      });
    };
    outputEl.style.display = 'block';
  }

  // Minimal Markdown-ish renderer: paragraphs, bullets, inline code, bold.
  // We deliberately don't pull in a full Markdown lib — this keeps the answer
  // readable when Claude uses light formatting, without HTML-injection risk.
  function renderAskMarkdown(text) {
    if (!text) return '';
    var lines = text.split(/\r?\n/);
    var html = '';
    var inList = false;
    var paragraph = [];

    function flushParagraph() {
      if (!paragraph.length) return;
      html += '<p>' + renderAskInline(paragraph.join(' ')) + '</p>';
      paragraph = [];
    }
    function openList() { if (!inList) { html += '<ul>'; inList = true; } }
    function closeList() { if (inList) { html += '</ul>'; inList = false; } }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        openList();
        html += '<li>' + renderAskInline(bullet[1]) + '</li>';
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }
      if (inList) { closeList(); }
      paragraph.push(line.trim());
    }
    flushParagraph();
    closeList();
    return html;
  }

  function renderAskInline(s) {
    // Escape first, then re-introduce known markup. Bold (**x**) and inline
    // `code` only — no links/images, since the model shouldn't be producing them.
    var out = esc(s);
    out = out.replace(/`([^`]+)`/g, function (_, code) {
      return '<code class="sfnav-ask-code">' + code + '</code>';
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return out;
  }

  // Render `…` as <code>…</code>, escaping HTML in everything else.
  function renderInlineCode(s) {
    var out = '';
    var inCode = false;
    var buf = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '`') {
        if (inCode) {
          out += '<code class="sfnav-flowdebug-code">' + esc(buf) + '</code>';
        } else {
          out += esc(buf);
        }
        buf = '';
        inCode = !inCode;
      } else {
        buf += ch;
      }
    }
    // Unclosed backtick — flush remainder as plain text
    out += esc(buf);
    return out;
  }

  function showPalette() {
    injectPalette();
    searchMode = 'root';
    scopedObject = null;
    scopedCmdt = null;
    objectPickerFilter = '';
    flowPickerFilter = '';
    appPickerFilter = '';
    cmdtPickerFilter = '';
    labelPickerFilter = '';
    var overlay = document.getElementById('sfnav-overlay');
    var input = document.getElementById('sfnav-input');
    overlay.style.display = 'flex';
    paletteVisible = true;
    input.value = '';
    input.placeholder = 'Search or pick a category below';
    hideSoqlPanel();
    renderResults(resolveInput(''));
    setFooterHints('root');
    input.focus();
  }

  function hideSoqlPanel() {
    var soqlEl = document.getElementById('sfnav-soql');
    if (soqlEl) soqlEl.style.display = 'none';
    var fdEl = document.getElementById('sfnav-flowdebug');
    if (fdEl) fdEl.style.display = 'none';
    var askEl = document.getElementById('sfnav-ask');
    if (askEl) askEl.style.display = 'none';
    var resultsEl = document.getElementById('sfnav-results');
    if (resultsEl) resultsEl.style.display = '';
  }

  function hidePalette() {
    var overlay = document.getElementById('sfnav-overlay');
    if (overlay) overlay.style.display = 'none';
    paletteVisible = false;
    selectedIndex = -1;
    searchMode = 'root';
    scopedObject = null;
    scopedCmdt = null;
    objectPickerFilter = '';
    flowPickerFilter = '';
    appPickerFilter = '';
    cmdtPickerFilter = '';
    labelPickerFilter = '';
  }

  function togglePalette() {
    if (paletteVisible) hidePalette(); else showPalette();
  }

  // Expose for background.js (called via executeScript in isolated world)
  window.__sfnavToggle = togglePalette;
  window.togglePalette = togglePalette; // keep for console debugging

  function renderResults(resolution) {
    var listEl = document.getElementById('sfnav-results');
    var hintEl = document.getElementById('sfnav-hint');
    var breadcrumbEl = document.getElementById('sfnav-breadcrumb');

    // Filter out headers and disabled items for navigation
    currentResults = resolution.results.filter(function (r) { return r.type !== 'header' && !r.disabled; });
    selectedIndex = currentResults.length > 0 ? 0 : -1;

    if (resolution.mode === 'object-picker') {
      breadcrumbEl.innerHTML = '<span class="sfnav-bc-seg">@object</span> <span class="sfnav-bc-arrow">›</span>';
      breadcrumbEl.style.display = 'flex';
    } else if (resolution.mode === 'object-scoped' && resolution.object) {
      breadcrumbEl.innerHTML =
        '<span class="sfnav-bc-seg">@object</span>' +
        ' <span class="sfnav-bc-arrow">›</span> ' +
        '<span class="sfnav-bc-seg sfnav-bc-current">' + esc(resolution.object.label) + '</span>' +
        ' <span class="sfnav-bc-arrow">›</span>';
      breadcrumbEl.style.display = 'flex';
    } else if (resolution.mode === 'flow-picker') {
      breadcrumbEl.innerHTML = '<span class="sfnav-bc-seg">@flows</span> <span class="sfnav-bc-arrow">›</span>';
      breadcrumbEl.style.display = 'flex';
    } else if (resolution.mode === 'cmd-picker') {
      breadcrumbEl.innerHTML = '<span class="sfnav-bc-seg">@cmd</span> <span class="sfnav-bc-arrow">›</span>';
      breadcrumbEl.style.display = 'flex';
    } else if (resolution.mode === 'label-picker') {
      breadcrumbEl.innerHTML = '<span class="sfnav-bc-seg">@label</span> <span class="sfnav-bc-arrow">›</span>';
      breadcrumbEl.style.display = 'flex';
    } else if (resolution.mode === 'permset-picker') {
      breadcrumbEl.innerHTML = '<span class="sfnav-bc-seg">@permset</span> <span class="sfnav-bc-arrow">›</span>';
      breadcrumbEl.style.display = 'flex';
    } else if (resolution.mode === 'cmd-scoped' && resolution.cmdt) {
      breadcrumbEl.innerHTML =
        '<span class="sfnav-bc-seg">@cmd</span>' +
        ' <span class="sfnav-bc-arrow">›</span> ' +
        '<span class="sfnav-bc-seg sfnav-bc-current">' + esc(resolution.cmdt.label) + '</span>' +
        ' <span class="sfnav-bc-arrow">›</span>';
      breadcrumbEl.style.display = 'flex';
    } else {
      breadcrumbEl.textContent = '';
      breadcrumbEl.style.display = 'none';
    }

    hintEl.textContent = resolution.hint || '';
    listEl.innerHTML = '';

    var selectableIndex = 0;
    resolution.results.forEach(function (result) {
      if (result.type === 'header') {
        var hdr = document.createElement('li');
        hdr.className = 'sfnav-section-header';
        hdr.textContent = result.label;
        listEl.appendChild(hdr);
        return;
      }

      var li = document.createElement('li');

      if (result.disabled) {
        li.className = 'sfnav-item sfnav-disabled';
        li.innerHTML =
          '<span class="sfnav-label">'   + esc(result.label)             + '</span>' +
          '<span class="sfnav-sublabel">'+ esc(result.sublabel || '')    + '</span>' +
          '<span class="sfnav-shortcut" aria-hidden="true">↵</span>';
        li.addEventListener('click', function (e) { e.stopPropagation(); });
        listEl.appendChild(li);
        return;
      }

      var isSelected = selectableIndex === selectedIndex;
      li.className = 'sfnav-item' + (isSelected ? ' selected' : '');
      li.dataset.url = result.url;

      // Objects in picker mode get a ›  indicator to show they expand
      var shortcutLabel = (result.type === 'object' || result.type === 'cmdt') ? '›' : '↵';
      li.innerHTML =
        '<span class="sfnav-label">'   + esc(result.label)             + '</span>' +
        '<span class="sfnav-sublabel">'+ esc(result.sublabel || '')    + '</span>' +
        '<span class="sfnav-shortcut">' + shortcutLabel + '</span>';
      li.addEventListener('click', function () { navigateTo(result.url, result); });
      listEl.appendChild(li);
      selectableIndex++;
    });

    var first = listEl.querySelector('.sfnav-item');
    if (first) first.scrollIntoView({ block: 'nearest' });
  }

  function setSelection(index) {
    var items = document.querySelectorAll('.sfnav-item');
    if (!items.length) return;
    selectedIndex = Math.max(0, Math.min(index, items.length - 1));
    items.forEach(function (el, i) { el.classList.toggle('selected', i === selectedIndex); });
    items[selectedIndex] && items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }

  function moveSelection(delta) {
    var items = document.querySelectorAll('.sfnav-item');
    if (!items.length) return;
    var next = selectedIndex < 0 ? (delta > 0 ? 0 : items.length - 1) : selectedIndex + delta;
    setSelection(next);
  }

  function navigateTo(url, result) {
    if (result && result.type === 'action' && result.action === 'soql-generator') {
      enterSoqlMode();
      return;
    }

    if (result && result.type === 'action' && result.action === 'flow-debug') {
      enterFlowDebugMode();
      return;
    }

    if (result && result.type === 'action' && result.action === 'ask') {
      enterAskMode('');
      return;
    }

    if (result && result.type === 'object') {
      enterObjectScopedMode(result.object);
      return;
    }

    if (result && result.type === 'cmdt') {
      enterCmdScopedMode(result.cmdt);
      return;
    }

    if (result && result.type === 'cmdt-action') {
      handleCmdtAction(result);
      return;
    }

    if (result && result.type === 'shortcut') {
      executeShortcut(result.keyword);
      return;
    }

    hidePalette();
    window.location.href = url;
  }

  function executeShortcut(keyword) {
    switch (keyword) {
      case 'object':     enterObjectPickerMode(''); return;
      case 'flow':       enterFlowPickerMode(''); return;
      case 'app':        enterAppPickerMode(''); return;
      case 'cmd':        enterCmdPickerMode(''); return;
      case 'label':      enterLabelPickerMode(''); return;
      case 'permset':    enterPermsetPickerMode(''); return;
      case 'setup':      enterSetupPickerMode(''); return;
      case 'soql':       enterSoqlMode(); return;
      case 'ask':        enterAskMode(''); return;
      case 'flow-debug': enterFlowDebugMode(); return;
      case 'refresh':    runRefresh(); return;
    }
  }

  function runRefresh() {
    var input = document.getElementById('sfnav-input');
    var hintEl = document.getElementById('sfnav-hint');
    if (input) input.value = '';
    if (hintEl) hintEl.textContent = 'Refreshing flow + object caches…';

    var tasks = [];
    if (typeof loadFlows === 'function')           tasks.push(loadFlows());
    if (typeof loadObjectsFromPage === 'function') tasks.push(loadObjectsFromPage());
    if (typeof loadApps === 'function')            tasks.push(loadApps());
    if (typeof loadLabels === 'function')          tasks.push(loadLabels());
    if (typeof loadPermsets === 'function')        tasks.push(loadPermsets());

    Promise.allSettled(tasks).then(function (results) {
      var failed = results.filter(function (r) { return r.status === 'rejected'; });
      if (hintEl) {
        hintEl.textContent = failed.length
          ? 'Refresh finished with errors — ' + failed[0].reason.message
          : 'Caches refreshed — ' + getAllFlows().length + ' flows, ' + getAllApps().length + ' apps, ' + getAllObjects().length + ' objects';
      }
      if (searchMode === 'root') renderResults(resolveInput(input ? input.value : ''));
    });
  }

  function handleCmdtAction(result) {
    var hintEl = document.getElementById('sfnav-hint');
    if (result.action === 'definition') {
      if (hintEl) hintEl.textContent = 'Resolving entity ID…';
      getEntityIdForCmdt(result.cmdt.apiName)
        .then(function (entityId) {
          hidePalette();
          window.location.href = buildCmdtObjectDefinitionUrl(entityId);
        })
        .catch(function (err) {
          if (hintEl) hintEl.textContent = 'Error: ' + err.message;
          console.warn('sfnav: CMDT entity ID lookup failed —', err);
        });
      return;
    }
    if (result.action === 'records') {
      // keyPrefix is usually already on the cached object (from describeGlobal); only
      // hits the network on a cache miss for older entries.
      if (result.cmdt.keyPrefix) {
        hidePalette();
        window.location.href = buildCmdtManageRecordsUrl(result.cmdt.keyPrefix);
        return;
      }
      if (hintEl) hintEl.textContent = 'Resolving key prefix…';
      getKeyPrefixForCmdt(result.cmdt.apiName)
        .then(function (prefix) {
          hidePalette();
          window.location.href = buildCmdtManageRecordsUrl(prefix);
        })
        .catch(function (err) {
          if (hintEl) hintEl.textContent = 'Error: ' + err.message;
          console.warn('sfnav: CMDT key prefix lookup failed —', err);
        });
    }
  }

  function navigateToSelected() {
    if (selectedIndex < 0 || selectedIndex >= currentResults.length) return;
    navigateTo(currentResults[selectedIndex].url, currentResults[selectedIndex]);
  }

  function setFooterHints(mode) {
    var el = document.getElementById('sfnav-footer-hints');
    if (!el) return;
    if (mode === 'soql') {
      el.textContent = 'Enter to generate \u00b7 Esc to go back';
    } else if (mode === 'flow-debug') {
      el.textContent = 'Cmd+Enter to analyze \u00b7 Esc to go back';
    } else if (mode === 'ask') {
      el.textContent = 'Cmd+Enter to ask \u00b7 Esc to go back';
    } else {
      el.textContent = '\u2191\u2193 navigate \u00b7 Enter to select \u00b7 Esc to close';
    }
  }

  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Re-render when async data finishes loading while the palette is open
  document.addEventListener('sfnav:flows-loaded', function () {
    if (!paletteVisible) return;
    var input = document.getElementById('sfnav-input');
    if (!input) return;
    if (searchMode === 'flow-picker') {
      renderResults(resolveFlowPicker(input.value));
    } else if (input.value.replace(/^@/, '').toLowerCase().startsWith('flow')) {
      renderResults(resolveInput(input.value));
    }
  });

  document.addEventListener('sfnav:labels-loaded', function () {
    if (!paletteVisible) return;
    var input = document.getElementById('sfnav-input');
    if (!input) return;
    if (searchMode === 'label-picker') {
      renderResults(resolveLabelPicker(input.value));
    }
  });

  document.addEventListener('sfnav:permsets-loaded', function () {
    if (!paletteVisible) return;
    var input = document.getElementById('sfnav-input');
    if (!input) return;
    if (searchMode === 'permset-picker') {
      renderResults(resolvePermsetPicker(input.value));
    }
  });

  // Keyboard shortcut (direct, for cases where background message isn't used)
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'K') {
      e.preventDefault();
      e.stopPropagation();
      togglePalette();
    }
  });

}());
