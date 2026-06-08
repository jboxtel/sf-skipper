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
var providerSummaryEl = document.getElementById('providerSummary');

var openInToggleEl   = document.getElementById('openInToggle');
var shortcutRowEl    = document.getElementById('shortcutRow');
var walkthroughRowEl = document.getElementById('walkthroughRow');
var walkSubEl        = document.getElementById('walkSub');
var versionEl        = document.getElementById('version');

var state = {
  provider: 'gemini',
  providers: { gemini: {}, anthropic: {}, openai: {} },
  openInNewTab: true,
  skipper: null
};

// ─── Version stamp ──────────────────────────────────────────────────────────

try {
  var version = chrome.runtime.getManifest().version;
  if (versionEl) versionEl.textContent = 'v' + version;
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
    state.provider = 'gemini';
  }

  state.openInNewTab = opts.openInNewTab !== false;
  setToggle(openInToggleEl, state.openInNewTab);
  state.skipper = opts.skipper || null;

  renderProvider();
  refreshSkipperQuota();
});

// Re-render when storage changes — proxy responses update sfnavOptions.skipper.quota
// after every call, and the Account section may toggle signed-in state.
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.sfnavOptions) return;
    var newOpts = changes.sfnavOptions.newValue || {};
    state.skipper = newOpts.skipper || null;
    updateProviderSummary();
  });
}

// Pull a fresh quota snapshot when the Options page opens. Header-driven
// cache on proxy responses keeps the count live during a session; this is
// the cold-start path.
var SKIPPER_BACKEND_URL = 'http://localhost:3000';
function refreshSkipperQuota() {
  var skipper = state.skipper || {};
  if (!skipper.accessToken) return;
  // Skip if BYOK is set — the Free+ subtitle won't show anyway.
  var entry = state.providers[state.provider] || {};
  if (entry.apiKey) return;
  fetch(SKIPPER_BACKEND_URL + '/api/quota', {
    headers: { 'Authorization': 'Bearer ' + skipper.accessToken }
  }).then(function (r) { return r.ok ? r.json() : null; }).then(function (q) {
    if (!q) return;
    var nextQuota = {};
    Object.keys(q.limits || {}).forEach(function (feat) {
      var lim = q.limits[feat];
      var used = (q.used && q.used[feat]) || 0;
      if (typeof lim === 'number') {
        nextQuota[feat] = { remaining: Math.max(0, lim - used), limit: lim, ts: Date.now() };
      }
    });
    mergeOptions({ skipper: Object.assign({}, skipper, { quota: nextQuota }) });
  }).catch(function () { /* offline; subtitle just stays without count */ });
}

// ─── Expand/collapse rows ───────────────────────────────────────────────────

function setExpanded(rowEl, open) {
  if (!rowEl) return;
  rowEl.classList.toggle('open', !!open);
}

function isExpanded(rowEl) {
  return rowEl && rowEl.classList.contains('open');
}

// Header click toggles the row. Clicks inside the body shouldn't collapse it,
// and inputs inside the body shouldn't either — so we only listen on .row-main.
document.addEventListener('click', function (e) {
  var head = e.target.closest('.row.expandable > .row-main');
  if (!head) return;
  var row = head.parentElement;
  setExpanded(row, !isExpanded(row));
});

