// Shared Playwright bits for debug.js + e2e.js.
// Loads the unpacked extension into a persistent Chromium profile, handles
// auto-login from .sf-credentials, and exposes small DOM helpers.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname);
const PROFILE = path.join(EXT, '.playwright-profile');
const CREDS_FILE = path.join(EXT, '.sf-credentials');

function loadCreds() {
  if (!fs.existsSync(CREDS_FILE)) return {};
  const out = {};
  for (const line of fs.readFileSync(CREDS_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Stale Singleton* lockfiles in the persistent profile cause launch failures
// when a previous run didn't shut down cleanly (Ctrl+C, crash). Safe to remove.
function cleanProfileLocks() {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(PROFILE, f)); } catch {}
  }
}

async function launchContext({ slowMo } = {}) {
  cleanProfileLocks();
  return chromium.launchPersistentContext(PROFILE, {
    headless: false, // extensions need a real Chromium UI
    viewport: { width: 1400, height: 900 },
    slowMo,
    // Drop Playwright defaults that interfere with content-script injection on Salesforce hosts.
    ignoreDefaultArgs: [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--enable-automation',
    ],
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });
}

function attachLogging(page, { filter } = {}) {
  page.on('console', msg => {
    const t = msg.text();
    if (!filter || filter.test(t)) {
      console.log(`[page:${msg.type()}] ${t}`);
    }
  });
  page.on('pageerror', err => console.log(`[pageerror] ${err.message}`));
}

// If the current page is the SF login form, fill it in from .sf-credentials.
// Returns true if a submit happened.
async function maybeLogin(page) {
  const creds = loadCreds();
  if (!creds.SF_USERNAME || !creds.SF_PASSWORD) return false;

  const username = await page.$('#username').catch(() => null);
  const password = await page.$('#password').catch(() => null);
  if (!username || !password) return false;

  await username.fill(creds.SF_USERNAME);
  await password.fill(creds.SF_PASSWORD);
  await page.click('#Login');
  await page.waitForLoadState('domcontentloaded');
  return true;
}

// Navigate to the target URL, log in if we hit the login page, and wait
// long enough for Lightning to settle so the content script's document_idle
// hook fires and the initial REST fetches finish.
async function gotoApp(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (await maybeLogin(page)) {
    await page.waitForURL(/lightning\.force\.com|salesforce-setup\.com/, { timeout: 30_000 })
      .catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

// Open the palette via keyboard. The content script's keydown listener crosses
// the isolated-world boundary, which is the only way to reach it from Playwright.
async function openPalette(page) {
  // If already open, no-op.
  const visible = await page.locator('#sfnav-overlay').isVisible().catch(() => false);
  if (visible) return true;
  await page.keyboard.press('Meta+Shift+KeyK');
  const ok = await page.waitForSelector('#sfnav-overlay', { state: 'visible', timeout: 4_000 })
    .then(() => true).catch(() => false);
  if (ok) return true;
  await page.keyboard.press('Control+Shift+KeyK');
  return page.waitForSelector('#sfnav-overlay', { state: 'visible', timeout: 3_000 })
    .then(() => true).catch(() => false);
}

async function closePalette(page) {
  const visible = await page.locator('#sfnav-overlay').isVisible().catch(() => false);
  if (!visible) return;
  await page.keyboard.press('Escape');
  // The palette may step back into a sub-mode rather than fully close — press until hidden.
  for (let i = 0; i < 5; i++) {
    const stillVisible = await page.locator('#sfnav-overlay').isVisible().catch(() => false);
    if (!stillVisible) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  }
}

// Read the palette state from the DOM (page world can see DOM elements the
// content script injected).
async function readPalette(page) {
  return page.evaluate(() => {
    const get = id => document.getElementById(id);
    return {
      visible: get('sfnav-overlay')?.style.display !== 'none' && !!get('sfnav-overlay'),
      breadcrumb: get('sfnav-breadcrumb')?.textContent || '',
      hint: get('sfnav-hint')?.textContent || '',
      input: get('sfnav-input')?.value || '',
      placeholder: get('sfnav-input')?.placeholder || '',
      items: Array.from(document.querySelectorAll('.sfnav-item')).map(el => ({
        label: el.querySelector('.sfnav-label')?.textContent,
        sublabel: el.querySelector('.sfnav-sublabel')?.textContent,
        url: el.dataset.url,
        selected: el.classList.contains('selected'),
      })),
      sectionHeaders: Array.from(document.querySelectorAll('.sfnav-section-header'))
        .map(el => el.textContent),
    };
  });
}

// Type @keyword into the input. By default also presses Enter to enter the picker.
async function typeAndEnter(page, value) {
  await page.fill('#sfnav-input', value);
  await page.waitForTimeout(50); // let the input handler render
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
}

module.exports = {
  EXT,
  PROFILE,
  loadCreds,
  cleanProfileLocks,
  launchContext,
  attachLogging,
  maybeLogin,
  gotoApp,
  openPalette,
  closePalette,
  readPalette,
  typeAndEnter,
};
