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
  var openInNewTabPref = true;

  var skipperSignedIn = false;

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('sfnavOptions', function (data) {
      var opts = (data && data.sfnavOptions) || {};
      if (opts.openInNewTab === false) openInNewTabPref = false;
      skipperSignedIn = !!(opts.skipper && opts.skipper.accessToken);
      updateSignInBanner();
    });
    if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.sfnavOptions) return;
        var next = changes.sfnavOptions.newValue || {};
        openInNewTabPref = next.openInNewTab !== false;
        skipperSignedIn = !!(next.skipper && next.skipper.accessToken);
        updateSignInBanner();
      });
    }
  }

  // Visible only when not signed in AND we're in the root/picker view
  // (results list showing — not inside a panel like @soql/@ask/@debug/feedback).
  function updateSignInBanner() {
    var banner = document.getElementById('sfnav-signin-banner');
    if (!banner) return;
    var resultsEl = document.getElementById('sfnav-results');
    var resultsVisible = !!resultsEl && resultsEl.style.display !== 'none';
    banner.style.display = (!skipperSignedIn && resultsVisible) ? 'flex' : 'none';
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
    'cmd-scoped':    function () { enterCmdPickerMode(cmdtPickerFilter); }
  };

  // Where to bounce focus when the user clicks dead space inside a panel mode.
  var PANEL_PRIMARY_INPUTS = [
    { panelId: 'sfnav-soql',      inputId: 'sfnav-input' },
    { panelId: 'sfnav-flowdebug', inputId: 'sfnav-flowdebug-debug' },
    { panelId: 'sfnav-ask',       inputId: 'sfnav-ask-question' },
    { panelId: 'sfnav-feedback',  inputId: 'sfnav-feedback-message' }
  ];

  var FOOTER_HINTS = {
    'soql':       'Enter to generate · Esc to go back',
    'flow-debug': 'Enter to analyze · Shift+Enter for newline · Esc to go back',
    'ask':        'Enter to ask · Shift+Enter for newline · Esc to go back',
    'feedback':   'Cmd+Enter to send · Esc to go back'
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
    'permset-picker': '@permset'
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

  // Settings links inside the AI panels. pane: 'provider' (BYOK form) or
  // 'account' (Skipper sign-in). Mirrors the sign-in banner button.
  function openSoqlSettings(pane) {
    try { chrome.runtime.sendMessage({ type: 'openOptions', pane: pane || 'provider' }); } catch (err) {}
    hidePalette();
  }

  function wireSettingsLinks(el) {
    el.querySelectorAll('.sfnav-settings-link').forEach(function (link) {
      link.onclick = function (e) {
        e.preventDefault();
        openSoqlSettings(link.getAttribute('data-pane'));
      };
    });
  }

  // Used by the @soql, @debug, and @ask panels for the status pill above the
  // input. Shows one of:
  //   BYOK:            "API key connected"
  //   Free+ (allowed): "Skipper Free · 17/20 left"  (or "Skipper Free" when
  //                                                   quota hasn't been seen yet)
  //   Free+ (not on tier): "BYOK required for @ask"
  //   Signed out, feature on Free+: "Try @soql free — sign in · use your own key"
  //   Signed out, @ask:             "No API key — configure in settings"
  function renderApiKeyStat(elId, feature) {
    feature = feature || 'soql';
    canCallAi(feature).then(function (r) {
      var el = document.getElementById(elId);
      if (!el) return;

      if (r.ok && r.mode === 'byok') {
        el.textContent = 'API key connected';
        el.className = 'sfnav-apistat sfnav-apistat-ok';
        return;
      }
      if (r.ok && r.mode === 'free') {
        var label = 'Skipper Free';
        if (r.quota && typeof r.quota.remaining === 'number' && typeof r.quota.limit === 'number') {
          label += ' · ' + r.quota.remaining + '/' + r.quota.limit + ' left';
        }
        el.textContent = label;
        el.className = 'sfnav-apistat sfnav-apistat-ok';
        return;
      }
      if (!r.ok && r.mode === 'free' && r.reason === 'not_on_tier') {
        el.innerHTML = 'BYOK required for @' + feature + ' — <a href="#" data-pane="provider" class="sfnav-settings-link">add a key</a>';
        el.className = 'sfnav-apistat sfnav-apistat-missing';
        wireSettingsLinks(el);
        return;
      }
      if (feature === 'ask') {
        // Signing in doesn't unlock @ask (BYOK-only on Free+), so don't pitch it.
        el.innerHTML = 'No API key — <a href="#" data-pane="provider" class="sfnav-settings-link">configure in settings</a>';
        el.className = 'sfnav-apistat sfnav-apistat-missing';
        wireSettingsLinks(el);
        return;
      }
      el.innerHTML = 'Try @' + feature + ' free — <a href="#" data-pane="account" class="sfnav-settings-link">sign in</a> · <a href="#" data-pane="provider" class="sfnav-settings-link">use your own key</a>';
      el.className = 'sfnav-apistat sfnav-apistat-missing';
      wireSettingsLinks(el);
    });
  }

  // Run-handler pre-flight when canCallAi says "no". Signed-out users on a
  // Free+ feature get the sign-up pitch; @ask (BYOK-only) and not_on_tier get
  // the key-focused copy.
  function showAiUnavailable(statusEl, errorClass, feature, reason) {
    if (reason === 'not_on_tier') {
      statusEl.innerHTML = '@' + feature + ' is not on the Skipper Free tier. <a href="#" data-pane="provider" class="sfnav-settings-link">Open settings</a>.';
    } else if (feature === 'ask') {
      statusEl.innerHTML = 'No API key configured. <a href="#" data-pane="provider" class="sfnav-settings-link">Open settings</a>.';
    } else {
      statusEl.innerHTML = 'Run @' + feature + ' free with a Skipper account — no API key needed. '
        + '<a href="#" data-pane="account" class="sfnav-settings-link">Sign in</a> · '
        + '<a href="#" data-pane="provider" class="sfnav-settings-link">add your own key</a>.';
    }
    statusEl.className = errorClass;
    wireSettingsLinks(statusEl);
  }

  // Catch-block helper. If err.skipperCode is set (quota, kill-switch,
  // session-expired) we render a tailored message with a settings link.
  function renderAiError(statusEl, errorClass, err) {
    if (!err || !err.skipperCode) {
      statusEl.textContent = 'Error: ' + ((err && err.message) || 'unknown');
      statusEl.className = errorClass;
      return;
    }
    // Expired session → land on the Account row; everything else → BYOK form.
    var pane = err.skipperCode === 'session_expired' ? 'account' : 'provider';
    statusEl.innerHTML = (err.message || 'Error') + ' <a href="#" data-pane="' + pane + '" class="sfnav-settings-link">Open settings</a>.';
    statusEl.className = errorClass;
    wireSettingsLinks(statusEl);
  }

  function injectPalette() {
    if (document.getElementById('sfnav-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'sfnav-overlay';
    overlay.innerHTML =
      '<div id="sfnav-palette">' +
        '<div id="sfnav-signin-banner" style="display:none">' +
          '<span class="sfnav-signin-text">Sign in to Skipper</span>' +
          '<button id="sfnav-signin-btn" type="button">Sign in</button>' +
        '</div>' +
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
          '<div id="sfnav-ask-meta"></div>' +
          '<textarea id="sfnav-ask-question" placeholder="What’s happening here? Why this error? Anything you want to know about the current screen…" spellcheck="false"></textarea>' +
          '<div id="sfnav-ask-actions">' +
            '<button id="sfnav-ask-run" class="sfnav-soql-btn-primary">Ask <span class="sfnav-kbd">↵</span></button>' +
            '<span id="sfnav-ask-apistat" class="sfnav-apistat"></span>' +
          '</div>' +
          '<div id="sfnav-ask-status"></div>' +
          '<ul id="sfnav-ask-activity" style="display:none"></ul>' +
          '<div id="sfnav-ask-output" style="display:none">' +
            '<div class="sfnav-ask-output-question" style="display:none"></div>' +
            '<div class="sfnav-ask-answer"></div>' +
            '<button class="sfnav-ask-copy">Copy answer</button>' +
          '</div>' +
          '<div id="sfnav-ask-history-label" class="sfnav-section-header" style="display:none">Recent</div>' +
          '<ul id="sfnav-ask-history"></ul>' +
        '</div>' +
        '<div id="sfnav-feedback" style="display:none">' +
          '<div id="sfnav-feedback-context" style="display:none"></div>' +
          '<textarea id="sfnav-feedback-message" placeholder="What’s broken, missing, or confusing? Anything Skipper could do better…" spellcheck="false"></textarea>' +
          '<div class="sfnav-feedback-field">' +
            '<label for="sfnav-feedback-email" class="sfnav-feedback-field-label">Reply to (optional)</label>' +
            '<input id="sfnav-feedback-email" type="email" placeholder="your@email.com" autocomplete="email" />' +
          '</div>' +
          '<div id="sfnav-feedback-actions">' +
            '<button id="sfnav-feedback-send" class="sfnav-soql-btn-primary">Send <span class="sfnav-kbd">⌘↵</span></button>' +
            '<span id="sfnav-feedback-status"></span>' +
          '</div>' +
        '</div>' +
        '<div id="sfnav-footer"><span id="sfnav-brand">Skipper for Salesforce<span id="sfnav-brand-help">help</span></span><a id="sfnav-feedback-link" href="#">feedback</a><span id="sfnav-footer-hints"></span></div>' +
      '</div>';

    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) hidePalette();
    });

    // Clicking dead space inside a panel mode (the breadcrumb, meta line,
    // status, rendered answer, etc.) used to leave focus on a non-handler
    // element — Esc then went nowhere because only the panel's primary
    // input/textarea carries the keydown listener. Bounce focus back to it.
    PANEL_PRIMARY_INPUTS.forEach(function (entry) {
      var panel = document.getElementById(entry.panelId);
      if (!panel) return;
      panel.addEventListener('click', function (e) {
        if (e.target.closest('button, a, textarea, input, [contenteditable="true"]')) return;
        var target = document.getElementById(entry.inputId);
        if (target && !target.disabled) target.focus();
      });
    });

    var signInBtn = document.getElementById('sfnav-signin-btn');
    if (signInBtn) {
      signInBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        try { chrome.runtime.sendMessage({ type: 'openOptions', pane: 'account' }); } catch (err) {}
        hidePalette();
      });
    }

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
    updateSignInBanner();
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

    renderApiKeyStat('sfnav-soql-apistat', 'soql');

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

    var access = await canCallAi('soql');
    if (!access.ok) {
      actionsEl.style.display = 'none';
      showAiUnavailable(statusEl, 'sfnav-soql-status-error', 'soql', access.reason);
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
      renderAiError(statusEl, 'sfnav-soql-status-error', err);
      actionsEl.style.display = 'none';
      // Refresh the connected-status pill so quota count moves down on 402.
      renderApiKeyStat('sfnav-soql-apistat', 'soql');
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
    updateSignInBanner();
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

    renderApiKeyStat('sfnav-flowdebug-apistat', 'debug');

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

    var access = await canCallAi('debug');
    if (!access.ok) {
      showAiUnavailable(statusEl, 'sfnav-flowdebug-status-error', 'debug', access.reason);
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
      renderAiError(statusEl, 'sfnav-flowdebug-status-error', err);
      outputEl.style.display = 'none';
      renderApiKeyStat('sfnav-flowdebug-apistat', 'debug');
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
    updateSignInBanner();
    document.getElementById('sfnav-hint').textContent = '';
    document.getElementById('sfnav-breadcrumb').innerHTML = renderBreadcrumbHtml([{ text: '@ask' }]);
    document.getElementById('sfnav-breadcrumb').style.display = 'flex';
    document.getElementById('sfnav-ask').style.display = 'flex';
    document.getElementById('sfnav-ask-status').textContent = '';
    document.getElementById('sfnav-ask-status').className = '';
    document.getElementById('sfnav-ask-output').style.display = 'none';
    var actEl = document.getElementById('sfnav-ask-activity');
    actEl.innerHTML = '';
    actEl.style.display = 'none';
    document.getElementById('sfnav-ask-question').value = initialQuestion || '';

    if (typeof getAskHistory === 'function') {
      getAskHistory().then(function (entries) {
        askHistoryEntries = entries || [];
        renderAskHistoryList();
      });
    }

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

    renderApiKeyStat('sfnav-ask-apistat', 'ask');

    document.getElementById('sfnav-ask-run').onclick = runAskQuery;

    var qEl = document.getElementById('sfnav-ask-question');
    qEl.onkeydown = function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runAskQuery();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleBack();
      }
    };

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

    var access = await canCallAi('ask');
    if (!access.ok) {
      showAiUnavailable(statusEl, 'sfnav-ask-status-error', 'ask', access.reason);
      return;
    }

    askInFlight = true;
    runBtn.disabled = true;
    qEl.disabled = true;
    statusEl.textContent = 'Capturing screen + loading record';
    statusEl.className = 'sfnav-ask-status-loading sfnav-progress-dots';
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
            statusEl.textContent = 'Asking the assistant (sent ' + n + ' record fields)';
          } else {
            statusEl.textContent = 'Asking the assistant';
          }
        } else if (event.kind === 'tool_call') {
          appendAskActivity(activityEl, event);
          statusEl.textContent = 'Investigating';
        } else if (event.kind === 'tool_result') {
          updateLastAskActivity(activityEl, event);
        } else if (event.kind === 'interim_text') {
          appendAskInterim(activityEl, event.text);
        } else if (event.kind === 'escalate') {
          appendAskInterim(activityEl, 'Escalating to claude.ai — ' + event.reason);
        }
      });
      restoreOverlay();
      var ctxForEntry = result.context || {};
      var ctxBits = [];
      if (ctxForEntry.pageType)  ctxBits.push(ctxForEntry.pageType);
      if (ctxForEntry.sObject)   ctxBits.push(ctxForEntry.sObject);
      if (ctxForEntry.setupNode) ctxBits.push(ctxForEntry.setupNode);
      var contextLineForEntry = ctxBits.join(' · ');
      renderAskOutput({ question: question, answer: result.text || '' });
      if (typeof addToAskHistory === 'function' && result.text) {
        var updated = await addToAskHistory({
          question: question,
          answer: result.text,
          contextLine: contextLineForEntry
        });
        if (updated) askHistoryEntries = updated;
        renderAskHistoryList();
      }
      statusEl.textContent = result.toolCallCount
        ? 'Done · ' + result.toolCallCount + ' tool call' + (result.toolCallCount === 1 ? '' : 's')
        : 'Done';
      statusEl.className = 'sfnav-ask-status-ok';
    } catch (err) {
      restoreOverlay();
      renderAiError(statusEl, 'sfnav-ask-status-error', err);
      outputEl.style.display = 'none';
      renderApiKeyStat('sfnav-ask-apistat', 'ask');
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

  function renderAskOutput(entry) {
    var outputEl = document.getElementById('sfnav-ask-output');
    var questionEl = outputEl.querySelector('.sfnav-ask-output-question');
    var answerEl = outputEl.querySelector('.sfnav-ask-answer');
    var copyBtn  = outputEl.querySelector('.sfnav-ask-copy');
    var question = (entry && entry.question) || '';
    var answer = (entry && entry.answer) || '';
    if (question) {
      questionEl.textContent = question;
      questionEl.style.display = 'block';
    } else {
      questionEl.style.display = 'none';
    }
    answerEl.innerHTML = renderAskMarkdown(answer);
    copyBtn.onclick = function () {
      navigator.clipboard.writeText(answer).then(function () {
        var prev = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = prev; }, 1500);
      });
    };
    outputEl.style.display = 'block';
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
    var listEl = document.getElementById('sfnav-ask-history');
    var labelEl = document.getElementById('sfnav-ask-history-label');
    if (!listEl || !labelEl) return;
    if (!askHistoryEntries.length) {
      labelEl.style.display = 'none';
      listEl.style.display = 'none';
      listEl.innerHTML = '';
      return;
    }
    labelEl.style.display = 'flex';
    listEl.style.display = 'block';
    listEl.innerHTML = '';

    var COLLAPSED = 3;
    var visible = askHistoryExpanded ? askHistoryEntries : askHistoryEntries.slice(0, COLLAPSED);

    visible.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'sfnav-ask-history-item';
      li.innerHTML =
        '<span class="sfnav-ask-history-q">' + esc(entry.question || '') + '</span>' +
        '<span class="sfnav-ask-history-meta">' + esc(formatAskTimeAgo(entry.timestamp)) + '</span>';
      li.addEventListener('click', function () {
        renderAskOutput(entry);
      });
      listEl.appendChild(li);
    });

    if (askHistoryEntries.length > COLLAPSED) {
      var moreLi = document.createElement('li');
      moreLi.className = 'sfnav-ask-history-more';
      moreLi.textContent = askHistoryExpanded
        ? 'Show less'
        : '… ' + (askHistoryEntries.length - COLLAPSED) + ' more';
      moreLi.addEventListener('click', function () {
        askHistoryExpanded = !askHistoryExpanded;
        renderAskHistoryList();
      });
      listEl.appendChild(moreLi);
    }
  }

  // Minimal Markdown-ish renderer: paragraphs, bullets, inline code, bold.
  // We deliberately don't pull in a full Markdown lib — this keeps the answer
  // readable when Claude uses light formatting, without HTML-injection risk.
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
      var qEl = document.getElementById('sfnav-ask-question');
      var aEl = document.querySelector('#sfnav-ask-output .sfnav-ask-answer');
      var question = (qEl && qEl.value || '').trim();
      var answer = (aEl && aEl.textContent || '').trim();
      if ((!question || !answer) && askHistoryEntries && askHistoryEntries.length) {
        var last = askHistoryEntries[0];
        if (!question) question = ((last && last.question) || '').trim();
        if (!answer)   answer   = ((last && last.answer)   || '').trim();
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
    document.getElementById('sfnav-results').style.display = 'none';
    updateSignInBanner();
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

    msgEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        runFeedbackSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleBack();
      }
    });
    emailEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        runFeedbackSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleBack();
      }
    });

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
    updateSignInBanner();
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

    openUrl(url);
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
    el.textContent = FOOTER_HINTS[mode] || DEFAULT_FOOTER_HINT;
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