// Deep-link via #hash — legacy pane names map to the new expandable rows.
(function () {
  var hash = (location.hash || '').replace(/^#/, '');
  if (!hash) return;
  var map = {
    account:  'acctRowOut',
    provider: 'providerRow',
    feedback: 'feedbackRow'
  };
  var id = map[hash];
  if (!id) return;
  var el = document.getElementById(id);
  if (el) {
    setExpanded(el, true);
    el.scrollIntoView({ block: 'start' });
  }
})();

// ─── Toggle (Open links in new tab) ─────────────────────────────────────────

function setToggle(el, on) {
  if (!el) return;
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

if (openInToggleEl) {
  openInToggleEl.addEventListener('click', function () {
    var next = openInToggleEl.getAttribute('aria-checked') !== 'true';
    setToggle(openInToggleEl, next);
    state.openInNewTab = next;
    mergeOptions({ openInNewTab: next });
  });
}

// ─── Navigation shortcut row → opens chrome://extensions/shortcuts ──────────
// <a href="#"> won't navigate to chrome:// URLs from a regular link click,
// so we intercept and use chrome.tabs.create.

if (shortcutRowEl) {
  shortcutRowEl.addEventListener('click', function (e) {
    e.preventDefault();
    var url = shortcutRowEl.getAttribute('data-link') || 'chrome://extensions/shortcuts';
    chrome.tabs.create({ url: url });
  });
}

// ─── Provider rendering ─────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function linkHtml(label, url) {
  return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + ' &nearr;</a>';
}

function renderProvider() {
  Array.prototype.forEach.call(cardsEl.querySelectorAll('.pc'), function (el) {
    var match = el.getAttribute('data-provider') === state.provider;
    el.setAttribute('aria-checked', match ? 'true' : 'false');
  });

  var p = PROVIDERS[state.provider];

  if (p.note) { noteEl.textContent = p.note; noteEl.hidden = false; }
  else { noteEl.hidden = true; }

  stepsEl.innerHTML = '';
  p.steps(linkHtml).forEach(function (line) {
    var li = document.createElement('li');
    var span = document.createElement('span');
    span.innerHTML = line;
    li.appendChild(span);
    stepsEl.appendChild(li);
  });

  keyLabelEl.textContent = p.keyLabel;
  apiKeyEl.placeholder = p.keyPlaceholder;
  apiKeyEl.value = (state.providers[state.provider] && state.providers[state.provider].apiKey) || '';
  apiKeyEl.type = 'password';
  eyeShowEl.hidden = false;
  eyeHideEl.hidden = true;
  validateKeyFormat();

  modelEl.innerHTML = '';
  p.models.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    modelEl.appendChild(opt);
  });
  var savedModel = (state.providers[state.provider] && state.providers[state.provider].model) || p.defaultModel;
  modelEl.value = savedModel;

  updateProviderSummary();
  setStatus('');
}

function updateProviderSummary() {
  if (!providerSummaryEl) return;
  var p = PROVIDERS[state.provider];
  var entry = state.providers[state.provider] || {};
  if (entry.apiKey) {
    var modelId = entry.model || p.defaultModel;
    var modelMeta = p.models.find(function (m) { return m.id === modelId; });
    var modelLabel = modelMeta ? modelMeta.label.split(' (')[0] : modelId;
    providerSummaryEl.textContent = p.productName + ' · ' + modelLabel;
    return;
  }
  // No BYOK key. If signed in, the row represents the Skipper Free tier.
  var skipper = state.skipper || {};
  if (skipper.accessToken) {
    var quota = skipper.quota || {};
    var soql = quota.soql;
    var bits = ['Skipper Free', 'Haiku 4.5'];
    if (soql && typeof soql.remaining === 'number' && typeof soql.limit === 'number') {
      bits.push(soql.remaining + '/' + soql.limit + ' @soql left');
    }
    providerSummaryEl.textContent = bits.join(' · ');
    return;
  }
  providerSummaryEl.textContent = 'Not configured';
}

function validateKeyFormat() {
  var p = PROVIDERS[state.provider];
  var msg = p.validate(apiKeyEl.value.trim());
  if (msg) { keyWarnEl.textContent = msg; keyWarnEl.hidden = false; }
  else { keyWarnEl.hidden = true; }
}

function setStatus(text, kind) {
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.className = 'msg' + (kind ? ' ' + kind : '');
}

// ─── Provider event handlers ────────────────────────────────────────────────

