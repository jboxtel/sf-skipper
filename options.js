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
    keyPrefix: 'AIza',
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
    note: 'The free tier is enough for everyday use. On the free tier Google may use your prompts to improve its products; add billing in AI Studio to turn that off.',
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
    keyPrefix: 'sk-ant-',
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
    productName: 'OpenAI',
    badge: 'GPT',
    keyPrefix: 'sk-',
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
  },
  openrouter: {
    label: 'OpenRouter',
    productName: 'OpenRouter',
    badge: 'OPENROUTER',
    keyPrefix: 'sk-or-',
    keyLabel: 'OpenRouter API key',
    keyPlaceholder: 'sk-or-v1-…',
    validate: function (k) {
      if (!k) return null;
      if (/^sk-ant-/.test(k)) {
        return 'That looks like an Anthropic key (starts with "sk-ant-"). Switch to the Claude provider above.';
      }
      if (!/^sk-or-/.test(k)) {
        return 'OpenRouter API keys start with "sk-or-". This looks like a different provider’s key.';
      }
      return null;
    },
    steps: function (a) {
      return [
        'Open ' + a('openrouter.ai/keys', 'https://openrouter.ai/keys') + ' and sign in (create an account if you don’t have one).',
        'Add credit under Settings — OpenRouter is pay-as-you-go per request, no separate subscription.',
        'Click <strong>Create Key</strong>, copy it (starts with <code>sk-or-</code>), and paste it below.'
      ];
    },
    note: 'One key, many vendors — pick the underlying model below. Each request is billed by OpenRouter at that model’s per-token rate.',
    defaultModel: 'anthropic/claude-haiku-4.5',
    // The full catalogue is fetched from openrouter.ai at render time; `models`
    // is only the offline fallback when that request fails.
    dynamicModels: true,
    models: [
      { id: 'anthropic/claude-haiku-4.5',        label: 'Claude Haiku 4.5 (fast, recommended)' },
      { id: 'openai/gpt-4.1-mini',                label: 'GPT-4.1 mini' },
      { id: 'google/gemini-2.5-flash',            label: 'Gemini 2.5 Flash' }
    ]
  },
  // Sign in with ChatGPT: no key — requests run on the
  // user's Plus/Pro plan. The sign-in lives in chatgptAuth (chatgpt-auth.js),
  // not in sfnavOptions; providers.chatgpt only holds the model. It has no
  // pill of its own: it shares the OpenAI pill with the API key.
  chatgpt: {
    label: 'OpenAI',
    productName: 'ChatGPT',
    badge: 'CHATGPT',
    signIn: true,
    pill: 'openai',
    defaultModel: 'gpt-5.6-luna',
    // Seed list; the signed-in account's own list replaces it (loadChatGPTModels).
    models: [
      { id: 'gpt-5.6-luna',  label: 'GPT-5.6-Luna (fast, recommended)' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-sol',   label: 'GPT-5.6-Sol' },
      { id: 'gpt-6-astra',   label: 'GPT-6-Astra (most capable)' }
    ]
  }
};

// ─── DOM refs ───────────────────────────────────────────────────────────────

// ─── DOM refs (provider flow: paste → recognized → connected) ───────────────

var scrPasteEl    = document.getElementById('scr-paste');
var scrRecogEl    = document.getElementById('scr-recognized');
var scrConnEl     = document.getElementById('scr-connected');
var chatgptBlockEl = document.getElementById('chatgptBlock');
var signInBtnEl   = document.getElementById('chatgptSignIn');
var signinStatusEl = document.getElementById('signinStatus');
var apiKeyEl      = document.getElementById('apiKey');
var revealEl      = document.getElementById('revealKey');
var eyeShowEl     = document.getElementById('eyeShow');
var eyeHideEl     = document.getElementById('eyeHide');
var unrecEl       = document.getElementById('unrecognized');
var unrecMsgEl    = document.getElementById('unrecMsg');
var useAnywayEl   = document.getElementById('useAnyway');
var pillsEl       = document.getElementById('providerPills');
var usingNoteEl   = document.getElementById('usingNote');
var howLblEl      = document.getElementById('howLbl');
var stepsEl       = document.getElementById('providerSteps');
var noteEl        = document.getElementById('providerNote');
var apiKeyLabelEl = document.getElementById('apiKeyLabel');
var keepKeyEl     = document.getElementById('keepKey');
var keepKeyLinkEl = document.getElementById('keepKeyLink');
var pasteStatusEl = document.getElementById('pasteStatus');
var matchLineEl   = document.getElementById('matchLine');
var keyPreviewEl  = document.getElementById('keyPreview');
var clearDraftEl  = document.getElementById('clearDraft');
var keptKeyEl     = document.getElementById('keptKey');
var modelEl       = document.getElementById('model');
var modelFilterEl = document.getElementById('modelFilter');
var modelHintEl   = document.getElementById('modelHint');
var saveEl        = document.getElementById('save');
var statusEl      = document.getElementById('status');
var connKeyEl     = document.getElementById('connKey');
var connModelEl   = document.getElementById('connModel');
var modelStatusEl = document.getElementById('modelStatus');
var replaceKeyEl  = document.getElementById('replaceKey');
var removeKeyEl   = document.getElementById('removeKey');
var openInEl      = document.getElementById('openIn');
var replayEl      = document.getElementById('replayWalkthrough');
var walkStatusEl  = document.getElementById('walkthroughStatus');
var versionEl     = document.getElementById('version');
var paletteShortcutChipEl = document.getElementById('paletteShortcutChip');

