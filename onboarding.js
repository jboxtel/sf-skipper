(function () {
  var STEPS = [
    {
      title: 'Welcome to Salesforce Commander',
      body: 'Press ⌘⇧K (Ctrl+Shift+K on Windows) from any Salesforce page to open this. Start typing to find Setup pages, objects, flows, apps — and press Enter to go there instantly.',
      example: null
    },
    {
      title: 'Navigate anywhere directly with @',
      body: 'Type @ followed by what you are looking for. @object browses all objects in your org, @setup jumps to any Setup page, @flow finds flows, @app lists Lightning apps — plus @label, @permset, and @cmd.',
      example: ['@object Case', '@setup failed flow interviews', '@app sales console', '@flow Account Before Save - Main Flow', '@label welcome message', '@permset salesforce admin', '@cmd AWS mapping']
    },
    {
      title: 'Generate SOQL with @soql',
      body: 'Describe what you need in plain English and Claude writes the query. Copy it straight to the clipboard or pick from your recent history. Requires an Anthropic API key in Options.',
      example: ['@soql cases created last friday with an attachment', '@soql accounts with no opportunity in the last 6 months']
    },
    {
      title: 'Ask Claude about anything on screen',
      body: '@ask takes a screenshot of the current page and lets you ask Claude anything about it — why a record looks wrong, what a permission setting does, how to fix an error.',
      example: 'Try: @ask why is this validation rule failing?'
    },
    {
      title: 'Diagnose failing flows with @debug',
      body: 'Open a flow in Flow Builder, run it in debug mode, then use @debug to paste the output. Claude pinpoints the root cause and gives you a step-by-step fix.',
      example: 'Try: @debug (from a Flow Builder page)'
    }
  ];

  var _done = false;
  var _loaded = false;

  chrome.storage.local.get('sfnavOptions', function (data) {
    _done = !!(data.sfnavOptions && data.sfnavOptions.onboardingDone);
    _loaded = true;
  });

  var currentStep = 0;

  // Typewriter animation state
  var _anim = null;
  var _animTimer = null;

  function stopAnimation() {
    if (_animTimer) { clearTimeout(_animTimer); _animTimer = null; }
    _anim = null;
  }

  function animTick() {
    var a = _anim;
    if (!a || !document.body.contains(a.el)) return;
    var text = a.phrases[a.phraseIdx];

    if (a.phase === 'typing') {
      a.charIdx++;
      a.el.textContent = text.slice(0, a.charIdx) + '|';
      if (a.charIdx >= text.length) {
        a.phase = 'pausing';
        _animTimer = setTimeout(animTick, 1400);
      } else {
        _animTimer = setTimeout(animTick, 60);
      }
    } else if (a.phase === 'pausing') {
      a.phase = 'deleting';
      _animTimer = setTimeout(animTick, 80);
    } else if (a.phase === 'deleting') {
      a.charIdx--;
      a.el.textContent = text.slice(0, a.charIdx) + (a.charIdx > 0 ? '|' : '');
      if (a.charIdx <= 0) {
        a.phraseIdx = (a.phraseIdx + 1) % a.phrases.length;
        a.charIdx = 0;
        a.phase = 'typing';
        _animTimer = setTimeout(animTick, 380);
      } else {
        _animTimer = setTimeout(animTick, 38);
      }
    }
  }

  function startAnimation(el, phrases) {
    stopAnimation();
    _anim = { el: el, phrases: phrases, phraseIdx: 0, charIdx: 0, phase: 'typing' };
    _animTimer = setTimeout(animTick, 300);
  }

  function getCard() { return document.getElementById('sfnav-onboarding'); }

  function renderStep(step) {
    stopAnimation();
    var card = getCard();
    if (!card) return;
    var s = STEPS[step];
    card.querySelector('.sfnav-coach-step').textContent = (step + 1) + ' / ' + STEPS.length;
    card.querySelector('.sfnav-coach-title').textContent = s.title;
    card.querySelector('.sfnav-coach-body').textContent = s.body;
    var ex = card.querySelector('.sfnav-coach-example');
    if (Array.isArray(s.example)) {
      ex.style.display = '';
      startAnimation(ex, s.example);
    } else if (s.example) {
      ex.textContent = s.example;
      ex.style.display = '';
    } else {
      ex.style.display = 'none';
    }
    var prev = card.querySelector('.sfnav-coach-prev');
    prev.style.visibility = step === 0 ? 'hidden' : '';
    var next = card.querySelector('.sfnav-coach-next');
    next.textContent = step === STEPS.length - 1 ? 'Done' : 'Next →';
    var dots = card.querySelectorAll('.sfnav-coach-dot');
    dots.forEach(function (d, i) {
      d.classList.toggle('sfnav-coach-dot-active', i === step);
    });
  }

  function dismissOnboarding() {
    stopAnimation();
    _done = true;
    var card = getCard();
    if (card) card.style.display = 'none';
    var hint = document.getElementById('sfnav-hint');
    if (hint) hint.style.display = '';
    chrome.storage.local.get('sfnavOptions', function (data) {
      var opts = data.sfnavOptions || {};
      opts.onboardingDone = true;
      chrome.storage.local.set({ sfnavOptions: opts });
    });
  }

  function showOnboardingCard() {
    var card = getCard();
    if (!card) return;
    currentStep = 0;
    renderStep(0);
    card.style.display = '';
    var hint = document.getElementById('sfnav-hint');
    if (hint) hint.style.display = 'none';
  }

  function injectOnboardingCard() {
    if (document.getElementById('sfnav-onboarding')) return;

    var dots = STEPS.map(function (_, i) {
      return '<span class="sfnav-coach-dot' + (i === 0 ? ' sfnav-coach-dot-active' : '') + '"></span>';
    }).join('');

    var el = document.createElement('div');
    el.id = 'sfnav-onboarding';
    el.style.display = 'none';
    el.innerHTML =
      '<div class="sfnav-coach-header">' +
        '<span class="sfnav-coach-step"></span>' +
        '<button class="sfnav-coach-skip">Skip tour</button>' +
      '</div>' +
      '<div class="sfnav-coach-title"></div>' +
      '<div class="sfnav-coach-body"></div>' +
      '<div class="sfnav-coach-example"></div>' +
      '<div class="sfnav-coach-nav">' +
        '<button class="sfnav-coach-prev">← Back</button>' +
        '<div class="sfnav-coach-dots">' + dots + '</div>' +
        '<button class="sfnav-coach-next">Next →</button>' +
      '</div>';

    var hint = document.getElementById('sfnav-hint');
    if (hint && hint.parentNode) {
      hint.parentNode.insertBefore(el, hint.nextSibling);
    }

    el.querySelector('.sfnav-coach-skip').addEventListener('click', dismissOnboarding);

    el.querySelector('.sfnav-coach-prev').addEventListener('click', function () {
      if (currentStep > 0) { currentStep--; renderStep(currentStep); }
    });

    el.querySelector('.sfnav-coach-next').addEventListener('click', function () {
      if (currentStep < STEPS.length - 1) {
        currentStep++;
        renderStep(currentStep);
      } else {
        dismissOnboarding();
      }
    });

    document.addEventListener('keydown', function (e) {
      var card = getCard();
      if (!card || card.style.display === 'none') return;
      if (e.key === 'ArrowRight') {
        e.stopPropagation();
        if (currentStep < STEPS.length - 1) {
          currentStep++;
          renderStep(currentStep);
        } else {
          dismissOnboarding();
        }
      } else if (e.key === 'ArrowLeft') {
        e.stopPropagation();
        if (currentStep > 0) { currentStep--; renderStep(currentStep); }
      }
    }, true); // capture phase so we run before content.js handlers
  }

  function sfnavInitOnboarding() {
    if (_done) return;
    injectOnboardingCard();
    if (_loaded) {
      showOnboardingCard();
    } else {
      chrome.storage.local.get('sfnavOptions', function (data) {
        _done = !!(data.sfnavOptions && data.sfnavOptions.onboardingDone);
        _loaded = true;
        if (!_done) showOnboardingCard();
      });
    }
  }

  window.sfnavInitOnboarding = sfnavInitOnboarding;
}());
