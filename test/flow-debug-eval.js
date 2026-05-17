// Flow Debug grounding eval harness.
//
// Boots Playwright, injects flow-debug.js + its dependencies into a blank page,
// stubs the Salesforce REST + Tooling API + the chrome.runtime Claude bridge
// with fixture data, then runs analyzeFlowDebug(flowId, debug, expectation)
// against every case and asserts on the parsed { summary, rootCause, fix }.
//
// Real Anthropic calls go through page.exposeFunction so the model actually
// has to ground against the fixture's flow metadata and object describes —
// stubbing Claude would defeat the purpose of an eval.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... npm run eval:flow-debug
//   ANTHROPIC_API_KEY=sk-ant-... node test/flow-debug-eval.js <caseName>

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EVALS_DIR = path.join(ROOT, 'evals', 'flow-debug');

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

function readTextIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

function discoverCases() {
  if (!fs.existsSync(EVALS_DIR)) return [];
  const found = [];
  for (const name of fs.readdirSync(EVALS_DIR)) {
    const dir = path.join(EVALS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, 'flow.json'))) continue;
    if (!fs.existsSync(path.join(dir, 'expect.json'))) continue;
    found.push({ name, dir });
  }
  return found;
}

function loadCase(name, dir) {
  const describesDir = path.join(dir, 'describes');
  const describes = {};
  if (fs.existsSync(describesDir)) {
    for (const f of fs.readdirSync(describesDir)) {
      if (f.endsWith('.json')) {
        describes[f.replace(/\.json$/, '')] = readJson(path.join(describesDir, f));
      }
    }
  }
  return {
    name,
    dir,
    meta: readJsonIfExists(path.join(dir, 'meta.json')) || {},
    flow: readJson(path.join(dir, 'flow.json')),
    debug: readTextIfExists(path.join(dir, 'debug.txt')),
    expectation: readTextIfExists(path.join(dir, 'expectation.txt')),
    recordTypes: readJsonIfExists(path.join(dir, 'record-types.json')) || [],
    describes,
    expect: readJson(path.join(dir, 'expect.json'))
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

// Mirror of test/soql-eval.js — strip PCRE (?i) inline flag so patterns stay
// portable across grep/Python/JS. We apply 'i' globally below.
function compilePattern(pat) {
  return new RegExp(pat.replace(/\(\?i\)/g, ''), 'i');
}

function checkPatterns(field, value, includes, excludes) {
  const reasons = [];
  const text = String(value == null ? '' : value);
  for (const pat of includes || []) {
    if (!compilePattern(pat).test(text)) reasons.push(`${field} missing: /${pat}/i`);
  }
  for (const pat of excludes || []) {
    if (compilePattern(pat).test(text)) reasons.push(`${field} contains forbidden: /${pat}/i`);
  }
  return reasons;
}

function evaluateResult(r, expect) {
  if (!r.ok) {
    return { pass: false, reasons: ['analyzeFlowDebug threw: ' + r.error] };
  }
  const { summary, rootCause, fix } = r.result;
  const fixText = Array.isArray(fix) ? fix.join('\n') : String(fix || '');
  const reasons = []
    .concat(checkPatterns('summary', summary, expect.summaryInclude, expect.summaryExclude))
    .concat(checkPatterns('rootCause', rootCause, expect.rootCauseInclude, expect.rootCauseExclude))
    .concat(checkPatterns('fix', fixText, expect.fixInclude, expect.fixExclude));
  if (expect.fixMinSteps && (!Array.isArray(fix) || fix.length < expect.fixMinSteps)) {
    reasons.push(`fix has ${Array.isArray(fix) ? fix.length : 0} steps, expected at least ${expect.fixMinSteps}`);
  }
  return { pass: reasons.length === 0, reasons };
}

async function setupFixture(page, fix) {
  await page.evaluate((c) => {
    window.__fixture = c;

    // Reset module-level caches between cases
    if (typeof _flowMetadataCache !== 'undefined') {
      for (const k of Object.keys(_flowMetadataCache)) delete _flowMetadataCache[k];
    }
    if (typeof _describeCache !== 'undefined') {
      for (const k of Object.keys(_describeCache)) delete _describeCache[k];
    }
    if (typeof _countCache !== 'undefined') {
      for (const k of Object.keys(_countCache)) delete _countCache[k];
    }
    if (typeof _recordTypesCache !== 'undefined') {
      window._recordTypesCache = null;
    }

    window.fetch = (url) => {
      const u = String(url);
      if (u.endsWith('/services/data/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ url: '/services/data/v60.0/', version: '60.0' }])
        });
      }
      // sobjects/X/describe
      const dm = u.match(/\/sobjects\/([^/]+)\/describe$/);
      if (dm) {
        const apiName = decodeURIComponent(dm[1]);
        const d = c.describes[apiName];
        if (!d) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(d) });
      }
      // Tooling API: SELECT ... FROM Flow WHERE Id = '...'
      const tooling = u.match(/\/tooling\/query\/?\?q=([^&]+)/);
      if (tooling) {
        const q = decodeURIComponent(tooling[1]);
        if (/FROM\s+Flow\b/i.test(q)) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ totalSize: 1, done: true, records: [c.flow] })
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ totalSize: 0, done: true, records: [] }) });
      }
      // Standard query: RecordType lookup
      const cm = u.match(/\/query\/?\?q=([^&]+)/);
      if (cm) {
        const q = decodeURIComponent(cm[1]);
        if (/FROM\s+RecordType\b/i.test(q)) {
          const records = (c.recordTypes || []).map((rt, i) => ({
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
        // COUNT() / other queries — return empty
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ totalSize: 0, done: true, records: [] })
        });
      }
      return Promise.resolve({
        ok: false, status: 404,
        json: () => Promise.resolve({ message: 'eval-harness: unstubbed URL ' + u })
      });
    };
  }, fix);
}