var state = {
  provider: 'gemini',
  providers: { gemini: {}, anthropic: {}, openai: {}, openrouter: {}, chatgpt: {} },
  openInNewTab: true,
  chatgptAuth: {} // stored ChatGPT sign-in (tokens never leave chatgpt-auth.js / the worker)
};

// The provider pane is a three-screen flow (vsr/gen-4/candidates/w4-repaired.md):
// paste a key → the key names its provider → save-and-test → connected. Nothing is
// written to storage until a test succeeds, so a half-finished replacement never
// disturbs a working key.
var flow = {
  mode: 'paste',   // 'paste' | 'recognized' | 'connected'
  choice: 'gemini', // provider pill selected on the paste screen
  draft: { key: '', provider: null, manual: false, model: '' },
  pasteNote: null  // { text, kind } shown on the paste screen (e.g. after Remove key)
};

// ─── Version stamp ──────────────────────────────────────────────────────────

try {
  var version = chrome.runtime.getManifest().version;
  if (versionEl)  versionEl.textContent = 'v' + version;
} catch (e) { /* non-extension preview */ }

// ─── Load + migrate stored options ──────────────────────────────────────────

chrome.storage.local.get(['sfnavOptions', CHATGPT_AUTH_KEY], function (data) {
  var opts = data.sfnavOptions || {};
  state.providers = Object.assign({ gemini: {}, anthropic: {}, openai: {}, openrouter: {}, chatgpt: {} }, opts.providers || {});
  state.chatgptAuth = data[CHATGPT_AUTH_KEY] || {};

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
  flow.choice = PROVIDERS[state.provider] ? pillOf(state.provider) : 'gemini';
  // A saved key for the active provider means we're already set up — open on
  // the Connected screen rather than asking for a key again.
  if (hasSavedKey(state.provider)) flow.mode = 'connected';

  renderFlow();
});

// ─── Rendering ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Spec format: first 7 characters, a run of bullets, last 4
// ("sk-ant-••••" as a preview, "sk-ant-••••1234" when connected).
function maskPreview(key) {
  return key ? key.slice(0, 7) + '••••' : '';
}

function maskConnected(key) {
  if (!key) return '';
  return key.length <= 11 ? maskPreview(key) : maskPreview(key) + key.slice(-4);
}

if (paletteShortcutChipEl && typeof sfnavPaletteShortcutParts === 'function') {
  paletteShortcutChipEl.innerHTML = sfnavPaletteShortcutParts()
    .map(function (part) { return '<kbd>' + esc(part) + '</kbd>'; })
    .join('');
}

// ─── Provider flow rendering ────────────────────────────────────────────

var MATCH_LINES = {
  gemini: "That's a Gemini key (Google).",
  anthropic: "That's a Claude key (Anthropic).",
  openai: "That's an OpenAI key.",
  openrouter: "That's an OpenRouter key."
};

// Distinguishes "could not reach the provider" from a provider rejecting the
// key: fetch/timeout failures surface as network-flavoured error strings.
var NETWORK_ERR_RE = /failed to fetch|networkerror|load failed|abort|timed?.?out|err_(connection|internet|name|address)|could not resolve|getaddrinfo/i;

function showScreen(mode) {
  scrPasteEl.hidden = mode !== 'paste';
  scrRecogEl.hidden = mode !== 'recognized';
  scrConnEl.hidden = mode !== 'connected';
}

