// Shared Playwright bits for debug.js + e2e.js.
// Loads the unpacked extension into a persistent Chromium profile, handles
// auto-login from .sf-credentials, and exposes small DOM helpers.

const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
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

// No password needed when the Salesforce CLI is already logged in: ask it for
// a one-time frontdoor link. Uses SF_ORG (alias or username) from
// .sf-credentials / the environment, else the CLI's default org.
// Returns { frontdoorUrl, setupUrl } or null if the CLI can't help.
function cliLogin(path = '/lightning/setup/SetupOneHome/home') {
  const org = process.env.SF_ORG || loadCreds().SF_ORG;
  const args = ['org', 'open', '--url-only', '--json', '--path', path];
  if (org) args.push('--target-org', org);
  try {
    const out = JSON.parse(execFileSync('sf', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const frontdoorUrl = out.result && out.result.url;
    if (!frontdoorUrl) return null;
    const host = new URL(frontdoorUrl).hostname.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
    return { frontdoorUrl, setupUrl: `https://${host}${path}`, org: out.result.username || org };
  } catch {
    return null;
  }
}

// ─── Test org fixtures (test/e2e-org) ─────────────────────────────────────
// A known flow and custom label, deployed with the CLI before the run, so the
// tests check real data instead of whatever happens to be in the org.

const FIXTURE_DIR = path.join(EXT, 'test', 'e2e-org');
const FIXTURE_FLOW = 'Skipper_E2E_Flow';

function sf(args, opts = {}) {
  const out = execFileSync('sf', [...args, '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: opts.cwd || FIXTURE_DIR,
  });
  return JSON.parse(out).result;
}

function deployFixtures(org, dir = FIXTURE_DIR) {
  sf(['project', 'deploy', 'start', '--target-org', org, '--wait', '10'], { cwd: dir });
}

function activeFlowVersion(org) {
  const r = sf(['data', 'query', '--target-org', org, '--query',
    `SELECT ActiveVersionId FROM FlowDefinitionView WHERE ApiName = '${FIXTURE_FLOW}'`]);
  return r.records[0] && r.records[0].ActiveVersionId;
}

// Deploy a changed copy of the fixture flow, which activates a new version.
// Drops old inactive versions first (Salesforce caps a flow at 50).
function bumpFixtureFlow(org) {
  const old = sf(['data', 'query', '--use-tooling-api', '--target-org', org, '--query',
    `SELECT Id FROM Flow WHERE Definition.DeveloperName = '${FIXTURE_FLOW}' AND Status != 'Active' ORDER BY VersionNumber`]);
  for (const rec of old.records) {
    try { sf(['data', 'delete', 'record', '--use-tooling-api', '--target-org', org, '--sobject', 'Flow', '--record-id', rec.Id]); } catch {}
  }
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'skipper-e2e-'));
  fs.cpSync(FIXTURE_DIR, tmp, { recursive: true, filter: src => !/[\\/]\.sfd?x?$/.test(src) });
  const file = path.join(tmp, 'force-app/main/default/flows', FIXTURE_FLOW + '.flow-meta.xml');
  const xml = fs.readFileSync(file, 'utf8')
    .replace('Safe to delete.</description>', `Safe to delete. Run ${Date.now()}.</description>`);
  fs.writeFileSync(file, xml);
  try { deployFixtures(org, tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
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
  let ok = await page.waitForSelector('#sfnav-overlay', { state: 'visible', timeout: 4_000 })
    .then(() => true).catch(() => false);
  if (!ok) {
    await page.keyboard.press('Control+Shift+KeyK');
    ok = await page.waitForSelector('#sfnav-overlay', { state: 'visible', timeout: 3_000 })
      .then(() => true).catch(() => false);
  }
  if (ok) await skipWalkthrough(page);
  return ok;
}

// A fresh profile gets the first-run walkthrough on first open, which makes
// the input read-only. Esc skips it and leaves the palette open.
async function skipWalkthrough(page) {
  await page.waitForTimeout(300);
  const touring = await page.locator('#sfnav-coachmark').isVisible().catch(() => false);
  if (!touring) return;
  await page.keyboard.press('Escape');
  await page.waitForSelector('#sfnav-coachmark', { state: 'hidden', timeout: 2_000 }).catch(() => {});
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
  cliLogin,
  deployFixtures,
  activeFlowVersion,
  bumpFixtureFlow,
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
