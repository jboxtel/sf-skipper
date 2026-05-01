(function () {
  if (window !== window.top) return; // skip iframes
  if (window.__sfnavLoaded) { togglePalette(); return; } // already loaded — just toggle
  window.__sfnavLoaded = true;

  initCustomObjects(); // populate custom object cache from storage + URL + DOM
  initFlows();         // populate flow cache from storage + API

  var paletteVisible = false;
  var selectedIndex = -1;
  var currentResults = [];
  var searchMode = 'root'; // 'root' | 'object-picker' | 'object-scoped' | 'flow-picker' | 'soql' | 'flow-debug'
  var scopedObject = null;
  var objectPickerFilter = '';
  var flowPickerFilter = '';
  var soqlInFlight = false;
  var flowDebugInFlight = false;

  function injectPalette() {
    if (document.getElementById('sfnav-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'sfnav-overlay';
    overlay.innerHTML =
      '<div id="sfnav-palette">' +
        '<div id="sfnav-breadcrumb"></div>' +
        '<input id="sfnav-input" type="text" placeholder="Type @ to start — e.g. @account" autocomplete="off" spellcheck="false" />' +
        '<div id="sfnav-hint"></div>' +
        '<ul id="sfnav-results"></ul>' +
        '<div id="sfnav-soql" style="display:none">' +
          '<div id="sfnav-soql-status"></div>' +
          '<pre id="sfnav-soql-output"></pre>' +
          '<div id="sfnav-soql-actions">' +
            '<button id="sfnav-soql-copy" class="sfnav-soql-btn-primary">Copy</button>' +
            '<button id="sfnav-soql-clear" class="sfnav-soql-btn-secondary">Clear</button>' +
            '<button id="sfnav-soql-settings" class="sfnav-soql-btn-secondary">Settings</button>' +
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
            '<button id="sfnav-flowdebug-settings" class="sfnav-soql-btn-secondary">Settings</button>' +
            '<span class="sfnav-flowdebug-privacy">Flow + debug output sent to Anthropic</span>' +
          '</div>' +
          '<div id="sfnav-flowdebug-status"></div>' +
          '<div id="sfnav-flowdebug-output" style="display:none">' +
            '<div class="sfnav-flowdebug-section sfnav-flowdebug-summary"><span class="sfnav-flowdebug-label">Summary</span><div class="sfnav-flowdebug-body"></div></div>' +
            '<div class="sfnav-flowdebug-section sfnav-flowdebug-cause"><span class="sfnav-flowdebug-label">Root cause</span><div class="sfnav-flowdebug-body"></div></div>' +
            '<div class="sfnav-flowdebug-section sfnav-flowdebug-fix"><span class="sfnav-flowdebug-label">Suggested fix</span><div class="sfnav-flowdebug-body"></div><button class="sfnav-flowdebug-copy">Copy fix</button></div>' +
          '</div>' +
        '</div>' +
        '<div id="sfnav-footer"><span id="sfnav-brand">⌘ Salesforce Commander</span><span id="sfnav-footer-hints"></span></div>' +
      '</div>';

    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) hidePalette();
    });

    var input = document.getElementById('sfnav-input');

    input.addEventListener('input', function () {
      var val = input.value;
      if (searchMode === 'object-picker') {
        renderResults(resolveObjectPicker(val));
      } else if (searchMode === 'object-scoped') {
        renderResults(resolveObjectScoped(val, scopedObject));
      } else if (searchMode === 'flow-picker') {
        renderResults(resolveFlowPicker(val));
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
      else if (e.key === 'Escape')     { hidePalette(); }
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
      if (keyword === 'soql') {
        enterSoqlMode();
        return;
      }
      if (keyword === 'flow-debug' || keyword === 'debug') {
        enterFlowDebugMode();
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
    navigateToSelected();
  }

  function handleBack() {
    if (searchMode === 'object-scoped') {
      enterObjectPickerMode(objectPickerFilter);
    } else if (searchMode === 'object-picker' || searchMode === 'flow-picker' || searchMode === 'soql' || searchMode === 'flow-debug') {
      hidePalette();
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
    document.getElementById('sfnav-soql-settings').onclick = function () {
      openSoqlSettings();
    };
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
      statusEl.innerHTML = 'No API key configured. <a href="#" id="sfnav-soql-open-settings">Open settings</a>.';
      statusEl.className = 'sfnav-soql-status-error';
      actionsEl.style.display = 'none';
      var link = document.getElementById('sfnav-soql-open-settings');
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
      history.forEach(function (entry) {
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
    } else {
      metaEl.textContent = 'Loading flow…';
      fetchFlowMetadata(flowId)
        .then(function (record) {
          // Only update if user is still in flow-debug mode for this flow
          if (searchMode !== 'flow-debug') return;
          metaEl.textContent = 'Flow: ' + (record.MasterLabel || flowId);
        })
        .catch(function (err) {
          if (searchMode !== 'flow-debug') return;
          metaEl.innerHTML = '<em class="sfnav-flowdebug-warn">Could not load flow: ' + esc(err.message) + '</em>';
        });
    }

    document.getElementById('sfnav-flowdebug-run').onclick = runFlowDebugAnalysis;
    document.getElementById('sfnav-flowdebug-settings').onclick = function () { openSoqlSettings(); };

    // Submit on Cmd/Ctrl+Enter from inside the textarea (plain Enter keeps newline)
    var debugEl = document.getElementById('sfnav-flowdebug-debug');
    debugEl.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runFlowDebugAnalysis();
      }
    });

    // Plain Enter from the expectation field submits (it's a single-line input)
    var expEl = document.getElementById('sfnav-flowdebug-expectation');
    expEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        runFlowDebugAnalysis();
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
      statusEl.innerHTML = 'No API key configured. <a href="#" id="sfnav-flowdebug-open-settings">Open settings</a>.';
      statusEl.className = 'sfnav-flowdebug-status-error';
      var link = document.getElementById('sfnav-flowdebug-open-settings');
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
    var fixBody     = fixSec.querySelector('.sfnav-flowdebug-body');
    var copyBtn     = fixSec.querySelector('.sfnav-flowdebug-copy');

    function setSection(sec, body, value) {
      var v = (value || '').trim();
      if (v) {
        body.textContent = v;
        sec.style.display = '';
      } else {
        body.textContent = '';
        sec.style.display = 'none';
      }
    }

    setSection(summarySec, summaryBody, result.summary);
    setSection(causeSec,   causeBody,   result.rootCause);
    setSection(fixSec,     fixBody,     result.fix);

    copyBtn.onclick = function () {
      navigator.clipboard.writeText(result.fix || '').then(function () {
        var prev = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = prev; }, 1500);
      });
    };

    outputEl.style.display = 'block';
  }

  function showPalette() {
    injectPalette();
    searchMode = 'root';
    scopedObject = null;
    objectPickerFilter = '';
    flowPickerFilter = '';
    var overlay = document.getElementById('sfnav-overlay');
    var input = document.getElementById('sfnav-input');
    overlay.style.display = 'flex';
    paletteVisible = true;
    input.value = '';
    input.placeholder = 'Type @ to start — e.g. @account';
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
    objectPickerFilter = '';
    flowPickerFilter = '';
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

    currentResults = resolution.results;
    selectedIndex = resolution.results.length > 0 ? 0 : -1;

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
    } else {
      breadcrumbEl.textContent = '';
      breadcrumbEl.style.display = 'none';
    }

    hintEl.textContent = resolution.hint || '';
    listEl.innerHTML = '';

    resolution.results.forEach(function (result, i) {
      var li = document.createElement('li');
      li.className = 'sfnav-item' + (i === selectedIndex ? ' selected' : '');
      li.dataset.url = result.url;

      // Objects in picker mode get a ›  indicator to show they expand
      var shortcutLabel = (result.type === 'object') ? '›' : '↵';
      li.innerHTML =
        '<span class="sfnav-icon">'    + esc(result.icon || '⚙') + '</span>' +
        '<span class="sfnav-label">'   + esc(result.label)             + '</span>' +
        '<span class="sfnav-sublabel">'+ esc(result.sublabel || '')    + '</span>' +
        '<span class="sfnav-shortcut">' + shortcutLabel + '</span>';
      li.addEventListener('click', function () { navigateTo(result.url, result); });
      listEl.appendChild(li);
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

    if (result && result.type === 'object') {
      enterObjectScopedMode(result.object);
      return;
    }

    hidePalette();
    window.location.href = url;
  }

  function navigateToSelected() {
    if (selectedIndex < 0 || selectedIndex >= currentResults.length) return;
    navigateTo(currentResults[selectedIndex].url, currentResults[selectedIndex]);
  }

  function setFooterHints(mode) {
    var el = document.getElementById('sfnav-footer-hints');
    if (!el) return;
    var hints;
    switch (mode) {
      case 'soql':
        hints = '↵ generate   Esc close';
        break;
      case 'flow-debug':
        hints = '⌘↵ analyze   Esc close';
        break;
      default:
        hints = '↑↓ navigate   ↵ select   ⌫ back   Esc close';
    }
    el.innerHTML = hints;
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

  // Keyboard shortcut (direct, for cases where background message isn't used)
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'K') {
      e.preventDefault();
      e.stopPropagation();
      togglePalette();
    }
  });

}());
