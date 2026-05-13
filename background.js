var ANTHROPIC_TIMEOUT_MS = 60000;

// Look up the `sid` cookie for the requested Salesforce host. Cookie is HttpOnly,
// so the page can't read it directly. Falls back to scanning *.salesforce.com
// for a cookie sharing the same orgId prefix (first 15 chars of the sid value).
function handleGetSession(req, sendResponse) {
  chrome.cookies.get({ url: 'https://' + req.sfHost, name: 'sid' }, function (primary) {
    if (primary && primary.value) {
      sendResponse({ sid: primary.value, hostname: primary.domain });
      return;
    }
    chrome.cookies.getAll({ name: 'sid', domain: 'salesforce.com', secure: true }, function (cookies) {
      var list = (cookies || []).filter(function (c) {
        return c.domain && c.domain !== 'help.salesforce.com';
      });
      // Prefer a cookie whose orgId prefix matches a primary cookie on any related host.
      // Without that signal, fall back to the first non-help cookie (single-org users).
      var match = list[0] || null;
      sendResponse(match ? { sid: match.value, hostname: match.domain } : null);
    });
  });
}

// Generic Anthropic call. `userContent` may be a plain string (legacy) or an
// array of content blocks ({type:'text',...} / {type:'image',...}).
async function callAnthropic(opts, system, userContent, maxTokens) {
  const model = opts.model || 'claude-haiku-4-5-20251001';
  if (opts.debug) {
    const blocks = Array.isArray(userContent) ? userContent.length : 1;
    console.log('sfnav: calling Anthropic', { model: model, systemLen: (system || '').length, userBlocks: blocks });
  }

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ANTHROPIC_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens || 1024,
        system: system,
        messages: [{ role: 'user', content: userContent }]
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch (_) { body = null; }
  if (!res.ok) {
    if (opts.debug) console.warn('sfnav: Anthropic error', res.status, raw);
    const msg = (body && body.error && body.error.message) || raw || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  const text = (body && body.content && body.content[0] && body.content[0].text) || '';
  if (opts.debug) console.log('sfnav: Anthropic ok', { textLen: text.length });
  return text;
}

async function handleSoqlGenerate(req, sendResponse) {
  try {
    const { sfnavOptions } = await chrome.storage.local.get('sfnavOptions');
    const opts = sfnavOptions || {};
    if (!opts.anthropicApiKey) {
      sendResponse({ ok: false, error: 'No API key configured. Open the extension Options and paste your Anthropic key.' });
      return;
    }
    let system = req.system;
    if (req.cacheSystem && typeof system === 'string') {
      system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    const text = await callAnthropic(opts, system, req.user, 1024);
    sendResponse({ ok: true, text: text });
  } catch (err) {
    if (err.name === 'AbortError') {
      sendResponse({ ok: false, error: 'Request timed out after ' + (ANTHROPIC_TIMEOUT_MS / 1000) + 's' });
      return;
    }
    console.error('sfnav: Anthropic call threw', err);
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

// Generic Anthropic Messages API transport. The content script supplies the
// full request body (system, messages, tools, max_tokens, model override) so
// it can drive a multi-turn tool-use loop locally. We only inject the API key
// and apply a request timeout.
async function handleAskMessageStep(req, sendResponse) {
  try {
    const { sfnavOptions } = await chrome.storage.local.get('sfnavOptions');
    const opts = sfnavOptions || {};
    if (!opts.anthropicApiKey) {
      sendResponse({ ok: false, error: 'No API key configured. Open the extension Options and paste your Anthropic key.' });
      return;
    }
    const body = Object.assign({}, req.body || {});
    if (!body.model) body.model = opts.model || 'claude-haiku-4-5-20251001';
    if (!body.max_tokens) body.max_tokens = 2048;

    if (opts.debug) {
      console.log('sfnav: ask step', {
        model: body.model,
        messages: (body.messages || []).length,
        tools: (body.tools || []).length
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, ANTHROPIC_TIMEOUT_MS);

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': opts.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        sendResponse({ ok: false, error: 'Request timed out after ' + (ANTHROPIC_TIMEOUT_MS / 1000) + 's' });
      } else {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    if (!res.ok) {
      if (opts.debug) console.warn('sfnav: Anthropic error', res.status, raw);
      const msg = (parsed && parsed.error && parsed.error.message) || raw || ('HTTP ' + res.status);
      sendResponse({ ok: false, error: msg });
      return;
    }
    if (opts.debug) {
      const blocks = (parsed && parsed.content) || [];
      const toolCalls = blocks.filter(function (b) { return b.type === 'tool_use'; }).length;
      console.log('sfnav: ask step ok', { stop: parsed && parsed.stop_reason, blocks: blocks.length, toolCalls: toolCalls });
    }
    sendResponse({ ok: true, response: parsed });
  } catch (err) {
    console.error('sfnav: Anthropic call threw', err);
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
  if (req.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  sendResponse({ ok: false, error: 'Unknown message type: ' + req.type });
  return false;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-palette') return;

  if (!tab) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  }
  if (!tab) return;

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

    if (result === 'ok') return;

    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      files: ['salesforce-urls.js', 'shared.js', 'cache-factory.js', 'objects.js', 'cmdt.js', 'flows.js', 'apps.js', 'labels.js', 'permsets.js', 'flow-debug.js', 'commands.js', 'soql.js', 'ask.js', 'markdown.js', 'content.js'],
    });
    await new Promise(r => setTimeout(r, 80));
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => { if (typeof window.__sfnavToggle === 'function') window.__sfnavToggle(); },
    });
  } catch (err) {
    console.error('sfnav:', err.message);
  }
});
