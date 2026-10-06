// End-to-end tests against a real Salesforce org, driven by agent-browser.
// See AGENTS.md for setup and for driving the extension by hand.
//
//   npm run e2e                  run the tests (signs in if needed)
//   npm run e2e -- open [url]    fresh browser with the extension, left open
//   npm run e2e -- login         sign in to the org in the open browser
//   npm run e2e -- otp <code>    submit Salesforce's emailed verification code
//   npm run e2e -- close         close the browser
//
// Everything runs in the agent-browser session "skipper-e2e". Headless by
// default; HEADED=1 shows the window.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(EXT, '.e2e-browser-profile');
const ENV_FILE = path.join(EXT, '.env.local');
const SESSION = 'skipper-e2e';

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

// The daemon takes a moment to exit after close. Launching before it's gone
// fails with "Failed to connect", so wait until the session is no longer listed.
function closeBrowser() {
  spawnSync('agent-browser', ['--session', SESSION, 'close'], { encoding: 'utf8' });
  for (let i = 0; i < 20; i++) {
    const list = spawnSync('agent-browser', ['session', 'list'], { encoding: 'utf8' }).stdout || '';
    if (!list.split('\n').some(line => line.trim().replace(/^→\s*/, '') === SESSION)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
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
  else if (!evaluate("!!document.querySelector('#username')")) ab('open', process.env.SF_URL);
  return login();
}

// ── Palette helpers ─────────────────────────────────────────────────────────
// The content script runs in an isolated world, so everything is read from the DOM.

const PALETTE_STATE = `(() => {
  const get = id => document.getElementById(id);
  const overlay = get('sfnav-overlay');
  return {
    visible: !!overlay && overlay.style.display !== 'none',
    focused: document.activeElement?.id === 'sfnav-input',
    breadcrumb: get('sfnav-breadcrumb')?.textContent || '',
    hint: get('sfnav-hint')?.textContent || '',
    placeholder: get('sfnav-input')?.placeholder || '',
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

// Wait for a JS expression to turn truthy. Returns false on timeout instead of throwing.
function waitFor(js) {
  try { ab('wait', '--fn', js); return true; } catch { return false; }
}

const PALETTE_VISIBLE = "(o => !!o && o.style.display !== 'none')(document.getElementById('sfnav-overlay'))";

// Open the palette with the shortcut, skipping the first-run walkthrough if it shows.
function openPalette() {
  if (evaluate(PALETTE_VISIBLE)) return true;
  ab('press', 'Control+Shift+K');
  if (!waitFor(PALETTE_VISIBLE)) return false;
  if (evaluate("!!document.querySelector('.sfnav-cm-skip')?.offsetParent")) ab('click', '.sfnav-cm-skip');
  return true;
}

function closePalette() {
  for (let i = 0; i < 6 && evaluate(PALETTE_VISIBLE); i++) ab('press', 'Escape');
}

// Type into the palette input and wait for the results to re-render.
function type(text) {
  ab('fill', '#sfnav-input', text);
}

// Type an @keyword and press Enter to step into its picker.
function enter(keyword) {
  type(keyword);
  ab('press', 'Enter');
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
  section('Palette (signed out)');

  step('Ctrl+Shift+K opens the palette', () => openPalette());
  step('input is focused', () => palette().focused);

  step('root menu lists every @ keyword', () => {
    const labels = palette().items.map(i => i.label);
    const need = ['@object', '@flow', '@app', '@cmd', '@label', '@permset', '@user', '@setup', '@ask', '@soql'];
    const missing = need.filter(n => !labels.includes(n));
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  });

  step('ArrowDown and ArrowUp move the selection', () => {
    const selected = () => palette().items.findIndex(i => i.selected);
    const start = selected();
    ab('press', 'ArrowDown');
    if (selected() !== start + 1) throw new Error('ArrowDown did not move');
    ab('press', 'ArrowUp');
    return selected() === start;
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

  step('@ask without a key warns and links to Options', () => {
    enter('@ask');
    return waitFor("/No API key/.test(document.getElementById('sfnav-ask-keywarn')?.textContent)");
  });
  closePalette();

  step('@soql without a key warns on submit', () => {
    openPalette();
    enter('@soql');
    type('all accounts');
    ab('press', 'Enter');
    return waitFor("/No API key/.test(document.getElementById('sfnav-soql-status')?.textContent)");
  });

  step('Escape closes the palette', () => {
    closePalette();
    return !evaluate(PALETTE_VISIBLE);
  });
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

  step('plain search finds the Account object', () => {
    type('account');
    return waitFor("[...document.querySelectorAll('.sfnav-item .sfnav-label')].some(e => e.textContent === 'Account')");
  });

  section('@object');

  step('@object lists at least 20 objects', () => {
    enter('@object');
    return waitFor("document.querySelectorAll('.sfnav-item').length >= 20");
  });

  step('picking Account scopes the breadcrumb to it', () => {
    type('account');
    clickItem('Account');
    return /account/i.test(palette().breadcrumb);
  });

  step('Account offers Fields & Relationships', () =>
    palette().items.some(i => i.label === 'Fields & Relationships'));

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
    type('@labs');
    if (palette().items.some(i => i.label === 'Turn on export')) {
      clickItem('Turn on export');
    }
    type('@export');
    return palette().items.some(i => i.label === '@export');
  });

  step('@export runs a query and shows rows', () => {
    ab('press', 'Enter');
    ab('wait', '#sfnav-export-query');
    ab('fill', '#sfnav-export-query', 'SELECT Id, Name FROM Account LIMIT 5');
    ab('click', '#sfnav-export-run');
    return waitFor("(document.getElementById('sfnav-export-summary')?.textContent || '').length > 0")
      && evaluate("document.querySelectorAll('#sfnav-export-grid tr').length > 1");
  });

  closePalette();
}

function runTests() {
  requireCreds();
  console.log(`${BOLD}Skipper for Salesforce — end-to-end tests${RESET}\n${DIM}Org: ${process.env.SF_URL}${RESET}`);
  closeBrowser(); // launch flags only apply to a fresh browser
  launch(process.env.SF_URL);

  // The content script also matches Salesforce login pages, so these run signed out.
  signedOutTests();

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
    closeBrowser();
  }

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

function main() {
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const [cmd, arg] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
      return runTests();
    case 'open': {
      const url = arg || process.env.SF_URL;
      if (!url) throw new Error('Usage: npm run e2e -- open <url>  (or set SF_URL in .env.local)');
      closeBrowser();
      launch(url);
      console.log(`Browser open with the extension on ${ab('get', 'url').url} (session ${SESSION}).`);
      return;
    }
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