function renderFlow() {
  renderPills();
  if (flow.mode === 'connected') renderConnected();
  else if (flow.mode === 'recognized') renderRecognized();
  else renderPaste();
  showScreen(flow.mode);
}

function setSigninStatus(text, kind) {
  signinStatusEl.textContent = text || '';
  signinStatusEl.className = 'st' + (kind ? ' ' + kind : '');
}

function resetDraft() {
  flow.draft = { key: '', provider: null, manual: false, model: '' };
}

function renderPaste() {
  apiKeyEl.value = flow.draft.key;
  apiKeyEl.type = 'password';
  eyeShowEl.hidden = false;
  eyeHideEl.hidden = true;
  unrecEl.hidden = true;
  pasteStatusEl.textContent = flow.pasteNote ? flow.pasteNote.text : '';
  pasteStatusEl.className = flow.pasteNote ? (flow.pasteNote.kind || '') : '';
  setSigninStatus('');
  signInBtnEl.disabled = false;
  renderProviderChoice();
}

// ─── Pills ──────────────────────────────────────────────────────────────────
// A pill can stand for more than one provider: the OpenAI pill covers both an
// OpenAI API key and Sign in with ChatGPT. flow.choice is always a pill name.

function pillOf(name) {
  return (PROVIDERS[name] && PROVIDERS[name].pill) || name;
}

function providersOfPill(pill) {
  return Object.keys(PROVIDERS).filter(function (n) { return pillOf(n) === pill; });
}

// The provider a pill switches to: the one in use if it's under this pill,
// else the first one that's set up. Null when nothing under it is set up.
function savedProviderOfPill(pill) {
  var family = providersOfPill(pill);
  if (family.indexOf(state.provider) > -1 && hasSavedKey(state.provider)) return state.provider;
  return family.filter(hasSavedKey)[0] || null;
}

// The selected pill is what the screen below shows. The provider in use is
// marked green; other providers with a saved key get a grey dot.
function renderPills() {
  Array.prototype.forEach.call(pillsEl.querySelectorAll('.ppill'), function (pill) {
    var n = pill.getAttribute('data-provider');
    var on = n === flow.choice;
    var savedAs = savedProviderOfPill(n);
    var active = !!savedAs && savedAs === state.provider;
    pill.setAttribute('aria-checked', on ? 'true' : 'false');
    pill.tabIndex = on ? 0 : -1; // roving tabindex: arrows move within the group
    pill.classList.toggle('active', active);
    pill.classList.toggle('has-key', !!savedAs && !active);
    pill.title = active ? 'In use' : (savedAs ? (PROVIDERS[savedAs].signIn ? 'Signed in' : 'Key saved') + ' — click to use it' : '');
  });
  renderUsingNote();
}

// While setting up another provider, say which one Skipper still uses and
// when that changes — otherwise the selected pill and the green dot look
// like two selections.
function renderUsingNote() {
  var inUse = hasSavedKey(state.provider) ? state.provider : null;
  var next, how;
  if (!inUse || flow.mode === 'connected') {
    next = null;
  } else if (flow.mode === 'recognized') {
    // A pasted key names its provider exactly — compare providers, not pills.
    if (flow.draft.provider !== inUse) {
      next = PROVIDERS[flow.draft.provider].productName;
      how = 'once this key passes the test';
    }
  } else if (pillOf(inUse) !== flow.choice) {
    next = flow.choice === 'openai' ? 'ChatGPT or OpenAI' : PROVIDERS[flow.choice].productName;
    how = flow.choice === 'openai' ? 'once you sign in or save a working key' : 'once you save a working key';
  } else if (PROVIDERS[inUse].signIn) {
    // "Use an API key instead": same pill, signed in, about to paste a key.
    next = 'an OpenAI key';
    how = 'once you save one that works';
  }
  usingNoteEl.hidden = !next;
  if (!next) return;
  usingNoteEl.innerHTML = '<span>Skipper is using <strong>' + esc(PROVIDERS[inUse].productName) + '</strong>. ' +
    'It switches to ' + esc(next) + ' ' + how + '.</span>';
}

