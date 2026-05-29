// Unit tests for validateSoqlSemantics.
//
// The semantic validator catches picklist-literal mismatches the Salesforce
// planner misses (planner is grammar-only). False positives here mean wasted
// retries against real users, so the validator is conservative: skip
// unresolvable paths, skip non-picklist types, skip multipicklist. These
// tests pin the conservative behavior so we don't regress into "validator
// rejects every query."
//
// Run:
//   npm run test:soql-semantic
//   node test/soql-semantic-test.js

const { chromium } = require('playwright');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// A small schema fixture covering the shapes the validator has to reason about:
//   - root object with picklist + text fields
//   - dot-walk via custom relationship (__r) into a parent with its own picklist
//   - multipicklist (must be skipped — uses INCLUDES, not =)
//   - lookup target object that's the dot-walk destination
function buildSchema() {
  return [
    {
      apiName: 'Asset',
      fields: [
        { name: 'Id', type: 'id' },
        { name: 'Name', type: 'string' },
        { name: 'StatusFlight__c', type: 'picklist', values: ['Active', 'Retired', 'OnGround'] },
        { name: 'Tags__c', type: 'multipicklist', values: ['A', 'B', 'C'] },
        { name: 'AffectedFlight__c', type: 'reference', referenceTo: ['Flight__c'], relationshipName: 'AffectedFlight__r' },
        { name: 'AccountId', type: 'reference', referenceTo: ['Account'], relationshipName: 'Account' }
      ]
    },
    {
      apiName: 'Flight__c',
      fields: [
        { name: 'Id', type: 'id' },
        { name: 'eu261Status__c', type: 'picklist', values: ['CR', 'CL', 'OK', 'PD'] }
      ]
    },
    {
      apiName: 'Account',
      fields: [
        { name: 'Id', type: 'id' },
        { name: 'Industry', type: 'picklist', values: ['Agriculture', 'Banking', 'Technology'] }
      ]
    }
  ];
}

