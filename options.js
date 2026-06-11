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
    keyUrl: 'https://aistudio.google.com/apikey',
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
    keyUrl: 'https://console.anthropic.com/settings/keys',
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
    keyUrl: 'https://platform.openai.com/api-keys',
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

var providerSelectEl = document.getElementById('providerSelect');
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

var planTitleEl   = document.getElementById('planTitle');
var activePillEl  = document.getElementById('activePill');
var segFreeEl     = document.getElementById('segFree');
var segByokEl     = document.getElementById('segByok');
var freePaneEl    = document.getElementById('freePane');
var byokPaneEl    = document.getElementById('byokPane');
var quotaMeterEl  = document.getElementById('quotaMeter');
var quotaUsedLblEl = document.getElementById('quotaUsedLbl');
var quotaLeftLblEl = document.getElementById('quotaLeftLbl');
var freeHintEl    = document.getElementById('freeHint');
var freeActionsEl = document.getElementById('freeActions');
var switchFreeEl  = document.getElementById('switchFree');
var freeStatusEl  = document.getElementById('freeStatus');
var keyHintTextEl = document.getElementById('keyHintText');
var keyDocsLinkEl = document.getElementById('keyDocsLink');

var openInToggleEl   = document.getElementById('openInToggle');
var shortcutRowEl    = document.getElementById('shortcutRow');
var walkthroughRowEl = document.getElementById('walkthroughRow');
var walkSubEl        = document.getElementById('walkSub');
var versionEl        = document.getElementById('version');

var state = {
  provider: 'gemini',
  providers: { gemini: {}, anthropic: {}, openai: {} },
  openInNewTab: true,
  skipper: null,
  // 'free' | 'byok' | undefined. Explicit 'free' routes through the proxy even
  // when a key is stored (the key is kept so switching back needs no re-paste).
  // Undefined = legacy installs: key wins, else free when signed in.
  plan: undefined
};

// Which segment the user is looking at — independent of what's active.
// The header/pill derive only from saved state; this only picks the pane.
var viewedSegment = 'free';

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
  state.plan = opts.plan;

  viewedSegment = activePlanKind() === 'byok' ? 'byok' : 'free';
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
    state.plan = newOpts.plan;
    renderPlanUI();
  });
}

