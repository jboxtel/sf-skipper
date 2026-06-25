(() => {
  const SF_HOST_RE = /^https:\/\/[^/]+\.(lightning\.force\.com|salesforce\.com|salesforce-setup\.com|force\.com)\//;

  const kbdEl = document.getElementById('kbd');
  const isMac = /Mac/i.test(navigator.platform);
  if (kbdEl && typeof sfnavPaletteShortcut === 'function') {
    kbdEl.textContent = sfnavPaletteShortcut();
  }

  chrome.commands.getAll((commands) => {
    const cmd = commands.find(c => c.name === 'open-palette');
    if (cmd && !cmd.shortcut) {
      if (kbdEl) {
        kbdEl.textContent = 'Not set';
        kbdEl.classList.add('warn');
      }
      showNote('No shortcut set — go to chrome://extensions/shortcuts to assign ' + (isMac ? '⌘⇧K' : 'Ctrl+Shift+K') + '.', true);
    }
  });

  const noteEl = document.getElementById('note');
  const paletteBtn = document.getElementById('openPalette');

  function showNote(text, warn) {
    noteEl.textContent = text;
    noteEl.classList.toggle('warn', !!warn);
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
