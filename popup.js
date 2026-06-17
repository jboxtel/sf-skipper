(() => {
  const SF_HOST_RE = /^https:\/\/[^/]+\.(lightning\.force\.com|salesforce\.com|salesforce-setup\.com|force\.com)\//;

  const kbdEl = document.getElementById('kbd');
  if (kbdEl && typeof sfnavPaletteShortcut === 'function') {
    kbdEl.textContent = sfnavPaletteShortcut();
  }

  const noteEl = document.getElementById('note');
  const paletteBtn = document.getElementById('openPalette');

  function showNote(text) {
    noteEl.textContent = text;
    noteEl.classList.remove('hidden');
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    const onSf = tab && tab.url && SF_HOST_RE.test(tab.url);
    if (!onSf) {
      paletteBtn.disabled = true;
      showNote('Open a Salesforce tab to use the palette.');
    }
  });

  paletteBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'openPalette' }, () => window.close());
  });

  document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
})();