// Everything on the paste screen that depends on the selected pill. Kept
// apart from renderPaste so switching pills never clears a half-typed key.
function renderProviderChoice() {
  var name = flow.choice;
  var p = PROVIDERS[name];
  chatgptBlockEl.hidden = name !== 'openai';
  keepKeyEl.hidden = !savedProviderOfPill(name);
  howLblEl.textContent = 'Don’t have ' + aKey(p) + ' yet? Here’s how to get one';
  stepsEl.innerHTML = p.steps(function (text, href) {
    return '<a href="' + href + '" target="_blank" rel="noopener">' + esc(text) + '</a>';
  }).map(function (step) { return '<li><span>' + step + '</span></li>'; }).join('');
  noteEl.textContent = p.note;
  apiKeyLabelEl.textContent = 'Paste your ' + p.productName + ' key';
  apiKeyEl.placeholder = 'Starts with ' + p.keyPrefix + '…';
  useAnywayEl.textContent = 'Use it as ' + aKey(p) + ' anyway';
}

// For ChatGPT "saved key" means signed in with plan usage approved.
// "a Gemini key", "an OpenAI key".
function aKey(p) {
  return (/^[AEIOU]/.test(p.productName) ? 'an ' : 'a ') + p.productName + ' key';
}

function hasSavedKey(name) {
  if (PROVIDERS[name] && PROVIDERS[name].signIn) {
    return chatgptIsSignedIn(state.chatgptAuth) && chatgptHasPlanScope(state.chatgptAuth);
  }
  return !!(state.providers[name] && state.providers[name].apiKey);
}

// A pill with a saved key switches to it straight away — no re-paste, no
// re-test (it passed its test when it was saved). A pill without a key opens
// the paste screen, keeping any half-typed key.
function selectProvider(name, focus) {
  if (!PROVIDERS[name]) return;
  var saved = savedProviderOfPill(name);
  if (saved) {
    if (saved === state.provider && flow.mode === 'connected') return;
    activateProvider(saved);
  } else {
    if (name === flow.choice && flow.mode === 'paste') return;
    flow.choice = name;
    if (flow.mode !== 'paste') {
      resetDraft();
      flow.pasteNote = null;
      flow.mode = 'paste';
      renderFlow();
    } else {
      renderPills();
      renderProviderChoice();
      handleKeyInput(); // re-word the not-recognized message for the new pill
    }
  }
  if (focus) pillsEl.querySelector('[data-provider="' + name + '"]').focus();
}

function activateProvider(name) {
  flow.choice = pillOf(name);
  if (name !== state.provider) {
    state.provider = name;
    mergeOptions({ provider: name });
  }
  resetDraft();
  flow.pasteNote = null;
  flow.mode = 'connected';
  renderFlow();
}

// Called on input/paste into the key field: a recognized prefix jumps straight
// to Screen 2 — under the provider the key belongs to, even if a different pill
// was selected. A long enough unrecognized value offers to use it anyway with
// the selected provider.
function handleKeyInput() {
  var v = apiKeyEl.value.trim();
  flow.pasteNote = null;
  if (!v) {
    unrecEl.hidden = true;
    resetDraft();
    return;
  }
  var det = detectProvider(v);
  if (det) {
    enterRecognized(v, det, false);
    return;
  }
  var p = PROVIDERS[flow.choice];
  unrecMsgEl.textContent = 'This doesn’t look like ' + aKey(p) + ' — those start with ' +
    p.keyPrefix + '. Check you copied the whole key.';
  unrecEl.hidden = v.length < 16;
}

// Prefixes are unambiguous in this set, with one ordering trap: sk-ant- and
// sk-or- must both be tested before the bare sk- that means OpenAI.
function detectProvider(k) {
  if (/^sk-ant-/.test(k)) return 'anthropic';
  if (/^sk-or-/.test(k))  return 'openrouter';
  if (/^sk-/.test(k))     return 'openai';
  if (/^AIza/.test(k))    return 'gemini';
  return null;
}

function enterRecognized(key, providerName, manual) {
  flow.choice = providerName; // "Clear and paste a different key" comes back on this pill
  flow.draft = { key: key, provider: providerName, manual: manual, model: '' };
  flow.mode = 'recognized';
  renderFlow();
}

function renderRecognized() {
  var name = flow.draft.provider;
  var p = PROVIDERS[name];
  if (flow.draft.manual) {
    matchLineEl.textContent = 'You named this ' + aKey(p) + (p.label !== p.productName ? ' (' + p.label + ')' : '') + '. Skipper could not confirm it from the prefix.';
  } else {
    matchLineEl.textContent = MATCH_LINES[name];
  }
  keyPreviewEl.textContent = maskPreview(flow.draft.key);

  // If another provider is already set up, say so — replacing a key must
  // never silently drop it.
  var others = Object.keys(PROVIDERS).filter(function (n) {
    return n !== name && hasSavedKey(n);
  });
  var prevActive = others.indexOf(state.provider) > -1 ? state.provider : others[0];
  if (prevActive) {
    keptKeyEl.textContent = PROVIDERS[prevActive].signIn
      ? 'You stay signed in to ' + PROVIDERS[prevActive].productName + '.'
      : 'Your ' + PROVIDERS[prevActive].productName + ' key is kept.';
    keptKeyEl.hidden = false;
  } else {
    keptKeyEl.hidden = true;
  }

  renderModelMenuFor(name);
  setStatus('');
}

