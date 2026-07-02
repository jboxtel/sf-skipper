(function () {
  if (window !== window.top) return; // skip iframes
  if (window.__sfnavLoaded) { togglePalette(); return; } // already loaded — just toggle
  window.__sfnavLoaded = true;

  initCustomObjects(); // populate custom object cache from storage + URL + DOM
  initFlows();         // populate flow cache from storage + API
  initApps();          // populate Lightning app cache from storage + API
  initLabels();        // populate custom label cache from storage + Tooling API
  initPermsets();      // populate permission set cache from storage + REST API
  if (typeof initSetupHarvest === 'function') initSetupHarvest();

  var paletteVisible = false;
  var selectedIndex = -1;
  var currentResults = [];
  var searchMode = 'root'; // 'root' | 'object-picker' | 'object-scoped' | 'flow-picker' | 'app-picker' | 'soql' | 'flow-debug' | 'cmd-picker' | 'cmd-scoped' | 'permset-picker' | 'feedback'
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
  var askHistoryEntries = [];
  var askIncludeScreenshot = true;       // home toggle — default ON for a new question
  var askReplyIncludeScreenshot = false; // thread toggle — default OFF for follow-ups
  var askView = 'home'; // 'home' | 'thread' — sub-view while searchMode === 'ask'
  // Live @ask conversation: { messages, systemBlocks, context, turns, ended,
  // qas, historyId, contextLine }. Null between conversations. Lets follow-up
  // turns continue the same thread.
  var askConversation = null;
  // Set when the user leaves the thread view while a request is in flight —
  // the completion handler then persists to history but skips all UI commits.
  var askRunDetached = false;
  var askRecentSelIndex = -1; // keyboard selection in the recent list (-1 = none)
  var askRecallIndex = -1;    // ArrowUp question-recall position (-1 = not recalling)
  var askRecallDraft = '';
  var askVisibleEntries = [];
  var MAX_ASK_TURNS = 3;
  var openInNewTabPref = true;
  var askDebugMode = false;

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('sfnavOptions', function (data) {
      var opts = (data && data.sfnavOptions) || {};
      if (opts.openInNewTab === false) openInNewTabPref = false;
      if (DEV_MODE && opts.debug) askDebugMode = true;
    });
    if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.sfnavOptions) return;
        var next = changes.sfnavOptions.newValue || {};
        openInNewTabPref = next.openInNewTab !== false;
        if (DEV_MODE) askDebugMode = !!next.debug;
      });
    }
  }

  if (DEV_MODE) {
    window.sfnavDebug = function (on) {
      chrome.storage.local.get('sfnavOptions', function (data) {
        var opts = (data && data.sfnavOptions) || {};
        opts.debug = !!on;
        chrome.storage.local.set({ sfnavOptions: opts });
      });
    };
  }

  function openUrl(url) {
    hidePalette();
    if (openInNewTabPref) {
      var win = window.open(url, '_blank');
      if (win) return;
      // Popup blocked — fall through to same-tab navigation rather than do nothing.
    }
    window.location.href = url;
  }

  // ─── Mode dispatch tables ────────────────────────────────────────────────
  // The @keyword catalogue lives in commands.js (SHORTCUTS). Use
  // sfnavFindShortcut(input) for keyword → shortcut lookup; enterShortcutMode
  // (below) is the single dispatch that turns a shortcut into the right
  // panel/picker. MODE_RUN_HANDLERS handles Enter when already inside a
  // panel mode (soql/ask/debug); MODE_BACK_HANDLERS handles Esc for modes
  // that go back to a parent picker rather than to root.
  var MODE_RUN_HANDLERS = {
    'soql':       function () { runSoqlGeneration(); },
    'flow-debug': function () { runFlowDebugAnalysis(); },
    'ask':        function () { runAskQuery(); },
    'feedback':   function () { runFeedbackSubmit(); }
  };

  // Modes that go back to a parent picker rather than root.
  var MODE_BACK_HANDLERS = {
    'object-scoped': function () { enterObjectPickerMode(objectPickerFilter); },
    'cmd-scoped':    function () { enterCmdPickerMode(cmdtPickerFilter); },
  };

  var PANEL_MODES = { soql: 1, ask: 1, 'flow-debug': 1, feedback: 1 };

  function isFeedbackPanelOpen() {
    var el = document.getElementById('sfnav-feedback');
    return !!el && el.style.display !== 'none';
  }

  // Where to bounce focus when the user clicks dead space inside a panel mode.
  // getInputId (over inputId) lets a panel pick its primary input at click time
  // — @ask has one textarea per sub-view.
  var PANEL_PRIMARY_INPUTS = [
    { panelId: 'sfnav-soql',      inputId: 'sfnav-input' },
    { panelId: 'sfnav-flowdebug', inputId: 'sfnav-flowdebug-debug' },
    { panelId: 'sfnav-ask',       getInputId: function () { return askView === 'thread' ? 'sfnav-ask-reply' : 'sfnav-ask-question'; } },
    { panelId: 'sfnav-feedback',  inputId: 'sfnav-feedback-message' }
  ];

  var FOOTER_HINTS = {
    'soql':       'Enter to generate · Esc to go back',
    'flow-debug': 'Enter to analyze · Shift+Enter for newline · Esc to go back',
    'ask-home':   '↑↓ history · shift+↵ newline',
    'ask-thread': 'shift+↵ newline · esc back to recent',
    'feedback':   null
  };
  var DEFAULT_FOOTER_HINT = '↑↓ navigate · Enter to select · Esc to close';

  // Breadcrumb segments per resolution mode (single-segment pickers only —
  // scoped modes are handled by breadcrumbForResolution which needs runtime
  // data like the selected object/cmdt label).
  var BREADCRUMB_PICKER_LABELS = {
    'object-picker':  '@object',
    'flow-picker':    '@flows',
    'cmd-picker':     '@cmd',
    'label-picker':   '@label',
    'permset-picker': '@permset',
    'id-entry':       '@id'
  };

  function renderBreadcrumbHtml(segments) {
    return segments.map(function (s) {
      return '<span class="sfnav-bc-seg' + (s.current ? ' sfnav-bc-current' : '') + '">' + esc(s.text) + '</span>' +
        ' <span class="sfnav-bc-arrow">›</span>';
    }).join(' ');
  }

  function breadcrumbForResolution(resolution) {
    var simple = BREADCRUMB_PICKER_LABELS[resolution.mode];
    if (simple) return [{ text: simple }];
    if (resolution.mode === 'object-scoped' && resolution.object) {
      return [{ text: '@object' }, { text: resolution.object.label, current: true }];
    }
    if (resolution.mode === 'cmd-scoped' && resolution.cmdt) {
      return [{ text: '@cmd' }, { text: resolution.cmdt.label, current: true }];
    }
    return null;
  }

  function openOptions() {
    try { chrome.runtime.sendMessage({ type: 'openOptions' }); } catch (err) {}
  }


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
          '<div id="sfnav-soql-output-wrap">' +
            '<pre id="sfnav-soql-output"></pre>' +
            '<div id="sfnav-soql-actions">' +
              '<button id="sfnav-soql-copy" class="sfnav-soql-btn-primary">Copy</button>' +
              '<button id="sfnav-soql-clear" class="sfnav-soql-btn-secondary">Clear</button>' +
            '</div>' +
          '</div>' +
          '<div id="sfnav-soql-history-label" class="sfnav-section-header">Recent</div>' +
          '<ul id="sfnav-soql-history"></ul>' +
        '</div>' +
        '<div id="sfnav-flowdebug" style="display:none">' +
          '<div id="sfnav-flowdebug-meta"></div>' +
          '<textarea id="sfnav-flowdebug-debug" placeholder="Paste the Debug panel output here…" spellcheck="false"></textarea>' +
          '<input id="sfnav-flowdebug-expectation" type="text" placeholder="Optional: what did you expect to happen?" autocomplete="off" />' +
          '<div id="sfnav-flowdebug-actions">' +
            '<button id="sfnav-flowdebug-run" class="sfnav-soql-btn-primary">Analyze <span class="sfnav-kbd">↵</span></button>' +
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
          '<div id="sfnav-ask-header">' +
            '<span id="sfnav-ask-crumb"></span>' +
            '<span id="sfnav-ask-header-right"></span>' +
          '</div>' +
          '<div id="sfnav-ask-keywarn" style="display:none"></div>' +
          '<div id="sfnav-ask-home" style="display:none">' +
            '<div class="sfnav-ask-composer">' +
              '<textarea id="sfnav-ask-question" rows="2" placeholder="Ask about this screen…" spellcheck="false"></textarea>' +
              '<div class="sfnav-ask-composer-row">' +
                '<button id="sfnav-ask-shot-toggle" class="sfnav-ask-shot-toggle" type="button" aria-pressed="true"></button>' +
                '<span class="sfnav-ask-composer-hint">↵ to ask</span>' +
                '<button id="sfnav-ask-run" class="sfnav-soql-btn-primary">Ask</button>' +
              '</div>' +
              '<div id="sfnav-ask-home-status" class="sfnav-ask-status-row"></div>' +
            '</div>' +
            '<div id="sfnav-ask-recent" style="display:none">' +
              '<div class="sfnav-section-header">Recent — ↵ to resume thread</div>' +
              '<ul id="sfnav-ask-history"></ul>' +
            '</div>' +
          '</div>' +
          '<div id="sfnav-ask-threadview" style="display:none">' +
            '<div id="sfnav-ask-scroll">' +
              '<div id="sfnav-ask-output"></div>' +
            '</div>' +
            '<div class="sfnav-ask-composer" id="sfnav-ask-reply-composer">' +
              '<textarea id="sfnav-ask-reply" rows="1" placeholder="Reply…" spellcheck="false"></textarea>' +
              '<div class="sfnav-ask-composer-row">' +
                '<button id="sfnav-ask-reply-shot-toggle" class="sfnav-ask-shot-toggle" type="button" aria-pressed="false"></button>' +
                '<span class="sfnav-ask-composer-hint">↵ to send</span>' +
                '<button id="sfnav-ask-send" class="sfnav-soql-btn-primary">Send</button>' +
              '</div>' +
              '<div id="sfnav-ask-thread-status" class="sfnav-ask-status-row"></div>' +
            '</div>' +
            '<div id="sfnav-ask-handoff" style="display:none"></div>' +
          '</div>' +
        '</div>' +
        '<div id="sfnav-feedback" style="display:none">' +
          '<div id="sfnav-feedback-context" style="display:none"></div>' +
          '<textarea id="sfnav-feedback-message" placeholder="What’s broken, missing, or confusing? Anything Skipper could do better…" spellcheck="false"></textarea>' +
          '<div class="sfnav-feedback-field">' +
            '<label for="sfnav-feedback-email" class="sfnav-feedback-field-label">Reply to (optional)</label>' +
            '<input id="sfnav-feedback-email" type="email" placeholder="your@email.com" autocomplete="email" />' +
          '</div>' +
          '<div id="sfnav-feedback-actions">' +
            '<button id="sfnav-feedback-send" class="sfnav-soql-btn-primary">Send <span class="sfnav-kbd"></span></button>' +
            '<span id="sfnav-feedback-status"></span>' +
          '</div>' +
        '</div>' +
        '<div id="sfnav-footer"><span id="sfnav-brand">Skipper for Salesforce<span id="sfnav-brand-help">help</span></span><a id="sfnav-feedback-link" href="#">feedback</a><span id="sfnav-footer-hints"></span></div>' +
      '</div>';

    document.body.appendChild(overlay);

    var overlayMouseDownOnBackdrop = false;
    overlay.addEventListener('mousedown', function (e) {
      overlayMouseDownOnBackdrop = (e.target === overlay);
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay && overlayMouseDownOnBackdrop) hidePalette();
      overlayMouseDownOnBackdrop = false;
    });

    // Clicking dead space inside a panel mode (the breadcrumb, meta line,
    // status, rendered answer, etc.) used to leave focus on a non-handler
    // element — Esc then went nowhere because only the panel's primary
    // input/textarea carries the keydown listener. Bounce focus back to it.
    PANEL_PRIMARY_INPUTS.forEach(function (entry) {
      var panel = document.getElementById(entry.panelId);
      if (!panel) return;
      panel.addEventListener('click', function (e) {
        if (e.target.closest('button, a, textarea, input, [contenteditable="true"], #sfnav-ask-output, #sfnav-ask-history')) return;
        var inputId = entry.getInputId ? entry.getInputId() : entry.inputId;
        var target = document.getElementById(inputId);
        if (target && !target.disabled) target.focus();
      });
    });

    var feedbackPanel = document.getElementById('sfnav-feedback');
    if (feedbackPanel) {
      feedbackPanel.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (!isFeedbackPanelOpen() && searchMode !== 'feedback') return;
        e.preventDefault();
        e.stopPropagation();
        handleBack();
      }, true);

      var feedbackMsgEl = document.getElementById('sfnav-feedback-message');
      var feedbackEmailEl = document.getElementById('sfnav-feedback-email');
      if (feedbackMsgEl) {
        feedbackMsgEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            runFeedbackSubmit();
          }
        });
      }
      if (feedbackEmailEl) {
        feedbackEmailEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            runFeedbackSubmit();
          }
        });
      }
    }

    var feedbackSendKbd = document.querySelector('#sfnav-feedback-send .sfnav-kbd');
    if (feedbackSendKbd) feedbackSendKbd.textContent = sfnavModEnterKbd();

    var feedbackLink = document.getElementById('sfnav-feedback-link');
    if (feedbackLink) {
      feedbackLink.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        enterFeedbackMode();
      });
    }

    var input = document.getElementById('sfnav-input');

    input.addEventListener('input', function () {
      var val = input.value;
      // `@cmd foo` / `@flow foo` / `@object foo` jumps into the matching
      // picker with `foo` as the live filter. `@Account` / `@Account fields`
      // jumps straight into Account's scoped pages. This runs in any mode
      // so the user can pivot between scopes without first pressing Esc.
      if (val.charAt(0) === '@') {
        var invocation = sfnavParseShortcutInvocation(val);
        if (invocation) {
          enterShortcutMode(invocation.shortcut, invocation.filter);
          return;
        }
        var objectInvocation = resolveObjectScopedInvocation(val);
        if (objectInvocation) {
          enterObjectScopedMode(objectInvocation.object, objectInvocation.filter);
          return;
        }
        // Bare `@objects` / `@flows` / `@<exact-keyword>` — pop back to root
        // and render the shortcut hint so Enter has somewhere to go.
        if (sfnavFindShortcut(val)) {
          searchMode = 'root';
          renderResults(resolveInput(val));
          return;
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
      } else if (searchMode === 'id-entry') {
        renderResults(resolveIdEntry(val));
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
      var shortcut = sfnavFindShortcut(input.value);
      if (shortcut) { executeShortcut(shortcut.id); return; }
    } else {
      var modeHandler = MODE_RUN_HANDLERS[searchMode];
      if (modeHandler) { modeHandler(); return; }
    }
    navigateToSelected();
  }

  function handleBack() {
    // Esc walks up one level at a time: thread → @ask home → main palette → closed.
    if (searchMode === 'ask') {
      if (askView === 'thread') { showAskHome(''); return; }
      goToRoot();
      return;
    }
    if (PANEL_MODES[searchMode] || isFeedbackPanelOpen()) {
      goToRoot();
      return;
    }
    if (searchMode === 'root') { hidePalette(); return; }
    var custom = MODE_BACK_HANDLERS[searchMode];
    if (custom) { custom(); return; }
    goToRoot();
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

  // Single dispatch for shortcut activation. Adding a new shortcut means one
  // SHORTCUTS row + one case here (or none, if the shortcut is action-only
  // and handled by executeShortcut below).
  function enterShortcutMode(shortcut, filterText) {
    // Hide any open panel before pivoting — otherwise typing @soql while
    // the feedback (or any other) panel is open leaves both rendered.
    hideSoqlPanel();
    switch (shortcut.id) {
      case 'object':  enterObjectPickerMode(filterText || '');  return;
      case 'flow':    enterFlowPickerMode(filterText || '');    return;
      case 'app':     enterAppPickerMode(filterText || '');     return;
      case 'cmd':     enterCmdPickerMode(filterText || '');     return;
      case 'label':   enterLabelPickerMode(filterText || '');   return;
      case 'permset': enterPermsetPickerMode(filterText || ''); return;
      case 'setup':   enterSetupPickerMode(filterText || '');   return;
      case 'id':      enterIdEntryMode(filterText || '');      return;
      case 'ask':     enterAskMode(filterText || '');           return;
      case 'soql':       enterSoqlMode();        return;
      case 'flow-debug': enterFlowDebugMode();   return;
      case 'refresh':    runRefresh();           return;
    }
  }

  // Recognize @<objectName> or @<objectName> <filter> as a direct jump into
  // object-scoped mode. Returns null if the first token is a known shortcut
  // keyword (those have priority via sfnavParseShortcutInvocation) or if the
  // token isn't an exact match for an object's apiName or label — fuzzy
  // matching here would auto-jump on every keystroke (`@a` → Account, etc.).
  function resolveObjectScopedInvocation(value) {
    var stripped = String(value || '').trim().replace(/^@/, '');
    if (!stripped) return null;
    var parts = stripped.match(/^(\S+)(?:\s+(.*))?$/);
    if (!parts) return null;
    var objectQuery = parts[1];
    if (sfnavFindShortcut(objectQuery)) return null;

    var query = objectQuery.toLowerCase();
    var match = getAllObjects().find(function (o) {
      return o.apiName.toLowerCase() === query || o.label.toLowerCase() === query;
    });
    if (!match) return null;
    return { object: match, filter: parts[2] || '' };
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

  function enterObjectScopedMode(obj, filterText) {
    // Remember where we came from so ESC can restore it
    if (searchMode === 'object-picker') {
      objectPickerFilter = document.getElementById('sfnav-input').value;
    } else {
      objectPickerFilter = '';
    }
    searchMode = 'object-scoped';
    scopedObject = obj;
    var input = document.getElementById('sfnav-input');
    input.value = filterText || '';
    input.placeholder = 'Filter sections…';
    renderResults(resolveObjectScoped(filterText || '', obj));
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
    document.getElementById('sfnav-breadcrumb').innerHTML = renderBreadcrumbHtml([{ text: '@soql' }]);
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
        el.innerHTML = 'No API key — <a href="#" class="sfnav-options-link">configure in Options</a>';
        el.className = 'sfnav-apistat sfnav-apistat-missing';
        var link = el.querySelector('.sfnav-options-link');
        if (link) link.onclick = function (e) { e.preventDefault(); openOptions(); };
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
      statusEl.innerHTML = 'No API key configured. <a href="#" class="sfnav-options-link">Open Options</a>.';
      statusEl.className = 'sfnav-soql-status-error';
      actionsEl.style.display = 'none';
      var link = statusEl.querySelector('.sfnav-options-link');
      if (link) link.onclick = function (e) { e.preventDefault(); openOptions(); };
      return;
    }

    soqlInFlight = true;
    input.disabled = true;
    statusEl.textContent = 'Generating';
    statusEl.className = 'sfnav-soql-status-loading sfnav-progress-dots';
    outputEl.textContent = '';
    actionsEl.style.display = 'none';

    try {
      var result = await generateSoql(prompt, function (phase) {
        statusEl.textContent = phase;
      });
      outputEl.textContent = result.soql;
      if (result.validationError) {
        statusEl.textContent = 'Salesforce rejected this query: ' + result.validationError;
        statusEl.className = 'sfnav-soql-status-error';
      } else {
        statusEl.textContent = result.explanation || ('Object: ' + result.objectName);
        statusEl.className = 'sfnav-soql-status-ok';
      }
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

  function enterIdEntryMode(filterText) {
    searchMode = 'id-entry';
    var input = document.getElementById('sfnav-input');
    input.value = filterText || '';
    input.placeholder = 'Paste a record ID (15 or 18 characters)…';
    renderResults(resolveIdEntry(filterText || ''));
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
    input.placeholder = flowId
      ? 'Paste the Debug panel output below, then press ' + sfnavModEnterKbd()
      : 'Open a flow first to use this';
    document.getElementById('sfnav-results').style.display = 'none';
    document.getElementById('sfnav-hint').textContent = '';
    document.getElementById('sfnav-breadcrumb').innerHTML = renderBreadcrumbHtml([{ text: '@flow-debug' }]);
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
        el.innerHTML = 'No API key — <a href="#" class="sfnav-options-link">configure in Options</a>';
        el.className = 'sfnav-apistat sfnav-apistat-missing';
        var link = el.querySelector('.sfnav-options-link');
        if (link) link.onclick = function (e) { e.preventDefault(); openOptions(); };
      }
    });

    document.getElementById('sfnav-flowdebug-run').onclick = runFlowDebugAnalysis;

    // Enter submits, Shift+Enter inserts a newline (matches @ask). Escape steps
    // back to root.
    var debugEl = document.getElementById('sfnav-flowdebug-debug');
    debugEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
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
      statusEl.innerHTML = 'No API key configured. <a href="#" class="sfnav-options-link">Open Options</a>.';
      statusEl.className = 'sfnav-flowdebug-status-error';
      var link = statusEl.querySelector('.sfnav-options-link');
      if (link) link.onclick = function (e) { e.preventDefault(); openOptions(); };
      return;
    }

    flowDebugInFlight = true;
    runBtn.disabled = true;
    debugEl.disabled = true;
    expEl.disabled = true;
    statusEl.textContent = 'Fetching flow + analyzing';
    statusEl.className = 'sfnav-flowdebug-status-loading sfnav-progress-dots';
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

  var ASK_CAMERA_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
      '<circle cx="12" cy="13" r="4"/>' +
    '</svg>';

  function enterAskMode(initialQuestion) {
    searchMode = 'ask';
    var input = document.getElementById('sfnav-input');
    input.value = '';
    input.disabled = true;
    input.style.display = 'none'; // @ask renders its own header bar
    document.getElementById('sfnav-results').style.display = 'none';
    var hintEl = document.getElementById('sfnav-hint');
    hintEl.textContent = '';
    hintEl.style.display = 'none';
    var breadcrumbEl = document.getElementById('sfnav-breadcrumb');
    breadcrumbEl.textContent = '';
    breadcrumbEl.style.display = 'none';
    document.getElementById('sfnav-ask').style.display = 'flex';

    wireAskPanel();
    showAskHome(initialQuestion || '');
  }

  // ─── View 1: @ask home (input + recent) ───────────────────────────────────

  function showAskHome(initialText) {
    if (askInFlight) askRunDetached = true;
    askView = 'home';
    askConversation = null;
    askRecentSelIndex = -1;
    askRecallIndex = -1;
    askRecallDraft = '';
    askHistoryExpanded = false;
    setFooterHints('ask-home');

    document.getElementById('sfnav-ask-home').style.display = 'flex';
    document.getElementById('sfnav-ask-threadview').style.display = 'none';

    document.getElementById('sfnav-ask-crumb').innerHTML =
      '<span class="sfnav-ask-crumb-kw">@ask</span>' +
      '<span class="sfnav-ask-crumb-sep">·</span>' +
      '<span class="sfnav-ask-crumb-title">Ask Claude about this screen</span>';
    document.getElementById('sfnav-ask-header-right').innerHTML =
      '<span class="sfnav-ask-header-hint">esc to go back</span>';

    var statusEl = document.getElementById('sfnav-ask-home-status');
    statusEl.textContent = '';
    statusEl.className = 'sfnav-ask-status-row';

    var qEl = document.getElementById('sfnav-ask-question');
    qEl.value = initialText || '';
    qEl.disabled = false;
    autoGrowAskTextarea(qEl);
    document.getElementById('sfnav-ask-run').disabled = false;

    askIncludeScreenshot = true;
    renderAskShotToggle();
    refreshAskKeyWarning();

    if (typeof getAskHistory === 'function') {
      getAskHistory().then(function (entries) {
        if (searchMode !== 'ask' || askView !== 'home') return;
        askHistoryEntries = entries || [];
        renderAskHistoryList();
      });
    } else {
      renderAskHistoryList();
    }

    qEl.focus();
  }

  // ─── View 2: thread ────────────────────────────────────────────────────────

  function showAskThreadView() {
    askView = 'thread';
    askRecentSelIndex = -1;
    setFooterHints('ask-thread');
    document.getElementById('sfnav-ask-home').style.display = 'none';
    document.getElementById('sfnav-ask-threadview').style.display = 'flex';
    document.getElementById('sfnav-ask-handoff').style.display = 'none';
    document.getElementById('sfnav-ask-reply-composer').style.display = 'flex';
    var statusEl = document.getElementById('sfnav-ask-thread-status');
    statusEl.textContent = '';
    statusEl.className = 'sfnav-ask-status-row';
    askReplyIncludeScreenshot = false;
    renderAskShotToggle();
  }

  // pendingFirstQ covers the gap before the first turn is committed to qas.
  function updateAskThreadHeader(pendingFirstQ) {
    var crumbEl = document.getElementById('sfnav-ask-crumb');
    var rightEl = document.getElementById('sfnav-ask-header-right');
    var qas = (askConversation && askConversation.qas) || [];
    var firstQ = (qas[0] && qas[0].q) || pendingFirstQ || '';
    var title = firstQ.length > 46 ? firstQ.slice(0, 45) + '…' : firstQ;
    var n = qas.length;
    crumbEl.innerHTML =
      '<span class="sfnav-ask-crumb-kw">@ask</span>' +
      '<span class="sfnav-ask-crumb-sep">›</span>' +
      '<span class="sfnav-ask-crumb-title">' + esc(title) + '</span>' +
      (n ? '<span class="sfnav-ask-turnpill">' + n + ' turn' + (n === 1 ? '' : 's') + '</span>' : '');
    rightEl.innerHTML = '<button id="sfnav-ask-newthread" class="sfnav-ask-newthread" type="button">+ New thread</button>';
    document.getElementById('sfnav-ask-newthread').onclick = function () { showAskHome(''); };
  }

  function resetAskReplyComposer() {
    var replyEl = document.getElementById('sfnav-ask-reply');
    replyEl.value = '';
    replyEl.disabled = false;
    autoGrowAskTextarea(replyEl);
    document.getElementById('sfnav-ask-send').disabled = false;
    askReplyIncludeScreenshot = false;
    renderAskShotToggle();
  }

  // Resume a stored thread: rebuild a continuable conversation from the saved
  // transcript and render it in the thread view. Never re-submits anything.
  function resumeAskThread(entry) {
    if (askInFlight) return;
    if (typeof rebuildAskConversation !== 'function') return;
    var conv = rebuildAskConversation(entry);
    conv.historyId = entry.id;
    conv.contextLine = entry.contextLine || '';
    conv.ended = conv.ended || conv.turns >= MAX_ASK_TURNS;
    askConversation = conv;

    showAskThreadView();
    var outputEl = document.getElementById('sfnav-ask-output');
    outputEl.innerHTML = '';
    (entry.turns || []).forEach(function (t) {
      appendUserBubble(t.q, t.s ? { context: t.sc || entry.contextLine } : null);
      appendAssistantMessage(t.a, null, t.t || entry.timestamp);
    });
    updateAskThreadHeader();

    if (conv.ended) {
      showAskHandoff();
    } else {
      resetAskReplyComposer();
      document.getElementById('sfnav-ask-reply').focus();
    }
    scrollAskThreadToBottom();
  }

  // ─── Shared @ask panel wiring ──────────────────────────────────────────────

  function autoGrowAskTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 110) + 'px';
  }

  function askPrimaryTextarea() {
    return document.getElementById(askView === 'thread' ? 'sfnav-ask-reply' : 'sfnav-ask-question');
  }

  function renderAskShotToggle() {
    var homeBtn = document.getElementById('sfnav-ask-shot-toggle');
    if (homeBtn) {
      homeBtn.setAttribute('aria-pressed', askIncludeScreenshot ? 'true' : 'false');
      homeBtn.innerHTML = ASK_CAMERA_SVG + '<span>' + (askIncludeScreenshot ? 'Capture screenshot ✓' : 'Capture screenshot') + '</span>';
    }
    var replyBtn = document.getElementById('sfnav-ask-reply-shot-toggle');
    if (replyBtn) {
      replyBtn.setAttribute('aria-pressed', askReplyIncludeScreenshot ? 'true' : 'false');
      replyBtn.innerHTML = ASK_CAMERA_SVG + '<span>' + (askReplyIncludeScreenshot ? 'Capture new screenshot ✓' : 'Capture new screenshot') + '</span>';
    }
  }

  // Healthy state is silent — the banner only appears when the key is missing.
  function refreshAskKeyWarning() {
    var el = document.getElementById('sfnav-ask-keywarn');
    if (!el) return;
    hasSoqlApiKey().then(function (ok) {
      if (searchMode !== 'ask') return;
      if (ok) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
      }
      el.innerHTML = 'No API key configured — <a href="#" class="sfnav-options-link">Open settings</a>';
      el.style.display = 'block';
      var link = el.querySelector('.sfnav-options-link');
      if (link) link.onclick = function (e) { e.preventDefault(); openOptions(); };
    });
  }

  function wireAskPanel() {
    document.getElementById('sfnav-ask-run').onclick = runAskQuery;
    document.getElementById('sfnav-ask-send').onclick = runAskQuery;

    document.getElementById('sfnav-ask-shot-toggle').onclick = function () {
      askIncludeScreenshot = !askIncludeScreenshot;
      renderAskShotToggle();
      askPrimaryTextarea().focus();
    };
    document.getElementById('sfnav-ask-reply-shot-toggle').onclick = function () {
      askReplyIncludeScreenshot = !askReplyIncludeScreenshot;
      renderAskShotToggle();
      askPrimaryTextarea().focus();
    };

    var qEl = document.getElementById('sfnav-ask-question');
    qEl.oninput = function () {
      askRecallIndex = -1; // editing breaks the recall cycle
      autoGrowAskTextarea(this);
    };
    qEl.onkeydown = handleAskHomeKeydown;

    var replyEl = document.getElementById('sfnav-ask-reply');
    replyEl.oninput = function () { autoGrowAskTextarea(this); };
    replyEl.onkeydown = function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runAskQuery();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleBack();
      }
    };
  }

  // Flattened past questions, newest first, for terminal-style ArrowUp recall.
  function askRecallList() {
    var out = [];
    askHistoryEntries.forEach(function (entry) {
      var turns = entry.turns || [];
      for (var i = turns.length - 1; i >= 0; i--) {
        if (turns[i].q) out.push(turns[i].q);
      }
    });
    return out;
  }

  function setAskRecentSelection(i) {
    var rows = document.querySelectorAll('#sfnav-ask-history .sfnav-ask-history-item');
    if (!rows.length) { askRecentSelIndex = -1; return; }
    if (i < 0) i = -1;
    if (i > rows.length - 1) i = rows.length - 1;
    askRecentSelIndex = i;
    rows.forEach(function (el, idx) { el.classList.toggle('selected', idx === askRecentSelIndex); });
    if (i >= 0) rows[i].scrollIntoView({ block: 'nearest' });
  }

  function handleAskHomeKeydown(e) {
    var qEl = this;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (askRecentSelIndex >= 0 && askVisibleEntries[askRecentSelIndex]) {
        resumeAskThread(askVisibleEntries[askRecentSelIndex]);
        return;
      }
      runAskQuery();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleBack();
      return;
    }
    if (e.key === 'ArrowUp') {
      if (askRecentSelIndex >= 0) {
        e.preventDefault();
        setAskRecentSelection(askRecentSelIndex - 1); // above row 0 → back to textarea
        return;
      }
      if (qEl.value === '' || askRecallIndex >= 0) {
        var recall = askRecallList();
        if (!recall.length) return;
        e.preventDefault();
        if (askRecallIndex === -1) askRecallDraft = qEl.value;
        if (askRecallIndex < recall.length - 1) askRecallIndex++;
        qEl.value = recall[askRecallIndex];
        autoGrowAskTextarea(qEl);
        qEl.selectionStart = qEl.selectionEnd = qEl.value.length;
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      if (askRecallIndex >= 0) {
        e.preventDefault();
        askRecallIndex--;
        qEl.value = askRecallIndex === -1 ? askRecallDraft : askRecallList()[askRecallIndex];
        autoGrowAskTextarea(qEl);
        qEl.selectionStart = qEl.selectionEnd = qEl.value.length;
        return;
      }
      if (askRecentSelIndex >= 0) {
        e.preventDefault();
        setAskRecentSelection(askRecentSelIndex + 1);
        return;
      }
      // Move into the recent list — only when the caret has nowhere lower to go.
      var caretAtEnd = qEl.selectionStart === qEl.value.length;
      if (caretAtEnd && askVisibleEntries.length) {
        e.preventDefault();
        setAskRecentSelection(0);
      }
      return;
    }
    // Any character typed returns to composing.
    if (askRecentSelIndex >= 0 && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      setAskRecentSelection(-1);
    }
  }

  // Short human label for where a screenshot was taken, e.g. "Case record page".
  function askScreenContextLabel(ctx) {
    if (!ctx) return null;
    if (ctx.pageType === 'record' && ctx.sObject) return ctx.sObject + ' record page';
    if (ctx.pageType === 'list-view' && ctx.sObject) return ctx.sObject + ' list view';
    if (ctx.pageType === 'setup') return 'Setup' + (ctx.setupNode ? ' · ' + ctx.setupNode : '');
    if (ctx.pageType === 'flow-builder') return 'Flow Builder';
    if (ctx.pageType === 'app' && ctx.app) return ctx.app + ' app';
    return null;
  }

  async function runAskQuery() {
    if (askInFlight) return;
    var isThread = askView === 'thread';
    var conv = isThread ? askConversation : null;
    if (conv && (conv.ended || conv.turns >= MAX_ASK_TURNS)) return;

    var qEl = document.getElementById(isThread ? 'sfnav-ask-reply' : 'sfnav-ask-question');
    var statusEl = document.getElementById(isThread ? 'sfnav-ask-thread-status' : 'sfnav-ask-home-status');
    var overlay = document.getElementById('sfnav-overlay');

    var question = qEl.value.trim();
    if (!question) {
      statusEl.textContent = 'Type a question first.';
      statusEl.className = 'sfnav-ask-status-row sfnav-ask-status-error';
      return;
    }

    var hasKey = await hasSoqlApiKey();
    if (!hasKey) {
      refreshAskKeyWarning();
      statusEl.innerHTML = 'No API key configured — <a href="#" class="sfnav-options-link">Open settings</a>';
      statusEl.className = 'sfnav-ask-status-row sfnav-ask-status-error';
      var link = statusEl.querySelector('.sfnav-options-link');
      if (link) link.onclick = function (e) { e.preventDefault(); openOptions(); };
      return;
    }

    var isFollowUp = !!(conv && conv.messages && conv.messages.length);
    var includeScreenshot = isThread ? askReplyIncludeScreenshot : askIncludeScreenshot;
    var shotContext = includeScreenshot && typeof getAskOrgContext === 'function'
      ? askScreenContextLabel(getAskOrgContext())
      : null;

    statusEl.textContent = '';
    statusEl.className = 'sfnav-ask-status-row';

    if (!isThread) {
      // A question from home opens a fresh thread view.
      showAskThreadView();
      document.getElementById('sfnav-ask-output').innerHTML = '';
      updateAskThreadHeader(question);
      statusEl = document.getElementById('sfnav-ask-thread-status');
    }

    appendUserBubble(question, includeScreenshot ? { context: shotContext } : null);
    qEl.value = '';
    autoGrowAskTextarea(qEl);

    // Per-turn activity container sits between the user bubble and the answer;
    // the thinking line below it keeps the UI alive until the answer lands.
    var activityEl = createAskActivityContainer();
    var thinkingEl = showAskThinking(includeScreenshot ? 'Screenshot captured' : (isFollowUp ? 'Thinking' : 'Loading record'));

    askInFlight = true;
    askRunDetached = false;
    var replyEl = document.getElementById('sfnav-ask-reply');
    var sendBtn = document.getElementById('sfnav-ask-send');
    replyEl.disabled = true;
    sendBtn.disabled = true;

    var prevDisplay = overlay.style.display;
    var restored = false;
    function restoreOverlay() {
      if (restored) return;
      restored = true;
      overlay.style.display = prevDisplay || 'flex';
    }
    if (!includeScreenshot) {
      restored = true;
    } else {
      overlay.style.display = 'none';
    }

    try {
      if (includeScreenshot) {
        await new Promise(function (resolve) {
          requestAnimationFrame(function () { requestAnimationFrame(resolve); });
        });
      }
      var result = await runAsk(question, function (event) {
        if (event.kind === 'captured') {
          restoreOverlay();
          updateAskThinking(thinkingEl, isFollowUp ? 'Thinking' : 'Loading record');
        } else if (event.kind === 'enriched') {
          updateAskThinking(thinkingEl, 'Thinking');
        } else if (event.kind === 'tool_call') {
          appendAskActivity(activityEl, event);
          updateAskThinking(thinkingEl, 'Investigating');
        } else if (event.kind === 'tool_result') {
          updateLastAskActivity(activityEl, event);
        } else if (event.kind === 'interim_text') {
          appendAskInterim(activityEl, event.text);
        } else if (event.kind === 'escalate') {
          appendAskInterim(activityEl, 'This needs a deeper session — ' + event.reason);
        }
      }, isFollowUp ? conv : null, { includeScreenshot: includeScreenshot });
      restoreOverlay();

      var turnRecord = { q: question, a: result.text || '', t: Date.now() };
      if (includeScreenshot) {
        turnRecord.s = 1;
        if (shotContext) turnRecord.sc = shotContext;
      }

      if (isFollowUp) {
        conv.messages = result.messages;
        conv.turns += 1;
        conv.qas.push(turnRecord);
        if (result.escalate) conv.ended = true;
      } else {
        conv = {
          messages: result.messages,
          systemBlocks: result.systemBlocks,
          context: result.context,
          turns: 1,
          ended: !!result.escalate,
          qas: [turnRecord],
          historyId: (typeof makeAskHistoryId === 'function') ? makeAskHistoryId() : String(Date.now()),
          contextLine: ''
        };
      }

      if (!conv.contextLine) {
        var ctxForEntry = result.context || {};
        var ctxBits = [];
        if (ctxForEntry.pageType && ctxForEntry.pageType !== 'other') ctxBits.push(ctxForEntry.pageType);
        if (ctxForEntry.sObject)   ctxBits.push(ctxForEntry.sObject);
        if (ctxForEntry.setupNode) ctxBits.push(ctxForEntry.setupNode);
        conv.contextLine = ctxBits.join(' · ');
      }

      if (typeof addToAskHistory === 'function' && result.text) {
        var updated = await addToAskHistory({
          id: conv.historyId,
          turns: conv.qas,
          contextLine: conv.contextLine,
          update: true
        });
        if (updated) askHistoryEntries = updated;
      }

      if (askRunDetached || searchMode !== 'ask') return; // user walked away — history is saved

      askConversation = conv;
      removeAskThinking(thinkingEl);

      var debugPayload = (DEV_MODE && askDebugMode)
        ? { system: result.systemBlocks, messages: result.messages }
        : null;
      appendAssistantMessage(result.text || '', debugPayload, turnRecord.t);
      updateAskThreadHeader();

      if (conv.ended || conv.turns >= MAX_ASK_TURNS) {
        showAskHandoff();
      } else {
        resetAskReplyComposer();
      }
    } catch (err) {
      restoreOverlay();
      removeAskThinking(thinkingEl);
      if (!askRunDetached && searchMode === 'ask' && askView === 'thread') {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'sfnav-ask-status-row sfnav-ask-status-error';
      }
      console.warn('sfnav: ask failed —', err);
    } finally {
      askInFlight = false;
      replyEl.disabled = false;
      sendBtn.disabled = false;
      if (!askRunDetached && searchMode === 'ask' && askView === 'thread'
          && !(askConversation && (askConversation.ended || askConversation.turns >= MAX_ASK_TURNS))) {
        replyEl.focus();
      }
    }
  }

  // shot: { context } when this message included a screenshot; null otherwise.
  function appendUserBubble(question, shot) {
    var outputEl = document.getElementById('sfnav-ask-output');
    var bubble = document.createElement('div');
    bubble.className = 'sfnav-ask-bubble-user';
    var textEl = document.createElement('div');
    textEl.className = 'sfnav-ask-bubble-text';
    textEl.textContent = question || '';
    bubble.appendChild(textEl);
    if (shot) {
      var note = document.createElement('div');
      note.className = 'sfnav-ask-bubble-note';
      note.innerHTML = ASK_CAMERA_SVG + '<span>Screenshot' + (shot.context ? ' · ' + esc(shot.context) : '') + '</span>';
      bubble.appendChild(note);
    }
    outputEl.appendChild(bubble);
    scrollAskThreadToBottom();
  }

  function appendAssistantMessage(answer, debugPayload, ts) {
    var outputEl = document.getElementById('sfnav-ask-output');
    var wrap = document.createElement('div');
    wrap.className = 'sfnav-ask-answer-wrap';
    var aDiv = document.createElement('div');
    aDiv.className = 'sfnav-ask-answer';
    aDiv.innerHTML = renderAskMarkdown(answer || '');
    wrap.appendChild(aDiv);

    var meta = document.createElement('div');
    meta.className = 'sfnav-ask-answer-meta';
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'sfnav-ask-answer-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = function () {
      navigator.clipboard.writeText(answer || '').then(function () {
        copyBtn.textContent = 'Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
      });
    };
    meta.appendChild(copyBtn);
    if (debugPayload) {
      var dbgBtn = document.createElement('button');
      dbgBtn.type = 'button';
      dbgBtn.className = 'sfnav-ask-answer-copy';
      dbgBtn.title = 'Copy debug payload';
      dbgBtn.textContent = '{ }';
      dbgBtn.onclick = function () {
        var json = JSON.stringify(debugPayload, null, 2);
        navigator.clipboard.writeText(json).then(function () {
          var prev = dbgBtn.textContent;
          dbgBtn.textContent = 'Copied';
          setTimeout(function () { dbgBtn.textContent = prev; }, 1500);
        });
      };
      meta.appendChild(dbgBtn);
    }
    var timeEl = document.createElement('span');
    timeEl.className = 'sfnav-ask-answer-time';
    timeEl.textContent = formatAskTimeAgo(ts || Date.now());
    meta.appendChild(timeEl);
    wrap.appendChild(meta);

    outputEl.appendChild(wrap);
    scrollAskThreadToBottom();
  }

  // ─── Thinking indicator (spinner + status while a turn is in flight) ───────

  function showAskThinking(text) {
    var outputEl = document.getElementById('sfnav-ask-output');
    if (!outputEl) return null;
    var el = document.createElement('div');
    el.className = 'sfnav-ask-thinking';
    el.innerHTML = '<span class="sfnav-ask-thinking-dot"></span><span class="sfnav-ask-thinking-text sfnav-progress-dots"></span>';
    el.querySelector('.sfnav-ask-thinking-text').textContent = text;
    outputEl.appendChild(el);
    scrollAskThreadToBottom();
    return el;
  }

  function updateAskThinking(el, text) {
    if (!el) return;
    var t = el.querySelector('.sfnav-ask-thinking-text');
    if (t) t.textContent = text;
    // Keep the indicator last in the thread even as activity items land above it.
    if (el.parentNode && el.parentNode.lastChild !== el) el.parentNode.appendChild(el);
    scrollAskThreadToBottom();
  }

  function removeAskThinking(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // Creates a per-turn activity container appended to the output thread,
  // positioned between the user bubble and the assistant answer for that turn.
  function createAskActivityContainer() {
    var outputEl = document.getElementById('sfnav-ask-output');
    var ul = document.createElement('ul');
    ul.className = 'sfnav-ask-activity';
    ul.style.display = 'none';
    outputEl.appendChild(ul);
    return ul;
  }

  function scrollAskThreadToBottom() {
    var scrollEl = document.getElementById('sfnav-ask-scroll');
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function showAskHandoff() {
    var composerEl = document.getElementById('sfnav-ask-reply-composer');
    var handoffEl = document.getElementById('sfnav-ask-handoff');
    if (composerEl) composerEl.style.display = 'none';
    if (!handoffEl) return;
    handoffEl.innerHTML =
      '<div class="sfnav-ask-handoff-heading">This thread is wrapping up</div>' +
      '<p class="sfnav-ask-handoff-body">Skipper keeps @ask short and grounded in your org. Want to dig deeper? The handover prompt packs this whole thread — questions, answers, and every query already run against your org — into one message you can paste into claude.ai, ChatGPT, or any other LLM to continue the investigation there.</p>' +
      '<div class="sfnav-ask-handoff-actions">' +
        '<button id="sfnav-ask-handoff-copy" class="sfnav-soql-btn-primary">Copy handover prompt</button>' +
        '<button id="sfnav-ask-handoff-new" class="sfnav-soql-btn-secondary">New thread</button>' +
      '</div>';
    handoffEl.style.display = 'flex';
    var copyBtn = document.getElementById('sfnav-ask-handoff-copy');
    if (copyBtn) {
      copyBtn.onclick = function () {
        var text = buildAskHandoverPrompt();
        if (!text) return;
        navigator.clipboard.writeText(text).then(function () {
          var prev = copyBtn.textContent;
          copyBtn.textContent = 'Copied';
          setTimeout(function () { copyBtn.textContent = prev; }, 1500);
        });
      };
    }
    var newBtn = document.getElementById('sfnav-ask-handoff-new');
    if (newBtn) {
      newBtn.onclick = function () { showAskHome(''); };
    }
    scrollAskThreadToBottom();
  }

  // One line per tool call for the handover prompt, e.g. "SOQL: SELECT ...".
  // Returns null for tools that don't belong in the list (escalateToDesktop).
  function askHandoverToolLine(name, input) {
    input = input || {};
    switch (name) {
      case 'runSoql':         return 'SOQL: ' + (input.query || '');
      case 'runToolingSoql':  return 'Tooling API SOQL: ' + (input.query || '');
      case 'describeSObject': return 'Described object ' + (input.sObject || '');
      case 'getFieldHistory': return 'Field history for record ' + (input.recordId || '');
      case 'searchApex':      return 'Searched Apex source for "' + (input.query || '') + '"';
      case 'searchFlows':     return 'Searched active Flows for "' + (input.query || '') + '"';
      case 'readApexClass':   return 'Read Apex ' + (input.kind === 'trigger' ? 'trigger' : 'class') + ' ' + (input.name || '');
      default: return null;
    }
  }

  // Portable, untruncated version of the thread for pasting into any LLM.
  // Assembled locally (no API call): the Q/As are already distilled answers,
  // and the tool_use blocks in the message history tell the receiving model
  // exactly which org data was already checked.
  function buildAskHandoverPrompt() {
    var conv = askConversation;
    if (!conv || !conv.qas || !conv.qas.length) return '';

    var lines = [
      'I\'m a Salesforce admin. I was troubleshooting an issue in my org with an AI assistant that had read-only API access, and I\'m handing the thread over to you to continue.'
    ];
    var where = askScreenContextLabel(conv.context) || conv.contextLine || '';
    if (conv.context && conv.context.recordId) {
      where += (where ? ' — ' : '') + 'record Id ' + conv.context.recordId;
    }
    if (where) lines.push('', 'Where this happened: ' + where);

    lines.push('', 'Thread so far:');
    conv.qas.forEach(function (qa) {
      lines.push('', 'Q: ' + qa.q, 'A: ' + qa.a);
    });

    var toolLines = [];
    (conv.messages || []).forEach(function (msg) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
      msg.content.forEach(function (block) {
        if (block.type !== 'tool_use') return;
        var line = askHandoverToolLine(block.name, block.input);
        if (line && toolLines.indexOf(line) === -1) toolLines.push(line);
      });
    });
    if (toolLines.length) {
      lines.push('', 'Org data the assistant already pulled:');
      toolLines.forEach(function (l) { lines.push('- ' + l); });
    }

    lines.push(
      '',
      'You don\'t have access to my org. When you need org data, give me the exact SOQL query, Tooling API query, or Setup path, and I\'ll paste back the results. Pick up the investigation from here.'
    );
    return lines.join('\n');
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
    escalateToDesktop: 'Recommending handover'
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

  function formatAskTimeAgo(ts) {
    var diff = Date.now() - (ts || 0);
    if (diff < 0) diff = 0;
    var min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    var day = Math.floor(hr / 24);
    return day + 'd ago';
  }

  var askHistoryExpanded = false;

  function renderAskHistoryList() {
    var recentEl = document.getElementById('sfnav-ask-recent');
    var listEl = document.getElementById('sfnav-ask-history');
    if (!recentEl || !listEl) return;
    askRecentSelIndex = -1;
    if (!askHistoryEntries.length) {
      recentEl.style.display = 'none';
      listEl.innerHTML = '';
      askVisibleEntries = [];
      return;
    }
    recentEl.style.display = 'block';
    listEl.innerHTML = '';

    var COLLAPSED = 3;
    var visible = askHistoryExpanded ? askHistoryEntries : askHistoryEntries.slice(0, COLLAPSED);
    askVisibleEntries = visible;

    var seenFirstQ = {};
    visible.forEach(function (entry) {
      var entryTurns = entry.turns || [{ q: entry.question || '', a: entry.answer || '' }];
      var firstQ = (entryTurns[0] && entryTurns[0].q) || '';
      var lastQ = (entryTurns[entryTurns.length - 1] && entryTurns[entryTurns.length - 1].q) || '';
      // Threads opening with the same question would render as twin rows —
      // show the latest question for the later duplicates instead.
      var displayQ = firstQ;
      var qKey = firstQ.trim().toLowerCase();
      if (seenFirstQ[qKey] && lastQ && lastQ !== firstQ) displayQ = lastQ;
      seenFirstQ[qKey] = true;

      var hasShot = entryTurns.some(function (t) { return t.s; });
      var metaText = entryTurns.length + ' turn' + (entryTurns.length === 1 ? '' : 's') + ' · ' + formatAskTimeAgo(entry.timestamp);

      var li = document.createElement('li');
      li.className = 'sfnav-ask-history-item';
      li.innerHTML =
        '<span class="sfnav-ask-history-main">' +
          '<span class="sfnav-ask-history-q">' + esc(displayQ) + '</span>' +
          '<span class="sfnav-ask-history-meta">' +
            (hasShot ? '<span class="sfnav-ask-history-cam">' + ASK_CAMERA_SVG + '</span>' : '') +
            esc(metaText) +
          '</span>' +
        '</span>' +
        '<span class="sfnav-ask-history-resume">Resume →</span>';
      li.addEventListener('click', function () {
        resumeAskThread(entry);
      });
      listEl.appendChild(li);
    });

    if (askHistoryEntries.length > COLLAPSED) {
      var moreLi = document.createElement('li');
      moreLi.className = 'sfnav-ask-history-more';
      moreLi.textContent = askHistoryExpanded
        ? 'Show fewer'
        : 'Show all conversations (' + askHistoryEntries.length + ') →';
      moreLi.addEventListener('click', function () {
        askHistoryExpanded = !askHistoryExpanded;
        renderAskHistoryList();
      });
      listEl.appendChild(moreLi);
    }
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
    if (typeof sfnavInitOnboarding === 'function') sfnavInitOnboarding();
    input.focus();
  }

  // Lets onboarding.js read live shortcut metadata for the cheat sheet.
  window.__sfnavGetShortcuts = function () { return SHORTCUTS.slice(); };

  var feedbackInFlight = false;
  var feedbackContext = null;

  function truncateForContext(s, max) {
    if (!s) return '';
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  // Snapshot whatever the user was looking at when they clicked the feedback
  // link — almost always they want to tell us about that artifact, not file
  // a generic note. Capture runs BEFORE the prior panel is torn down.
  function captureFeedbackContext() {
    if (searchMode === 'soql') {
      var prompt = (document.getElementById('sfnav-input').value || '').trim();
      var soqlEl = document.getElementById('sfnav-soql-output');
      var statusEl = document.getElementById('sfnav-soql-status');
      var soql = soqlEl ? (soqlEl.textContent || '').trim() : '';
      var status = statusEl ? (statusEl.textContent || '').trim() : '';
      if (!prompt && !soql) return null;
      return {
        mode: 'soql',
        prompt: truncateForContext(prompt, 2000),
        soql: truncateForContext(soql, 2000),
        status: truncateForContext(status, 500)
      };
    }
    if (searchMode === 'ask') {
      var qEl = askPrimaryTextarea();
      var answerEls = document.querySelectorAll('#sfnav-ask-output .sfnav-ask-answer');
      var aEl = answerEls.length ? answerEls[answerEls.length - 1] : null;
      var question = (qEl && qEl.value || '').trim();
      if (!question && askConversation && askConversation.qas && askConversation.qas.length) {
        question = (askConversation.qas[askConversation.qas.length - 1].q || '').trim();
      }
      var answer = (aEl && aEl.textContent || '').trim();
      if ((!question || !answer) && askHistoryEntries && askHistoryEntries.length) {
        var lastTurns = (askHistoryEntries[0] && askHistoryEntries[0].turns) || [];
        var lastTurn = lastTurns[lastTurns.length - 1] || {};
        if (!question) question = (lastTurn.q || '').trim();
        if (!answer)   answer   = (lastTurn.a || '').trim();
      }
      if (!question && !answer) return null;
      return {
        mode: 'ask',
        question: truncateForContext(question, 2000),
        answer:   truncateForContext(answer, 2000)
      };
    }
    if (searchMode === 'flow-debug') {
      var output = document.getElementById('sfnav-flowdebug-output');
      if (!output || output.style.display === 'none') return null;
      var summaryNode = output.querySelector('.sfnav-flowdebug-summary .sfnav-flowdebug-body');
      var causeNode   = output.querySelector('.sfnav-flowdebug-cause .sfnav-flowdebug-body');
      var summary = summaryNode ? (summaryNode.textContent || '').trim() : '';
      var cause   = causeNode   ? (causeNode.textContent   || '').trim() : '';
      if (!summary && !cause) return null;
      var expEl = document.getElementById('sfnav-flowdebug-expectation');
      var expectation = expEl ? (expEl.value || '').trim() : '';
      var flowId = (typeof getFlowIdFromUrl === 'function') ? (getFlowIdFromUrl() || null) : null;
      return {
        mode: 'flow-debug',
        flowId: flowId,
        expectation: truncateForContext(expectation, 500),
        summary: truncateForContext(summary, 2000),
        cause:   truncateForContext(cause, 2000)
      };
    }
    return null;
  }

  function renderFeedbackContextChip() {
    var el = document.getElementById('sfnav-feedback-context');
    if (!el) return;
    if (!feedbackContext) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    var actionLabel = '';
    var snippet = '';
    if (feedbackContext.mode === 'soql') {
      actionLabel = 'Attaching your SOQL query';
      snippet = feedbackContext.prompt || feedbackContext.soql || '';
    } else if (feedbackContext.mode === 'ask') {
      actionLabel = 'Attaching your @ask conversation';
      snippet = feedbackContext.question || feedbackContext.answer || '';
    } else if (feedbackContext.mode === 'flow-debug') {
      actionLabel = 'Attaching your debug analysis';
      snippet = feedbackContext.summary || feedbackContext.flowId || '';
    } else {
      actionLabel = 'Attaching context';
    }
    if (snippet.length > 70) snippet = snippet.slice(0, 69) + '…';
    el.innerHTML =
      '<span class="sfnav-feedback-ctx-icon" aria-hidden="true"></span>' +
      '<span class="sfnav-feedback-ctx-text">' +
        '<span class="sfnav-feedback-ctx-label">' + esc(actionLabel) + '</span>' +
        (snippet ? '<span class="sfnav-feedback-ctx-snippet">' + esc(snippet) + '</span>' : '') +
      '</span>' +
      '<button class="sfnav-feedback-ctx-x" type="button" title="Don’t attach" aria-label="Don’t attach">×</button>';
    el.style.display = 'flex';
    var xBtn = el.querySelector('.sfnav-feedback-ctx-x');
    if (xBtn) xBtn.onclick = function () {
      feedbackContext = null;
      renderFeedbackContextChip();
      var msg = document.getElementById('sfnav-feedback-message');
      if (msg) msg.focus();
    };
  }

  function enterFeedbackMode() {
    feedbackContext = captureFeedbackContext();
    hideSoqlPanel();
    searchMode = 'feedback';
    setFooterHints('feedback');
    var input = document.getElementById('sfnav-input');
    input.value = '';
    input.placeholder = 'Send feedback to the Skipper team';
    input.disabled = true;
    document.getElementById('sfnav-results').style.display = 'none';
    var hintEl = document.getElementById('sfnav-hint');
    hintEl.textContent = '';
    hintEl.style.display = 'none';
    document.getElementById('sfnav-breadcrumb').innerHTML = renderBreadcrumbHtml([{ text: 'Feedback' }]);
    document.getElementById('sfnav-breadcrumb').style.display = 'flex';
    document.getElementById('sfnav-feedback').style.display = 'flex';

    var statusEl = document.getElementById('sfnav-feedback-status');
    statusEl.textContent = '';
    statusEl.className = '';

    var msgEl = document.getElementById('sfnav-feedback-message');
    var emailEl = document.getElementById('sfnav-feedback-email');
    msgEl.value = '';

    chrome.storage.local.get('sfnavOptions', function (data) {
      var opts = (data && data.sfnavOptions) || {};
      var savedEmail = (opts.skipper && opts.skipper.email) || opts.feedbackEmail || '';
      if (savedEmail && !emailEl.value) emailEl.value = savedEmail;
    });

    document.getElementById('sfnav-feedback-send').onclick = runFeedbackSubmit;

    renderFeedbackContextChip();

    msgEl.focus();
  }

  function runFeedbackSubmit() {
    if (feedbackInFlight) return;
    var msgEl = document.getElementById('sfnav-feedback-message');
    var emailEl = document.getElementById('sfnav-feedback-email');
    var statusEl = document.getElementById('sfnav-feedback-status');
    var btn = document.getElementById('sfnav-feedback-send');

    var message = msgEl.value.trim();
    if (!message) {
      statusEl.textContent = 'Type something first.';
      statusEl.className = 'sfnav-soql-status-error';
      msgEl.focus();
      return;
    }

    feedbackInFlight = true;
    btn.disabled = true;
    msgEl.disabled = true;
    emailEl.disabled = true;
    statusEl.textContent = 'Sending';
    statusEl.className = 'sfnav-soql-status-loading sfnav-progress-dots';

    var email = emailEl.value.trim();
    sendFeedback(message, email, feedbackContext).then(function () {
      // Remember the email so the next feedback round doesn't ask again.
      if (email) {
        chrome.storage.local.get('sfnavOptions', function (data) {
          var opts = (data && data.sfnavOptions) || {};
          opts.feedbackEmail = email;
          chrome.storage.local.set({ sfnavOptions: opts });
        });
      }
      statusEl.textContent = 'Thanks — sent.';
      statusEl.className = 'sfnav-soql-status-ok';
      msgEl.value = '';
      msgEl.disabled = false;
      emailEl.disabled = false;
      btn.disabled = false;
      feedbackInFlight = false;
      feedbackContext = null;
      renderFeedbackContextChip();
    }).catch(function (err) {
      statusEl.textContent = 'Could not send: ' + err.message;
      statusEl.className = 'sfnav-soql-status-error';
      msgEl.disabled = false;
      emailEl.disabled = false;
      btn.disabled = false;
      feedbackInFlight = false;
    });
  }

  function hideSoqlPanel() {
    var inputEl = document.getElementById('sfnav-input');
    if (inputEl) inputEl.style.display = ''; // @ask hides it in favor of its own header
    var soqlEl = document.getElementById('sfnav-soql');
    if (soqlEl) soqlEl.style.display = 'none';
    var fdEl = document.getElementById('sfnav-flowdebug');
    if (fdEl) fdEl.style.display = 'none';
    var askEl = document.getElementById('sfnav-ask');
    if (askEl) askEl.style.display = 'none';
    var fbEl = document.getElementById('sfnav-feedback');
    if (fbEl) fbEl.style.display = 'none';
    var resultsEl = document.getElementById('sfnav-results');
    if (resultsEl) resultsEl.style.display = '';
    var hintEl = document.getElementById('sfnav-hint');
    if (hintEl) hintEl.style.display = '';
  }

  function hidePalette() {
    var overlay = document.getElementById('sfnav-overlay');
    if (overlay) overlay.style.display = 'none';
    if (typeof sfnavHideOnboarding === 'function') sfnavHideOnboarding();
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

    var segments = breadcrumbForResolution(resolution);
    if (segments) {
      breadcrumbEl.innerHTML = renderBreadcrumbHtml(segments);
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
        if (result.keyword) li.dataset.shortcut = result.keyword;
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
      if (result.keyword) li.dataset.shortcut = result.keyword;

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

    if (result && result.type === 'action' && PICKER_REFRESH[result.action]) {
      runPickerRefresh(result.action);
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

    if (result && result.type === 'subpage') {
      openSubPage(result);
      return;
    }

    if (result && result.type === 'flow' && result.flow) {
      openFlow(result);
      return;
    }

    openUrl(url);
  }

  // The cached flow version id can be stale (see resolveFlowVersionId), so we
  // re-resolve the current active/latest version at open time. Falls back to
  // the cached URL if resolution fails.
  function openFlow(result) {
    var hintEl = document.getElementById('sfnav-hint');
    if (hintEl) hintEl.textContent = 'Opening latest version…';
    resolveFlowVersionId(result.flow)
      .then(function (versionId) {
        openUrl(getOrgBase() + '/builder_platform_interaction/flowBuilder.app?flowId=' + (versionId || result.flow.id));
      })
      .catch(function (err) {
        console.warn('sfnav: flow open failed —', err);
        openUrl(result.url);
      });
  }

  var PICKER_REFRESH = {
    'refresh-flows':    { label: 'flows',           load: function () { return loadFlows(); } },
    'refresh-apps':     { label: 'apps',            load: function () { return loadApps(); } },
    'refresh-labels':   { label: 'custom labels',   load: function () { return loadLabels(); } },
    'refresh-permsets': { label: 'permission sets', load: function () { return loadPermsets(); } },
    'refresh-objects':  { label: 'objects',         load: function () { return loadObjectsFromPage(); } },
  };

  // Reloads a picker's backing cache and updates the hint while loading.
  // The sfnav:*-loaded event listener re-renders the picker once the load
  // completes, so the user never has to leave the palette.
  function runPickerRefresh(action) {
    var entry = PICKER_REFRESH[action];
    if (!entry) return;
    var hintEl = document.getElementById('sfnav-hint');
    if (hintEl) hintEl.textContent = 'Refreshing ' + entry.label + '…';
    entry.load().catch(function (err) {
      console.warn('sfnav: ' + entry.label + ' refresh failed —', err);
      if (hintEl) hintEl.textContent = 'Failed to refresh ' + entry.label + ': ' + (err && err.message ? err.message : 'unknown error');
    });
  }

  // Object Manager sub-pages must be opened with the EntityDefinition DurableId,
  // not the API name. Using the API name bounces the page to the setup subdomain
  // in a state where the "New" button (and other action-bar elements) don't render.
  function openSubPage(result) {
    var object = result.object;
    if (object && object.entityId) {
      openUrl(buildObjectSubPageUrl(object.entityId, result.segment));
      return;
    }
    var hintEl = document.getElementById('sfnav-hint');
    if (hintEl) hintEl.textContent = 'Resolving object…';
    getEntityIdForObject(object.apiName)
      .then(function (entityId) {
        openUrl(buildObjectSubPageUrl(entityId, result.segment));
      })
      .catch(function (err) {
        console.warn('sfnav: entity ID lookup failed —', err);
        openUrl(result.url);
      });
  }

  function executeShortcut(keyword) {
    var shortcut = sfnavFindShortcut(keyword);
    if (shortcut) enterShortcutMode(shortcut, '');
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
          openUrl(buildCmdtObjectDefinitionUrl(entityId));
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
        openUrl(buildCmdtManageRecordsUrl(result.cmdt.keyPrefix));
        return;
      }
      if (hintEl) hintEl.textContent = 'Resolving key prefix…';
      getKeyPrefixForCmdt(result.cmdt.apiName)
        .then(function (prefix) {
          openUrl(buildCmdtManageRecordsUrl(prefix));
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
    if (mode === 'feedback') {
      el.textContent = sfnavModEnterHint() + ' to send · Esc to go back';
      return;
    }
    el.textContent = FOOTER_HINTS[mode] || DEFAULT_FOOTER_HINT;
  }

  // Re-render when async data finishes loading while the palette is open
  document.addEventListener('sfnav:apps-loaded', function () {
    if (!paletteVisible) return;
    var input = document.getElementById('sfnav-input');
    if (!input) return;
    if (searchMode === 'app-picker') {
      renderResults(resolveAppPicker(input.value));
    }
  });

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

  document.addEventListener('sfnav:objects-loaded', function () {
    if (!paletteVisible) return;
    var input = document.getElementById('sfnav-input');
    if (!input) return;
    if (searchMode === 'object-picker') {
      renderResults(resolveObjectPicker(input.value));
    } else if (searchMode === 'cmd-picker') {
      renderResults(resolveCmdtPicker(input.value));
    }
  });

  // Keyboard shortcut (direct, for cases where background message isn't used)
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'K') {
      e.preventDefault();
      e.stopPropagation();
      togglePalette();
      return;
    }
    // Esc must always escape the palette, even when focus has drifted to a
    // non-handler element (rendered answer, breadcrumb, status line, etc.).
    // Inner inputs/textareas call preventDefault on their own Esc handling, so
    // defaultPrevented guards against double-firing.
    if (e.key === 'Escape' && paletteVisible && !e.defaultPrevented) {
      e.preventDefault();
      handleBack();
    }
  });

}());
