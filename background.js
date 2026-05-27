// LLM provider adapters — translation between Anthropic-shaped requests and
// OpenAI/Gemini. Loaded as a classic worker so importScripts is available.
importScripts('providers.js');

// Skipper backend base URL. Same constant exists in shared.js / options.js.
var SKIPPER_BACKEND_URL = 'http://localhost:3000';

// Look up the `sid` cookie for the requested Salesforce host. Cookie is
// HttpOnly so the page can't read it directly. If the exact host has no
// cookie, fall back to a sibling host with the same MyDomain prefix (e.g.
// caller asked about foo.lightning.force.com but the sid is on
// foo.my.salesforce.com). The fallback is constrained to the leftmost
// subdomain so a user logged into multiple orgs/sandboxes can never have
// Org A's sid returned for a request scoped to Org B.
function handleGetSession(req, sendResponse) {
  chrome.cookies.get({ url: 'https://' + req.sfHost, name: 'sid' }, function (primary) {
    if (primary && primary.value) {
      sendResponse({ sid: primary.value, hostname: primary.domain });
      return;
    }
    var wanted = leftmostSubdomain(req.sfHost);
    if (!wanted) { sendResponse(null); return; }
    chrome.cookies.getAll({ name: 'sid', secure: true }, function (cookies) {
      var match = (cookies || []).find(function (c) {
        if (!c.domain) return false;
        return leftmostSubdomain(c.domain.replace(/^\./, '')) === wanted;
      });
      sendResponse(match ? { sid: match.value, hostname: match.domain } : null);
    });
  });
}

// Leftmost subdomain identifies the org+environment uniquely on Salesforce:
// production "foo.my.salesforce.com" and its Lightning host
// "foo.lightning.force.com" share "foo"; sandbox "foo--qa.my.salesforce.com"
// is treated as a different MyDomain ("foo--qa") and never matches "foo".
function leftmostSubdomain(host) {
  var parts = String(host || '').toLowerCase().split('.');
  if (parts.length < 3) return null;
  var sub = parts[0];
  if (!sub || sub === 'help' || sub === 'login' || sub === 'www') return null;
  return sub;
}

async function loadOpts() {
  var data = await chrome.storage.local.get('sfnavOptions');
  return data.sfnavOptions || {};
}

