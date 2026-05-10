// Drive the unpacked extension in a real Chromium against a real Salesforce org.
//
// Login (interactive — only needed if you don't have .sf-credentials):
//   node debug.js login <salesforce-url>
//     Opens Chromium with the extension loaded. Log into Salesforce manually,
//     then close the window. Session persists in ./.playwright-profile/.
//
// Probe a single command:
//   node debug.js probe <salesforce-url> [--keyword=label]
//     Auto-logs in via .sf-credentials, opens the palette, types @<keyword>,
//     presses Enter, and dumps the resulting palette state as JSON.
//
// Stay open for manual poking:
//   node debug.js shell <salesforce-url>
//     Auto-logs in, then leaves the browser open. Ctrl+C / close window to exit.

const {
  launchContext,
  attachLogging,
  gotoApp,
  openPalette,
  readPalette,
  typeAndEnter,
} = require('./e2e-helpers');

const cmd = process.argv[2];
const url = process.argv[3];
const flags = Object.fromEntries(
  process.argv.slice(4).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

if (!cmd || !url) {
  console.error('Usage: node debug.js <login|probe|shell> <salesforce-url> [--keyword=label]');
  process.exit(1);
}

(async () => {
  const ctx = await launchContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  attachLogging(page, { filter: /sfnav|label|tooling|ExternalString|Custom Label/i });

  if (cmd === 'login') {
    console.log('Navigating — log into Salesforce in the opened window, then close it.');
    await page.goto(url);
    await ctx.waitForEvent('close', { timeout: 0 });
    return;
  }

  if (cmd === 'shell') {
    await gotoApp(page, url);
    console.log('Browser open. Ctrl+C / close window to exit.');
    await ctx.waitForEvent('close', { timeout: 0 });
    return;
  }

  if (cmd === 'probe') {
    const keyword = flags.keyword || 'label';
    await gotoApp(page, url);
    if (!(await openPalette(page))) {
      console.error('Palette never opened. Content script likely not injected. URL:', page.url());
      await ctx.close();
      process.exit(2);
    }
    await typeAndEnter(page, `@${keyword}`);
    await page.waitForTimeout(2000); // let the data fetch settle

    const state = await readPalette(page);
    console.log('\n=== probe result ===');
    console.log(JSON.stringify(state, null, 2));
    await ctx.close();
    return;
  }

  console.error('Unknown command:', cmd);
  process.exit(1);
})();
