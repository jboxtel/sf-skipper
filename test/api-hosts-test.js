// REST calls work from every Salesforce domain the content script runs on.
//
// Salesforce serves Setup from more than one domain: the classic Lightning
// host (<org>.lightning.force.com) and the newer Setup domain
// (<org>.my.salesforce-setup.com). Neither serves the REST API — every call
// has to go to <org>.my.salesforce.com. A miss here shows up as "Failed to load
// flows: Flow query 404" and breaks every cached picker on that domain.
//
// Each case loads the real scripts on a fake org page, answers REST calls only
// on the API host, and fails if a REST call goes anywhere else. It also covers
// the flow open path (version lookup, timeout fallback, persisted basePath).
//
// Run:
//   npm run test:api-hosts
//   node test/api-hosts-test.js

const { chromium } = require('playwright');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const API_HOST = 'acme.my.salesforce.com';

// Every hostname shape the content script can run on → the host REST calls
// must go to. Our test org is a recent Developer Edition on enhanced domains
// and the new Setup domain, so the older formats below (still common in
// production orgs and long-lived sandboxes) are only covered here.
const HOST_FORMATS = [
  // [page host, API host, what it is]
  ['acme.lightning.force.com', 'acme.my.salesforce.com', 'production, Lightning'],
  ['acme.my.salesforce-setup.com', 'acme.my.salesforce.com', 'production, new Setup domain'],
  ['acme.my.salesforce.com', 'acme.my.salesforce.com', 'production, Classic / My Domain'],
  ['acme--uat.sandbox.lightning.force.com', 'acme--uat.sandbox.my.salesforce.com', 'sandbox, enhanced domains, Lightning'],
  ['acme--uat.sandbox.my.salesforce-setup.com', 'acme--uat.sandbox.my.salesforce.com', 'sandbox, enhanced domains, Setup domain'],
  ['acme--uat.sandbox.my.salesforce.com', 'acme--uat.sandbox.my.salesforce.com', 'sandbox, enhanced domains, Classic'],
  ['acme--uat.lightning.force.com', 'acme--uat.my.salesforce.com', 'sandbox, pre-enhanced domains, Lightning'],
  ['acme--uat.my.salesforce.com', 'acme--uat.my.salesforce.com', 'sandbox, pre-enhanced domains, Classic'],
  ['acme--uat.cs42.my.salesforce.com', 'acme--uat.cs42.my.salesforce.com', 'sandbox, instanced My Domain, Classic'],
  ['acme-dev-ed.develop.lightning.force.com', 'acme-dev-ed.develop.my.salesforce.com', 'Developer Edition, enhanced, Lightning'],
  ['acme-dev-ed.develop.my.salesforce-setup.com', 'acme-dev-ed.develop.my.salesforce.com', 'Developer Edition, enhanced, Setup domain'],
  ['acme-dev-ed.lightning.force.com', 'acme-dev-ed.my.salesforce.com', 'Developer Edition, pre-enhanced, Lightning'],
  ['acme-dev-ed.trailblaze.lightning.force.com', 'acme-dev-ed.trailblaze.my.salesforce.com', 'Trailhead Playground, Lightning'],
  ['acme.scratch.lightning.force.com', 'acme.scratch.my.salesforce.com', 'scratch org, Lightning'],
  ['na85.salesforce.com', 'na85.salesforce.com', 'no My Domain, instance URL (Classic)'],
];

const FLOWS = [
  { Id: '300A', Label: 'Account - Before Save', ApiName: 'Account_Before_Save', ActiveVersionId: '301OLD', LatestVersionId: '301OLD' },
  { Id: '300B', Label: 'Case - Escalate', ApiName: 'Case_Escalate', ActiveVersionId: null, LatestVersionId: '301B' }
];

function json(route, body) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

// One fake org: a blank page on every host, REST only on API_HOST.
async function openOrgPage(browser, pageHost, state) {
  const context = await browser.newContext();
  const page = await context.newPage();

  await context.route('https://**/*', async (route) => {
    const url = new URL(route.request().url());
    const isRest = url.pathname.startsWith('/services/');
    if (!isRest) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>org</title>' });
    }
    state.requests.push(url.host + url.pathname);
    if (url.host !== (state.apiHost || API_HOST)) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '[{"errorCode":"RESOURCE_NOT_FOUND"}]' });
    }
    if (route.request().headers()['authorization'] !== 'Bearer SID') {
      return route.fulfill({ status: 401, body: 'missing session' });
    }
    if (url.pathname === '/services/data/') {
      return json(route, [{ version: '61.0', url: '/services/data/v61.0' }, { version: '62.0', url: '/services/data/v62.0' }]);
    }
    if (url.pathname === '/services/data/v62.0/query/') {
      const q = url.searchParams.get('q');
      if (/WHERE ApiName = 'Account_Before_Save'/.test(q)) {
        if (state.lookupDelayMs) await new Promise(r => setTimeout(r, state.lookupDelayMs));
        return json(route, { records: [{ ActiveVersionId: '301NEW', LatestVersionId: '301NEW' }] });
      }
      if (/FROM FlowDefinitionView/.test(q)) return json(route, { records: FLOWS });
    }
    return route.fulfill({ status: 404, body: 'unexpected ' + url.pathname });
  });

  await page.goto('https://' + pageHost + '/lightning/setup/SetupOneHome/home');

  // Stub the extension APIs the scripts use: the session comes from the
  // background, caches go to chrome.storage.local.
  await page.evaluate((stored) => {
    window.__storage = stored || {};
    window.chrome = {
      runtime: {
        getManifest: () => ({ update_url: 'store' }),
        sendMessage: (msg, cb) => setTimeout(() => cb(msg.type === 'getSession' ? { sid: 'SID' } : null), 0),
        lastError: null
      },
      storage: {
        local: {
          get: (key, cb) => {
            const keys = Array.isArray(key) ? key : [key];
            const out = {};
            keys.forEach(k => { if (window.__storage[k] !== undefined) out[k] = window.__storage[k]; });
            setTimeout(() => cb(out), 0);
          },
          set: (obj, cb) => { Object.assign(window.__storage, obj); if (cb) setTimeout(cb, 0); }
        }
      }
    };
  }, state.stored);

  for (const f of ['salesforce-urls.js', 'shared.js', 'cache-factory.js', 'flows.js']) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }
  return { page, context };
}