// Pull a fresh quota snapshot when the Options page opens. Header-driven
// cache on proxy responses keeps the count live during a session; this is
// the cold-start path.
var SKIPPER_BACKEND_URL = 'http://localhost:3000';
function refreshSkipperQuota() {
  var skipper = state.skipper || {};
  if (!skipper.accessToken) return;
  // Skip only when BYOK is the active plan — a stashed key with plan='free'
  // still needs fresh numbers for the quota meter.
  if (activePlanKind() === 'byok') return;
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

// ─── Plan switcher rendering ────────────────────────────────────────────────
//
// Two independent pieces of state:
//   activePlanKind()  what's saved and powering requests — drives the header
//                     title, subtitle, and the green Active pill
//   viewedSegment     which pane the user is looking at — drives panes only
// Typing a key or switching segments must never move the pill; only a
// successful Save-and-test (or "Switch to Skipper Free") changes the header.

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isSignedIn() {
  return !!(state.skipper && state.skipper.accessToken);
}

function activePlanKind() {
  if (state.plan === 'free') return isSignedIn() ? 'free' : 'none';
  var entry = state.providers[state.provider] || {};
  if (entry.apiKey) return 'byok';
  if (isSignedIn()) return 'free';
  return 'none';
}

// First of next month, UTC — quota periods are UTC months on the backend.
function quotaResetLabel() {
  var d = new Date();
  var next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function modelLabelFor(providerName, modelId) {
  var p = PROVIDERS[providerName];
  var meta = p.models.find(function (m) { return m.id === modelId; });
  return meta ? meta.label.split(' (')[0] : modelId;
}

function renderHeader() {
  var kind = activePlanKind();
  if (kind === 'byok') {
    var p = PROVIDERS[state.provider];
    var entry = state.providers[state.provider] || {};
    planTitleEl.textContent = p.productName;
    providerSummaryEl.textContent =
      modelLabelFor(state.provider, entry.model || p.defaultModel) + ' · your ' + p.label + ' key';
    activePillEl.hidden = false;
  } else if (kind === 'free') {
    planTitleEl.textContent = 'Skipper Free';
    providerSummaryEl.textContent = 'Haiku 4.5 · powers @soql and @debug';
    activePillEl.hidden = false;
  } else {
    planTitleEl.textContent = 'AI provider';
    providerSummaryEl.textContent = 'Not configured';
    activePillEl.hidden = true;
  }
}

function renderSegments() {
  segFreeEl.setAttribute('aria-pressed', viewedSegment === 'free' ? 'true' : 'false');
  segByokEl.setAttribute('aria-pressed', viewedSegment === 'byok' ? 'true' : 'false');
  freePaneEl.hidden = viewedSegment !== 'free';
  byokPaneEl.hidden = viewedSegment !== 'byok';
}

function renderFreePane() {
  var quota = (state.skipper && state.skipper.quota && state.skipper.quota.soql) || null;
  var limit = (quota && quota.limit) || 20;
  var remaining = quota ? quota.remaining : null;
  var used = remaining === null ? 0 : Math.max(0, limit - remaining);

  quotaMeterEl.innerHTML = '';
  for (var i = 0; i < limit; i++) {
    var segSpan = document.createElement('span');
    if (isSignedIn() && i < used) segSpan.className = 'on';
    quotaMeterEl.appendChild(segSpan);
  }

  if (!isSignedIn()) {
    quotaMeterEl.setAttribute('aria-label', 'Skipper Free quota — sign in to activate');
    quotaUsedLblEl.textContent = '—';
    quotaLeftLblEl.textContent = limit + ' @soql/mo after sign-in';
    freeHintEl.innerHTML = 'Sign in under <strong>Account</strong> above to activate Skipper Free — no API key needed.';
    freeActionsEl.hidden = true;
    return;
  }

  quotaMeterEl.setAttribute('aria-label', used + ' of ' + limit + ' free @soql requests used this month');
  quotaUsedLblEl.textContent = remaining === null ? '— used' : used + ' used';
  quotaLeftLblEl.textContent = remaining === null
    ? 'resets ' + quotaResetLabel()
    : remaining + ' left · resets ' + quotaResetLabel();

  var debugQ = state.skipper.quota && state.skipper.quota.debug;
  var debugBit = debugQ && typeof debugQ.remaining === 'number'
    ? '@debug has its own pool (' + debugQ.remaining + '/' + debugQ.limit + ' left). '
    : '@debug has its own monthly pool. ';
  freeHintEl.textContent = '@soql runs on Claude Haiku 4.5 through Skipper. ' + debugBit + '@ask needs your own key.';

  // The switch button is the action; selecting this segment is just looking.
  freeActionsEl.hidden = activePlanKind() !== 'byok';
}

function renderByokPane() {
  providerSelectEl.value = state.provider;
  var p = PROVIDERS[state.provider];

  if (p.note) { noteEl.textContent = p.note; noteEl.hidden = false; }
  else { noteEl.hidden = true; }

  keyLabelEl.textContent = p.keyLabel;
  apiKeyEl.placeholder = p.keyPlaceholder;
  apiKeyEl.value = (state.providers[state.provider] && state.providers[state.provider].apiKey) || '';
  apiKeyEl.type = 'password';
  eyeShowEl.hidden = false;
  eyeHideEl.hidden = true;
  validateKeyFormat();

  keyHintTextEl.textContent = 'Stored only in this browser, sent only to ' + p.label + '.';
  keyDocsLinkEl.href = p.keyUrl;

  modelEl.innerHTML = '';
  p.models.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    modelEl.appendChild(opt);
  });
  var savedModel = (state.providers[state.provider] && state.providers[state.provider].model) || p.defaultModel;
  modelEl.value = savedModel;

  saveEl.disabled = !apiKeyEl.value.trim();
}

function renderPlanUI() {
  renderHeader();
  renderSegments();
  renderFreePane();
}