async function runOne(page, caseObj) {
  await setupFixture(page, caseObj);
  return await page.evaluate(async (args) => {
    try {
      const result = await analyzeFlowDebug(args.flowId, args.debug, args.expectation);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, { flowId: caseObj.flow.Id, debug: caseObj.debug, expectation: caseObj.expectation });
}

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY must be set to run the eval harness.');
    process.exit(2);
  }
  // Match background.js production default so the eval predicts real @debug behavior.
  const model = process.env.FLOW_DEBUG_EVAL_MODEL || 'claude-haiku-4-5-20251001';

  const caseFilter = process.argv[2] || null;

  const cases = discoverCases()
    .filter(c => !caseFilter || c.name === caseFilter)
    .map(c => loadCase(c.name, c.dir));

  if (cases.length === 0) {
    console.error(`No flow-debug eval cases found in ${EVALS_DIR}${caseFilter ? ` matching "${caseFilter}"` : ''}.`);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('data:text/html,<html><body></body></html>');

  await page.exposeFunction('__callClaude', async (system, user) => {
    return callAnthropic(apiKey, model, system, user);
  });

  // Inject production scripts. flow-debug uses fetchDescribe / loadRecordTypes
  // from soql.js, so include it too.
  for (const f of ['salesforce-urls.js', 'shared.js', 'objects.js', 'soql.js', 'flow-debug.js']) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }

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

  console.log(`\n${BOLD}Flow Debug grounding eval${RESET}  ${DIM}(model: ${model})${RESET}\n`);

  let passed = 0;
  let failed = 0;

  for (const c of cases) {
    process.stdout.write(`  ${c.name} ${DIM}...${RESET} `);
    const t0 = Date.now();
    let r;
    try {
      r = await runOne(page, c);
    } catch (e) {
      r = { ok: false, error: 'runner: ' + e.message };
    }
    const dt = Date.now() - t0;
    const v = evaluateResult(r, c.expect);
    if (v.pass) {
      passed++;
      console.log(`${GREEN}PASS${RESET} ${DIM}(${dt}ms)${RESET}`);
    } else {
      failed++;
      console.log(`${RED}FAIL${RESET} ${DIM}(${dt}ms)${RESET}`);
      v.reasons.forEach(reason => console.log(`      - ${reason}`));
      if (r.ok) {
        console.log(`      ${DIM}summary:${RESET}   ${r.result.summary || ''}`);
        console.log(`      ${DIM}rootCause:${RESET} ${r.result.rootCause || ''}`);
        const fix = Array.isArray(r.result.fix) ? r.result.fix : [];
        fix.forEach((step, i) => console.log(`      ${DIM}fix[${i}]:${RESET}    ${step}`));
      }
    }
  }

  await browser.close();

  console.log(`\n${BOLD}${passed} passed, ${failed} failed${RESET} (out of ${cases.length})\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
