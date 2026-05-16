// SOQL grounding eval harness.
//
// Boots Playwright, injects soql.js + its dependencies into a blank page,
// stubs Salesforce REST + the chrome.runtime Claude bridge with fixture data,
// then runs generateSoql(prompt) against every (prompt × org) pair in the
// matrix and asserts on the parsed result.
//
// Real Anthropic calls go through page.exposeFunction so the model actually
// has to ground against the fixture's schema/counts — stubbing Claude would
// defeat the purpose of an eval.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... npm run eval:soql
//   ANTHROPIC_API_KEY=sk-ant-... node test/soql-eval.js <orgName> <promptId>

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ORGS_DIR = path.join(FIXTURES_DIR, 'orgs');
const PROMPTS_FILE = path.join(FIXTURES_DIR, 'prompts.json');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readJsonIfExists(p) {
  try { return readJson(p); } catch (_) { return null; }
}

function loadOrg(name) {
  const dir = path.join(ORGS_DIR, name);
  const describeDir = path.join(dir, 'describe');
  const describes = {};
  if (fs.existsSync(describeDir)) {
    for (const f of fs.readdirSync(describeDir)) {
      if (f.endsWith('.json')) {
        describes[f.replace(/\.json$/, '')] = readJson(path.join(describeDir, f));
      }
    }
  }
  return {
    name,
    meta: readJson(path.join(dir, 'meta.json')),
    sobjects: readJson(path.join(dir, 'sobjects.json')),
    counts: readJsonIfExists(path.join(dir, 'counts.json')) || {},
    recordTypes: readJsonIfExists(path.join(dir, 'record-types.json')) || [],
    describes
  };
}

async function callAnthropic(apiKey, model, system, user) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error('Anthropic ' + resp.status + ': ' + body.slice(0, 300));
  }
  const data = await resp.json();
  const block = (data.content || []).find(b => b.type === 'text');
  return block ? block.text : '';
}

function evaluateResult(r, expect) {
  if (!r.ok) {
    return { pass: false, reasons: ['generateSoql threw: ' + r.error] };
  }
  const { soql, objectName } = r.result;
  const reasons = [];
  if (expect.object && objectName !== expect.object) {
    reasons.push(`expected object=${expect.object}, got ${objectName}`);
  }
  for (const pat of expect.mustInclude || []) {
    if (!new RegExp(pat, 'i').test(soql)) reasons.push(`SOQL missing: /${pat}/i`);
  }
  for (const pat of expect.mustNotInclude || []) {
    if (new RegExp(pat, 'i').test(soql)) reasons.push(`SOQL contains forbidden: /${pat}/i`);
  }
  return { pass: reasons.length === 0, reasons };
}

async function setupFixture(page, org) {
  await page.evaluate((fix) => {
    window.__fixture = fix;

    // Reset soql.js module-level caches between runs
    if (typeof _describeCache !== 'undefined') {
      for (const k of Object.keys(_describeCache)) delete _describeCache[k];
    }
    if (typeof _countCache !== 'undefined') {
      for (const k of Object.keys(_countCache)) delete _countCache[k];
    }
    if (typeof _recordTypesCache !== 'undefined') {
      window._recordTypesCache = null;
    }

    // Seed objects.js custom-object cache from fixture
    window._customObjects = fix.sobjects.map(s => ({
      apiName: s.name,
      label: s.label,
      isCustom: !!s.custom,
      keyPrefix: s.keyPrefix || null
    }));

    // Stub fetch — route by URL pattern against fixture data
    window.fetch = (url) => {
      const u = String(url);
      if (u.endsWith('/services/data/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ url: '/services/data/v60.0/', version: '60.0' }])
        });
      }
      if (/\/sobjects\/?$/.test(u)) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ sobjects: fix.sobjects })
        });
      }
      const dm = u.match(/\/sobjects\/([^/]+)\/describe$/);
      if (dm) {
        const apiName = decodeURIComponent(dm[1]);
        const d = fix.describes[apiName];
        if (!d) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(d) });
      }
      const cm = u.match(/\/query\/?\?q=([^&]+)/);
      if (cm) {
        const q = decodeURIComponent(cm[1]);
        // RecordType query — serve full records from record-types.json
        if (/FROM\s+RecordType\b/i.test(q)) {
          const records = (fix.recordTypes || []).map((rt, i) => ({
            attributes: { type: 'RecordType', url: '/services/data/v60.0/sobjects/RecordType/0120000000RT' + (i + 1).toString().padStart(3, '0') },
            SobjectType: rt.SobjectType,
            DeveloperName: rt.DeveloperName,
            Name: rt.Name
          }));
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ totalSize: records.length, done: true, records })
          });
        }
        // COUNT() query — extract FROM <Name>, return totalSize from fixture
        const m = q.match(/FROM\s+(\S+)/i);
        const apiName = m ? m[1] : null;
        const totalSize = apiName && fix.counts[apiName] != null ? fix.counts[apiName] : 0;
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ totalSize, done: true, records: [] })
        });
      }
      // Query planner — always succeed in the harness; we measure object choice + structure,
      // not parser conformance. (Parser conformance is the planner's job in real runs.)
      if (u.includes('/query/?explain=') || u.includes('/query?explain=')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ plans: [] }) });
      }
      return Promise.resolve({
        ok: false, status: 404,
        json: () => Promise.resolve({ message: 'eval-harness: unstubbed URL ' + u })
      });
    };
  }, org);
}

