var SF_HOST_RE = /^https:\/\/[^/]+\.(lightning\.force\.com|salesforce\.com|salesforce-setup\.com|force\.com)\//;

// Provider catalogue. Everything user-facing about a provider — label, key
// console link, setup steps, key-format hints, default model, model menu —
// lives here so adding a fourth provider is just a new entry. Keep this
// in sync with the shape providers.js expects in sfnavOptions.providers[name].
var PROVIDERS = {
  gemini: {
    label: 'Google',
    productName: 'Gemini',
    keyLabel: 'Google API key',
    keyPlaceholder: 'AIza...',
    validate: function (k) {
      if (!k) return null;
      if (!/^AIza[0-9A-Za-z_\-]{30,}$/.test(k)) {
        return 'That key does not look like a Google API key (starts with "AIza"). Double-check you copied the right one.';
      }
      return null;
    },
    consoleLabel: 'aistudio.google.com/apikey',
    consoleUrl: 'https://aistudio.google.com/apikey',
    steps: function (a) {
      return [
        'Open ' + a('aistudio.google.com/apikey', 'https://aistudio.google.com/apikey') + ' and sign in with any Google account.',
        'Click <strong>Create API key</strong>.',
        'Copy the key (starts with <code>AIza</code>) and paste it below.'
      ];
    },
    note: null,
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (recommended, free tier)' },
      { id: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro (more accurate)' }
    ]
  },
  anthropic: {
    label: 'Anthropic',
    productName: 'Claude',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-...',
    validate: function (k) {
      if (!k) return null;
      if (!/^sk-ant-/.test(k)) {
        return 'Anthropic API keys start with "sk-ant-". This looks like a different provider’s key.';
      }
      return null;
    },
    consoleLabel: 'console.anthropic.com',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    steps: function (a) {
      return [
        'Open ' + a('console.anthropic.com/settings/keys', 'https://console.anthropic.com/settings/keys') + ' and sign in (create an account if you don’t have one).',
        'Add a payment method under Billing — Anthropic API is pay-as-you-go, billed separately from Claude Pro.',
        'Click <strong>Create Key</strong>, copy it (starts with <code>sk-ant-</code>), and paste it below.'
      ];
    },
    note: 'This is separate from your Claude Pro / Max subscription — API access is billed separately on console.anthropic.com.',
    defaultModel: 'claude-haiku-4-5-20251001',
    models: [
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast, recommended)' },
      { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6 (more accurate)' },
      { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7 (most accurate)' }
    ]
  },
  openai: {
    label: 'OpenAI',
    productName: 'GPT',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-...',
    validate: function (k) {
      if (!k) return null;
      if (!/^sk-/.test(k)) {
        return 'OpenAI API keys start with "sk-". This looks like a different provider’s key.';
      }
      if (/^sk-ant-/.test(k)) {
        return 'That looks like an Anthropic key (starts with "sk-ant-"). Switch to the Claude provider above.';
      }
      return null;
    },
    consoleLabel: 'platform.openai.com/api-keys',
    consoleUrl: 'https://platform.openai.com/api-keys',
    steps: function (a) {
      return [
        'Open ' + a('platform.openai.com/api-keys', 'https://platform.openai.com/api-keys') + ' and sign in (create an account if you don’t have one).',
        'Add a payment method under Billing — the API is billed separately from ChatGPT Plus.',
        'Click <strong>Create new secret key</strong>, copy it (starts with <code>sk-</code>), and paste it below.'
      ];
    },
    note: 'This is separate from your ChatGPT Plus subscription — API access is billed separately on platform.openai.com.',
    defaultModel: 'gpt-4.1-mini',
    models: [
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini (fast, recommended)' },
      { id: 'gpt-4.1',      label: 'GPT-4.1 (more accurate)' },
      { id: 'gpt-4o',       label: 'GPT-4o' }
    ]
  }
};

// ─── DOM refs ───────────────────────────────────────────────────────────────

var cardsEl       = document.querySelector('.provider-cards');
var stepsEl       = document.getElementById('providerSteps');
var noteEl        = document.getElementById('subscriptionNote');
var keyLabelEl    = document.getElementById('apiKeyLabel');
var apiKeyEl      = document.getElementById('apiKey');
var keyWarnEl     = document.getElementById('keyFormatWarn');
var modelEl       = document.getElementById('model');
var saveEl        = document.getElementById('save');
var statusEl      = document.getElementById('status');
var openInEl      = document.getElementById('openIn');
var replayEl     = document.getElementById('replayWalkthrough');
var walkStatusEl = document.getElementById('walkthroughStatus');

var state = {
  provider: 'gemini',
  providers: { gemini: {}, anthropic: {}, openai: {} },
  openInNewTab: true
};

// ─── Load + migrate stored options ──────────────────────────────────────────

chrome.storage.local.get('sfnavOptions', function (data) {
  var opts = data.sfnavOptions || {};
  state.providers = Object.assign({ gemini: {}, anthropic: {}, openai: {} }, opts.providers || {});

  // Migrate the pre-multi-provider shape: a top-level anthropicApiKey + model
  // become providers.anthropic, and Anthropic becomes the active provider so
  // existing users see no change after upgrade.
  if (opts.anthropicApiKey && !state.providers.anthropic.apiKey) {
    state.providers.anthropic.apiKey = opts.anthropicApiKey;
    if (opts.model) state.providers.anthropic.model = opts.model;
  }
  if (opts.provider) {
    state.provider = opts.provider;
  } else if (opts.anthropicApiKey) {
    state.provider = 'anthropic';
  } else {
    state.provider = 'gemini'; // fresh install default
  }

  state.openInNewTab = opts.openInNewTab !== false;
  openInEl.value = state.openInNewTab ? 'new' : 'same';

  renderProvider();
});

// ─── Rendering ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Link helper used inside provider step templates so URLs stay declarative in
// the catalogue while still being escaped here.
function linkHtml(label, url) {
  return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + ' &nearr;</a>';
}

function renderProvider() {
  // Card selection state
  Array.prototype.forEach.call(cardsEl.querySelectorAll('.provider-card'), function (el) {
    var match = el.getAttribute('data-provider') === state.provider;
    el.setAttribute('aria-checked', match ? 'true' : 'false');
  });

  var p = PROVIDERS[state.provider];

  // Subscription warning (Anthropic / OpenAI only)
  if (p.note) {
    noteEl.textContent = p.note;
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }

  // 3-step "how to get a key" — always visible, deep-links to provider
  var stepsHtml = '<p class="provider-steps-title">How to get a key</p><ol>';
  p.steps(linkHtml).forEach(function (line) {
    stepsHtml += '<li>' + line + '</li>';
  });
  stepsHtml += '</ol>';
  stepsEl.innerHTML = stepsHtml;

  // Key field rebinding
  keyLabelEl.textContent = p.keyLabel;
  apiKeyEl.placeholder = p.keyPlaceholder;
  apiKeyEl.value = (state.providers[state.provider] && state.providers[state.provider].apiKey) || '';
  validateKeyFormat();

  // Model dropdown — repopulated per provider
  modelEl.innerHTML = '';
  p.models.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    modelEl.appendChild(opt);
  });
  var savedModel = (state.providers[state.provider] && state.providers[state.provider].model) || p.defaultModel;
  modelEl.value = savedModel;

  setStatus('');
}

