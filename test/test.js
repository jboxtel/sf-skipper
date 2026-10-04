const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ${GREEN}✓${RESET} ${label}`);
  passed++;
}

function fail(label, detail) {
  console.log(`  ${RED}✗${RESET} ${label}`);
  if (detail) console.log(`    ${RED}${detail}${RESET}`);
  failed++;
}

async function assert(label, condition, detail) {
  if (await condition()) {
    ok(label);
  } else {
    fail(label, detail);
  }
}

async function injectExtension(page) {
  // Inject CSS
  await page.addStyleTag({ path: path.join(EXT, 'content.css') });

  // Inject scripts as script tags so const/let declarations are shared across all of them.
  // Order matters: salesforce-urls (getApiBase) → shared (sfRestPreamble) → objects/commands.
  // markdown.js holds esc + renderAskMarkdown, used by content.js.
  for (const file of ['salesforce-urls.js', 'shared.js', 'markdown.js', 'objects.js', 'commands.js', 'export.js']) {
    await page.addScriptTag({ path: path.join(EXT, file) });
  }

  // Stubs: chrome API + fetch (mocking Salesforce REST API response)
  const contentSrc = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  await page.addScriptTag({
    content: `
      window.chrome = window.chrome || {
        runtime: {},
        storage: { local: { get: (_k, cb) => cb({}), set: () => {} } }
      };
      // flows.js / apps.js / labels.js / permsets.js / users.js / soql.js / ask.js
      // aren't injected — stub every symbol content.js / commands.js reaches for.
      window.initFlows = () => {};
      window.getAllFlows = () => [];
      window.getFlowsState = () => 'idle';
      window.getFlowsError = () => '';
      window.resolveFlowPicker = () => ({ mode: 'flow-picker', results: [], hint: '' });
      window.initApps = () => {};
      window.getAllApps = () => [];
      window.getAppsState = () => 'idle';
      window.getAppsError = () => '';
      window.resolveAppPicker = () => ({ mode: 'app-picker', results: [], hint: '' });
      window.initLabels = () => {};
      window.getAllLabels = () => [];
      window.getLabelsState = () => 'idle';
      window.getLabelsError = () => '';
      window.resolveLabelPicker = () => ({ mode: 'label-picker', results: [], hint: '' });
      window.initPermsets = () => {};
      window.getAllPermsets = () => [];
      window.getPermsetsState = () => 'idle';
      window.getPermsetsError = () => '';
      window.resolvePermsetPicker = () => ({ mode: 'permset-picker', results: [], hint: '' });
      window.initUsers = () => {};
      window.getAllUsers = () => [];
      window.getUsersState = () => 'idle';
      window.getUsersError = () => '';
      window.resolveUserPicker = () => ({ mode: 'user-picker', results: [], hint: '' });
      window.hasSoqlApiKey = () => Promise.resolve(false);
      window.getActiveProviderSummary = () => Promise.resolve(null);
      window.generateSoql = () => Promise.reject(new Error('not stubbed'));
      window.getSoqlHistory = () => Promise.resolve([]);
      window.addToSoqlHistory = () => Promise.resolve();
      // soql.js isn't injected — @export autocomplete reads its describe cache
      window.fetchDescribe = (apiName) => Promise.resolve(apiName === 'Account' ? [
        { name: 'Id', label: 'Account ID', type: 'id' },
        { name: 'Name', label: 'Account Name', type: 'string' },
        { name: 'OwnerId', label: 'Owner', type: 'reference', referenceTo: ['User'], relationshipName: 'Owner' }
      ] : []);
      // flow-debug.js isn't injected — stub the symbols content.js / commands.js touch
      window.isFlowBuilderPage = () => false;
      window.getFlowIdFromUrl = () => null;
      window.analyzeFlowDebug = () => Promise.reject(new Error('not stubbed'));
      // ask.js isn't injected — stub the symbols content.js touches
      window.runAsk = () => Promise.reject(new Error('not stubbed'));
      window.getAskOrgContext = () => ({ url: '', host: '' });
      // CMDT helpers live in cmdt.js (not injected) — stub the lookups
      window.getKeyPrefixForCmdt = () => Promise.reject(new Error('not stubbed'));
      window.getEntityIdForCmdt = () => Promise.reject(new Error('not stubbed'));
      window.getAllCustomMetadataTypes = () => [];
      // Mock fetch so @load returns 2 test custom objects
      window.fetch = (url) => {
        if (url === '/services/data/') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([{ url: '/services/data/v61.0/', version: 'v61.0' }]) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          sobjects: [
            { name: 'Claim__c',         label: 'Claim',          custom: true  },
            { name: 'ClaimLineItem__c', label: 'Claim Line Item', custom: true  },
            { name: 'Account',          label: 'Account',         custom: false },
          ]
        })});
      };
      ${contentSrc}
    `,
  });
}

async function openPalette(page) {
  // Trigger via keyboard shortcut (Playwright sends to the page directly, bypassing Chrome UI)
  await page.keyboard.press('Control+Shift+K');
  // Give the palette time to appear
  await page.waitForSelector('#sfnav-overlay', { timeout: 2000 }).catch(() => null);
}

(async () => {
  console.log(`\n${BOLD}Salesforce Setup Navigator — Playwright Tests${RESET}\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('data:text/html,<html><body><h1>Mock Salesforce</h1></body></html>');
  await injectExtension(page);

  // Override URL helpers so assertions have predictable values
  await page.evaluate(() => {
    window.getOrgBase = () => 'https://myorg.lightning.force.com';
    window.getApiBase = () => '';  // keep fetch URLs relative so the mock matches
  });

  // ── Test 1: palette hidden on load ──────────────────────────────────────
  console.log('Palette visibility');
  await assert(
    'palette is not visible initially',
    async () => {
      const overlay = await page.$('#sfnav-overlay');
      return overlay === null;
    },
    '#sfnav-overlay found in DOM before any interaction',
  );

  // ── Test 2: Ctrl+Shift+K opens palette ──────────────────────────────────
  await openPalette(page);

  await assert(
    'Ctrl+Shift+K shows the palette',
    async () => {
      const display = await page.$eval('#sfnav-overlay', el => el.style.display).catch(() => null);
      return display === 'flex';
    },
    '#sfnav-overlay not visible after keypress',
  );

  await assert(
    'input field is focused',
    async () => {
      return page.evaluate(() => document.activeElement?.id === 'sfnav-input');
    },
    'sfnav-input not focused',
  );

  // ── Test 3: root state shows setup links ────────────────────────────────
  console.log('\nRoot state');
  await assert(
    'shows setup quick links by default',
    async () => {
      const count = await page.$$eval('.sfnav-item', els => els.length);
      return count >= 5;
    },
    'fewer than 5 items shown in root state',
  );

  await assert(
    'hint text is visible',
    async () => {
      const hint = await page.$eval('#sfnav-hint', el => el.textContent);
      return hint.length > 0;
    },
    'hint text is empty',
  );

  // ── Test 4: @account → object-scoped ────────────────────────────────────
  console.log('\n@account → object-scoped mode');
  await page.fill('#sfnav-input', '@account');
  await page.waitForTimeout(50);

  await assert(
    'switches to object-scoped mode',
    async () => {
      const breadcrumb = await page.$eval('#sfnav-breadcrumb', el => el.textContent);
      return breadcrumb.includes('Account');
    },
    'breadcrumb does not show "Account"',
  );

  await assert(
    'shows object sub-pages',
    async () => {
      const labels = await page.$$eval('.sfnav-label', els => els.map(e => e.textContent));
      return labels.includes('Fields & Relationships') && labels.includes('Validation Rules');
    },
    'Fields & Relationships or Validation Rules not in results',
  );

  await assert(
    'sub-page URLs point to correct org',
    async () => {
      const url = await page.$eval('.sfnav-item[data-url]', el => el.dataset.url);
      return url.startsWith('https://myorg.lightning.force.com/lightning/setup/ObjectManager/Account/');
    },
    'URL does not contain expected org base',
  );

  // ── Test 5: @account fields → filtered sub-pages ────────────────────────
  console.log('\n@account fields → filtered sub-pages');
  await page.fill('#sfnav-input', '@account fields');
  await page.waitForTimeout(50);

  await assert(
    'top result is "Fields & Relationships"',
    async () => {
      const first = await page.$eval('.sfnav-item.selected .sfnav-label', el => el.textContent);
      return first === 'Fields & Relationships';
    },
    'first result is not "Fields & Relationships"',
  );

  // ── Test 6: @account validation → Validation Rules ──────────────────────
  await page.fill('#sfnav-input', '@account val');
  await page.waitForTimeout(50);

  await assert(
    '@account val → top result is Validation Rules',
    async () => {
      const first = await page.$eval('.sfnav-item.selected .sfnav-label', el => el.textContent).catch(() => null);
      return first === 'Validation Rules';
    },
    'first result is not "Validation Rules"',
  );

  // ── Test 7: @objects shows all objects ──────────────────────────────────
  console.log('\n@objects mode');
  await page.fill('#sfnav-input', '@objects');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);

  await assert(
    '@objects shows many objects',
    async () => {
      const count = await page.$$eval('.sfnav-item', els => els.length);
      return count >= 20;
    },
    'fewer than 20 objects shown',
  );

  await assert(
    '@objects acc filters to Account etc.',
    async () => {
      await page.fill('#sfnav-input', '@objects acc');
      await page.waitForTimeout(50);
      const labels = await page.$$eval('.sfnav-label', els => els.map(e => e.textContent));
      return labels.some(l => l.toLowerCase().includes('account'));
    },
    'no account-related object in filtered list',
  );

  // ── Test 8: @flows shortcut hint ────────────────────────────────────────
  // Escape back to root before testing the hint.
  await page.keyboard.press('Escape');
  console.log('\n@flows shortcut hint');
  await page.fill('#sfnav-input', '@flows');
  await page.waitForTimeout(50);

  await assert(
    '@flows shows the browse shortcut hint',
    async () => {
      const hint = await page.$eval('#sfnav-hint', el => el.textContent).catch(() => null);
      return hint === 'Press Enter to browse all flows';
    },
    'flow shortcut hint missing',
  );

  // ── Test 9: @load via REST API mock ─────────────────────────────────────
  console.log('\n@load via REST API');

  // Playwright unwraps Promises returned from page.evaluate, so we can await loadObjectsFromPage directly
  const loadCount = await page.evaluate(() => loadObjectsFromPage());

  await assert(
    '@load fetches and caches objects from REST API',
    async () => loadCount === 3,
    `expected 3 objects, got ${loadCount}`,
  );

  await assert(
    'getAllObjects includes loaded custom objects',
    async () => {
      const names = await page.evaluate(() => getAllObjects().map(o => o.apiName));
      return names.includes('ClaimLineItem__c') && names.includes('Claim__c');
    },
    'ClaimLineItem__c or Claim__c not found in getAllObjects()',
  );

  await page.fill('#sfnav-input', '@ClaimLineItem__c');
  await page.waitForTimeout(50);

  await assert(
    '@ClaimLineItem__c resolves to object-scoped mode',
    async () => {
      const breadcrumb = await page.$eval('#sfnav-breadcrumb', el => el.textContent).catch(() => '');
      return breadcrumb.includes('Claim Line Item');
    },
    'breadcrumb does not show "Claim Line Item"',
  );

  await assert(
    'custom object sub-pages have correct URL',
    async () => {
      const url = await page.$eval('.sfnav-item[data-url]', el => el.dataset.url).catch(() => '');
      return url.includes('/ClaimLineItem__c/');
    },
    'URL does not contain ClaimLineItem__c',
  );

  // ── Test 10: keyboard navigation ─────────────────────────────────────────
  console.log('\nKeyboard navigation');
  await page.fill('#sfnav-input', '@objects');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);

  const initialSelected = await page.$eval('.sfnav-item.selected', el => el.textContent).catch(() => null);
  await page.keyboard.press('ArrowDown');
  const afterDown = await page.$eval('.sfnav-item.selected', el => el.textContent).catch(() => null);

  await assert(
    'ArrowDown moves selection',
    async () => initialSelected !== afterDown,
    'selection did not change after ArrowDown',
  );

  await page.keyboard.press('ArrowUp');
  const afterUp = await page.$eval('.sfnav-item.selected', el => el.textContent).catch(() => null);

  await assert(
    'ArrowUp moves selection back',
    async () => afterUp === initialSelected,
    'selection did not return to original after ArrowUp',
  );

  // ── Test 11: Escape closes palette ──────────────────────────────────────
  // Two Escapes: first pops out of object-picker (from the keyboard-nav
  // test) back to root; second hides the palette.
  console.log('\nDismiss');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await assert(
    'Escape hides the palette',
    async () => {
      const display = await page.$eval('#sfnav-overlay', el => el.style.display).catch(() => 'none');
      return display === 'none';
    },
    'palette still visible after Escape',
  );

  // ── Test 12: @export runs SOQL and renders a grid ───────────────────────
  console.log('\n@export');
  await page.evaluate(() => {
    window.__queryUrls = [];
    window.__clipboard = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { window.__clipboard = t; return Promise.resolve(); } }
    });
    const realFetch = window.fetch;
    const rec = (n, owner) => ({
      attributes: { type: 'Account' }, Id: '00100000000000' + n + 'AAA', Name: 'Acme ' + n,
      Owner: owner ? { attributes: { type: 'User' }, Name: owner } : null
    });
    window.fetch = (url, init) => {
      if (url.indexOf('/query/') !== -1 || url.indexOf('/query-more/') !== -1) {
        window.__queryUrls.push(url);
        const body = url.indexOf('/query-more/') !== -1
          ? { totalSize: 3, done: true, records: [rec(3, 'Kim')] }
          : { totalSize: 3, done: false, nextRecordsUrl: '/services/data/v61.0/query-more/01g-2000', records: [rec(1, null), rec(2, 'Jo')] };
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      }
      return realFetch(url, init);
    };
  });

  await openPalette(page);
  await page.fill('#sfnav-input', '@export ');
  await page.waitForTimeout(50);

  await assert(
    '@export stays hidden until its labs flag is on',
    async () => page.evaluate(() =>
      document.getElementById('sfnav-export').style.display !== 'flex' &&
      !Array.from(document.querySelectorAll('.sfnav-item')).some(el => el.textContent.includes('@export'))),
    '@export reachable without the labs flag',
  );

  await page.fill('#sfnav-input', '@labs');
  await page.waitForTimeout(50);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);

  await assert(
    '@labs → Enter turns the export flag on',
    async () => page.evaluate(() => sfnavLabEnabled('export') &&
      /export is on/.test(document.getElementById('sfnav-hint').textContent)),
    'hint: ' + await page.$eval('#sfnav-hint', el => el.textContent),
  );

  await page.fill('#sfnav-input', '@export ');
  await page.waitForTimeout(50);

  await assert(
    '@export opens at normal width with the editor focused',
    async () => page.evaluate(() =>
      document.getElementById('sfnav-export').style.display === 'flex' &&
      !document.getElementById('sfnav-palette').classList.contains('sfnav-wide') &&
      document.activeElement.id === 'sfnav-export-query'),
    'panel not shown, palette already wide, or editor not focused',
  );

  await page.keyboard.type('SELECT  FROM Account');
  await page.evaluate(() => document.getElementById('sfnav-export-query').setSelectionRange(7, 7));
  await page.keyboard.type('Na');
  await page.waitForSelector('#sfnav-export-ac li', { timeout: 1000 }).catch(() => null);
  await page.keyboard.press('Tab');

  await assert(
    'autocomplete suggests fields and Tab inserts one',
    async () => (await page.$eval('#sfnav-export-query', el => el.value)) === 'SELECT Name FROM Account',
    'editor value: ' + await page.$eval('#sfnav-export-query', el => el.value),
  );

  await page.fill('#sfnav-export-query', 'SELECT Id, Name, Owner.Name FROM Account');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => /3 rows/.test(document.getElementById('sfnav-export-summary').textContent), null, { timeout: 2000 }).catch(() => null);

  await assert(
    'follows nextRecordsUrl, shows every row and widens the palette',
    async () => page.evaluate(() =>
      window.__queryUrls.length === 2 &&
      document.querySelectorAll('#sfnav-export-grid tbody tr').length === 3 &&
      document.getElementById('sfnav-palette').classList.contains('sfnav-wide')),
    'summary: ' + await page.$eval('#sfnav-export-summary', el => el.textContent),
  );

  await assert(
    'flattens parent lookups into dotted columns and links Ids',
    async () => page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('#sfnav-export-grid th')).map(th => th.textContent);
      return heads.join(',') === 'Id,Name,Owner.Name' &&
        !!document.querySelector('#sfnav-export-grid td a[href$="/001000000000001AAA"]');
    }),
    'unexpected columns or missing Id link',
  );

  await page.click('.sfnav-export-out[data-export="tsv"]');
  await page.waitForTimeout(50);

  await assert(
    'Copy Excel puts tab-separated rows on the clipboard',
    async () => page.evaluate(() => (window.__clipboard || '').split('\n')[0] === 'Id\tName\tOwner.Name' &&
      window.__clipboard.split('\n').length === 4),
    'clipboard: ' + JSON.stringify(await page.evaluate(() => window.__clipboard)),
  );

  const urlsBefore = await page.evaluate(() => window.__queryUrls.length);
  await page.fill('#sfnav-export-query', 'DELETE FROM Account');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(50);

  await assert(
    'non-SELECT queries are rejected before any request',
    async () => page.evaluate((n) =>
      window.__queryUrls.length === n &&
      /Only SELECT/.test(document.getElementById('sfnav-export-status').textContent), urlsBefore),
    'status: ' + await page.$eval('#sfnav-export-status', el => el.textContent),
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);

  await assert(
    'Escape returns to the root palette at normal width',
    async () => page.evaluate(() =>
      document.getElementById('sfnav-export').style.display === 'none' &&
      !document.getElementById('sfnav-palette').classList.contains('sfnav-wide') &&
      document.activeElement.id === 'sfnav-input'),
    'still in @export or palette still wide',
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  await browser.close();
  console.log(`\n${BOLD}Results: ${GREEN}${passed} passed${RESET}${BOLD}, ${failed > 0 ? RED : ''}${failed} failed${RESET}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
