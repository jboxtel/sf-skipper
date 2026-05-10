// End-to-end tests against a real Salesforce org.
//
// Setup (one-time):
//   1. Create .sf-credentials with SF_USERNAME, SF_PASSWORD, SF_TEST_URL.
//      SF_TEST_URL must point at the org's Setup home, e.g.
//      SF_TEST_URL=https://yourorg.lightning.force.com/lightning/setup/SetupOneHome/home
//   2. Run: npm run e2e
//
// Override URL: node e2e.js <url>

const {
  loadCreds,
  launchContext,
  attachLogging,
  gotoApp,
  openPalette,
  closePalette,
  readPalette,
  typeAndEnter,
} = require('./e2e-helpers');

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

(async () => {
  const creds = loadCreds();
  const url = process.argv[2] || creds.SF_TEST_URL;
  if (!url) {
    console.error('No URL provided. Set SF_TEST_URL in .sf-credentials, or pass as the first arg.');
    process.exit(1);
  }

  console.log(`${BOLD}Salesforce Commander — end-to-end tests${RESET}\n${DIM}Org: ${url}${RESET}`);

  const ctx = await launchContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  attachLogging(page, { filter: /sfnav.*(error|fail|failed|warn)/i });

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
