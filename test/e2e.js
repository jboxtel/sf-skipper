// End-to-end tests of the unpacked extension in Chrome, driven by agent-browser.
// AGENTS.md covers setup and driving the extension by hand.
//
//   npm run e2e                   run the signed-out tests on the login page
//   npm run e2e -- signed-in      also sign in and run the org tests
//   npm run e2e -- open [url]     fresh browser with the extension, left open
//   npm run e2e -- login          sign in to the org in the open browser
//   npm run e2e -- otp <code>     submit Salesforce's emailed verification code
//   npm run e2e -- close          close the browser
//   npm run e2e -- id             print the extension ID
//   npm run e2e -- palette-state  print the palette's state as JSON, tour included
//   npm run e2e -- type <text>    open the palette (skipping the tour), type, print the state
//   npm run e2e -- storage [key]  print chrome.storage.local, API keys masked
//
// Signing in needs SF_URL, SF_USERNAME and SF_PASSWORD in .env.local. The
// login asks for the username, then the password on a second screen; login()
// handles both. A new browser profile makes Salesforce email a verification
// code to the org owner and the browser waits on that page. Submit it with
// `otp`, which ticks "don't ask again", so .e2e-browser-profile/ stays trusted
// until you delete it. Every attempt from an untrusted profile emails a fresh
// code: don't loop on it. agent-browser's auth vault doesn't fit, since it
// expects both fields on one screen.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(EXT, '.e2e-browser-profile');
const ENV_FILE = path.join(EXT, '.env.local');
const SESSION = 'skipper-e2e';
const DEFAULT_URL = 'https://login.salesforce.com';

// Chrome derives an unpacked extension's ID from its absolute path.
const EXT_ID = [...require('crypto').createHash('sha256').update(EXT).digest('hex').slice(0, 32)]
  .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