function renderConnected() {
  var name = state.provider;
  var stored = state.providers[name] || {};
  var signIn = !!PROVIDERS[name].signIn;
  connKeyEl.textContent = signIn
    ? 'Signed in as ' + (state.chatgptAuth.email || 'your ChatGPT account')
    : maskConnected(stored.apiKey || '');
  connKeyEl.classList.toggle('conn-who', signIn);
  replaceKeyEl.textContent = signIn ? 'Use an API key instead' : 'Use a different key';
  removeKeyEl.textContent = signIn ? 'Sign out' : 'Remove key';
  setModelStatus('', '');
  renderConnectedModels(name);
}

// ─── Model menu ─────────────────────────────────────────────────────────────
// Single-vendor providers ship a hand-picked shortlist. OpenRouter fronts a few
// hundred models, so its menu is built from the live catalogue at
// openrouter.ai/api/v1/models (public, no key needed), cached for a day.

var OR_MODELS_KEY = 'sfnavOrModels2'; // v2: catalogue filtered to image-capable models
try { chrome.storage.local.remove('sfnavOrModels'); } catch (_) {} // drop the v1 cache
var OR_MODELS_TTL = 24 * 60 * 60 * 1000;
var orModels = null;   // normalized catalogue for this page session
var modelReq = 0;      // guards against a slow fetch landing after a provider switch

function fillModelSelectInto(selectEl, list, selected) {
  selectEl.innerHTML = '';
  var has = list.some(function (m) { return m.id === selected; });

  // The current model always stays selectable, even when a filter excludes it —
  // otherwise Save would write back an empty model.
  if (selected && !has) {
    var cur = document.createElement('optgroup');
    cur.label = 'Current';
    cur.appendChild(optionFor({ id: selected, label: selected }));
    selectEl.appendChild(cur);
  }

  var groups = {};
  var order = [];
  list.forEach(function (m) {
    if (!m.group) { selectEl.appendChild(optionFor(m)); return; }
    if (!groups[m.group]) {
      groups[m.group] = document.createElement('optgroup');
      groups[m.group].label = m.groupLabel || m.group;
      order.push(m.group);
    }
    groups[m.group].appendChild(optionFor(m));
  });
  order.forEach(function (g) { selectEl.appendChild(groups[g]); });

  selectEl.value = selected;
}

// Keep only models that advertise tool support — @soql, @debug and @ask are
// entirely tool-call driven, so a model without `tools` fails on the first turn.
function normalizeOrModels(data) {
  var out = [];
  (data || []).forEach(function (m) {
    if (!m || !m.id) return;
    // Every model in the menu has to work with every feature: @soql/@ask need
    // tool calling, and @ask sends a screenshot, so text-only models are out.
    if ((m.supported_parameters || []).indexOf('tools') === -1) return;
    if (((m.architecture && m.architecture.input_modalities) || []).indexOf('image') === -1) return;
    var name = m.name || m.id;
    var split = name.indexOf(': ');
    var vendorSlug = m.id.indexOf('/') > -1 ? m.id.split('/')[0] : 'other';
    out.push({
      id: m.id,
      label: split > -1 ? name.slice(split + 2) : name,
      group: vendorSlug,
      groupLabel: split > -1 ? name.slice(0, split) : vendorSlug
    });
  });
  out.sort(function (a, b) {
    if (a.groupLabel !== b.groupLabel) return a.groupLabel.localeCompare(b.groupLabel);
    return a.label.localeCompare(b.label);
  });
  return out;
}

function loadOrModels() {
  if (orModels) return Promise.resolve(orModels);
  return new Promise(function (resolve) {
    chrome.storage.local.get(OR_MODELS_KEY, function (data) {
      var cached = (data && data[OR_MODELS_KEY]) || null;
      var fresh = cached && cached.models && cached.models.length &&
                  (Date.now() - cached.fetchedAt) < OR_MODELS_TTL;
      if (fresh) { orModels = cached.models; resolve(orModels); return; }

      fetch('https://openrouter.ai/api/v1/models')
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (json) {
          var list = normalizeOrModels(json && json.data);
          if (!list.length) throw new Error('empty catalogue');
          orModels = list;
          var store = {};
          store[OR_MODELS_KEY] = { fetchedAt: Date.now(), models: list };
          chrome.storage.local.set(store);
          resolve(list);
        })
        .catch(function () {
          // A stale cache still beats the five-model fallback.
          if (cached && cached.models && cached.models.length) {
            orModels = cached.models;
            resolve(orModels);
          } else {
            resolve(null);
          }
        });
    });
  });
}

