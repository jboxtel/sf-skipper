// End-to-end tests against a real Salesforce org.
//
// Login, either:
//   - Salesforce CLI (no password): uses the CLI's default org, or SF_ORG
//     (alias/username) from the environment or .sf-credentials.
//   - .sf-credentials with SF_USERNAME, SF_PASSWORD, SF_TEST_URL.
//     SF_TEST_URL must point at the org's Setup home, e.g.
//     SF_TEST_URL=https://yourorg.lightning.force.com/lightning/setup/SetupOneHome/home
// Run: npm run e2e
//
// Override URL: node test/e2e.js <url>

const {
  loadCreds,
  cliLogin,
  deployFixtures,
  activeFlowVersion,
  bumpFixtureFlow,
  launchContext,
  attachLogging,
  gotoApp,
  openPalette,
  closePalette,
  readPalette,
  typeAndEnter,
} = require('./e2e-helpers');
const { URL } = require('url');

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { console.log(`  ${GREEN}✓${RESET} ${label}`); passed++; }
function fail(label, detail) {
  console.log(`  ${RED}✗${RESET} ${label}`);
  if (detail) console.log(`    ${DIM}${detail}${RESET}`);
  failed++;
  failures.push({ label, detail });
}
async function step(label, fn) {
  try {
    const result = await fn();
    if (result === false) { fail(label); return; }
    ok(label);
  } catch (err) {
    fail(label, err.message);
  }
}
function section(title) { console.log(`\n${BOLD}${title}${RESET}`); }

// A page on each domain. Orgs on the new Setup domain redirect Setup pages
// away from lightning.force.com, so the Lightning check uses the app home.
function setupDomainUrls(url) {
  const org = new URL(url).hostname
    .replace(/\.lightning\.force\.com$/, '')
    .replace(/\.my\.salesforce-setup\.com$/, '')
    .replace(/\.my\.salesforce\.com$/, '');
  return [
    ['Lightning domain', `https://${org}.lightning.force.com/lightning/page/home`],
    ['Setup domain', `https://${org}.my.salesforce-setup.com/lightning/setup/SetupOneHome/home`],
  ];
}

// Every cached picker loads (not just "the hint mentions flows").
const CACHED_PICKERS = [
  ['@flow', /^Failed to load flows/],
  ['@app', /^Failed to load apps/],
  ['@label', /^Failed to load custom labels/],
  ['@permset', /^Failed to load permission sets/],
  ['@user', /^Failed to load users/],
];

async function waitForPickerLoaded(page) {
  for (let i = 0; i < 60; i++) {
    const s = await readPalette(page);
    if (!/loading/i.test(s.hint)) return s;
    await page.waitForTimeout(250);
  }
  return readPalette(page);
}

// Pick Skipper E2E Flow in @flow and press Enter. Returns the version id the
// row had cached and the one Flow Builder was opened with.
async function openFixtureFlow(ctx, page) {
  await openPalette(page);
  await typeAndEnter(page, '@flow');
  await waitForPickerLoaded(page);
  await page.fill('#sfnav-input', 'Skipper E2E');
  await page.waitForTimeout(300);
  let row = (await readPalette(page)).items[0];
  if (row && /^↻/.test(row.label)) {
    // The cached list predates the fixture deploy — use the refresh row, as a user would.
    await page.locator('.sfnav-item', { hasText: '↻' }).first().click();
    for (let i = 0; i < 60 && !(row && row.label === 'Skipper E2E Flow'); i++) {
      await page.waitForTimeout(250);
      row = (await readPalette(page)).items[0];
    }
  }
  if (!row || row.label !== 'Skipper E2E Flow') {
    throw new Error('Skipper E2E Flow not listed (first row: ' + (row && row.label) + ')');
  }
  const cachedId = (row.url.match(/flowId=([^&]+)/) || [])[1];
  // Opens in a new tab by default (Options → open in new tab); fall back to
  // same-tab navigation if that's switched off.
  const newTab = ctx.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
  await page.keyboard.press('Enter');
  const target = (await newTab) || page;
  // Flow Builder keeps loading long after it's usable, so don't wait for 'load'.
  await target.waitForURL(/flowBuilder\.app\?flowId=/, { timeout: 20_000, waitUntil: 'commit' }).catch(() => {});
  await target.waitForTimeout(3000); // a redirect to an error page would show by now
  const final = target.url();
  if (target !== page) await target.close();
  return { cachedId, landedId: (final.match(/flowId=([^&]+)/) || [])[1], final };
}

