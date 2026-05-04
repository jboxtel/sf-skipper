var ANTHROPIC_TIMEOUT_MS = 30000;

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

async function handleSoqlGenerate(req, sendResponse) {
  try {
    const { sfnavOptions } = await chrome.storage.local.get('sfnavOptions');
    const opts = sfnavOptions || {};
    if (!opts.anthropicApiKey) {
      sendResponse({ ok: false, error: 'No API key configured. Open the extension Options and paste your Anthropic key.' });
      return;
    }
    const model = opts.model || 'claude-haiku-4-5-20251001';
    if (opts.debug) {
      console.log('sfnav: calling Anthropic', { model: model, systemLen: (req.system||'').length, userLen: (req.user||'').length });
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
          max_tokens: 1024,
          system: req.system,
          messages: [{ role: 'user', content: req.user }]
        }),
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
    let body;
    try { body = JSON.parse(raw); } catch (_) { body = null; }
    if (!res.ok) {
      if (opts.debug) console.warn('sfnav: Anthropic error', res.status, raw);
      const msg = (body && body.error && body.error.message) || raw || ('HTTP ' + res.status);
      sendResponse({ ok: false, error: msg });
      return;
    }
    const text = (body && body.content && body.content[0] && body.content[0].text) || '';
    if (opts.debug) console.log('sfnav: Anthropic ok', { textLen: text.length });
    sendResponse({ ok: true, text: text });
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
      files: ['salesforce-urls.js', 'shared.js', 'objects.js', 'flows.js', 'apps.js', 'flow-debug.js', 'commands.js', 'soql.js', 'content.js'],
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