function optionFor(m) {
  var opt = document.createElement('option');
  opt.value = m.id;
  opt.textContent = m.label;
  return opt;
}

function setModelHint(text, kind) {
  modelHintEl.textContent = text || '';
  modelHintEl.className = 'field-hint' + (kind ? ' ' + kind : '');
  modelHintEl.hidden = !text;
}

function renderModelMenuFor(providerName) {
  var p = PROVIDERS[providerName];
  var selected = flow.draft.model ||
    (state.providers[providerName] && state.providers[providerName].model) || p.defaultModel;
  var req = ++modelReq;
  modelFilterEl.value = '';

  if (!p.dynamicModels) {
    modelFilterEl.hidden = true;
    setModelHint('');
    fillModelSelectInto(modelEl, p.models, selected);
    return;
  }

  modelFilterEl.hidden = false;
  // Seed with the built-in shortlist so the menu is never empty while loading.
  fillModelSelectInto(modelEl, orModels || p.models, selected);
  if (!orModels) setModelHint('Loading the OpenRouter catalogue…');

  loadOrModels().then(function (list) {
    if (req !== modelReq) return; // provider changed while the fetch was in flight
    if (!list) {
      setModelHint('Showing ' + p.models.length + ' offline models. Could not reach the OpenRouter catalogue.', 'err');
      return;
    }
    applyModelFilterFor(providerName);
  });
}

function applyModelFilterFor(providerName) {
  var p = PROVIDERS[providerName];
  var list = orModels || p.models;
  var q = (modelFilterEl.value || '').trim().toLowerCase();
  var shown = !q ? list : list.filter(function (m) {
    return (m.id + ' ' + m.label).toLowerCase().indexOf(q) > -1;
  });
  var selected = flow.draft.model ||
    (state.providers[providerName] && state.providers[providerName].model) || p.defaultModel;
  fillModelSelectInto(modelEl, shown, selected);
  setModelHint('Showing ' + shown.length + ' of ' + list.length + ' tool-capable models' +
    (q ? ' match “' + q + '”' : '') + '.');
}

function renderConnectedModels(providerName) {
  var p = PROVIDERS[providerName];
  var selected = (state.providers[providerName] && state.providers[providerName].model) || p.defaultModel;
  var req = ++modelReq;
  if (p.signIn) {
    fillModelSelectInto(connModelEl, chatgptModels || p.models, selected);
    loadChatGPTModels().then(function (list) {
      if (req === modelReq && list) fillModelSelectInto(connModelEl, list, selected);
    });
    return;
  }
  if (!p.dynamicModels) {
    fillModelSelectInto(connModelEl, p.models, selected);
    return;
  }
  fillModelSelectInto(connModelEl, orModels || p.models, selected);
  loadOrModels().then(function (list) {
    if (req !== modelReq) return;
    if (list) fillModelSelectInto(connModelEl, list, selected);
    // Catalogue unreachable: the short offline list stays selectable.
  });
}

// The models a ChatGPT account may use come from /v1/models with the user's
// token. Each entry carries a large Codex prompt, so only id + label are kept,
// cached for a day. The worker fetches it so token refreshes stay in one place.
var CHATGPT_MODELS_KEY = 'sfnavChatgptModels';
var chatgptModels = null;

function loadChatGPTModels() {
  if (chatgptModels) return Promise.resolve(chatgptModels);
  return new Promise(function (resolve) {
    chrome.storage.local.get(CHATGPT_MODELS_KEY, function (data) {
      var cached = (data && data[CHATGPT_MODELS_KEY]) || null;
      if (cached && cached.models && cached.models.length && (Date.now() - cached.fetchedAt) < OR_MODELS_TTL) {
        chatgptModels = cached.models;
        resolve(chatgptModels);
        return;
      }
      chrome.runtime.sendMessage({ type: 'chatgpt.models' }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok || !resp.models || !resp.models.length) {
          resolve(cached && cached.models && cached.models.length ? cached.models : null);
          return;
        }
        chatgptModels = resp.models;
        var store = {};
        store[CHATGPT_MODELS_KEY] = { fetchedAt: Date.now(), models: chatgptModels };
        chrome.storage.local.set(store);
        resolve(chatgptModels);
      });
    });
  });
}