const CASES = [];

for (const [host, apiHost, what] of HOST_FORMATS) {
  CASES.push({
    name: `${what} (${host}): flow list loads via ${apiHost}`,
    async run(browser) {
      const state = { requests: [], apiHost };
      const { page, context } = await openOrgPage(browser, host, state);
      const r = await page.evaluate(async () => {
        const base = getApiBase();
        try { await loadFlows(); } catch (e) { return { base, error: e.message }; }
        return { base, flows: getAllFlows().length };
      });
      await context.close();
      const stray = state.requests.filter(u => !u.startsWith(apiHost + '/'));
      if (r.base !== 'https://' + apiHost) return { ok: false, detail: 'API base ' + r.base };
      if (r.error) return { ok: false, detail: r.error };
      if (stray.length) return { ok: false, detail: 'REST calls to ' + stray.join(', ') };
      return { ok: r.flows === 2, detail: JSON.stringify(r) };
    }
  });
}

for (const host of ['acme.lightning.force.com', 'acme.my.salesforce-setup.com']) {
  CASES.push({
    name: host + ': opening a flow resolves its current version',
    async run(browser) {
      const state = { requests: [] };
      const { page, context } = await openOrgPage(browser, host, state);
      const id = await page.evaluate(() =>
        resolveFlowVersionId({ apiName: 'Account_Before_Save', versionId: '301OLD', id: '300A' }));
      await context.close();
      return { ok: id === '301NEW', detail: 'got ' + id };
    }
  });
}

CASES.push({
  name: 'saved API version skips the version probe on the next page load',
  async run(browser) {
    const host = 'acme.my.salesforce-setup.com';
    const first = { requests: [] };
    let org = await openOrgPage(browser, host, first);
    await org.page.evaluate(() => loadFlows());
    const stored = await org.page.evaluate(() => window.__storage);
    await org.context.close();

    const second = { requests: [], stored };
    org = await openOrgPage(browser, host, second);
    await org.page.evaluate(() => loadFlows());
    await org.context.close();
    const probes = second.requests.filter(u => u.endsWith('/services/data/'));
    return {
      ok: !!stored['sfnavApiBasePath:' + host] && probes.length === 0,
      detail: 'stored ' + JSON.stringify(stored['sfnavApiBasePath:' + host]) + ', probes ' + probes.length
    };
  }
});

CASES.push({
  name: 'a malformed saved API version is ignored',
  async run(browser) {
    const host = 'acme.lightning.force.com';
    const state = { requests: [], stored: { ['sfnavApiBasePath:' + host]: { basePath: 'undefined', ts: Date.now() } } };
    const { page, context } = await openOrgPage(browser, host, state);
    const r = await page.evaluate(async () => {
      try { await loadFlows(); return { n: getAllFlows().length }; } catch (e) { return { error: e.message }; }
    });
    await context.close();
    return { ok: r.n === 2, detail: JSON.stringify(r) };
  }
});

CASES.push({
  name: 'a slow version lookup falls back to the cached version within ~1s',
  async run(browser) {
    const state = { requests: [], lookupDelayMs: 3000 };
    const { page, context } = await openOrgPage(browser, 'acme.lightning.force.com', state);
    const r = await page.evaluate(async () => {
      const t0 = Date.now();
      const id = await resolveFlowVersionId({ apiName: 'Account_Before_Save', versionId: '301OLD', id: '300A' });
      return { id, ms: Date.now() - t0 };
    });
    await context.close();
    return { ok: r.id === '301OLD' && r.ms < 1500, detail: JSON.stringify(r) };
  }
});

CASES.push({
  name: 'a prefetched lookup is reused when the flow is opened',
  async run(browser) {
    const state = { requests: [], lookupDelayMs: 300 };
    const { page, context } = await openOrgPage(browser, 'acme.lightning.force.com', state);
    const id = await page.evaluate(async () => {
      const flow = { apiName: 'Account_Before_Save', versionId: '301OLD', id: '300A' };
      prefetchFlowVersion(flow);
      await new Promise(r => setTimeout(r, 100));
      return resolveFlowVersionId(flow);
    });
    await context.close();
    const lookups = state.requests.filter(u => u.endsWith('/query/')).length;
    return { ok: id === '301NEW' && lookups === 1, detail: 'id ' + id + ', queries ' + lookups };
  }
});

(async () => {
  const browser = await chromium.launch();
  console.log(`\n${BOLD}API host tests${RESET}\n`);

  let passed = 0;
  let failed = 0;
  for (const c of CASES) {
    let r;
    try { r = await c.run(browser); } catch (e) { r = { ok: false, detail: 'threw: ' + e.message }; }
    if (r.ok) {
      passed++;
      console.log(`  ${GREEN}PASS${RESET} ${c.name}`);
    } else {
      failed++;
      console.log(`  ${RED}FAIL${RESET} ${c.name}`);
      console.log(`        ${DIM}${r.detail || '(no detail)'}${RESET}`);
    }
  }

  await browser.close();
  console.log(`\n${BOLD}${passed} passed, ${failed} failed${RESET} (out of ${CASES.length})\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