function renderProvider() {
  renderByokPane();
  renderPlanUI();
  setStatus('');
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

// ─── Plan switcher event handlers ───────────────────────────────────────────

function selectSegment(seg) {
  if (seg === viewedSegment) return;
  viewedSegment = seg;
  setMsg(freeStatusEl, '');
  setStatus('');
  renderPlanUI();
}

segFreeEl.addEventListener('click', function () { selectSegment('free'); });
segByokEl.addEventListener('click', function () { selectSegment('byok'); });

// Arrow keys move between the two segments (and focus follows).
document.getElementById('planSeg').addEventListener('keydown', function (e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  var next = e.key === 'ArrowLeft' ? 'free' : 'byok';
  selectSegment(next);
  (next === 'free' ? segFreeEl : segByokEl).focus();
});

switchFreeEl.addEventListener('click', async function (e) {
  e.stopPropagation();
  if (!isSignedIn()) return;
  // Keep the stored key — only the routing flag changes, so switching back
  // to BYOK doesn't require re-pasting.
  state.plan = 'free';
  await mergeOptions({ plan: 'free' });
  setMsg(freeStatusEl, 'Switched — Skipper Free is active.', 'ok');
  renderPlanUI();
});

apiKeyEl.addEventListener('input', function () {
  validateKeyFormat();
  saveEl.disabled = !apiKeyEl.value.trim();
});

revealEl.addEventListener('click', function (e) {
  e.stopPropagation();
  var hidden = apiKeyEl.type === 'password';
  apiKeyEl.type = hidden ? 'text' : 'password';
  eyeShowEl.hidden = hidden;
  eyeHideEl.hidden = !hidden;
});

providerSelectEl.addEventListener('change', function () {
  var name = providerSelectEl.value;
  if (!name || name === state.provider) return;
  // Stash the in-flight key for the previous provider so switching back
  // doesn't lose what the user typed. In-memory only — nothing persists
  // until Save and test succeeds.
  state.providers[state.provider] = state.providers[state.provider] || {};
  state.providers[state.provider].apiKey = apiKeyEl.value.trim();
  state.providers[state.provider].model = modelEl.value;
  state.provider = name;
  renderByokPane();
  setStatus('');
});

function friendlyTestError(message) {
  var m = String(message || '');
  if (/401|invalid|unauthorized|authentication|api key/i.test(m)) return 'Invalid key.';
  if (/network|fetch|timed? ?out|failed to/i.test(m)) return 'Network error — retry.';
  return 'Failed: ' + m;
}

saveEl.addEventListener('click', function (e) {
  e.stopPropagation();
  var key = apiKeyEl.value.trim();
  if (!key) return;

  // Test with a transient opts override; storage (and therefore the Active
  // pill and routing) only changes after the test succeeds.
  var candidate = Object.assign({}, state.providers);
  candidate[state.provider] = { apiKey: key, model: modelEl.value };

  saveEl.disabled = true;
  setStatus('Testing…', 'loading');
  chrome.runtime.sendMessage(
    { type: 'provider.test', opts: { provider: state.provider, providers: candidate } },
    async function (resp) {
      saveEl.disabled = !apiKeyEl.value.trim();
      if (chrome.runtime.lastError) { setStatus('Network error — retry.', 'err'); return; }
      if (!resp) { setStatus('Network error — retry.', 'err'); return; }
      if (!resp.ok) { setStatus(friendlyTestError(resp.error), 'err'); return; }

      state.providers = candidate;
      state.plan = 'byok';
      await mergeOptions({ provider: state.provider, providers: state.providers, plan: 'byok' });
      setStatus('✓ Connected — Skipper is now using ' + PROVIDERS[state.provider].productName + '.', 'ok');
      renderPlanUI();
    }
  );
});

modelEl.addEventListener('change', function () {
  state.providers[state.provider] = state.providers[state.provider] || {};
  state.providers[state.provider].model = modelEl.value;
  // If this provider's key is already saved and active, persist the model
  // change directly — re-testing the same key for a model swap is noise.
  if (activePlanKind() === 'byok' && state.providers[state.provider].apiKey) {
    mergeOptions({ providers: state.providers });
  }
  renderPlanUI();
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
    // Supabase email-OTP length is a dashboard setting (6-10 digits) — don't
    // assume 6 or a longer code gets silently truncated and always fails.
    if (!/^\d{6,10}$/.test(code)) {
      setMsg(acctCodeStatusEl, 'Enter the code from the email.', 'err');
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