const CASES = [
  {
    name: 'passes a clean query with a valid picklist literal',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c = 'Active'",
    expectOk: true
  },
  {
    name: 'rejects a picklist literal not in the value set (the canonical CR-on-wrong-field case)',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c = 'CR'",
    expectOk: false,
    expectErrorIncludes: ["StatusFlight__c", "'CR'", "Active"]
  },
  {
    name: 'passes the same literal when used on the correct dot-walked picklist',
    soql: "SELECT Id FROM Asset WHERE AffectedFlight__r.eu261Status__c = 'CR'",
    expectOk: true
  },
  {
    name: 'rejects a bad literal via a dot-walked relationship',
    soql: "SELECT Id FROM Asset WHERE AffectedFlight__r.eu261Status__c = 'NotAStatus'",
    expectOk: false,
    expectErrorIncludes: ["eu261Status__c", "'NotAStatus'", "CR"]
  },
  {
    name: 'rejects a bad literal via a standard-reference dot-walk (AccountId -> Account)',
    soql: "SELECT Id FROM Asset WHERE Account.Industry = 'NotARealIndustry'",
    expectOk: false,
    expectErrorIncludes: ["Account.Industry", "NotARealIndustry", "Banking"]
  },
  {
    name: 'handles != as well as =',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c != 'NotAStatus'",
    expectOk: false,
    expectErrorIncludes: ["StatusFlight__c", "NotAStatus"]
  },
  {
    name: 'checks every literal in an IN list, flagging only the bad one',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c IN ('Active', 'Bogus', 'Retired')",
    expectOk: false,
    expectErrorIncludes: ["StatusFlight__c", "Bogus"]
  },
  {
    name: 'passes when every IN literal is valid',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c IN ('Active', 'Retired')",
    expectOk: true
  },
  {
    name: 'handles NOT IN',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c NOT IN ('Bogus', 'Active')",
    expectOk: false,
    expectErrorIncludes: ["Bogus"]
  },
  {
    name: 'skips text fields (no picklist values to check against)',
    soql: "SELECT Id FROM Asset WHERE Name = 'anything goes here'",
    expectOk: true
  },
  {
    name: 'skips multipicklist (uses INCLUDES, not =)',
    soql: "SELECT Id FROM Asset WHERE Tags__c = 'NotInValueSet'",
    expectOk: true
  },
  {
    name: 'skips unresolvable field paths (no false positives on unknown roots)',
    soql: "SELECT Id FROM UnknownObject__c WHERE Status__c = 'whatever'",
    expectOk: true
  },
  {
    name: 'skips literals inside a child subquery (different FROM scope)',
    // Child has no schema in our fixture; even if the inner field name collided
    // with a picklist on Asset (StatusFlight__c), we shouldn't resolve it.
    soql: "SELECT Id FROM Asset WHERE Id IN (SELECT AssetId FROM Case WHERE StatusFlight__c = 'CR')",
    expectOk: true
  },
  {
    name: 'still flags outer-WHERE picklist violations when a subquery is present',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c = 'CR' AND Id IN (SELECT AssetId FROM Case WHERE Subject = 'Anything')",
    expectOk: false,
    expectErrorIncludes: ["StatusFlight__c", "'CR'"]
  },
  {
    name: 'is case-sensitive (Salesforce picklist filters are case-sensitive)',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c = 'active'",
    expectOk: false,
    expectErrorIncludes: ["StatusFlight__c", "'active'"]
  },
  {
    name: 'returns ok when soql is empty',
    soql: '',
    expectOk: true
  },
  {
    name: 'returns ok when schemaObjects is empty',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c = 'CR'",
    overrideSchema: [],
    expectOk: true
  },
  {
    name: 'dedupes repeated violations',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c = 'Bad' OR StatusFlight__c = 'Bad' OR StatusFlight__c = 'AlsoBad'",
    expectOk: false,
    // Two distinct (path, literal) violations; the error mentions both literals.
    expectErrorIncludes: ["'Bad'", "'AlsoBad'"]
  }
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('data:text/html,<html><body></body></html>');

  // soql.js references chrome.storage / chrome.runtime at load time via the
  // glossary observer wiring; stub them so the file parses cleanly.
  await page.evaluate(() => {
    window.getOrgBase = () => 'https://myorg.lightning.force.com';
    window.getApiBase = () => '';
    window.fetch = () => Promise.reject(new Error('semantic validator tests do not perform fetch'));
    window.chrome = {
      runtime: { sendMessage: (_, cb) => cb && cb({ ok: false }) },
      storage: { local: { get: (_k, cb) => cb({}), set: () => {} } }
    };
  });
  for (const f of ['salesforce-urls.js', 'shared.js', 'cache-factory.js', 'objects.js', 'org-glossary.js', 'org-glossary-extractors.js', 'soql.js']) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }

  console.log(`\n${BOLD}validateSoqlSemantics unit tests${RESET}\n`);

  let passed = 0;
  let failed = 0;

  for (const c of CASES) {
    const r = await page.evaluate(({ soql, overrideSchema, schema }) => {
      return validateSoqlSemantics(soql, overrideSchema !== undefined ? overrideSchema : schema);
    }, { soql: c.soql, overrideSchema: c.overrideSchema, schema: buildSchema() });

    let pass = true;
    const reasons = [];
    if (c.expectOk && !r.ok) {
      pass = false;
      reasons.push(`expected ok, got error: ${r.error}`);
    }
    if (!c.expectOk && r.ok) {
      pass = false;
      reasons.push('expected an error, got ok');
    }
    if (c.expectErrorIncludes) {
      const needles = Array.isArray(c.expectErrorIncludes) ? c.expectErrorIncludes : [c.expectErrorIncludes];
      const text = r.error || '';
      for (const n of needles) {
        if (!text.includes(n)) {
          pass = false;
          reasons.push(`error missing "${n}"`);
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