function setModelStatus(text, kind) {
  modelStatusEl.textContent = text || '';
  modelStatusEl.className = kind || '';
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

function setWalkStatus(text, kind) {
  walkStatusEl.textContent = text;
  walkStatusEl.className = 'st' + (kind ? ' ' + kind : '');
}

// ─── Event handlers ─────────────────────────────────────────────────────────

apiKeyEl.addEventListener('input', handleKeyInput);

// Back out of pasting a replacement for a provider that already has a key.
keepKeyLinkEl.addEventListener('click', function (e) {
  e.preventDefault();
  var saved = savedProviderOfPill(flow.choice);
  if (saved) activateProvider(saved);
});

useAnywayEl.addEventListener('click', function () {
  var key = apiKeyEl.value.trim();
  if (!key) return;
  enterRecognized(key, flow.choice, true);
});

pillsEl.addEventListener('click', function (e) {
  var pill = e.target.closest('.ppill');
  if (pill) selectProvider(pill.getAttribute('data-provider'), false);
});

pillsEl.addEventListener('keydown', function (e) {
  var order = Array.prototype.map.call(pillsEl.querySelectorAll('.ppill'), function (p) {
    return p.getAttribute('data-provider');
  });
  var i = order.indexOf(flow.choice);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = (i + 1) % order.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = (i + order.length - 1) % order.length;
  else return;
  e.preventDefault();
  selectProvider(order[i], true);
});

revealEl.addEventListener('click', function () {
  var hidden = apiKeyEl.type === 'password';
  apiKeyEl.type = hidden ? 'text' : 'password';
  eyeShowEl.hidden = hidden;
  eyeHideEl.hidden = !hidden;
});

clearDraftEl.addEventListener('click', function (e) {
  e.preventDefault();
  resetDraft();
  flow.pasteNote = null;
  flow.mode = 'paste';
  renderFlow();
  apiKeyEl.focus();
});

saveEl.addEventListener('click', function () {
  var key = flow.draft.key;
  var name = flow.draft.provider;
  if (!key || !name) return;
  flow.draft.model = modelEl.value;

  // Test first with a transient opts override — storage is only written on
  // success, so a failed test never disturbs an already-working key.
  var patched = {};
  Object.keys(state.providers).forEach(function (n) {
    patched[n] = Object.assign({}, state.providers[n]);
  });
  patched[name] = Object.assign({}, patched[name], { apiKey: key, model: flow.draft.model });
  var testOpts = { provider: name, providers: patched, openInNewTab: state.openInNewTab };

  saveEl.disabled = true;
  setStatus('Testing…', 'loading');
  chrome.runtime.sendMessage({ type: 'provider.test', opts: testOpts }, function (resp) {
    saveEl.disabled = false;
    if (chrome.runtime.lastError) { setStatus('Error: ' + chrome.runtime.lastError.message, 'err'); return; }
    if (!resp) { setStatus('No response from background', 'err'); return; }
    if (!resp.ok) {
      if (NETWORK_ERR_RE.test(resp.error)) {
        setStatus('Could not reach ' + PROVIDERS[name].productName + '. Check your connection and try again.', 'err');
      } else {
        setStatus('Failed: ' + resp.error, 'err');
      }
      return;
    }
    state.providers = patched;
    state.provider = name;
    mergeOptions({ provider: name, providers: patched });
    flow.mode = 'connected';
    renderFlow();
  });
});

modelEl.addEventListener('change', function () {
  flow.draft.model = modelEl.value;
});

openInEl.addEventListener('change', function () {
  mergeOptions({ openInNewTab: openInEl.value !== 'same' });
});

modelFilterEl.addEventListener('input', function () {
  var name = flow.draft.provider;
  if (name && PROVIDERS[name].dynamicModels) applyModelFilterFor(name);
});

connModelEl.addEventListener('change', function () {
  state.providers[state.provider] = state.providers[state.provider] || {};
  state.providers[state.provider].model = connModelEl.value;
  mergeOptions({ providers: state.providers });
  setModelStatus('Model updated.', 'ok');
});

replaceKeyEl.addEventListener('click', function (e) {
  e.preventDefault();
  resetDraft();
  flow.pasteNote = null;
  flow.mode = 'paste';
  renderFlow();
  apiKeyEl.focus();
});

removeKeyEl.addEventListener('click', function (e) {
  e.preventDefault();
  if (PROVIDERS[state.provider].signIn) {
    signOutChatGPT().then(function () {
      flow.pasteNote = { text: 'Signed out. @soql, @debug and @ask won\'t respond until you sign in again or pick another provider.', kind: 'ok' };
      flow.mode = 'paste';
      renderFlow();
    });
    return;
  }
  delete state.providers[state.provider].apiKey;
  mergeOptions({ providers: state.providers });
  resetDraft();
  flow.pasteNote = { text: 'Key removed. @soql, @debug and @ask won\'t respond until you add one.', kind: 'ok' };
  flow.mode = 'paste';
  renderFlow();
});

// ─── Sign in with ChatGPT ───────────────────────────────────────────────────
// Sign in (opens a ChatGPT tab), then the same one-word test as Save and test.
// Only a passing test makes ChatGPT the active provider; any failure after
// sign-in signs out again, so a Free account or a denied plan permission
// never leaves a half-connected provider behind.

function signOutChatGPT() {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage({ type: 'chatgpt.signOut' }, function () {
      void chrome.runtime.lastError;
      chatgptLoadAuth().then(function (auth) { state.chatgptAuth = auth; resolve(); });
    });
  });
}