async function checkDomain(ctx, name, domainUrl, fixtures) {
  const expectedHost = new URL(domainUrl).hostname;
  section(`${name} (${expectedHost})`);

  const page = await ctx.newPage();
  attachLogging(page, { filter: /sfnav.*(error|fail|failed|warn)/i });
  const loaded = await gotoApp(page, domainUrl).then(() => true, () => false);

  // Older orgs aren't on the Setup domain yet; that's not a Skipper failure.
  const isSetupDomain = /\.salesforce-setup\.com$/.test(expectedHost);
  if (isSetupDomain && (!loaded || new URL(page.url()).hostname !== expectedHost)) {
    console.log(`  ${DIM}– skipped: this org isn't on the Setup domain (ended on ${loaded ? new URL(page.url()).hostname : 'an error page'})${RESET}`);
    await page.close();
    return;
  }

  await step('Salesforce keeps us on this domain', async () => {
    const host = new URL(page.url()).hostname;
    if (host !== expectedHost) throw new Error(`redirected to ${host}`);
    return true;
  });
  await step('palette opens', () => openPalette(page));

  for (const [keyword, errorRe] of CACHED_PICKERS) {
    await step(`${keyword} loads its list`, async () => {
      await typeAndEnter(page, keyword);
      const s = await waitForPickerLoaded(page);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      if (errorRe.test(s.hint)) throw new Error(s.hint);
      if (/loading/i.test(s.hint)) throw new Error('still loading after 15s');
      return true;
    });
  }

  await step('clicking the refresh row keeps the keyboard working', async () => {
    await openPalette(page);
    await typeAndEnter(page, '@flow');
    await waitForPickerLoaded(page);
    await page.fill('#sfnav-input', 'no flow is called this');
    await page.waitForTimeout(300);
    await page.locator('.sfnav-item', { hasText: '↻' }).first().click();
    await page.waitForTimeout(300);
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    await waitForPickerLoaded(page);
    await closePalette(page);
    if (focused !== 'sfnav-input') throw new Error('focus went to ' + (focused || 'the page'));
    return true;
  });

  await step('@label finds the test label', async () => {
    await openPalette(page);
    if (!fixtures) throw new Error('needs a Salesforce CLI login to deploy test/e2e-org');
    await typeAndEnter(page, '@label');
    await waitForPickerLoaded(page);
    await page.fill('#sfnav-input', 'Skipper E2E');
    await page.waitForTimeout(300);
    const s = await readPalette(page);
    await closePalette(page);
    if (!s.items.some(i => /Skipper.E2E.Label/.test(i.label))) {
      throw new Error('not listed — got: ' + s.items.map(i => i.label).join(', '));
    }
    return true;
  });

  await step('@flow opens the test flow on its active version', async () => {
    if (!fixtures) throw new Error('needs a Salesforce CLI login to deploy test/e2e-org');
    const r = await openFixtureFlow(ctx, page);
    if (r.landedId !== fixtures.activeVersion) {
      throw new Error(`expected flowId=${fixtures.activeVersion}, ended on ${r.final}`);
    }
    return true;
  });

  await page.close();
}

