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
const EVALS_DIR = path.join(ROOT, 'evals');

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

function discoverFixtures() {
  if (!fs.existsSync(EVALS_DIR)) return {};
  const found = {};
  for (const name of fs.readdirSync(EVALS_DIR)) {
    const dir = path.join(EVALS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, 'meta.json'))) continue;
    found[name] = dir;
  }
  return found;
}

function loadOrg(name, dir) {
  const describeDir = path.join(dir, 'describe');
  const describes = {};
  if (fs.existsSync(describeDir)) {
    for (const f of fs.readdirSync(describeDir)) {
      if (f.endsWith('.json')) {
        describes[f.replace(/\.json$/, '')] = readJson(path.join(describeDir, f));
      }
    }
  }
  const promptsFile = path.join(dir, 'prompts.json');
  return {
    name,
    dir,
    meta: readJson(path.join(dir, 'meta.json')),
    sobjects: readJson(path.join(dir, 'sobjects.json')),
    counts: readJsonIfExists(path.join(dir, 'counts.json')) || {},
    recordTypes: readJsonIfExists(path.join(dir, 'record-types.json')) || [],
    describes,
    prompts: readJsonIfExists(promptsFile) || []
  };
}

// Call the Anthropic Messages API. Accepts the full opts shape passed from
// the in-page `callClaude` helper so tool_use, tool_choice, and the cached
// system-prompt block all reach the API unchanged. Mirrors background.js's
// handleSoqlGenerate so the eval exercises the same request the extension
// would build in production.
//
// Returns { text, toolInput } — text is the first text block (may be empty
// when the model went straight to tool_use); toolInput is the parsed input
// object from the first tool_use block (null when the model didn't use a
// tool). Callers that ask for tools must look at toolInput, not text.
//
// On a 429 rate-limit response, honors the retry-after header (seconds) and
// retries up to ANTHROPIC_MAX_RETRIES times before propagating. The full-tier
// fixture has heavy schema dumps that easily blow the per-minute input-token
// budget on the Anthropic free tier; throttling between cells in the cell
// loop is the primary defense, this retry is a safety net.
const ANTHROPIC_MAX_RETRIES = 3;
const ANTHROPIC_DEFAULT_RETRY_S = 30;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAnthropic(apiKey, model, opts) {
  opts = opts || {};
  // Apply the same cache-control block transformation background.js does:
  // when caller passes a string system + cacheSystem flag, wrap into the
  // ephemeral-cache block shape the API expects.
  let system = opts.system;
  if (opts.cacheSystem && typeof system === 'string') {
    system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
  const body = {
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: opts.user }]
  };
  if (opts.tools && opts.tools.length) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;

  for (let attempt = 0; attempt <= ANTHROPIC_MAX_RETRIES; attempt++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required to read cache_control blocks; harmless on calls that don't use them.
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(body)
    });

    if (resp.status === 429 && attempt < ANTHROPIC_MAX_RETRIES) {
      // Anthropic returns retry-after in seconds (HTTP standard). Some
      // responses include a unix-timestamp variant; both are handled here.
      // Default to 30s if the header is missing — same order of magnitude as
      // the per-minute window resetting.
      const raw = resp.headers.get('retry-after');
      let waitMs = ANTHROPIC_DEFAULT_RETRY_S * 1000;
      if (raw) {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) {
          // Heuristic: values > 10^10 are unix seconds, smaller are deltas.
          waitMs = n > 1e10 ? Math.max(0, (n - Math.floor(Date.now() / 1000)) * 1000) : n * 1000;
        }
      }
      // Cap waits at a sane upper bound so a misbehaving server can't park us.
      waitMs = Math.min(waitMs, 90 * 1000);
      process.stderr.write(`\n      [rate-limited, retrying after ${Math.round(waitMs / 1000)}s] `);
      await sleep(waitMs);
      continue;
    }

    if (!resp.ok) {
      const bodyText = await resp.text();
      throw new Error('Anthropic ' + resp.status + ': ' + bodyText.slice(0, 300));
    }
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const toolBlock = (data.content || []).find(b => b.type === 'tool_use');
    return {
      text: (textBlock && textBlock.text) || '',
      toolInput: (toolBlock && toolBlock.input) || null
    };
  }
  throw new Error('Anthropic: retries exhausted after rate limiting');
}