async function runOne(page, org, promptText) {
  await setupFixture(page, org);
  return await page.evaluate(async (p) => {
    try {
      const result = await generateSoql(p);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, promptText);
}

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY must be set to run the eval harness.');
    process.exit(2);
  }
  const model = process.env.SOQL_EVAL_MODEL || 'claude-sonnet-4-6';

  const orgFilter = process.argv[2] || null;
  const promptFilter = process.argv[3] || null;

  const prompts = readJson(PROMPTS_FILE);
  const orgNames = fs.readdirSync(ORGS_DIR).filter(
    n => fs.statSync(path.join(ORGS_DIR, n)).isDirectory()
  );
  const orgs = Object.fromEntries(orgNames.map(n => [n, loadOrg(n)]));

  const cells = [];
  for (const p of prompts) {
    const targets = p.orgs && p.orgs.length ? p.orgs : orgNames;
    for (const orgName of targets) {
      if (orgFilter && orgFilter !== orgName) continue;
      if (promptFilter && promptFilter !== p.id) continue;
      if (!orgs[orgName]) {
        console.warn(`skipping ${p.id} × ${orgName}: org fixture missing`);
        continue;
      }
      const expect = (p.expect && p.expect[orgName]) || {};
      cells.push({ prompt: p, org: orgs[orgName], expect });
    }
  }
  if (cells.length === 0) {
    console.error('No matrix cells matched. Check filters and fixtures.');
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('data:text/html,<html><body></body></html>');

  await page.exposeFunction('__callClaude', async (system, user) => {
    return callAnthropic(apiKey, model, system, user);
  });

  // Inject the production scripts in dependency order
  for (const f of ['salesforce-urls.js', 'shared.js', 'objects.js', 'soql.js']) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }

  // Stub chrome surface — route soql.generate to our exposed Anthropic caller
  await page.evaluate(() => {
    window.getOrgBase = () => 'https://myorg.lightning.force.com';
    window.getApiBase = () => '';
    window.chrome = {
      runtime: {
        sendMessage: (msg, cb) => {
          if (msg && msg.type === 'soql.generate') {
            window.__callClaude(msg.system, msg.user).then(
              text => cb({ ok: true, text }),
              e => cb({ ok: false, error: e.message })
            );
            return;
          }
          if (msg && msg.type === 'getSession') { cb({ sid: 'fake-sid' }); return; }
          cb({ ok: false, error: 'eval-harness: unhandled chrome message ' + (msg && msg.type) });
        }
      },
      storage: { local: { get: (_k, cb) => cb({}), set: () => {} } }
    };
  });

  console.log(`\n${BOLD}SOQL grounding eval${RESET}  ${DIM}(model: ${model})${RESET}\n`);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const cell of cells) {
    const label = `${cell.prompt.id} × ${cell.org.name}`;
    process.stdout.write(`  ${label} ${DIM}...${RESET} `);
    const t0 = Date.now();
    let r;
    try {
      r = await runOne(page, cell.org, cell.prompt.prompt);
    } catch (e) {
      r = { ok: false, error: 'runner: ' + e.message };
    }
    const dt = Date.now() - t0;
    const v = evaluateResult(r, cell.expect);
    if (v.pass) {
      passed++;
      const summary = r.result ? `${r.result.objectName}` : '';
      console.log(`${GREEN}PASS${RESET} ${DIM}(${dt}ms, ${summary})${RESET}`);
    } else {
      failed++;
      console.log(`${RED}FAIL${RESET} ${DIM}(${dt}ms)${RESET}`);
      v.reasons.forEach(reason => console.log(`      - ${reason}`));
      if (r.ok) {
        console.log(`      ${DIM}SOQL:${RESET} ${r.result.soql}`);
      }
      failures.push({ label, reasons: v.reasons, result: r });
    }
  }

  await browser.close();

  console.log(`\n${BOLD}${passed} passed, ${failed} failed${RESET} (out of ${cells.length})\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
