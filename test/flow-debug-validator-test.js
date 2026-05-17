// Unit tests for validateFlowFix.
//
// The structural validator is hard to test against the real model without
// burning API calls, and a misfiring validator (false positive) silently
// burns retries in production. This harness loads flow-debug.js into a
// Playwright page and calls validateFlowFix directly with hand-crafted
// fix payloads — fast and free.
//
// Run:
//   npm run test:flow-debug-validator
//   node test/flow-debug-validator-test.js

const { chromium } = require('playwright');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// Each case: { name, meta, describesByObject, parsed, expectOk, expectErrorIncludes }
const CASES = [
  {
    name: 'passes a clean fix against a real element',
    meta: { decisions: [{ name: 'Is_Technology', rules: [{ name: 'Tech' }] }] },
    describesByObject: {},
    parsed: {
      fix: ["Open the `'Is_Technology'` Decision element.", "Click on the `'Tech'` Outcome."]
    },
    expectOk: true
  },
  {
    name: 'rejects a backtick-quoted element name that does not exist',
    meta: { decisions: [{ name: 'Is_Technology', rules: [{ name: 'Tech' }] }] },
    describesByObject: {},
    parsed: {
      fix: ["Open the `'NonexistentDecision'` Decision element."]
    },
    expectOk: false,
    expectErrorIncludes: 'NonexistentDecision'
  },
  {
    name: 'rejects a {!Resource} that is not defined',
    meta: {
      variables: [{ name: 'myVar' }],
      decisions: [{ name: 'D1', rules: [{ name: 'R1' }] }]
    },
    describesByObject: {},
    parsed: {
      fix: ["Set `Value` = `{!ghostVar}`."]
    },
    expectOk: false,
    expectErrorIncludes: 'ghostVar'
  },
  {
    name: 'accepts {!Resource} when the resource is defined',
    meta: { variables: [{ name: 'myVar' }] },
    describesByObject: {},
    parsed: {
      fix: ["Set `Value` = `{!myVar}`."]
    },
    expectOk: true
  },
  {
    name: 'rejects {!$Record.<Field>} when the field is not on the trigger object',
    meta: { start: { object: 'Account' } },
    describesByObject: {
      Account: { fields: [{ name: 'Industry', type: 'picklist' }, { name: 'Name', type: 'string' }] }
    },
    parsed: {
      fix: ["Compare `{!$Record.NotAField__c}` to `'X'`."]
    },
    expectOk: false,
    expectErrorIncludes: 'NotAField__c'
  },
  {
    name: 'accepts {!$Record.<Field>} when the field exists (case-insensitive)',
    meta: { start: { object: 'Account' } },
    describesByObject: {
      Account: { fields: [{ name: 'Industry', type: 'picklist' }] }
    },
    parsed: {
      // String literals follow the system-prompt convention: double-quoted,
      // no backticks. Backtick-and-single-quoted tokens are reserved for
      // element/outcome/resource NAMES, so the validator is right to flag
      // them when they don't resolve.
      fix: ['Compare `{!$Record.industry}` to "Technology".']
    },
    expectOk: true
  },
  {
    name: 'ignores $Record field check when describe is missing',
    meta: { start: { object: 'Account' } },
    describesByObject: {},
    parsed: {
      fix: ['Compare `{!$Record.AnythingGoes__c}` to "X".']
    },
    expectOk: true
  },
  {
    name: 'ignores other $Global refs ($User, $GlobalConstant, etc.)',
    meta: { start: { object: 'Account' } },
    describesByObject: { Account: { fields: [{ name: 'Industry', type: 'picklist' }] } },
    parsed: {
      fix: ["Set `Value` = `{!$GlobalConstant.True}`.", "Use `{!$User.Email}`."]
    },
    expectOk: true
  },
  {
    name: 'accepts the implicit "Start" element name',
    meta: { decisions: [{ name: 'D1' }] },
    describesByObject: {},
    parsed: { fix: ["Open the `'Start'` element."] },
    expectOk: true
  },
  {
    name: 'reports multiple distinct errors in one response',
    meta: { start: { object: 'Account' }, decisions: [{ name: 'D1', rules: [{ name: 'R1' }] }] },
    describesByObject: { Account: { fields: [{ name: 'Industry', type: 'picklist' }] } },
    parsed: {
      fix: [
        "Open `'NotARealElement'`.",
        "Compare `{!$Record.MissingField__c}`.",
        "Use `{!undefinedVar}`."
      ]
    },
    expectOk: false,
    expectErrorIncludes: ['NotARealElement', 'MissingField__c', 'undefinedVar']
  },
  {
    name: 'no-ops when fix array is missing or empty',
    meta: { decisions: [{ name: 'D1' }] },
    describesByObject: {},
    parsed: { rootCause: 'nothing', summary: 'nothing' },
    expectOk: true
  },
  {
    name: 'also scans rootCause text for hallucinated element names',
    meta: { decisions: [{ name: 'Is_Technology', rules: [{ name: 'Tech' }] }] },
    describesByObject: {},
    parsed: {
      rootCause: "The `'Phantom_Decision'` Decision's outcome misfires.",
      fix: []
    },
    expectOk: false,
    expectErrorIncludes: 'Phantom_Decision'
  }
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('data:text/html,<html><body></body></html>');

  // Load just enough to expose validateFlowFix. flow-debug uses fetchDescribe
  // from soql.js — not needed for the validator itself, but the script parses
  // cleaner if everything loads. We don't trigger any fetch here.
  await page.evaluate(() => {
    window.getOrgBase = () => 'https://myorg.lightning.force.com';
    window.getApiBase = () => '';
    window.fetch = () => Promise.reject(new Error('validator tests do not perform fetch'));
    window.chrome = { runtime: { sendMessage: (_, cb) => cb && cb({ ok: false }) }, storage: { local: { get: (_k, cb) => cb({}), set: () => {} } } };
  });
  for (const f of ['salesforce-urls.js', 'shared.js', 'objects.js', 'soql.js', 'flow-debug.js']) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }

  console.log(`\n${BOLD}validateFlowFix unit tests${RESET}\n`);

  let passed = 0;
  let failed = 0;

  for (const c of CASES) {
    const r = await page.evaluate(({ meta, describesByObject, parsed }) => {
      return validateFlowFix(parsed, meta, describesByObject);
    }, c);

    let pass = true;
    const reasons = [];
    if (c.expectOk && !r.ok) {
      pass = false;
      reasons.push(`expected ok, got errors: ${r.errors.join(' | ')}`);
    }
    if (!c.expectOk && r.ok) {
      pass = false;
      reasons.push('expected errors, got ok');
    }
    if (c.expectErrorIncludes) {
      const needles = Array.isArray(c.expectErrorIncludes) ? c.expectErrorIncludes : [c.expectErrorIncludes];
      const joined = (r.errors || []).join('\n');
      for (const n of needles) {
        if (!joined.includes(n)) {
          pass = false;
          reasons.push(`error output missing "${n}"`);
        }
      }
    }

    if (pass) {
      passed++;
      console.log(`  ${GREEN}PASS${RESET} ${c.name}`);
    } else {
      failed++;
      console.log(`  ${RED}FAIL${RESET} ${c.name}`);
      reasons.forEach(reason => console.log(`        - ${reason}`));
      console.log(`        ${DIM}validator returned:${RESET} ${JSON.stringify(r)}`);
    }
  }

  await browser.close();
  console.log(`\n${BOLD}${passed} passed, ${failed} failed${RESET} (out of ${CASES.length})\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