function validateKeyFormat() {
  var p = PROVIDERS[state.provider];
  var msg = p.validate(apiKeyEl.value.trim());
  if (msg) {
    keyWarnEl.textContent = msg;
    keyWarnEl.hidden = false;
  } else {
    keyWarnEl.hidden = true;
  }
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

function setWalkStatus(text, kind) {
  walkStatusEl.textContent = text;
  walkStatusEl.className = kind || '';
}

// ─── Event handlers ─────────────────────────────────────────────────────────

cardsEl.addEventListener('click', function (e) {
  var card = e.target.closest('.provider-card');
  if (!card) return;
  var name = card.getAttribute('data-provider');
  if (!name || name === state.provider) return;
  // Persist the in-flight key for the previous provider so switching back
  // doesn't lose what the user typed.
  state.providers[state.provider] = state.providers[state.provider] || {};
  state.providers[state.provider].apiKey = apiKeyEl.value.trim();
  state.providers[state.provider].model = modelEl.value;
  state.provider = name;
  renderProvider();
});

apiKeyEl.addEventListener('input', validateKeyFormat);

saveEl.addEventListener('click', async function () {
  var key = apiKeyEl.value.trim();
  if (!key) { setStatus('Enter an API key first', 'err'); return; }

  // Persist the active provider + key + model, then call provider.test so the
  // user gets a green/red verdict before they close the tab.
  state.providers[state.provider] = state.providers[state.provider] || {};
  state.providers[state.provider].apiKey = key;
  state.providers[state.provider].model = modelEl.value;
  await mergeOptions({
    provider: state.provider,
    providers: state.providers,
    openInNewTab: openInEl.value !== 'same'
  });

  saveEl.disabled = true;
  setStatus('Saving + testing…', 'loading');
  chrome.runtime.sendMessage({ type: 'provider.test' }, function (resp) {
    saveEl.disabled = false;
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message, 'err');
      return;
    }
    if (!resp) { setStatus('No response from background', 'err'); return; }
    if (!resp.ok) { setStatus('Failed: ' + resp.error, 'err'); return; }
    var p = PROVIDERS[state.provider];
    setStatus('Connected to ' + p.productName + ' (' + (resp.model || '—') + ')', 'ok');
  });
});

openInEl.addEventListener('change', function () {
  mergeOptions({ openInNewTab: openInEl.value !== 'same' });
});

modelEl.addEventListener('change', function () {
  state.providers[state.provider] = state.providers[state.provider] || {};
  state.providers[state.provider].model = modelEl.value;
});

replayEl.addEventListener('click', async function () {
  setWalkStatus('Looking for a Salesforce tab…', 'loading');
  await mergeOptions({ onboardingDone: false, walkthroughSeen: false });

  chrome.tabs.query({}, function (tabs) {
    var sfTabs = (tabs || []).filter(function (t) { return t.url && SF_HOST_RE.test(t.url); });
    if (!sfTabs.length) {
      setWalkStatus('Open a Salesforce tab, then click again.', 'err');
      return;
    }
    var target = sfTabs.find(function (t) { return t.active; }) || sfTabs[0];
    chrome.tabs.update(target.id, { active: true }, function () {
      if (target.windowId != null) chrome.windows.update(target.windowId, { focused: true });
      chrome.runtime.sendMessage({ type: 'openPalette', tabId: target.id }, function () {
        setWalkStatus('Walkthrough opened in your Salesforce tab.', 'ok');
        setTimeout(function () { setWalkStatus(''); }, 2500);
      });
    });
  });
});

function mergeOptions(patch) {
  return new Promise(function (resolve) {
    chrome.storage.local.get('sfnavOptions', function (data) {
      var next = Object.assign({}, data.sfnavOptions || {}, patch);
      chrome.storage.local.set({ sfnavOptions: next }, function () { resolve(next); });
    });
  });
}