cardsEl.addEventListener('click', function (e) {
  var card = e.target.closest('.pc');
  if (!card) return;
  e.stopPropagation();
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

revealEl.addEventListener('click', function (e) {
  e.stopPropagation();
  var hidden = apiKeyEl.type === 'password';
  apiKeyEl.type = hidden ? 'text' : 'password';
  eyeShowEl.hidden = hidden;
  eyeHideEl.hidden = !hidden;
});

saveEl.addEventListener('click', async function (e) {
  e.stopPropagation();
  var key = apiKeyEl.value.trim();
  if (!key) { setStatus('Enter an API key first', 'err'); return; }

  state.providers[state.provider] = state.providers[state.provider] || {};
  state.providers[state.provider].apiKey = key;
  state.providers[state.provider].model = modelEl.value;
  await mergeOptions({
    provider: state.provider,
    providers: state.providers,
    openInNewTab: state.openInNewTab
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
    updateProviderSummary();
  });
});

modelEl.addEventListener('change', function () {
  state.providers[state.provider] = state.providers[state.provider] || {};
  state.providers[state.provider].model = modelEl.value;
  updateProviderSummary();
});

// ─── Walkthrough replay ─────────────────────────────────────────────────────

var DEFAULT_WALK_SUB = walkSubEl ? walkSubEl.textContent : '';

function setWalkSub(text, kind) {
  if (!walkSubEl) return;
  walkSubEl.textContent = text;
  walkSubEl.className = 'row-sub' + (kind ? ' ' + kind : '');
}

if (walkthroughRowEl) {
  walkthroughRowEl.addEventListener('click', async function () {
    setWalkSub('Looking for a Salesforce tab…', 'loading');
    await mergeOptions({ onboardingDone: false, walkthroughSeen: false });

    chrome.tabs.query({}, function (tabs) {
      var sfTabs = (tabs || []).filter(function (t) { return t.url && SF_HOST_RE.test(t.url); });
      if (!sfTabs.length) {
        setWalkSub('Open a Salesforce tab, then click again.', 'err');
        setTimeout(function () { setWalkSub(DEFAULT_WALK_SUB); }, 4000);
        return;
      }
      var target = sfTabs.find(function (t) { return t.active; }) || sfTabs[0];
      chrome.tabs.update(target.id, { active: true }, function () {
        if (target.windowId != null) chrome.windows.update(target.windowId, { focused: true });
        chrome.runtime.sendMessage({ type: 'openPalette', tabId: target.id }, function () {
          setWalkSub('Walkthrough opened in your Salesforce tab.', 'ok');
          setTimeout(function () { setWalkSub(DEFAULT_WALK_SUB); }, 2500);
        });
      });
    });
  });
}

// ─── Account (Skipper sign-in) ──────────────────────────────────────────────

var acctRowOutEl      = document.getElementById('acctRowOut');
var acctRowInEl       = document.getElementById('acctRowIn');
var acctSignedOutEl   = document.getElementById('acctSignedOut');
var acctCodeEntryEl   = document.getElementById('acctCodeEntry');
var acctEmailEl       = document.getElementById('acctEmail');
var acctSendCodeEl    = document.getElementById('acctSendCode');
var acctStatusEl      = document.getElementById('acctStatus');
var acctCodeEl        = document.getElementById('acctCode');
var acctVerifyEl      = document.getElementById('acctVerify');
var acctResendEl      = document.getElementById('acctResend');
var acctCodeStatusEl  = document.getElementById('acctCodeStatus');
var acctEmailShownEl  = document.getElementById('acctEmailShown');
var acctAvatarEl      = document.getElementById('acctAvatar');
var acctSignOutEl     = document.getElementById('acctSignOut');
var acctSignedInStatusEl = document.getElementById('acctSignedInStatus');

// Email captured at "Send code" time — code verification needs the same
// address Supabase sent the OTP to.
var acctPendingEmail = '';

function setMsg(el, text, kind) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function setLineStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status-line' + (kind ? ' ' + kind : '');
}

function showAcctSubState(s) {
  acctSignedOutEl.hidden = s !== 'signed-out';
  acctCodeEntryEl.hidden = s !== 'code-entry';
}

function initialsFor(email) {
  if (!email) return '?';
  var name = (email.split('@')[0] || '').trim();
  var parts = name.split(/[._\-+]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]);
  return name.slice(0, 2) || '?';
}

