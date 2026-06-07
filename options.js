var SF_HOST_RE = /^https:\/\/[^/]+\.(lightning\.force\.com|salesforce\.com|salesforce-setup\.com|force\.com)\//;

// Provider catalogue. Everything user-facing about a provider — label, key
// console link, setup steps, key-format hints, default model, model menu —
// lives here so adding a fourth provider is just a new entry. Keep this
// in sync with the shape providers.js expects in sfnavOptions.providers[name].
var PROVIDERS = {
  gemini: {
    label: 'Google',
    productName: 'Gemini',
    badge: 'GEMINI',
    keyLabel: 'Google API key',
    keyPlaceholder: 'AIza…',
    validate: function (k) {
      if (!k) return null;
      if (!/^AIza[0-9A-Za-z_\-]{30,}$/.test(k)) {
        return 'That key does not look like a Google API key (starts with "AIza"). Double-check you copied the right one.';
      }
      return null;
    },
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
    badge: 'CLAUDE',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    validate: function (k) {
      if (!k) return null;
      if (!/^sk-ant-/.test(k)) {
        return 'Anthropic API keys start with "sk-ant-". This looks like a different provider’s key.';
      }
      return null;
    },
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
    badge: 'GPT',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
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

var navEl         = document.getElementById('nav');
var cardsEl       = document.getElementById('providerCards');
var stepsEl       = document.getElementById('providerSteps');
var noteEl        = document.getElementById('providerNote');
var keyLabelEl    = document.getElementById('apiKeyLabel');
var apiKeyEl      = document.getElementById('apiKey');
var keyWarnEl     = document.getElementById('keyFormatWarn');
var revealEl      = document.getElementById('revealKey');
var eyeShowEl     = document.getElementById('eyeShow');
var eyeHideEl     = document.getElementById('eyeHide');
var modelEl       = document.getElementById('model');
var saveEl        = document.getElementById('save');
var statusEl      = document.getElementById('status');
var openInEl      = document.getElementById('openIn');
var replayEl      = document.getElementById('replayWalkthrough');
var walkStatusEl  = document.getElementById('walkthroughStatus');
var versionEl     = document.getElementById('version');
var aboutVerEl    = document.getElementById('aboutVersion');
var connectedEl   = document.getElementById('connectedStatus');
var csProviderEl  = document.getElementById('csProvider');
var csKeyEl       = document.getElementById('csKey');
var csStateEl     = document.getElementById('csState');

var state = {
  provider: 'gemini',
  providers: { gemini: {}, anthropic: {}, openai: {} },
  openInNewTab: true
};

// ─── Version stamp ──────────────────────────────────────────────────────────

try {
  var version = chrome.runtime.getManifest().version;
  if (versionEl)  versionEl.textContent = 'v' + version;
  if (aboutVerEl) aboutVerEl.textContent = version;
} catch (e) { /* non-extension preview */ }

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

// ─── Pane switching ─────────────────────────────────────────────────────────

navEl.addEventListener('click', function (e) {
  var item = e.target.closest('.ni');
  if (!item) return;
  var pane = item.getAttribute('data-pane');
  if (!pane) return;
  Array.prototype.forEach.call(navEl.querySelectorAll('.ni'), function (n) {
    n.classList.toggle('on', n === item);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) {
    p.classList.toggle('on', p.id === 'pane-' + pane);
  });
});

// ─── Rendering ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function linkHtml(label, url) {
  return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + ' &nearr;</a>';
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••' + key.slice(-2);
  return key.slice(0, 8) + '••••••••••••' + key.slice(-4);
}

function renderProvider() {
  Array.prototype.forEach.call(cardsEl.querySelectorAll('.pc'), function (el) {
    var match = el.getAttribute('data-provider') === state.provider;
    el.setAttribute('aria-checked', match ? 'true' : 'false');
  });

  var p = PROVIDERS[state.provider];

  // Subscription warning (anthropic / openai only)
  if (p.note) {
    noteEl.textContent = p.note;
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }

  // 3-step "how to get a key"
  stepsEl.innerHTML = '';
  p.steps(linkHtml).forEach(function (line) {
    var li = document.createElement('li');
    var span = document.createElement('span');
    span.innerHTML = line;
    li.appendChild(span);
    stepsEl.appendChild(li);
  });

  // Key field rebinding
  keyLabelEl.textContent = p.keyLabel;
  apiKeyEl.placeholder = p.keyPlaceholder;
  apiKeyEl.value = (state.providers[state.provider] && state.providers[state.provider].apiKey) || '';
  // Reset reveal to masked on provider switch
  apiKeyEl.type = 'password';
  eyeShowEl.hidden = false;
  eyeHideEl.hidden = true;
  validateKeyFormat();

  // Model dropdown
  modelEl.innerHTML = '';
  p.models.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    modelEl.appendChild(opt);
  });
  var savedModel = (state.providers[state.provider] && state.providers[state.provider].model) || p.defaultModel;
  modelEl.value = savedModel;

  renderConnectedStatus();
  setStatus('');
}

