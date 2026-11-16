// Setup quick-link check — opens every SETUP_QUICK_LINKS destination in a real
// org and reports the ones that no longer load.
//
// Salesforce renames and retires Setup nodes with each release, and the palette
// only knows the URL segments hard-coded in salesforce-urls.js. Developer
// Edition orgs are always on the latest release, so a weekly run against one
// (.github/workflows/link-check.yml) catches a dead link before users do.
//
// Run locally:   npm run test:links            (logs in through the Salesforce CLI;
//                                               SF_ORG picks the org, else the CLI default)
//                npm run test:links -- --all   (print every link, not just failures)
//                npm run test:links -- --only 'Debug|Roles'   (labels matching a regex)
//
// A link FAILS when the page lands on Salesforce's "Page not found", an access
// error, the login screen, or shows nothing at all. Several Agentforce nodes
// render without ever setting a tab title; those pass only when the page body
// holds more text than Salesforce's bare "Page not found" shell, which the run
// measures first by opening a URL that cannot exist.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EXT, cliLogin } = require('./e2e-helpers');

const CONCURRENCY = 3;

// Pages that only exist once a feature is licensed or enabled. The test org
// can't show them, so a "Page not found" there is a SKIP, not a failure. Keep
// this list short: everything else must load in a plain Developer Edition org.
const GATED = {
  'Sandboxes': 'Developer Edition orgs have no sandboxes',
  'Digital Experiences': 'needs Digital Experiences enabled',
};
const SETTLE_MS = 12_000; // how long to wait for a Lightning page to name itself
const PLACEHOLDER_TITLE = /^(Home \| Salesforce|Lightning Experience|Salesforce)?$/;
const NOT_FOUND = /page not found|seite nicht gefunden|page (doesn.t|does not) exist|insufficient privileges|you don.t have access|cannot be displayed|invalid page/i;
const LOGIN = /^(login|anmelden|log in|connexion|iniciar sesi.n) \| salesforce$/i; // the login screen itself, not "Login History"

// Evaluate salesforce-urls.js with a fake window so the url() closures resolve
// against the org we're testing.
function loadQuickLinks(origin) {
  const src = fs.readFileSync(path.join(EXT, 'salesforce-urls.js'), 'utf8');
  const ctx = { window: { location: { origin, hostname: new URL(origin).hostname } } };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;this.__links = SETUP_QUICK_LINKS;', ctx);
  return ctx.__links.map(l => ({ label: l.label, url: l.url() }));
}

// Text length of the Setup shell (header, tree, footer) with no page inside
// it, measured on a URL that cannot exist. An untitled page must beat this.
async function measureShell(page, origin) {
  await page.goto(`${origin}/lightning/setup/SkipperNoSuchPage/home`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  let title = '';
  for (let i = 0; i < 20 && !NOT_FOUND.test(title); i++) {
    await page.waitForTimeout(750);
    title = await page.title().catch(() => '');
  }
  if (!NOT_FOUND.test(title)) console.log(`warning: the probe URL did not give "Page not found" (got "${title}") — dead-link detection may be off`);
  return (await pageText(page)).length;
}

const BLANK_MARGIN = 150; // chars above the shell an untitled page must show

// Visible text of the page plus every frame in it. Classic Setup pages (Data
// Import Wizard, Schema Builder, …) live in a full-page iframe, so the top
// document alone can look emptier than the shell.
async function pageText(page) {
  let text = '';
  for (const frame of page.frames()) {
    text += await frame.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  }
  return text.slice(0, 40_000);
}

async function probe(page, link, shellLen) {
  const started = Date.now();
  try {
    await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (err) {
    return { ...link, status: 'FAIL', note: 'navigation failed: ' + err.message.split('\n')[0] };
  }
  // Lightning sets the real title a few seconds after load; give it a chance.
  let title = '';
  while (Date.now() - started < SETTLE_MS) {
    title = await page.title().catch(() => '');
    if (!PLACEHOLDER_TITLE.test(title)) break;
    await page.waitForTimeout(750);
  }
  const text = await pageText(page);
  const landed = page.url();
  const ms = Date.now() - started;
  if (LOGIN.test(title) || /\/\?ec=\d+/.test(landed)) return { ...link, status: 'FAIL', note: 'redirected to login', ms };
  if (NOT_FOUND.test(title)) {
    if (GATED[link.label]) return { ...link, status: 'SKIP', note: GATED[link.label], ms };
    return { ...link, status: 'FAIL', note: title, ms };
  }
  if (NOT_FOUND.test(text)) return { ...link, status: 'FAIL', note: (text.match(NOT_FOUND) || [''])[0], ms };
  if (PLACEHOLDER_TITLE.test(title)) {
    if (text.length < shellLen + BLANK_MARGIN) {
      if (GATED[link.label]) return { ...link, status: 'SKIP', note: GATED[link.label], ms };
      return { ...link, status: 'FAIL', note: `blank page (no title, ${text.length} chars vs ${shellLen} for an empty shell)`, ms };
    }
    return { ...link, status: 'PASS', note: `untitled page with ${text.length - shellLen} chars of content`, ms };
  }
  return { ...link, status: 'PASS', note: title.replace(/ \| Salesforce$/, ''), ms };
}

(async () => {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx !== -1 ? new RegExp(argv[onlyIdx + 1], 'i') : null;
  const cli = cliLogin();
  if (!cli) {
    console.error('No org to test. Log in with the Salesforce CLI (sf org login web) or set SF_ORG.');
    process.exit(2);
  }
  const origin = new URL(cli.setupUrl).origin;
  const links = loadQuickLinks(origin).filter(l => !only || only.test(l.label));
  console.log(`Checking ${links.length} setup quick-links on ${origin} (as ${cli.org})`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const first = await context.newPage();
  await first.goto(cli.frontdoorUrl, { waitUntil: 'domcontentloaded' });
  await first.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  if (LOGIN.test(await first.title())) {
    console.error('Frontdoor login did not produce a session.');
    await browser.close();
    process.exit(2);
  }

  const shellLen = await measureShell(first, origin);
  const results = new Array(links.length);
  let next = 0;
  async function worker(page) {
    while (next < links.length) {
      const i = next++;
      results[i] = await probe(page, links[i], shellLen);
      const r = results[i];
      if (all || r.status === 'FAIL') console.log(`${r.status}  ${r.label}  →  ${r.url.replace(origin, '')}  (${r.note}, ${r.ms || 0}ms)`);
    }
  }
  const pages = [first];
  while (pages.length < CONCURRENCY) pages.push(await context.newPage());
  await Promise.all(pages.map(worker));
  await browser.close();

  const failed = results.filter(r => r.status === 'FAIL');
  const skipped = results.filter(r => r.status === 'SKIP');
  const untitled = results.filter(r => r.status === 'PASS' && r.note.startsWith('untitled'));
  console.log(`\n${results.length - failed.length - skipped.length} of ${results.length} links load${untitled.length ? ` (${untitled.length} without a page title)` : ''}; ${skipped.length} gated in this org; ${failed.length} failed.`);

  // GitHub Actions: put the failures in the job summary.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`## Setup quick-link check`, '', `${results.length - failed.length}/${results.length} load on ${origin}`, ''];
    if (failed.length) {
      lines.push('| Link | URL | Problem |', '|---|---|---|');
      for (const r of failed) lines.push(`| ${r.label} | \`${r.url.replace(origin, '')}\` | ${r.note} |`);
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  process.exit(failed.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(2); });
