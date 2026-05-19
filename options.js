var apiKeyEl = document.getElementById('apiKey');
var modelEl = document.getElementById('model');
var openInEl = document.getElementById('openIn');
var saveEl = document.getElementById('save');
var testEl = document.getElementById('test');
var statusEl = document.getElementById('status');
var replayEl = document.getElementById('replayWalkthrough');
var walkStatusEl = document.getElementById('walkthroughStatus');

var SF_HOST_RE = /^https:\/\/[^/]+\.(lightning\.force\.com|salesforce\.com|salesforce-setup\.com|force\.com)\//;

chrome.storage.local.get('sfnavOptions', function (data) {
  var opts = data.sfnavOptions || {};
  if (opts.anthropicApiKey) apiKeyEl.value = opts.anthropicApiKey;
  if (opts.model) modelEl.value = opts.model;
  openInEl.value = opts.openInNewTab === false ? 'same' : 'new';
});

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

function setWalkStatus(text, kind) {
  walkStatusEl.textContent = text;
  walkStatusEl.className = kind || '';
}

function mergeOptions(patch) {
  return new Promise(function (resolve) {
    chrome.storage.local.get('sfnavOptions', function (data) {
      var next = Object.assign({}, data.sfnavOptions || {}, patch);
      chrome.storage.local.set({ sfnavOptions: next }, function () { resolve(next); });
    });
  });
}

saveEl.addEventListener('click', function () {
  mergeOptions({
    anthropicApiKey: apiKeyEl.value.trim(),
    model: modelEl.value,
    openInNewTab: openInEl.value !== 'same'
  }).then(function () {
    setStatus('Saved', 'ok');
    setTimeout(function () { setStatus(''); }, 1800);
  });
});

testEl.addEventListener('click', async function () {
  var key = apiKeyEl.value.trim();
  if (!key) { setStatus('Enter an API key first', 'err'); return; }

  await mergeOptions({ anthropicApiKey: key, model: modelEl.value });

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