function renderConnectedStatus() {
  var p = PROVIDERS[state.provider];
  var key = state.providers[state.provider] && state.providers[state.provider].apiKey;
  if (!key) {
    connectedEl.hidden = true;
    return;
  }
  connectedEl.hidden = false;
  csProviderEl.textContent = p.badge;
  csKeyEl.textContent = maskKey(key);
  csStateEl.textContent = 'Saved';
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
  walkStatusEl.className = 'walk-status' + (kind ? ' ' + kind : '');
}

// ─── Event handlers ─────────────────────────────────────────────────────────

cardsEl.addEventListener('click', function (e) {
  var card = e.target.closest('.pc');
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

revealEl.addEventListener('click', function () {
  var hidden = apiKeyEl.type === 'password';
  apiKeyEl.type = hidden ? 'text' : 'password';
  eyeShowEl.hidden = hidden;
  eyeHideEl.hidden = !hidden;
});

saveEl.addEventListener('click', async function () {
  var key = apiKeyEl.value.trim();
  if (!key) { setStatus('Enter an API key first', 'err'); return; }

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
    renderConnectedStatus();
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

// ─── Feedback ───────────────────────────────────────────────────────────────

var fbSendEl = document.getElementById('fbSend');
var fbMessageEl = document.getElementById('fbMessage');
var fbEmailEl = document.getElementById('fbEmail');
var fbStatusEl = document.getElementById('fbStatus');

chrome.storage.local.get('sfnavOptions', function (data) {
  var opts = (data && data.sfnavOptions) || {};
  var saved = (opts.skipper && opts.skipper.email) || opts.feedbackEmail || '';
  if (saved && fbEmailEl && !fbEmailEl.value) fbEmailEl.value = saved;
});

function setFbStatus(text, kind) {
  if (!fbStatusEl) return;
  fbStatusEl.textContent = text || '';
  fbStatusEl.className = kind ? ('walk-status ' + kind) : '';
}

if (fbSendEl) {
  fbSendEl.addEventListener('click', function () {
    var message = (fbMessageEl.value || '').trim();
    if (!message) { setFbStatus('Type something first.', 'err'); fbMessageEl.focus(); return; }
    if (message.length > 4000) { setFbStatus('Too long — keep it under 4000 characters.', 'err'); return; }

    var email = (fbEmailEl.value || '').trim();
    var manifest = chrome.runtime.getManifest();
    var payload = {
      message: message,
      email: email || null,
      url_host: null,
      extension_ver: manifest.version,
      user_agent: navigator.userAgent
    };

    fbSendEl.disabled = true;
    setFbStatus('Sending…', 'loading');

    chrome.runtime.sendMessage({ type: 'feedback.submit', payload: payload }, function (resp) {
      fbSendEl.disabled = false;
      if (chrome.runtime.lastError) { setFbStatus('Error: ' + chrome.runtime.lastError.message, 'err'); return; }
      if (!resp || !resp.ok) { setFbStatus('Could not send: ' + ((resp && resp.error) || 'unknown'), 'err'); return; }
      if (email) mergeOptions({ feedbackEmail: email });
      fbMessageEl.value = '';
      setFbStatus('Thanks — sent.', 'ok');
    });
  });
}

function mergeOptions(patch) {
  return new Promise(function (resolve) {
    chrome.storage.local.get('sfnavOptions', function (data) {
      var next = Object.assign({}, data.sfnavOptions || {}, patch);
      chrome.storage.local.set({ sfnavOptions: next }, function () { resolve(next); });
    });
  });
}
