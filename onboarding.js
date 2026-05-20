(function () {
  // First-run walkthrough + help panel for the Skipper palette.
  // Entry points: sfnavInitOnboarding (called on palette open) and
  // sfnavHideOnboarding (called on palette close).

  var STORAGE_KEY = 'sfnavOptions';

  var state = { walkthroughSeen: false };
  var _loaded = false;
  var _tourActive = false;
  var _tourStep = 1;
  var _shownThisSession = false;
  var _helpOpen = false;
  var _resizeListener = null;
  var _keyListener = null;

  chrome.storage.local.get(STORAGE_KEY, function (data) {
    var opts = (data && data[STORAGE_KEY]) || {};
    state.walkthroughSeen = !!(opts.walkthroughSeen || opts.onboardingDone);
    _loaded = true;
  });

  function persist(patch) {
    chrome.storage.local.get(STORAGE_KEY, function (data) {
      var opts = (data && data[STORAGE_KEY]) || {};
      Object.keys(patch).forEach(function (k) { opts[k] = patch[k]; });
      chrome.storage.local.set({ sfnavOptions: opts });
    });
  }

  // ─── Step definitions ──────────────────────────────────────────────────────

  var STEPS = [
    {
      eyebrow: 'Open',
      title: 'Open Skipper from anywhere',
      desc: 'Press this keyboard shortcut from any page in Salesforce — Setup, a record, a flow, anywhere.',
      note: null,
      rows: [],
      right: 'shortcut'
    },
    {
      eyebrow: 'Navigate',
      title: 'Jump to anything with @',
      desc: 'Type @ to see what you can search. Add a word after the scope to filter — then press Enter to go straight there.',
      note: null,
      rows: ['object', 'flow', 'app', 'setup', 'label', 'permset'],
      right: 'examples',
      examples: [
        { scope: '@object', arg: ' Case',                   hint: 'goes to object' },
        { scope: '@setup',  arg: ' failed flow interviews',  hint: 'setup page'    },
        { scope: '@app',    arg: ' sales console',           hint: 'opens app'     },
        { scope: '@flow',   arg: ' Account Before Save',     hint: 'opens flow'    }
      ]
    },
    {
      eyebrow: 'AI — Query',
      title: 'Find records by describing them',
      desc: 'Type what you’re looking for in plain English — Claude turns it into a Salesforce data query (SOQL) for you.',
      note: 'Requires an Anthropic API key in Options.',
      rows: ['soql'],
      right: 'examples',
      examples: [
        { scope: '@soql', arg: ' cases created last friday with an attachment',   hint: '' },
        { scope: '@soql', arg: ' accounts with no contacts in the last 6 months', hint: '' }
      ]
    },
    {
      eyebrow: 'AI — Ask',
      title: 'Ask about what you’re looking at',
      desc: 'Skipper takes a screenshot of your current page and asks Claude to explain it — useful for understanding settings, errors, or anything that looks wrong.',
      note: null,
      rows: ['ask'],
      right: 'examples',
      examples: [
        { scope: '@ask', arg: ' why is this validation rule failing?', hint: '' },
        { scope: '@ask', arg: ' what does this permission set grant?', hint: '' }
      ]
    },
    {
      eyebrow: 'AI — Debug',
      title: 'Get help when a flow stops working',
      desc: 'When a flow fails during a test run in Flow Builder, paste the error output here. Claude reads it and tells you exactly what went wrong and where.',
      note: null,
      rows: ['flow-debug'],
      right: 'context+examples',
      context: 'Run a debug in Flow Builder first, then come back here.',
      examples: [
        { scope: '@debug', arg: '', hint: 'then paste the error log' }
      ]
    }
  ];

  // ─── DOM injection ─────────────────────────────────────────────────────────

  function buildHelpHTML() {
    var src = (typeof window.__sfnavGetShortcuts === 'function') ? window.__sfnavGetShortcuts() : [];
    var browse = src.filter(function (s) { return s.group === 'browse'; });
    var ai     = src.filter(function (s) { return s.group === 'ai'; });

    var html =
      '<div class="sfnav-hp-header">' +
        '<span class="sfnav-hp-title">Quick reference</span>' +
        '<button class="sfnav-hp-close" type="button">Close</button>' +
      '</div>' +
      '<div class="sfnav-hp-cols">' +
        '<div class="sfnav-hp-row"><span class="sfnav-hp-cmd sfnav-hp-plain">⌘⇧K</span><span class="sfnav-hp-desc">Open from any page</span></div>';

    browse.forEach(function (s) {
      html += '<div class="sfnav-hp-row"><span class="sfnav-hp-cmd">' + esc(s.label) + '</span><span class="sfnav-hp-desc">' + esc(s.sublabel) + '</span></div>';
    });

    html +=
      '</div>' +
      '<div class="sfnav-hp-divider"></div>' +
      '<div class="sfnav-hp-ai-label">AI commands — requires API key</div>' +
      '<div class="sfnav-hp-cols">';

    ai.forEach(function (s) {
      html += '<div class="sfnav-hp-row"><span class="sfnav-hp-cmd">' + esc(s.label) + '</span><span class="sfnav-hp-desc">' + esc(s.sublabel) + '</span></div>';
    });

    html +=
      '</div>' +
      '<div class="sfnav-hp-footer">' +
        '<button class="sfnav-hp-replay" type="button">Replay walkthrough</button>' +
      '</div>';

    return html;
  }

  function ensureInjected() {
    var palette = document.getElementById('sfnav-palette');
    if (!palette || document.getElementById('sfnav-coachmark')) return;

    var anchor = document.getElementById('sfnav-results');

    // Help panel
    var helpPanel = document.createElement('div');
    helpPanel.id = 'sfnav-help-panel';
    helpPanel.style.display = 'none';
    helpPanel.innerHTML = buildHelpHTML();
    palette.insertBefore(helpPanel, anchor);

    // Coachmark
    var coachmark = document.createElement('div');
    coachmark.id = 'sfnav-coachmark';
    coachmark.style.display = 'none';
    coachmark.innerHTML =
      '<div class="sfnav-cm-bar"><div class="sfnav-cm-fill" id="sfnav-cm-fill"></div></div>' +
      '<button class="sfnav-cm-btn sfnav-cm-skip" type="button">Skip tour</button>' +
      '<div class="sfnav-cm-wrap">' +
        '<div class="sfnav-cm-left">' +
          '<div>' +
            '<div class="sfnav-cm-eyebrow" id="sfnav-cm-eyebrow"></div>' +
            '<div class="sfnav-cm-title"   id="sfnav-cm-title"></div>' +
            '<div class="sfnav-cm-desc"    id="sfnav-cm-desc"></div>' +
            '<div class="sfnav-cm-note"    id="sfnav-cm-note" style="display:none"></div>' +
          '</div>' +
          '<div class="sfnav-cm-footer">' +
            '<div class="sfnav-cm-dots" id="sfnav-cm-dots"></div>' +
            '<div class="sfnav-cm-btns">' +
              '<button class="sfnav-cm-btn sfnav-cm-prev" type="button" style="display:none">Back</button>' +
              '<button class="sfnav-cm-btn sfnav-cm-primary sfnav-cm-next" type="button">Next</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="sfnav-cm-right" id="sfnav-cm-right"></div>' +
      '</div>';
    palette.insertBefore(coachmark, anchor);

    // Completion card
    var card = document.createElement('div');
    card.id = 'sfnav-completion-card';
    card.style.display = 'none';
    card.innerHTML =
      '<div class="sfnav-cc-icon">✓</div>' +
      '<div class="sfnav-cc-body">' +
        '<div class="sfnav-cc-title">You\'re all set</div>' +
        '<div class="sfnav-cc-sub">Need a reminder? Click <button class="sfnav-cc-trigger" type="button">Skipper</button> in the footer below.</div>' +
      '</div>' +
      '<button class="sfnav-cc-dismiss" type="button">Dismiss</button>';
    palette.insertBefore(card, anchor);

    // Ring (fixed-position, lives inside the overlay stacking context)
    var overlay = document.getElementById('sfnav-overlay');
    if (overlay && !document.getElementById('sfnav-ring')) {
      var ring = document.createElement('div');
      ring.id = 'sfnav-ring';
      overlay.appendChild(ring);
    }

    // Coachmark buttons
    coachmark.querySelector('.sfnav-cm-prev').addEventListener('click', function () { goToStep(_tourStep - 1); });
    coachmark.querySelector('.sfnav-cm-skip').addEventListener('click', skipTour);
    coachmark.querySelector('.sfnav-cm-next').addEventListener('click', function () {
      if (_tourStep >= STEPS.length) completeTour();
      else goToStep(_tourStep + 1);
    });

    // Completion card
    card.querySelector('.sfnav-cc-trigger').addEventListener('click', function () {
      hideCard();
      openHelp();
    });
    card.querySelector('.sfnav-cc-dismiss').addEventListener('click', hideCard);

    // Help panel
    helpPanel.querySelector('.sfnav-hp-close').addEventListener('click', closeHelp);
    helpPanel.querySelector('.sfnav-hp-replay').addEventListener('click', function () {
      closeHelp();
      startTour({ replay: true });
    });

    // Escape closes the help panel when the tour is not active
    document.addEventListener('keydown', function (e) {
      if (_helpOpen && !_tourActive && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeHelp();
      }
    }, true);

    // Brand click opens/closes help panel after tour is done
    var brand = document.getElementById('sfnav-brand');
    if (brand) {
      brand.addEventListener('click', function () {
        if (_tourActive || !state.walkthroughSeen) return;
        if (_helpOpen) closeHelp(); else openHelp();
      });
    }

    buildDots();
  }

  function buildDots() {
    var wrap = document.getElementById('sfnav-cm-dots');
    if (!wrap) return;
    for (var i = 0; i < STEPS.length; i++) {
      var btn = document.createElement('button');
      btn.className = 'sfnav-cm-dot';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Step ' + (i + 1));
      (function (n) {
        btn.addEventListener('click', function () { goToStep(n + 1); });
      }(i));
      wrap.appendChild(btn);
    }
  }

  // ─── Ring ──────────────────────────────────────────────────────────────────

  function positionRing(rows) {
    var ring = document.getElementById('sfnav-ring');
    if (!ring) return;
    if (!rows.length) { ring.style.display = 'none'; return; }

    var targets = rows.map(function (id) {
      return document.querySelector('[data-shortcut="' + id + '"]');
    }).filter(Boolean);

    if (!targets.length) { ring.style.display = 'none'; return; }

    var first = targets[0].getBoundingClientRect();
    var last  = targets[targets.length - 1].getBoundingClientRect();
    var palette = document.getElementById('sfnav-palette');
    var P = 3;
    var top    = first.top    - P;
    var bottom = last.bottom  + P;

    // Clamp to the palette's visible bottom so the ring never bleeds outside.
    if (palette) {
      var pb = palette.getBoundingClientRect().bottom - 8;
      if (bottom > pb) bottom = pb;
    }

    var height = bottom - top;
    if (height <= 0) { ring.style.display = 'none'; return; }

    ring.style.top    = top + 'px';
    ring.style.left   = (first.left - P) + 'px';
    ring.style.width  = (first.width + P * 2) + 'px';
    ring.style.height = height + 'px';
    ring.style.display = '';
  }

  // ─── Highlights ────────────────────────────────────────────────────────────

  function setHighlights(rows) {
    var results = document.getElementById('sfnav-results');
    if (results) results.classList.toggle('sfnav-results-dim', rows.length === 0);
    // Scroll so the first highlighted row is visible before measuring the ring.
    if (rows.length) {
      var first = document.querySelector('[data-shortcut="' + rows[0] + '"]');
      if (first) first.scrollIntoView({ block: 'nearest' });
    }
  }

  // ─── Right pane ────────────────────────────────────────────────────────────

  function renderRight(data) {
    var pane = document.getElementById('sfnav-cm-right');
    if (!pane) return;
    pane.innerHTML = '';

    if (data.right === 'shortcut') {
      pane.innerHTML =
        '<div class="sfnav-cm-shortcut-wrap">' +
          '<div class="sfnav-cm-shortcut-row">' +
            '<span class="sfnav-cm-platform">Mac</span>' +
            '<span class="sfnav-cm-kbd">⌘</span>' +
            '<span class="sfnav-cm-kbd">⇧</span>' +
            '<span class="sfnav-cm-kbd">K</span>' +
          '</div>' +
          '<div class="sfnav-cm-shortcut-row">' +
            '<span class="sfnav-cm-platform">Windows</span>' +
            '<span class="sfnav-cm-kbd">Ctrl</span>' +
            '<span class="sfnav-cm-kbd">Shift</span>' +
            '<span class="sfnav-cm-kbd">K</span>' +
          '</div>' +
        '</div>';
      return;
    }

    if (data.right === 'context+examples') {
      var ctx = document.createElement('div');
      ctx.className = 'sfnav-cm-context';
      ctx.textContent = data.context;
      pane.appendChild(ctx);
    }

    (data.examples || []).forEach(function (ex, i) {
      var row = document.createElement('div');
      row.className = 'sfnav-cm-ex';
      row.innerHTML =
        '<span class="sfnav-cm-ex-text">' +
          '<span class="sfnav-cm-ex-scope">' + esc(ex.scope) + '</span>' +
          esc(ex.arg) +
        '</span>' +
        (ex.hint ? '<span class="sfnav-cm-ex-hint">' + esc(ex.hint) + '</span>' : '');
      pane.appendChild(row);
      setTimeout(function (el) { el.classList.add('sfnav-cm-ex-vis'); }, 50 + i * 70, row);
    });
  }

  // ─── Step render ───────────────────────────────────────────────────────────

  function renderStep(stepNum) {
    var step = STEPS[stepNum - 1];

    var fill = document.getElementById('sfnav-cm-fill');
    if (fill) fill.style.width = ((stepNum / STEPS.length) * 100) + '%';

    var eyebrow = document.getElementById('sfnav-cm-eyebrow');
    var title   = document.getElementById('sfnav-cm-title');
    var desc    = document.getElementById('sfnav-cm-desc');
    var note    = document.getElementById('sfnav-cm-note');
    if (eyebrow) eyebrow.textContent = step.eyebrow;
    if (title)   title.textContent   = step.title;
    if (desc)    desc.textContent    = step.desc;
    if (note)  { note.textContent = step.note || ''; note.style.display = step.note ? '' : 'none'; }

    var dots = document.querySelectorAll('.sfnav-cm-dot');
    dots.forEach(function (d, i) { d.classList.toggle('sfnav-cm-dot-on', i === stepNum - 1); });

    var isLast = stepNum === STEPS.length;
    var prev = document.querySelector('.sfnav-cm-prev');
    var skip = document.querySelector('.sfnav-cm-skip');
    var next = document.querySelector('.sfnav-cm-next');
    if (prev) prev.style.display = stepNum > 1 ? '' : 'none';
    if (skip) skip.style.display = isLast ? 'none' : '';
    if (next) next.textContent   = isLast ? 'Done' : 'Next';

    setHighlights(step.rows);
    positionRing(step.rows);
    renderRight(step);
  }

  function goToStep(stepNum) {
    if (stepNum < 1 || stepNum > STEPS.length) return;
    _tourStep = stepNum;
    renderStep(stepNum);
  }

  // ─── Tour lifecycle ────────────────────────────────────────────────────────

  function startTour(opts) {
    var replay = !!(opts && opts.replay);
    ensureInjected();

    var coachmark = document.getElementById('sfnav-coachmark');
    var overlay   = document.getElementById('sfnav-overlay');
    if (!coachmark) return;

    hideCard();
    closeHelp();
    coachmark.style.display = '';
    if (overlay) overlay.classList.add('sfnav-tour-active');
    var hint = document.getElementById('sfnav-hint');
    if (hint) hint.style.display = 'none';

    var input = document.getElementById('sfnav-input');
    if (input) input.setAttribute('readonly', 'true');

    _tourActive = true;
    _tourStep   = 1;
    goToStep(1);

    _resizeListener = function () { positionRing(STEPS[_tourStep - 1].rows); };
    window.addEventListener('resize', _resizeListener);

    _keyListener = function (e) {
      if (!_tourActive) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        if (_tourStep >= STEPS.length) completeTour();
        else goToStep(_tourStep + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        if (_tourStep > 1) goToStep(_tourStep - 1);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        skipTour();
      }
    };
    document.addEventListener('keydown', _keyListener, true);

    if (!replay && !state.walkthroughSeen) {
      state.walkthroughSeen = true;
      persist({ walkthroughSeen: true });
    }
  }

  function endTour() {
    var coachmark = document.getElementById('sfnav-coachmark');
    var ring      = document.getElementById('sfnav-ring');
    var overlay   = document.getElementById('sfnav-overlay');

    if (coachmark) coachmark.style.display = 'none';
    if (ring)      ring.style.display      = 'none';
    if (overlay)   overlay.classList.remove('sfnav-tour-active');

    var results = document.getElementById('sfnav-results');
    if (results) results.classList.remove('sfnav-results-dim');

    if (_resizeListener) { window.removeEventListener('resize', _resizeListener); _resizeListener = null; }
    if (_keyListener)    { document.removeEventListener('keydown', _keyListener, true); _keyListener = null; }

    var input = document.getElementById('sfnav-input');
    if (input) { input.removeAttribute('readonly'); input.focus(); }

    var hint = document.getElementById('sfnav-hint');
    if (hint) hint.style.display = '';

    var brand = document.getElementById('sfnav-brand');
    if (brand) brand.classList.add('sfnav-brand-clickable');

    _tourActive = false;
  }

  function completeTour() {
    if (!_tourActive) return;
    endTour();
    state.walkthroughSeen = true;
    persist({ walkthroughSeen: true });
    var card = document.getElementById('sfnav-completion-card');
    if (card) card.style.display = '';
    var hint = document.getElementById('sfnav-hint');
    if (hint) hint.style.display = 'none';
  }

  function skipTour() {
    if (!_tourActive) return;
    endTour();
    state.walkthroughSeen = true;
    persist({ walkthroughSeen: true });
  }

  // ─── Help panel ────────────────────────────────────────────────────────────

  function openHelp() {
    var panel = document.getElementById('sfnav-help-panel');
    if (!panel) return;
    panel.style.display = '';
    _helpOpen = true;
    var hint = document.getElementById('sfnav-hint');
    if (hint) hint.style.display = 'none';
  }

  function closeHelp() {
    var panel = document.getElementById('sfnav-help-panel');
    if (panel) panel.style.display = 'none';
    _helpOpen = false;
    var hint = document.getElementById('sfnav-hint');
    if (hint) hint.style.display = '';
  }

  // ─── Completion card ───────────────────────────────────────────────────────

  function hideCard() {
    var card = document.getElementById('sfnav-completion-card');
    if (card) card.style.display = 'none';
    var hint = document.getElementById('sfnav-hint');
    if (hint) hint.style.display = '';
  }

  // ─── Public entry points ───────────────────────────────────────────────────

  function init() {
    function go() {
      ensureInjected();
      if (!state.walkthroughSeen && !_shownThisSession) {
        _shownThisSession = true;
        requestAnimationFrame(function () { startTour({ replay: false }); });
        return;
      }
      _shownThisSession = true;
      if (state.walkthroughSeen) {
        var brand = document.getElementById('sfnav-brand');
        if (brand) brand.classList.add('sfnav-brand-clickable');
      }
    }
    if (_loaded) { go(); return; }
    chrome.storage.local.get(STORAGE_KEY, function (data) {
      var opts = (data && data[STORAGE_KEY]) || {};
      state.walkthroughSeen = !!(opts.walkthroughSeen || opts.onboardingDone);
      _loaded = true;
      go();
    });
  }

  function hide() {
    if (_tourActive) endTour();
    closeHelp();
    hideCard();
    _shownThisSession = false;
    _loaded = false;
  }

  window.sfnavInitOnboarding = init;
  window.sfnavHideOnboarding = hide;
}());
