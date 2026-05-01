// Look up the `sid` cookie for the requested Salesforce host. The cookie is
// HttpOnly, so the page can't read it directly — it has to ask us.
// Fallback: if no sid is set on my.salesforce.com directly, scan *.salesforce.com
// for a cookie whose value starts with the same orgId prefix (the inspector trick).
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req && req.type === 'getSession' && req.sfHost) {
    chrome.cookies.get({ url: 'https://' + req.sfHost, name: 'sid' }, (primary) => {
      if (primary && primary.value) {
        sendResponse({ sid: primary.value, hostname: primary.domain });
        return;
      }
      chrome.cookies.getAll({ name: 'sid', domain: 'salesforce.com', secure: true }, (cookies) => {
        var match = (cookies || []).find(c => c.domain && c.domain !== 'help.salesforce.com');
        sendResponse(match ? { sid: match.value, hostname: match.domain } : null);
      });
    });
    return true;
  }

  if (req && req.type === 'soql.generate') {
    (async () => {
      try {
        const { sfnavOptions } = await chrome.storage.local.get('sfnavOptions');
        const opts = sfnavOptions || {};
        if (!opts.anthropicApiKey) {
          console.warn('sfnav: no API key configured');
          sendResponse({ ok: false, error: 'No API key configured. Open the extension Options and paste your Anthropic key.' });
          return;
        }
        const model = opts.model || 'claude-haiku-4-5-20251001';
        console.log('sfnav: calling Anthropic', { model: model, systemLen: (req.system||'').length, userLen: (req.user||'').length });
        const res = await fetch('https://api.anthropic.com/v1/messages', {
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
          })
        });
        const raw = await res.text();
        let body;
        try { body = JSON.parse(raw); } catch (_) { body = null; }
        if (!res.ok) {
          console.warn('sfnav: Anthropic error', res.status, raw);
          const msg = (body && body.error && body.error.message) || raw || ('HTTP ' + res.status);
          sendResponse({ ok: false, error: msg });
          return;
        }
        const text = (body && body.content && body.content[0] && body.content[0].text) || '';
        console.log('sfnav: Anthropic ok', { textLen: text.length });
        sendResponse({ ok: true, text: text });
      } catch (err) {
        console.error('sfnav: Anthropic call threw', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
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
      files: ['objects.js', 'flows.js', 'salesforce-urls.js', 'commands.js', 'soql.js', 'content.js'],
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