function renderAccount() {
  if (!window.SkipperAuth) return;
  SkipperAuth.getSession().then(function (skipper) {
    if (skipper && skipper.accessToken) {
      acctEmailShownEl.textContent = skipper.email || '(unknown)';
      acctAvatarEl.textContent = initialsFor(skipper.email);
      acctRowOutEl.hidden = true;
      acctRowInEl.hidden = false;
    } else {
      acctRowOutEl.hidden = false;
      acctRowInEl.hidden = true;
      showAcctSubState('signed-out');
    }
  });
}

if (acctSendCodeEl) {
  acctSendCodeEl.addEventListener('click', function (e) {
    e.stopPropagation();
    var email = (acctEmailEl.value || '').trim();
    if (!email || email.indexOf('@') === -1) {
      setMsg(acctStatusEl, 'Enter a valid email.', 'err');
      acctEmailEl.focus();
      return;
    }
    acctSendCodeEl.disabled = true;
    setMsg(acctStatusEl, 'Sending code…', 'loading');
    SkipperAuth.requestOtp(email).then(function () {
      acctPendingEmail = email;
      setMsg(acctStatusEl, '');
      setMsg(acctCodeStatusEl, 'Code sent to ' + email + '. Check your inbox.', 'ok');
      acctSendCodeEl.disabled = false;
      showAcctSubState('code-entry');
      setTimeout(function () { acctCodeEl && acctCodeEl.focus(); }, 50);
    }).catch(function (err) {
      acctSendCodeEl.disabled = false;
      setMsg(acctStatusEl, 'Could not send: ' + err.message, 'err');
    });
  });
}

if (acctVerifyEl) {
  acctVerifyEl.addEventListener('click', function (e) {
    e.stopPropagation();
    var code = (acctCodeEl.value || '').trim();
    if (!/^\d{6}$/.test(code)) {
      setMsg(acctCodeStatusEl, 'Enter the 6-digit code.', 'err');
      acctCodeEl.focus();
      return;
    }
    acctVerifyEl.disabled = true;
    setMsg(acctCodeStatusEl, 'Verifying…', 'loading');
    SkipperAuth.verifyOtp(acctPendingEmail, code).then(function () {
      acctVerifyEl.disabled = false;
      acctCodeEl.value = '';
      setMsg(acctCodeStatusEl, '');
      setLineStatus(acctSignedInStatusEl, 'Signed in.', 'ok');
      setTimeout(function () { setLineStatus(acctSignedInStatusEl, ''); }, 2500);
      renderAccount();
    }).catch(function (err) {
      acctVerifyEl.disabled = false;
      setMsg(acctCodeStatusEl, 'Could not sign in: ' + err.message, 'err');
    });
  });
}

if (acctCodeEl) {
  acctCodeEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); acctVerifyEl && acctVerifyEl.click(); }
  });
}

if (acctResendEl) {
  acctResendEl.addEventListener('click', function (e) {
    e.stopPropagation();
    acctPendingEmail = '';
    acctCodeEl.value = '';
    setMsg(acctCodeStatusEl, '');
    showAcctSubState('signed-out');
    setTimeout(function () { acctEmailEl && acctEmailEl.focus(); }, 50);
  });
}

if (acctSignOutEl) {
  acctSignOutEl.addEventListener('click', function (e) {
    e.stopPropagation();
    acctSignOutEl.disabled = true;
    setLineStatus(acctSignedInStatusEl, 'Signing out…', 'loading');
    SkipperAuth.signOut().then(function () {
      acctSignOutEl.disabled = false;
      setLineStatus(acctSignedInStatusEl, '');
      renderAccount();
    });
  });
}

renderAccount();

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

function setFbStatus(text, kind) { setMsg(fbStatusEl, text, kind); }

if (fbSendEl) {
  fbSendEl.addEventListener('click', function (e) {
    e.stopPropagation();
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
