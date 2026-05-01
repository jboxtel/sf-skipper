var apiKeyEl = document.getElementById('apiKey');
var modelEl = document.getElementById('model');
var saveEl = document.getElementById('save');
var testEl = document.getElementById('test');
var statusEl = document.getElementById('status');

chrome.storage.local.get('sfnavOptions', function (data) {
  var opts = data.sfnavOptions || {};
  if (opts.anthropicApiKey) apiKeyEl.value = opts.anthropicApiKey;
  if (opts.model) modelEl.value = opts.model;
});

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

saveEl.addEventListener('click', function () {
  var opts = {
    anthropicApiKey: apiKeyEl.value.trim(),
    model: modelEl.value
  };
  chrome.storage.local.set({ sfnavOptions: opts }, function () {
    setStatus('Saved', 'ok');
    setTimeout(function () { setStatus(''); }, 1800);
  });
});

testEl.addEventListener('click', async function () {
  var key = apiKeyEl.value.trim();
  if (!key) { setStatus('Enter an API key first', 'err'); return; }

  // Persist before testing so the background uses the latest value
  await new Promise(function (resolve) {
    chrome.storage.local.set({
      sfnavOptions: { anthropicApiKey: key, model: modelEl.value }
    }, resolve);
  });

  setStatus('Testing…', 'loading');
  chrome.runtime.sendMessage(
    {
      type: 'soql.generate',
      system: 'Reply with exactly the word "ok" and nothing else.',
      user: 'ping'
    },
    function (resp) {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message, 'err');
        return;
      }
      if (!resp) { setStatus('No response from background', 'err'); return; }
      if (!resp.ok) { setStatus('Failed: ' + resp.error, 'err'); return; }
      setStatus('Connected — model replied: ' + (resp.text || '').trim().slice(0, 60), 'ok');
    }
  );
});