function testProvider(opts) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ type: 'provider.test', opts: opts }, function (resp) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!resp) { reject(new Error('No response from background')); return; }
      if (!resp.ok) { reject(new Error(resp.error)); return; }
      resolve(resp);
    });
  });
}

signInBtnEl.addEventListener('click', function () {
  flow.pasteNote = null;
  signInBtnEl.disabled = true;
  setSigninStatus('Waiting for you to sign in to ChatGPT in the new tab…', 'loading');
  var signedIn = false;
  var patched = {};
  Object.keys(state.providers).forEach(function (n) { patched[n] = Object.assign({}, state.providers[n]); });
  patched.chatgpt.model = patched.chatgpt.model || PROVIDERS.chatgpt.defaultModel;

  chatgptSignIn().then(function (auth) {
    signedIn = true;
    if (!chatgptHasPlanScope(auth)) {
      throw new Error('You signed in, but Skipper wasn’t allowed to use your ChatGPT plan. Sign in again and approve it.');
    }
    state.chatgptAuth = auth;
    setSigninStatus('Testing…', 'loading');
    return testProvider({ provider: 'chatgpt', providers: patched, openInNewTab: state.openInNewTab });
  }).then(function () {
    state.providers = patched;
    state.provider = 'chatgpt';
    mergeOptions({ provider: 'chatgpt', providers: patched });
    flow.choice = 'openai';
    flow.mode = 'connected';
    renderFlow();
  }).catch(function (err) {
    var msg = err && err.message || String(err);
    if (NETWORK_ERR_RE.test(msg)) msg = 'Could not reach ChatGPT. Check your connection and try again.';
    (signedIn ? signOutChatGPT() : Promise.resolve()).then(function () {
      renderPills();
      signInBtnEl.disabled = false;
      setSigninStatus(msg, 'err');
    });
  });
});

// The worker clears the sign-in if ChatGPT revokes it — keep the page
// honest while it's open.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes[CHATGPT_AUTH_KEY]) return;
  state.chatgptAuth = changes[CHATGPT_AUTH_KEY].newValue || {};
  if (state.provider === 'chatgpt' && flow.mode === 'connected' && !hasSavedKey('chatgpt')) {
    flow.mode = 'paste';
    renderFlow();
  } else {
    renderPills();
  }
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
var fbToggleEl = document.getElementById('fbToggle');
var fbFormEl = document.getElementById('fbForm');

fbToggleEl.addEventListener('click', function () {
  var open = fbFormEl.hidden;
  fbFormEl.hidden = !open;
  fbToggleEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  fbToggleEl.textContent = open ? 'Close' : 'Write feedback';
  if (open) fbMessageEl.focus();
});

chrome.storage.local.get('sfnavOptions', function (data) {
  var opts = (data && data.sfnavOptions) || {};
  var saved = (opts.skipper && opts.skipper.email) || opts.feedbackEmail || '';
  if (saved && fbEmailEl && !fbEmailEl.value) fbEmailEl.value = saved;
});

function setFbStatus(text, kind) {
  if (!fbStatusEl) return;
  fbStatusEl.textContent = text || '';
  fbStatusEl.className = 'st' + (kind ? ' ' + kind : '');
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