(async () => {
  const creds = loadCreds();
  let url = process.argv[2] || creds.SF_TEST_URL;
  // Without a URL / password, log in through the Salesforce CLI.
  const cli = (!url || !creds.SF_PASSWORD) ? cliLogin() : null;
  if (!url && cli) url = cli.setupUrl;
  if (!url) {
    console.error('No org to test. Log in with the Salesforce CLI (sf org login web), set SF_TEST_URL in .sf-credentials, or pass a URL as the first arg.');
    process.exit(1);
  }

  console.log(`${BOLD}Skipper for Salesforce — end-to-end tests${RESET}\n${DIM}Org: ${url}${cli ? ` (logged in via sf CLI as ${cli.org})` : ''}${RESET}`);

  // Known test data (test/e2e-org) — deployed with the CLI login.
  let fixtures = null;
  if (cli) {
    try {
      deployFixtures(cli.org);
      fixtures = { activeVersion: activeFlowVersion(cli.org) };
    } catch (err) {
      console.log(`${RED}Could not deploy test/e2e-org: ${err.message}${RESET}`);
    }
  }

  const ctx = await launchContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  attachLogging(page, { filter: /sfnav.*(error|fail|failed|warn)/i });

  if (cli) {
    await page.goto(cli.frontdoorUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  }
  await gotoApp(page, url);

  // ── Palette open ─────────────────────────────────────────────────────────
  section('Palette');
  await step('Cmd+Shift+K opens the palette', async () => {
    return openPalette(page);
  });
  await step('input is focused after open', async () => {
    return page.evaluate(() => document.activeElement?.id === 'sfnav-input');
  });
  await step('placeholder is the root prompt', async () => {
    const s = await readPalette(page);
    return s.placeholder.includes('Search') || s.placeholder.includes('pick');
  });

  // ── Root menu ────────────────────────────────────────────────────────────
  section('Root menu');
  await step('shows expected shortcuts', async () => {
    const s = await readPalette(page);
    const labels = s.items.map(i => i.label);
    const need = ['@object', '@flow', '@app', '@cmd', '@label', '@setup'];
    const missing = need.filter(n => !labels.includes(n));
    if (missing.length) throw new Error(`missing shortcuts: ${missing.join(', ')}`);
    return true;
  });
  await step('shows section headers', async () => {
    const s = await readPalette(page);
    return s.sectionHeaders.includes('Browse') && s.sectionHeaders.includes('Setup');
  });

  // ── @object picker ───────────────────────────────────────────────────────
  section('@object picker');
  await step('@object opens the picker', async () => {
    await typeAndEnter(page, '@object');
    const s = await readPalette(page);
    return s.breadcrumb.includes('@object') && s.placeholder.includes('object');
  });
  await step('lists at least 20 objects', async () => {
    const s = await readPalette(page);
    return s.items.length >= 20;
  });
  await step('filtering "account" surfaces an Account result', async () => {
    await page.fill('#sfnav-input', 'account');
    await page.waitForTimeout(150);
    const s = await readPalette(page);
    return s.items.some(i => /account/i.test(i.label));
  });
  await step('Enter on Account → object-scoped breadcrumb', async () => {
    // Click the first matching Account row to step into scoped mode
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.sfnav-item'));
      const match = items.find(el => /^Account$/i.test(el.querySelector('.sfnav-label')?.textContent || ''));
      (match || items[0])?.click();
    });
    await page.waitForTimeout(200);
    const s = await readPalette(page);
    return /account/i.test(s.breadcrumb);
  });
  await step('object-scoped mode shows Fields & Relationships', async () => {
    const s = await readPalette(page);
    return s.items.some(i => /Fields & Relationships/i.test(i.label));
  });
  await step('filtering "val" narrows to Validation Rules', async () => {
    await page.fill('#sfnav-input', 'val');
    await page.waitForTimeout(150);
    const s = await readPalette(page);
    return /Validation Rules/i.test(s.items[0]?.label || '');
  });
  await step('Escape → back to object picker', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const s = await readPalette(page);
    return s.breadcrumb.includes('@object') && !s.breadcrumb.toLowerCase().includes('account ›');
  });
  await step('Escape from picker → back to root', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const s = await readPalette(page);
    return !s.breadcrumb;
  });

  // ── @flow picker ─────────────────────────────────────────────────────────
  section('@flow picker');
  await step('@flow opens the picker', async () => {
    await typeAndEnter(page, '@flow');
    const s = await readPalette(page);
    return /flow/i.test(s.breadcrumb) && /flow/i.test(s.placeholder);
  });
  await step('hint reports a count or loading state', async () => {
    const s = await readPalette(page);
    return /flow/i.test(s.hint) || /loading/i.test(s.hint);
  });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // ── @app picker ──────────────────────────────────────────────────────────
  section('@app picker');
  await step('@app opens the picker', async () => {
    await typeAndEnter(page, '@app');
    const s = await readPalette(page);
    return /app/i.test(s.placeholder);
  });
  await step('hint reports a count or loading state', async () => {
    const s = await readPalette(page);
    return /app/i.test(s.hint) || /loading/i.test(s.hint);
  });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // ── @label picker ────────────────────────────────────────────────────────
  section('@label picker');
  await step('@label opens the picker', async () => {
    await typeAndEnter(page, '@label');
    const s = await readPalette(page);
    return /label/i.test(s.breadcrumb) && /custom label/i.test(s.placeholder);
  });
  await step('hint reports a count, loading, or error', async () => {
    const s = await readPalette(page);
    return /custom label/i.test(s.hint) || /loading/i.test(s.hint);
  });
  await step('label items have ExternalStrings setup URLs (when present)', async () => {
    const s = await readPalette(page);
    if (!s.items.length) return true; // empty org is acceptable
    return s.items.every(i => i.url.includes('/lightning/setup/ExternalStrings/page'));
  });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // ── @cmd picker ──────────────────────────────────────────────────────────
  section('@cmd picker');
  await step('@cmd opens the picker', async () => {
    await typeAndEnter(page, '@cmd');
    const s = await readPalette(page);
    return /cmd/i.test(s.breadcrumb) && /metadata/i.test(s.placeholder);
  });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // ── @setup picker ────────────────────────────────────────────────────────
  section('@setup picker');
  await step('@setup opens the picker', async () => {
    await typeAndEnter(page, '@setup');
    const s = await readPalette(page);
    return /setup/i.test(s.placeholder);
  });
  await step('lists multiple setup quick links', async () => {
    const s = await readPalette(page);
    return s.items.length >= 5;
  });
  await step('filtering "user" narrows the list', async () => {
    await page.fill('#sfnav-input', 'user');
    await page.waitForTimeout(150);
    const s = await readPalette(page);
    return s.items.length > 0 && s.items.some(i => /user/i.test(i.label));
  });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // ── Keyboard navigation ──────────────────────────────────────────────────
  section('Keyboard navigation');
  await step('@object then ArrowDown moves selection', async () => {
    await typeAndEnter(page, '@object');
    const before = (await readPalette(page)).items.findIndex(i => i.selected);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(80);
    const after = (await readPalette(page)).items.findIndex(i => i.selected);
    return after > before && after >= 0;
  });
  await step('ArrowUp reverses selection', async () => {
    const before = (await readPalette(page)).items.findIndex(i => i.selected);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(80);
    const after = (await readPalette(page)).items.findIndex(i => i.selected);
    return after === before - 1;
  });

  // ── Dismiss ──────────────────────────────────────────────────────────────
  section('Dismiss');
  await closePalette(page);
  await step('Escape eventually closes the palette', async () => {
    return page.evaluate(() => {
      const o = document.getElementById('sfnav-overlay');
      return !o || o.style.display === 'none';
    });
  });

  // ── Both Setup domains ───────────────────────────────────────────────────
  // Salesforce serves Setup from <org>.lightning.force.com and from the newer
  // <org>.my.salesforce-setup.com. Neither serves the REST API, so every
  // picker has to reach the org's my.salesforce.com host from both. These run
  // against the live org so a Salesforce-side URL change shows up here too.
  const domains = setupDomainUrls(url);
  for (const [name, domainUrl] of domains) {
    await checkDomain(ctx, name, domainUrl, fixtures);
  }

  // ── Stale flow cache ─────────────────────────────────────────────────────
  // The flow list is cached for 30 minutes. A flow activated since then must
  // still open on its new version (resolveFlowVersionId), not the cached one.
  section('Stale flow cache');
  if (!fixtures) {
    fail('skipped', 'needs a Salesforce CLI login to deploy test/e2e-org');
  } else {
    const stalePage = await ctx.newPage();
    attachLogging(stalePage, { filter: /sfnav.*(error|fail|failed|warn)/i });
    await gotoApp(stalePage, domains[0][1]);
    let newVersion;
    await step('a new version of the test flow is activated', async () => {
      bumpFixtureFlow(cli.org);
      newVersion = activeFlowVersion(cli.org);
      if (!newVersion || newVersion === fixtures.activeVersion) throw new Error('active version did not change');
      return true;
    });
    await gotoApp(stalePage, domains[0][1]); // reload: the flow list comes from the cache
    await step('@flow opens the new version, not the cached one', async () => {
      const r = await openFixtureFlow(ctx, stalePage);
      if (r.cachedId === newVersion) throw new Error('cache already had the new version — nothing was tested');
      if (r.landedId !== newVersion) throw new Error(`expected flowId=${newVersion}, ended on ${r.final}`);
      return true;
    });
    await stalePage.close();
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  await ctx.close();
  const total = passed + failed;
  console.log(`\n${BOLD}Results:${RESET} ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ''}${failed} failed${RESET}  ${DIM}(${total} total)${RESET}`);
  if (failures.length) {
    console.log(`\n${BOLD}Failures:${RESET}`);
    failures.forEach(f => console.log(`  ${RED}•${RESET} ${f.label}${f.detail ? ` — ${f.detail}` : ''}`));
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('\nFatal:', err.stack || err.message);
  process.exit(2);
});