// Run one agent-browser command in our session and return its data payload.
// Throws on a failed command so callers don't have to check every step.
function ab(...args) {
  const res = spawnSync('agent-browser', ['--session', SESSION, '--json', ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`agent-browser not runnable: ${res.error.message}`);
  let out;
  try { out = JSON.parse(res.stdout.trim().split('\n').pop()); }
  catch { throw new Error(`agent-browser ${args[0]}: ${(res.stderr || res.stdout).trim()}`); }
  if (!out.success) throw new Error(`agent-browser ${args[0]}: ${out.error}`);
  return out.data;
}

function evaluate(js) {
  return ab('eval', js).result;
}

function launchArgs() {
  const args = ['--extension', EXT, '--profile', PROFILE];
  if (!process.env.HEADED) args.push('--args', '--headless=new');
  return args;
}

function launch(url) {
  // Launch without --json: agent-browser 0.38 fails to start the browser with it.
  const res = spawnSync('agent-browser', ['--session', SESSION, ...launchArgs(), 'open', url], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`agent-browser open: ${(res.stderr || res.stdout).trim()}`);
  ab('wait', '--load', 'domcontentloaded');
}

function openUrl(url) {
  ab('open', url);
  ab('wait', '--load', 'domcontentloaded');
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Poll a Node-side check for up to 10 s. Returns its first truthy result.
function until(fn) {
  for (let i = 0; i < 40; i++) {
    const v = fn();
    if (v) return v;
    sleep(250);
  }
  return null;
}

// Wait for a JS expression in the page to turn truthy. Returns false on timeout instead of throwing.
function waitFor(js) {
  try { ab('wait', '--fn', js); return true; } catch { return false; }
}

// The daemon takes a moment to exit after close. Launching before it's gone
// fails with "Failed to connect", so wait until the session is no longer listed.
function closeBrowser() {
  spawnSync('agent-browser', ['--session', SESSION, 'close'], { encoding: 'utf8' });
  until(() => {
    const list = spawnSync('agent-browser', ['session', 'list'], { encoding: 'utf8' }).stdout || '';
    return !list.split('\n').some(line => line.trim().replace(/^→\s*/, '') === SESSION);
  });
}

function onVerificationPage() {
  return ab('get', 'url').url.includes('/identity/verification/');
}

// Log in if Salesforce shows the login form. Returns 'ok' or 'verify'.
function login() {
  if (!evaluate("!!document.querySelector('#username')")) return 'ok';
  // Salesforce asks for the username first and shows #password on a second step.
  ab('fill', '#username', process.env.SF_USERNAME);
  ab('click', '#Login');
  ab('wait', '#password');
  ab('fill', '#password', process.env.SF_PASSWORD);
  ab('click', '#Login');
  ab('wait', '--fn', "!document.querySelector('#password')");
  ab('wait', '--load', 'domcontentloaded');
  if (onVerificationPage()) return 'verify';
  ab('wait', '--url', '**/lightning/**');
  return 'ok';
}

function requireCreds() {
  const missing = ['SF_URL', 'SF_USERNAME', 'SF_PASSWORD'].filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Put them in .env.local.`);
}

// Sign in within the open browser, launching one if there isn't any.
function signIn() {
  requireCreds();
  const open = spawnSync('agent-browser', ['--session', SESSION, 'get', 'url'], { encoding: 'utf8' }).status === 0;
  if (!open) launch(process.env.SF_URL);
  else if (!evaluate("!!document.querySelector('#username')")) openUrl(process.env.SF_URL);
  return login();
}

// ── Palette helpers ─────────────────────────────────────────────────────────
// The content script runs in an isolated world, so everything is read from the DOM.

const shown = id => `(e => !!e && e.style.display !== 'none')(document.getElementById('${id}'))`;
const PALETTE_VISIBLE = shown('sfnav-overlay');
const TOUR_VISIBLE = shown('sfnav-coachmark');

const PALETTE_STATE = `(() => {
  const get = id => document.getElementById(id);
  return {
    visible: ${PALETTE_VISIBLE},
    focused: document.activeElement?.id === 'sfnav-input',
    breadcrumb: get('sfnav-breadcrumb')?.textContent || '',
    hint: get('sfnav-hint')?.textContent || '',
    placeholder: get('sfnav-input')?.placeholder || '',
    // null unless the walkthrough is showing
    tour: !${TOUR_VISIBLE} ? null : {
      step: [...document.querySelectorAll('.sfnav-cm-dot')].findIndex(d => d.classList.contains('sfnav-cm-dot-on')) + 1,
      title: get('sfnav-cm-title')?.textContent || '',
    },
    items: [...document.querySelectorAll('.sfnav-item')].map(el => ({
      label: el.querySelector('.sfnav-label')?.textContent || '',
      sublabel: el.querySelector('.sfnav-sublabel')?.textContent || '',
      url: el.dataset.url || '',
      selected: el.classList.contains('selected'),
    })),
  };
})()`;

function palette() {
  return evaluate(PALETTE_STATE);
}

// Skip the first-run walkthrough if it shows. Onboarding reads storage after
// the palette opens, then starts the tour or marks the brand clickable.
function skipTour() {
  waitFor(`${TOUR_VISIBLE} || document.getElementById('sfnav-brand')?.classList.contains('sfnav-brand-clickable')`);
  if (evaluate(TOUR_VISIBLE)) clickEl('.sfnav-cm-skip');
}

// Open the palette with the shortcut, skipping the walkthrough.
function openPalette() {
  if (evaluate(PALETTE_VISIBLE)) return true;
  ab('press', 'Control+Shift+K');
  if (!waitFor(PALETTE_VISIBLE)) return false;
  skipTour();
  return true;
}

function closePalette() {
  for (let i = 0; i < 6 && evaluate(PALETTE_VISIBLE); i++) ab('press', 'Escape');
}

// Replace the palette input's text. The results re-render on the input event.
function type(text) {
  ab('fill', '#sfnav-input', text);
}

// Type an @keyword and press Enter to step into its picker.
function enter(keyword) {
  type(keyword);
  ab('press', 'Enter');
}

// Click an element through the DOM. agent-browser's click aims at coordinates,
// and the palette's footer can sit under the page's own layout.
function clickEl(sel) {
  const found = evaluate(`(el => (el?.click(), !!el))(document.querySelector(${JSON.stringify(sel)}))`);
  if (!found) throw new Error(`no element matches ${sel}`);
}

// Click the result row with this exact label.
function clickItem(label) {
  const clicked = evaluate(`(() => {
    const row = [...document.querySelectorAll('.sfnav-item')]
      .find(el => el.querySelector('.sfnav-label')?.textContent === ${JSON.stringify(label)});
    row?.click();
    return !!row;
  })()`);
  if (!clicked) throw new Error(`no row labelled "${label}"`);
}

// Turn the @export Labs flag on or off through @labs, whatever its current state.
function setExport(on) {
  enter('@labs');
  const want = on ? 'Turn on export' : 'Turn off export';
  if (palette().items.some(i => i.label === want)) clickItem(want);
  type('');
}

// ── Tab helpers ─────────────────────────────────────────────────────────────

const extPage = page => `chrome-extension://${EXT_ID}/${page}`;
let loginTab; // the tab the browser launched with

function tabs() {
  return ab('tab', 'list').tabs;
}

function newTab(label, url) {
  ab('tab', 'new', '--label', label, url);
  ab('wait', '--load', 'domcontentloaded');
}

// Close every tab but the login tab and switch back to it.
function backToLoginTab() {
  for (const t of tabs()) if (t.tabId !== loginTab) ab('tab', 'close', t.tabId);
  ab('tab', loginTab);
}

// ── Steps ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function step(label, fn) {
  let ok = false;
  let detail;
  try { ok = fn() !== false; } catch (err) { detail = err.message; }
  console.log(`  ${ok ? GREEN + '✓' : RED + '✗'}${RESET} ${label}`);
  if (!ok && detail) console.log(`    ${DIM}${detail}${RESET}`);
  ok ? passed++ : failed++;
  return ok;
}

function section(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

// ── Signed out: runs on the Salesforce login page ───────────────────────────

function signedOutTests() {
  section('Palette');

  step('Ctrl+Shift+K opens the palette', () => openPalette());
  step('input is focused', () => palette().focused);

  step('root menu lists every @ keyword', () => {
    const labels = palette().items.map(i => i.label);
    const need = ['@object', '@flow', '@app', '@cmd', '@label', '@permset', '@user', '@setup', '@ask', '@soql'];
    const missing = need.filter(n => !labels.includes(n));
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  });

  step('typing part of a keyword filters the shortcuts', () => {
    type('@la');
    const labels = palette().items.map(i => i.label);
    return labels.includes('@label') && !labels.includes('@object');
  });

  step('ArrowDown and ArrowUp move the selection', () => {
    type('');
    const selected = () => palette().items.findIndex(i => i.selected);
    const start = selected();
    ab('press', 'ArrowDown');
    if (selected() !== start + 1) throw new Error('ArrowDown did not move');
    ab('press', 'ArrowUp');
    return selected() === start;
  });

  step('plain search without @ lists the Account object', () => {
    type('account');
    return palette().items.some(i => i.label === 'Account');
  });

  step('a pasted record ID offers "Go to record"', () => {
    const id = '001000000000001AAA';
    type(id);
    const item = palette().items[0];
    return item?.sublabel === 'Go to record' && item.url.endsWith(`/lightning/r/${id}/view`);
  });

  step('@setup lists setup links', () => {
    enter('@setup');
    return palette().items.length >= 5;
  });

  step('filtering @setup by "user" narrows it', () => {
    const before = palette().items.length;
    type('user');
    const items = palette().items;
    return items.length > 0 && items.length < before && items.some(i => /user/i.test(i.label));
  });

  step('Backspace on an empty input steps back to the root', () => {
    type('');
    ab('press', 'Backspace');
    return palette().items.some(i => i.label === '@object');
  });

  step('Escape closes the palette', () => {
    closePalette();
    return !evaluate(PALETTE_VISIBLE);
  });

  // The standard objects ship with the extension, so @object works without an org.
  section('@object');

  step('@object lists at least 20 objects', () => {
    openPalette();
    enter('@object');
    return palette().items.length >= 20;
  });

  step('picking Account scopes the breadcrumb to it', () => {
    type('account');
    clickItem('Account');
    return /account/i.test(palette().breadcrumb);
  });

  step('Account offers Fields & Relationships', () =>
    palette().items.some(i => i.label === 'Fields & Relationships'
      && i.url.endsWith('/lightning/setup/ObjectManager/Account/FieldsAndRelationships/view')));

  step('filtering "val" puts Validation Rules first', () => {
    type('val');
    return palette().items[0]?.label === 'Validation Rules';
  });

  step('Escape steps back to the object picker, then the root', () => {
    ab('press', 'Escape');
    const picker = palette();
    if (!picker.breadcrumb.includes('@object') || /account/i.test(picker.breadcrumb)) throw new Error(`breadcrumb: ${picker.breadcrumb}`);
    ab('press', 'Escape');
    return palette().breadcrumb === '';
  });

  step('"@account fields" jumps straight to Account\'s fields', () => {
    type('@account fields');
    return /account/i.test(palette().breadcrumb) && palette().items[0]?.label === 'Fields & Relationships';
  });
  closePalette();

  section('AI without a key');

  step('@ask warns there is no key and links to Options', () => {
    openPalette();
    enter('@ask');
    return waitFor(`(el => /No API key/.test(el?.textContent) && !!el.querySelector('.sfnav-options-link'))
      (document.getElementById('sfnav-ask-keywarn'))`);
  });
  closePalette();

  step('@soql warns there is no key on submit', () => {
    openPalette();
    enter('@soql');
    type('all accounts');
    ab('press', 'Enter');
    return waitFor("/No API key/.test(document.getElementById('sfnav-soql-status')?.textContent)");
  });
  closePalette();

  step('@debug asks for a flow off Flow Builder', () => {
    openPalette();
    type('@debug');
    return /open a flow first/i.test(palette().hint);
  });
  closePalette();

  section('@export (Labs)');

  step('@export is hidden while its Labs flag is off', () => {
    openPalette();
    setExport(false);
    type('@export');
    return !palette().items.some(i => i.label === '@export');
  });

  step('@labs turns it on', () => {
    setExport(true);
    type('@export');
    return palette().items.some(i => i.label === '@export');
  });

  step('@export opens the editor, focused', () => {
    ab('press', 'Enter');
    return waitFor("document.activeElement?.id === 'sfnav-export-query'");
  });

  step('anything but SELECT is refused', () => {
    ab('fill', '#sfnav-export-query', 'DELETE FROM Account');
    ab('press', 'Control+Enter');
    return waitFor("/only select/i.test(document.getElementById('sfnav-export-status')?.textContent)");
  });

  step('Escape returns to the root', () => {
    ab('press', 'Escape');
    return palette().items.some(i => i.label === '@object');
  });
  closePalette();

  section('Footer');

  step('"help" opens the help panel', () => {
    openPalette();
    clickEl('#sfnav-brand');
    const open = waitFor("!!document.getElementById('sfnav-help-panel')?.offsetParent");
    clickEl('.sfnav-hp-close');
    return open;
  });

  step('"feedback" opens the feedback form', () => {
    clickEl('#sfnav-feedback-link');
    return waitFor("document.activeElement?.id === 'sfnav-feedback-message'");
  });
  closePalette();

  section('Walkthrough');

  const tourTitle = () => evaluate("document.getElementById('sfnav-cm-title')?.textContent || ''");

  // The help panel opens from the brand, which only works once the tour has been seen.
  function replayFromHelp() {
    clickEl('#sfnav-brand');
    if (!waitFor("!!document.getElementById('sfnav-help-panel')?.offsetParent")) throw new Error('help panel did not open');
    clickEl('.sfnav-hp-replay');
    return waitFor(TOUR_VISIBLE);
  }

  step("help panel's Replay starts the walkthrough", () => {
    openPalette();
    return replayFromHelp() && tourTitle() !== '';
  });

  step('Next and Back move between steps', () => {
    const first = tourTitle();
    clickEl('.sfnav-cm-next');
    const second = tourTitle();
    if (second === first) throw new Error('Next did not change the title');
    clickEl('.sfnav-cm-prev');
    return tourTitle() === first;
  });

  step('finishing shows the completion card', () => {
    for (let i = 0; i < 20 && evaluate(TOUR_VISIBLE); i++) clickEl('.sfnav-cm-next');
    return !evaluate(TOUR_VISIBLE) && waitFor(shown('sfnav-completion-card'));
  });

  step('Escape skips it and leaves the palette open', () => {
    clickEl('.sfnav-cc-dismiss');
    replayFromHelp();
    ab('press', 'Escape');
    return waitFor(`!${TOUR_VISIBLE}`) && evaluate(PALETTE_VISIBLE);
  });
  closePalette();

  section('Open links in');

  // @setup → "users" → Enter. Signed out, Salesforce redirects to the login page
  // with startURL=/lightning/setup/ManageUsers/home.
  function pickManageUsers() {
    openPalette();
    enter('@setup');
    type('users');
    ab('press', 'Enter');
  }
  const setOpenIn = value => {
    newTab('ext', extPage('options.html'));
    ab('select', '#openIn', value);
    backToLoginTab();
  };
  // The profile outlives a run, so drop the stored setting to get the default.
  const resetOpenIn = () => {
    newTab('ext', extPage('options.html'));
    evaluate(`new Promise(r => chrome.storage.local.get('sfnavOptions', ({ sfnavOptions: opts = {} }) => {
      delete opts.openInNewTab;
      chrome.storage.local.set({ sfnavOptions: opts }, () => r(true));
    }))`);
    backToLoginTab();
  };

  step('by default a pick opens in a new tab', () => {
    resetOpenIn();
    const before = tabs().length;
    pickManageUsers();
    const opened = until(() => tabs().find(t => t.url.includes('ManageUsers')));
    if (!opened) throw new Error('no new tab with ManageUsers');
    const ok = tabs().length === before + 1 && opened.tabId !== loginTab;
    backToLoginTab();
    return ok;
  });

  step('"same" opens it in the current tab', () => {
    setOpenIn('same');
    const before = tabs().length;
    pickManageUsers();
    ab('wait', '--url', '**ManageUsers**');
    return tabs().length === before;
  });
  resetOpenIn();
  openUrl(process.env.SF_URL);

  section('Extension pages');

  step('Options shows the manifest version', () => {
    newTab('ext', extPage('options.html'));
    const version = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
    return waitFor(`document.body.innerText.includes('v${version}')`);
  });

  step('Options has the "Open links in" setting', () =>
    evaluate("['new', 'same'].every(v => [...document.querySelectorAll('#openIn option')].some(o => o.value === v))"));

  // The key form, without "Save and test": that would call the provider.
  const notHidden = id => `!document.getElementById('${id}').hidden`;

  step('pasting a Claude key recognizes it', () => {
    ab('fill', '#apiKey', 'sk-ant-api03-not-a-real-key-0000');
    return evaluate(notHidden('scr-recognized'))
      && /That's a Claude key/.test(evaluate("document.getElementById('matchLine').textContent"));
  });

  step('"Clear and paste a different key" returns to the paste screen', () => {
    clickEl('#clearDraft');
    return evaluate(`${notHidden('scr-paste')} && !${notHidden('scr-recognized')}`)
      && evaluate("document.getElementById('apiKey').value") === '';
  });

  step('the eye button reveals the key', () => {
    clickEl('#revealKey');
    return evaluate("document.getElementById('apiKey').type") === 'text';
  });

  step('an unrecognized key offers "Use it anyway"', () => {
    ab('fill', '#apiKey', 'not-a-known-prefix-1234');
    return evaluate(notHidden('unrecognized'))
      && /Use it .*anyway/.test(evaluate("document.getElementById('unrecognized').innerText"));
  });
  ab('fill', '#apiKey', '');

  step('popup disables "Open palette" off Salesforce', () => {
    ab('open', extPage('popup.html'));
    return waitFor("document.getElementById('openPalette')?.disabled === true");
  });

  // agent-browser doesn't list tabs that chrome.runtime.openOptionsPage opens, so
  // a second extension page watches for it through chrome.extension.getViews.
  const optionsViews = "chrome.extension.getViews({ type: 'tab' }).filter(w => w.location.pathname === '/options.html')";
  step("popup's Options button opens Options", () => {
    ab('tab', 'close', 'ext');
    newTab('watch', extPage('popup.html'));
    if (evaluate(`${optionsViews}.length`)) throw new Error('Options already open');
    newTab('ext', extPage('popup.html'));
    clickEl('#openOptions');
    ab('tab', 'watch');
    return !!until(() => evaluate(`${optionsViews}.length`));
  });
  evaluate(`${optionsViews}.forEach(w => w.close())`);
  backToLoginTab();

  // Options' "Show walkthrough" opens the palette on the Salesforce tab and starts the tour.
  section('Show walkthrough');

  function showWalkthroughFromOptions() {
    newTab('ext', extPage('options.html'));
    clickEl('#replayWalkthrough');
    ab('tab', loginTab);
    return waitFor(`${PALETTE_VISIBLE} && ${TOUR_VISIBLE}`);
  }

  step('starts the tour on a tab that never opened the palette', () => {
    openUrl(process.env.SF_URL);
    return showWalkthroughFromOptions();
  });

  step('starts the tour with the palette already open, without closing it', () => {
    ab('press', 'Escape'); // skips the tour; the palette stays open
    if (!evaluate(PALETTE_VISIBLE)) throw new Error('palette closed');
    backToLoginTab();
    return showWalkthroughFromOptions();
  });
  closePalette(); // the first Escape skips the tour
  backToLoginTab();

  // A tab that loaded while the extension was off has no content scripts. The
  // popup and Options inject them on demand, reading the file list from the manifest.
  section('On-demand injection');

  const setEnabled = on => evaluate(
    `new Promise(r => chrome.management.setEnabled('${EXT_ID}', ${on}, () => r(true)))`);
  const staleUrl = Object.assign(new URL(process.env.SF_URL), { hash: 'skipper-stale' }).href;

  step('popup injects the palette into a tab that predates the extension', () => {
    newTab('ext', 'chrome://extensions');
    setEnabled(false);
    try { newTab('stale', staleUrl); }
    finally { ab('tab', 'ext'); setEnabled(true); }
    ab('open', extPage('popup.html'));
    const res = evaluate(`new Promise(r => chrome.tabs.query({}, ts => {
      const tab = ts.find(t => t.url === ${JSON.stringify(staleUrl)});
      chrome.runtime.sendMessage({ type: 'openPalette', tabId: tab.id }, r);
    }))`);
    ab('tab', 'stale');
    if (res?.status !== 'injected') throw new Error(`status: ${JSON.stringify(res)}`);
    return waitFor(PALETTE_VISIBLE);
  });

  step('@export opens its editor there, focused', () => {
    skipTour();
    setExport(true);
    type('@export');
    ab('press', 'Enter');
    return waitFor("document.activeElement?.id === 'sfnav-export-query'");
  });

  step('an @export query fails only for want of a session', () => {
    ab('fill', '#sfnav-export-query', 'SELECT Id FROM Account');
    ab('press', 'Control+Enter');
    if (!waitFor("document.getElementById('sfnav-export-status')?.className === 'sfnav-soql-status-error'")) return false;
    const status = evaluate("document.getElementById('sfnav-export-status').textContent");
    if (/is not defined/.test(status)) throw new Error(status);
    return true;
  });
  closePalette();

  // The login tab's content scripts died with the disable; reload for fresh ones.
  backToLoginTab();
  openUrl(process.env.SF_URL);
}

// ── Signed in: runs in Lightning ────────────────────────────────────────────

// Pickers whose hint reports a count once the org data has loaded.
const PICKERS = [
  { keyword: '@flow', noun: /flow/i },
  { keyword: '@app', noun: /app/i },
  { keyword: '@cmd', noun: /metadata|cmd/i },
  { keyword: '@label', noun: /label/i },
  { keyword: '@permset', noun: /permission/i },
  { keyword: '@user', noun: /user/i },
];

function signedInTests() {
  section('Palette (signed in)');

  step('palette opens in Lightning', () => openPalette());

  section('Pickers');

  for (const { keyword, noun } of PICKERS) {
    step(`${keyword} opens and loads`, () => {
      enter(keyword);
      if (!palette().breadcrumb.includes(keyword)) throw new Error(`breadcrumb: ${palette().breadcrumb}`);
      return waitFor(`!/loading/i.test(document.getElementById('sfnav-hint')?.textContent)`)
        && noun.test(palette().hint);
    });
    ab('press', 'Escape');
  }

  section('@export');

  step('@labs turns on export', () => {
    setExport(true);
    type('@export');
    return palette().items.some(i => i.label === '@export');
  });

  step('@export runs a query and shows rows', () => {
    ab('press', 'Enter');
    ab('wait', '#sfnav-export-query');
    ab('fill', '#sfnav-export-query', 'SELECT Id, Name FROM Account LIMIT 5');
    clickEl('#sfnav-export-run');
    return waitFor("(document.getElementById('sfnav-export-summary')?.textContent || '').length > 0")
      && evaluate("document.querySelectorAll('#sfnav-export-grid tr').length > 1");
  });

  closePalette();
}

function runTests({ signedIn }) {
  if (signedIn) requireCreds();
  process.env.SF_URL ||= DEFAULT_URL;
  console.log(`${BOLD}Skipper for Salesforce — end-to-end tests${RESET}\n${DIM}Org: ${process.env.SF_URL}${RESET}`);
  closeBrowser(); // launch flags only apply to a fresh browser
  launch(process.env.SF_URL);
  loginTab = tabs().find(t => t.active).tabId;

  // The content script also matches Salesforce login pages, so these run signed out.
  signedOutTests();

  if (signedIn) {
    section('Sign in');
    if (login() === 'verify') {
      step('signs in', () => {
        throw new Error('Salesforce emailed a verification code. The browser is still open on that page; '
          + 'run: npm run e2e -- otp <code>');
      });
    } else {
      step('signs in', () => true);
      ab('wait', '--load', 'networkidle');
      signedInTests();
    }
  }
  if (!failed) closeBrowser();

  console.log(`\n${BOLD}Results:${RESET} ${GREEN}${passed} passed${RESET}, ${failed ? RED : ''}${failed} failed${RESET}`);
  process.exit(failed ? 1 : 0);
}

// Submit the emailed code into the browser left open on the verification page.
function submitOtp(code) {
  if (!code) throw new Error('Usage: npm run e2e -- otp <code>');
  if (!onVerificationPage()) throw new Error('No verification page open. Run npm run e2e -- login first.');
  ab('fill', '#emc', code);
  ab('check', '#RememberDeviceCheckbox');
  ab('click', '#save');
  ab('wait', '--fn', "!location.pathname.includes('/identity/verification/')");
  console.log(`${GREEN}Verified.${RESET} Now on ${ab('get', 'url').url}`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

// Read chrome.storage.local from a throwaway extension tab, masking API keys.
function readStorage(key) {
  const before = tabs().find(t => t.active).tabId;
  newTab('storage', extPage('popup.html'));
  try {
    return evaluate(`new Promise(r => chrome.storage.local.get(${key ? JSON.stringify(key) : 'null'}, data =>
      r(JSON.parse(JSON.stringify(data, (k, v) => /apikey/i.test(k) && v ? v.slice(0, 7) + '…' : v)))))`);
  } finally {
    ab('tab', 'close', 'storage');
    ab('tab', before);
  }
}

function main() {
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const [cmd, arg] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
      return runTests({ signedIn: false });
    case 'signed-in':
      return runTests({ signedIn: true });
    case 'open': {
      const url = arg || process.env.SF_URL;
      if (!url) throw new Error('Usage: npm run e2e -- open <url>  (or set SF_URL in .env.local)');
      closeBrowser();
      launch(url);
      console.log(`Browser open with the extension on ${ab('get', 'url').url} (session ${SESSION}).`);
      console.log(`Extension ID: ${EXT_ID}`);
      return;
    }
    case 'id':
      return console.log(EXT_ID);
    case 'palette-state':
      return printJson(palette());
    case 'type': {
      if (!openPalette()) throw new Error('palette did not open');
      type(process.argv.slice(3).join(' '));
      return printJson(palette());
    }
    case 'storage':
      return printJson(readStorage(arg));
    case 'login': {
      const result = signIn();
      console.log(result === 'verify'
        ? 'Salesforce emailed a verification code. Run: npm run e2e -- otp <code>'
        : `${GREEN}Signed in.${RESET} Now on ${ab('get', 'url').url}`);
      return;
    }
    case 'otp':
      return submitOtp(arg);
    case 'close':
      return closeBrowser();
    default:
      throw new Error(`Unknown command "${cmd}". See the top of test/e2e.js.`);
  }
}

try {
  main();
} catch (err) {
  console.error(`\n${RED}Fatal:${RESET} ${err.message}`);
  process.exit(2);
}