// Single-shot helper preserving the existing soql.generate contract: caller
// sends system + user text (optional tools + toolChoice for structured output);
// background returns { text, toolInput }.
async function handleSoqlGenerate(req, sendResponse) {
  try {
    var opts = await loadOpts();
    var system = req.system;
    if (req.cacheSystem && typeof system === 'string') {
      system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    var body = {
      system: system,
      messages: [{ role: 'user', content: req.user }],
      max_tokens: 1024
    };
    if (req.tools && req.tools.length) body.tools = req.tools;
    if (req.toolChoice) body.tool_choice = req.toolChoice;

    var resp = await providerMessageStep(opts, body);
    var textBlock = (resp.content || []).find(function (b) { return b.type === 'text'; });
    var toolBlock = (resp.content || []).find(function (b) { return b.type === 'tool_use'; });
    sendResponse({
      ok: true,
      text: (textBlock && textBlock.text) || '',
      toolInput: (toolBlock && toolBlock.input) || null
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      sendResponse({ ok: false, error: 'Request timed out' });
      return;
    }
    console.error('sfnav: provider call threw', err);
    sendResponse({ ok: false, error: err.message });
  }
}

// Capture the visible viewport of the sender's tab and return as base64.
// Done in the background because chrome.tabs.captureVisibleTab is not exposed
// to content scripts. The content script is expected to hide the palette
// overlay before sending this message so the screenshot is clean.
function handleCaptureVisibleTab(sender, sendResponse) {
  const windowId = sender && sender.tab && sender.tab.windowId;
  const cb = function (dataUrl) {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    if (!dataUrl) {
      sendResponse({ ok: false, error: 'Empty capture' });
      return;
    }
    // dataUrl is "data:image/jpeg;base64,XXX" — strip the prefix for the API
    const comma = dataUrl.indexOf(',');
    const mediaMatch = dataUrl.match(/^data:([^;]+);base64,/);
    sendResponse({
      ok: true,
      mediaType: mediaMatch ? mediaMatch[1] : 'image/jpeg',
      data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    });
  };
  const opts = { format: 'jpeg', quality: 80 };
  if (typeof windowId === 'number') {
    chrome.tabs.captureVisibleTab(windowId, opts, cb);
  } else {
    chrome.tabs.captureVisibleTab(opts, cb);
  }
}

// Generic Messages API transport for the agentic @ask loop. The content script
// supplies the full Anthropic-shaped request body (system, messages, tools,
// max_tokens, optional model override); providers.js translates to the active
// backend and normalizes the response back to Anthropic shape so ask.js stays
// provider-agnostic.
async function handleAskMessageStep(req, sendResponse) {
  try {
    var opts = await loadOpts();
    var body = Object.assign({}, req.body || {});
    var resp = await providerMessageStep(opts, body);
    // ask.js expects { content, stop_reason } under .response
    sendResponse({ ok: true, response: resp });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      sendResponse({ ok: false, error: 'Request timed out' });
      return;
    }
    console.error('sfnav: provider call threw', err);
    sendResponse({ ok: false, error: err.message });
  }
}

// Phase 2 stub: forward the system+user prompt to the Skipper backend's
// /api/echo endpoint, just to prove the JWT-authenticated pipe works end to
// end. In Phase 4 this is replaced by feature-specific routes (/ai/soql,
// /ai/debug, /ai/ask).
async function handleSkipperRoutedClaude(req, sendResponse) {
  try {
    var opts = await loadOpts();
    if (!opts.skipperJwt) {
      sendResponse({ ok: false, error: 'Not signed in to Skipper' });
      return;
    }
    var resp = await fetch(SKIPPER_BACKEND_URL + '/api/echo', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + opts.skipperJwt,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system: req.system,
        user: req.user,
        feature: req.feature
      })
    });
    if (resp.status === 401) {
      sendResponse({ ok: false, error: 'Skipper session expired — sign in again', authExpired: true });
      return;
    }
    if (!resp.ok) {
      var errText = await resp.text();
      sendResponse({ ok: false, error: 'Skipper backend ' + resp.status + ': ' + errText });
      return;
    }
    var data = await resp.json();
    sendResponse({ ok: true, echoed: data.echoed, userId: data.userId, email: data.email });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleProviderTest(req, sendResponse) {
  try {
    // Caller may pass a transient opts override so the user can test without
    // having to Save first. Fall back to stored options.
    var opts = req.opts || (await loadOpts());
    var result = await providerTestCall(opts);
    sendResponse({ ok: true, provider: result.provider, model: result.model, text: result.text });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

chrome.runtime.onMessage.addListener(function (req, sender, sendResponse) {
  if (!req || !req.type) {
    sendResponse({ ok: false, error: 'Missing message type' });
    return false;
  }
  if (req.type === 'getSession' && req.sfHost) {
    handleGetSession(req, sendResponse);
    return true;
  }
  if (req.type === 'soql.generate') {
    handleSoqlGenerate(req, sendResponse);
    return true;
  }
  if (req.type === 'ask.captureVisibleTab') {
    handleCaptureVisibleTab(sender, sendResponse);
    return true;
  }
  if (req.type === 'ask.messageStep') {
    handleAskMessageStep(req, sendResponse);
    return true;
  }
  if (req.type === 'provider.test') {
    handleProviderTest(req, sendResponse);
    return true;
  }
  if (req.type === 'skipper.routedClaude') {
    handleSkipperRoutedClaude(req, sendResponse);
    return true;
  }
  if (req.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (req.type === 'openPalette') {
    const resolveTab = req.tabId
      ? new Promise((resolve) => chrome.tabs.get(req.tabId, (t) => resolve(chrome.runtime.lastError ? null : t)))
      : Promise.resolve(null);
    resolveTab.then((tab) => openPaletteInTab(tab)).then(
      (status) => sendResponse({ ok: true, status }),
      (err) => sendResponse({ ok: false, error: err && err.message })
    );
    return true;
  }
  sendResponse({ ok: false, error: 'Unknown message type: ' + req.type });
  return false;
});

const SF_HOST_RE = /^https:\/\/[^/]+\.(lightning\.force\.com|salesforce\.com|salesforce-setup\.com|force\.com)\//;

async function openPaletteInTab(tab) {
  if (!tab) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  }
  if (!tab) return 'no_tab';
  if (!tab.url || !SF_HOST_RE.test(tab.url)) return 'not_salesforce';

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => {
        if (typeof window.__sfnavToggle === 'function') {
          window.__sfnavToggle();
          return 'ok';
        }
        return 'not_loaded';
      },
    });

    if (result === 'ok') return 'toggled';

    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      files: ['salesforce-urls.js', 'shared.js', 'cache-factory.js', 'objects.js', 'cmdt.js', 'flows.js', 'apps.js', 'labels.js', 'permsets.js', 'flow-debug.js', 'commands.js', 'soql.js', 'ask.js', 'markdown.js', 'onboarding.js', 'content.js'],
    });
    await new Promise(r => setTimeout(r, 80));
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => { if (typeof window.__sfnavToggle === 'function') window.__sfnavToggle(); },
    });
    return 'injected';
  } catch (err) {
    console.error('sfnav:', err.message);
    return 'error';
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open-palette') return;
  openPaletteInTab(tab);
});