// JS regex doesn't support PCRE inline flags like `(?i)`. Patterns written
// for portability (compatible with grep/Python) often include them — strip
// before compiling. We already apply the 'i' flag globally below, so the
// inline marker is redundant either way.
function compilePattern(pat) {
  return new RegExp(pat.replace(/\(\?i\)/g, ''), 'i');
}

function evaluateResult(r, expect) {
  if (!r.ok) {
    // When the picker honestly refuses (no known object matches the prompt), some
    // fixtures consider that the correct behavior — e.g. concepts the grounding
    // can't yet ground. Honor an explicit acceptRefusal flag in the expect block.
    if (expect.acceptRefusal && /Picker could not identify|Could not identify object/i.test(r.error)) {
      return { pass: true, reasons: [], note: 'refused (acceptRefusal=true)' };
    }
    return { pass: false, reasons: ['generateSoql threw: ' + r.error] };
  }
  const { soql, objectName } = r.result;
  const reasons = [];
  if (expect.object && objectName !== expect.object) {
    reasons.push(`expected object=${expect.object}, got ${objectName}`);
  }
  for (const pat of expect.mustInclude || []) {
    if (!compilePattern(pat).test(soql)) reasons.push(`SOQL missing: /${pat}/i`);
  }
  for (const pat of expect.mustNotInclude || []) {
    if (compilePattern(pat).test(soql)) reasons.push(`SOQL contains forbidden: /${pat}/i`);
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
    // Per-field populationality cache (item 2) — keyed by api name, so a
    // fixture swap with shared api names would otherwise read stale values.
    if (typeof _fieldPopCache !== 'undefined') {
      for (const k of Object.keys(_fieldPopCache)) delete _fieldPopCache[k];
    }
    // BM25 index cache (item 5) — invalidates on object count change in prod
    // but the harness can swap fixtures with the same count; reset to be safe.
    if (typeof _bm25IndexCache !== 'undefined') {
      window._bm25IndexCache = null;
      window._bm25IndexObjectCount = -1;
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

// Parse `--flag=value`, `--flag value`, and positional args. Used so the
// harness accepts `node soql-eval.js --tier=smoke <orgName> <promptId>` and
// the older positional-only form still works.
function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
        else { out[a.slice(2)] = true; }
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY must be set to run the eval harness.');
    process.exit(2);
  }
  // Default to the same model background.js uses in production (sfnavOptions.model
  // default) so the eval predicts real @soql behavior. Override with SOQL_EVAL_MODEL
  // for cross-model comparisons.
  const model = process.env.SOQL_EVAL_MODEL || 'claude-haiku-4-5-20251001';

  const args = parseArgs(process.argv.slice(2));
  const orgFilter = args.positional[0] || null;
  const promptFilter = args.positional[1] || null;
  const tierFilter = args.tier || null;
  // Default throttle: 5s between cells on the heavy `full` tier (Anthropic
  // free tier is 50K input tokens per minute, and the full fixture's schema
  // dumps eat 5–15K per call); 1.5s on the smoke tier — small fixtures don't
  // need a 5s delay, but 0s makes the eval flaky on bursts (planner + generator
  // + occasional retry in quick succession can briefly cross the ITPM cap and
  // trigger 429 retries that delay specific cells by 30s). 1.5s smooths the
  // burst without making the run feel slow. Explicit --throttle=<ms> wins.
  const throttleMs = args.throttle != null
    ? parseInt(args.throttle, 10)
    : (tierFilter === 'smoke' ? 1500 : 5000);

  const fixtureDirs = discoverFixtures();
  const orgNames = Object.keys(fixtureDirs);
  const orgs = Object.fromEntries(orgNames.map(n => [n, loadOrg(n, fixtureDirs[n])]));

  // Each fixture ships with its own prompts.json. Prompts default to targeting
  // the fixture they live in; an explicit `orgs` array overrides.
  //
  // Tier resolution per cell:
  //   1. Explicit `tier` on the prompt itself (per-prompt override)
  //   2. `tier` field on the fixture's meta.json
  //   3. `full` if neither is set
  // The --tier filter then keeps only matching cells.
  const cells = [];
  for (const name of orgNames) {
    const fixtureTier = (orgs[name].meta && orgs[name].meta.tier) || 'full';
    for (const p of orgs[name].prompts) {
      const cellTier = p.tier || fixtureTier;
      if (tierFilter && tierFilter !== cellTier) continue;
      const targets = (p.orgs && p.orgs.length) ? p.orgs : [name];
      for (const orgName of targets) {
        if (orgFilter && orgFilter !== orgName) continue;
        if (promptFilter && promptFilter !== p.id) continue;
        if (!orgs[orgName]) {
          console.warn(`skipping ${p.id} × ${orgName}: org fixture missing`);
          continue;
        }
        const expect = (p.expect && p.expect[orgName]) || {};
        cells.push({ prompt: p, org: orgs[orgName], expect, tier: cellTier });
      }
    }
  }
  if (cells.length === 0) {
    console.error('No matrix cells matched. Check filters and fixtures.');
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('data:text/html,<html><body></body></html>');

  // Exposed function takes the full opts payload (system, user, cacheSystem,
  // tools, toolChoice) — same shape background.js's handleSoqlGenerate
  // expects. Returns { text, toolInput }. Both fields always present so the
  // stub doesn't need to know which path the caller used.
  await page.exposeFunction('__callClaude', async (opts) => {
    return callAnthropic(apiKey, model, opts);
  });

  // Inject the production scripts in dependency order. Glossary scripts are
  // included so the read-side + extractors load like in prod; tests can
  // optionally seed the glossary before running prompts.
  for (const f of ['salesforce-urls.js', 'shared.js', 'objects.js', 'org-glossary.js', 'org-glossary-extractors.js', 'soql.js']) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }

  // Stub chrome surface — route soql.generate to our exposed Anthropic caller.
  // The stub forwards the entire opts payload (tools, toolChoice, cacheSystem)
  // through to __callClaude so tool_use-bearing calls work end-to-end. The
  // response shape matches background.js's: { ok, text, toolInput }.
  await page.evaluate(() => {
    window.getOrgBase = () => 'https://myorg.lightning.force.com';
    window.getApiBase = () => '';
    window.chrome = {
      runtime: {
        sendMessage: (msg, cb) => {
          if (msg && msg.type === 'soql.generate') {
            window.__callClaude({
              system: msg.system,
              user: msg.user,
              cacheSystem: msg.cacheSystem,
              tools: msg.tools,
              toolChoice: msg.toolChoice
            }).then(
              resp => cb({ ok: true, text: resp.text, toolInput: resp.toolInput }),
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

  const tierLabel = tierFilter ? `tier=${tierFilter}` : 'all tiers';
  const throttleLabel = throttleMs > 0 ? `${throttleMs}ms throttle` : 'no throttle';
  console.log(`\n${BOLD}SOQL grounding eval${RESET}  ${DIM}(model: ${model}, ${tierLabel}, ${throttleLabel}, ${cells.length} cells)${RESET}\n`);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    // Throttle BEFORE each cell except the first. Putting it before (rather
    // than after) means a single-cell invocation has no delay, and the wait
    // happens at a clearer point in the output stream than a trailing pause.
    if (i > 0 && throttleMs > 0) await sleep(throttleMs);

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
