// Unit tests for the two grounding helpers added in this branch:
//   - validateSoqlObjectExists: reject queries whose FROM target isn't in the org
//   - buildPicklistValueIndex / findPicklistMatchesInPrompt: surface picklist
//     value hits from the prompt so the model picks the right field
//
// Run:
//   npm run test:soql-grounding
//   node test/soql-grounding-test.js

const { chromium } = require('playwright');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function buildSchema() {
  return [
    {
      apiName: 'Asset',
      fields: [
        { name: 'Id', type: 'id' },
        { name: 'Name', type: 'string' },
        { name: 'StatusFlight__c', type: 'picklist', values: ['Active', 'Retired', 'OnGround'] },
        { name: 'AffectedFlight__c', type: 'reference', referenceTo: ['Flight__c'], relationshipName: 'AffectedFlight__r' }
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
      apiName: 'Order',
      fields: [
        { name: 'Id', type: 'id' },
        { name: 'Status', type: 'picklist', values: ['Draft', 'Activated', 'Cancelled'] }
      ]
    }
  ];
}

const KNOWN_OBJECTS = ['Asset', 'Flight__c', 'Order', 'Account', 'Contact', 'Case'];

const OBJECT_EXISTS_CASES = [
  {
    name: 'passes when FROM target is in the known object list',
    soql: 'SELECT Id FROM Asset WHERE Name = \'X\'',
    expectOk: true
  },
  {
    name: 'passes when FROM target matches case-insensitively',
    soql: 'SELECT Id FROM asset',
    expectOk: true
  },
  {
    name: 'rejects when FROM target is not in the org',
    soql: 'SELECT Id FROM Hallucinated__c WHERE X = 1',
    expectOk: false,
    expectErrorIncludes: ["Hallucinated__c", "does not exist"]
  },
  {
    name: 'suggestions list the schema objects we already sent',
    soql: 'SELECT Id FROM Hallucinated__c',
    expectOk: false,
    expectErrorIncludes: ['Asset', 'Flight__c', 'Order']
  },
  {
    name: 'skips when schemaObjects is empty (still suggests from knownObjectNames)',
    soql: 'SELECT Id FROM Hallucinated__c',
    overrideSchema: [],
    expectOk: false,
    expectErrorIncludes: ['Asset']
  },
  {
    name: 'ignores subquery FROM clauses (those are child relationship names, not objects)',
    soql: 'SELECT Id, (SELECT Id FROM ChildOrders) FROM Account',
    overrideKnown: ['Account'],
    expectOk: true
  },
  {
    name: 'returns ok when soql is empty',
    soql: '',
    expectOk: true
  },
  {
    name: 'returns ok when knownObjectNames is empty (cannot decide)',
    soql: 'SELECT Id FROM Anything',
    overrideKnown: [],
    expectOk: true
  }
];

const FIELDS_EXIST_CASES = [
  {
    name: 'passes when every field reference exists on FROM',
    soql: 'SELECT Id, Name, StatusFlight__c FROM Asset',
    expectOk: true
  },
  {
    name: 'passes a valid dot-walk via custom relationship',
    soql: "SELECT Id, AffectedFlight__r.eu261Status__c FROM Asset",
    expectOk: true
  },
  {
    name: 'rejects a field name hallucinated onto the wrong object',
    soql: "SELECT Id FROM Asset WHERE EU261Status__c IN ('CR', 'CL')",
    expectOk: false,
    expectErrorIncludes: ["EU261Status__c", "Asset"]
  },
  {
    name: 'suggests the dot-walk path when the field exists on a related schema',
    // eu261Status__c lives on Flight__c, reachable via Asset.AffectedFlight__r
    soql: "SELECT Id FROM Asset WHERE eu261Status__c = 'CR'",
    expectOk: false,
    expectErrorIncludes: ["eu261Status__c", "AffectedFlight__r"]
  },
  {
    name: 'rejects a dot-walk whose final field does not exist on the related object',
    soql: "SELECT Id FROM Asset WHERE AffectedFlight__r.NotARealField__c = 'X'",
    expectOk: false,
    expectErrorIncludes: ["NotARealField__c", "Flight__c"]
  },
  {
    name: 'ignores RecordType.* paths (planner handles them)',
    soql: "SELECT Id FROM Asset WHERE RecordType.DeveloperName = 'Flight'",
    expectOk: true
  },
  {
    name: 'ignores aggregate function arguments that are known fields',
    soql: 'SELECT COUNT(Id) FROM Asset',
    expectOk: true
  },
  {
    name: 'ignores date-literal keywords without flagging them as fields',
    soql: 'SELECT Id FROM Asset WHERE CreatedDate = LAST_N_DAYS:7',
    overrideSchema: [
      {
        apiName: 'Asset',
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'CreatedDate', type: 'datetime' }
        ]
      }
    ],
    expectOk: true
  },
  {
    name: 'ignores fields inside child subqueries (different FROM scope)',
    soql: "SELECT Id FROM Asset WHERE Id IN (SELECT AssetId FROM Case WHERE NotOnAsset__c = 'x')",
    expectOk: true
  },
  {
    name: 'silently passes when FROM is not in our schema (object-exists owns that case)',
    soql: "SELECT Id FROM UnknownObject WHERE Whatever = 'X'",
    expectOk: true
  },
  {
    name: 'returns ok when soql is empty',
    soql: '',
    expectOk: true
  },
  {
    name: 'returns ok when schemaObjects is empty',
    soql: "SELECT Id FROM Asset WHERE Bogus__c = 'x'",
    overrideSchema: [],
    expectOk: true
  },
  {
    name: 'ignores string literals (field-like tokens inside quotes do not trigger the check)',
    soql: "SELECT Id FROM Asset WHERE Name = 'NotAField__c'",
    overrideSchema: [
      {
        apiName: 'Asset',
        fields: [
          { name: 'Id', type: 'id' },
          { name: 'Name', type: 'string' }
        ]
      }
    ],
    expectOk: true
  }
];

const LITERAL_PRESERVATION_CASES = [
  {
    name: 'passes when the prompt literal appears in a quoted literal',
    prompt: 'Show me flights with status CR',
    soql: "SELECT Id FROM Asset WHERE AffectedFlight__r.eu261Status__c = 'CR'",
    expectOk: true
  },
  {
    name: 'rejects when the prompt literal is missing from the SOQL',
    prompt: 'Show me flights with status CR',
    soql: "SELECT Id FROM Asset WHERE StatusFlight__c = 'OnGround'",
    expectOk: false,
    expectErrorIncludes: ["'CR'", "missing"]
  },
  {
    name: 'matches case-insensitively (user wrote cr, SOQL has CR)',
    prompt: 'flights with status cr',
    soql: "SELECT Id FROM Asset WHERE AffectedFlight__r.eu261Status__c = 'CR'",
    expectOk: true
  },
  {
    name: 'does not match a token that only appears inside a field name (not a quoted literal)',
    // The token 'CR' appears in the SOQL string (inside CR_Code__c) but not as a quoted literal — should still reject.
    prompt: 'flights with status CR',
    soql: "SELECT Id, CR_Code__c FROM Asset WHERE Name = 'something'",
    expectOk: false,
    expectErrorIncludes: ["'CR'"]
  },
  {
    name: 'passes when the prompt has no picklist matches at all',
    prompt: 'show me everything',
    soql: 'SELECT Id FROM Asset',
    expectOk: true
  },
  {
    name: 'returns ok when schemaObjects is empty',
    prompt: 'flights with status CR',
    soql: "SELECT Id FROM Asset",
    overrideSchema: [],
    expectOk: true
  },
  {
    name: 'returns ok when soql is empty',
    prompt: 'flights with status CR',
    soql: '',
    expectOk: true
  },
  {
    name: 'flags every missing prompt literal when several are absent',
    prompt: 'Flights where the EU261 status is CR or CL',
    soql: "SELECT Id FROM Asset WHERE Status = 'Active'",
    expectOk: false,
    expectErrorIncludes: ["'CR'", "'CL'"]
  }
];

const FIELD_NAME_SCORING_CASES = [
  {
    name: 'matches a substantive whole-word token in field names (flight on Product2-like schema)',
    prompt: 'show me flights from Frankfurt',
    fields: [
      { name: 'FlightLegFrom__c', label: 'Flight Leg From' },
      { name: 'FlightLegTo__c', label: 'Flight Leg To' },
      { name: 'DepartureDateScheduled__c', label: 'Departure Date Scheduled' }
    ],
    expectScoreAtLeast: 6
  },
  {
    name: 'matches multiple distinct tokens (flight + from in the prompt)',
    prompt: 'flights from Frankfurt last week',
    fields: [
      { name: 'FlightLegFrom__c', label: 'Flight Leg From' },
      { name: 'FlightLegTo__c', label: 'Flight Leg To' }
    ],
    expectScoreAtLeast: 10
  },
  {
    name: 'deduplicates: the same token appearing in many fields scores once',
    prompt: 'show me flights',
    fields: [
      { name: 'Flight1__c', label: 'Flight One' },
      { name: 'Flight2__c', label: 'Flight Two' },
      { name: 'Flight3__c', label: 'Flight Three' },
      { name: 'Flight4__c', label: 'Flight Four' }
    ],
    expectScoreAtMost: 6
  },
  {
    name: 'no match when prompt and field tokens do not overlap',
    prompt: 'show me bookings',
    fields: [
      { name: 'Family', label: 'Product Family' },
      { name: 'Color__c', label: 'Color' }
    ],
    expectScoreAtMost: 0
  },
  {
    name: 'ignores tokens shorter than the minimum length (no, on, in)',
    prompt: 'no on in to a',
    fields: [
      { name: 'Status', label: 'Status' }
    ],
    expectScoreAtMost: 0
  },
  {
    name: 'returns 0 when fields list is empty',
    prompt: 'show me flights',
    fields: [],
    expectScoreAtMost: 0
  },
  {
    name: 'returns 0 when prompt is empty',
    prompt: '',
    fields: [{ name: 'Flight__c', label: 'Flight' }],
    expectScoreAtMost: 0
  },
  {
    name: 'tokenizes CamelCase field names into component tokens',
    prompt: 'departure scheduled',
    fields: [
      { name: 'DepartureDateScheduled__c', label: 'Departure Date Scheduled' }
    ],
    expectScoreAtLeast: 18
  }
];

const PICKLIST_INDEX_CASES = [
  {
    name: 'surfaces a rare-code hit (CR is only on one field)',
    prompt: 'Show me flights with status CR',
    expectTokens: ['CR'],
    expectField: 'eu261Status__c'
  },
  {
    name: 'is case-insensitive on the prompt token but preserves picklist case',
    prompt: 'flights with status cr',
    expectTokens: ['cr'],
    expectField: 'eu261Status__c'
  },
  {
    name: 'returns no hits for tokens absent from any picklist',
    prompt: 'show me everything that happened yesterday',
    expectTokens: []
  },
  {
    name: 'returns no hits for pure-numeric tokens',
    prompt: '12345',
    expectTokens: []
  },
  {
    name: 'finds multiple distinct rare codes in the same prompt',
    prompt: 'Flights where eu261 status is CR or CL',
    expectTokens: ['CR', 'CL']
  },
  {
    name: 'drops hits with too many locations (cap at MAX_LOCATIONS) to avoid noise',
    prompt: 'cancelled',
    // 'Cancelled' appears once (Order.Status). With only 1 location it should be surfaced.
    expectTokens: ['cancelled']
  }
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('data:text/html,<html><body></body></html>');

  await page.evaluate(() => {
    window.getOrgBase = () => 'https://myorg.lightning.force.com';
    window.getApiBase = () => '';
    window.fetch = () => Promise.reject(new Error('grounding tests do not perform fetch'));
    window.chrome = {
      runtime: { sendMessage: (_, cb) => cb && cb({ ok: false }) },
      storage: { local: { get: (_k, cb) => cb({}), set: () => {} } }
    };
  });
  for (const f of ['salesforce-urls.js', 'shared.js', 'cache-factory.js', 'objects.js', 'org-glossary.js', 'org-glossary-extractors.js', 'soql.js']) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }

  console.log(`\n${BOLD}validateSoqlObjectExists unit tests${RESET}\n`);

  let passed = 0;
  let failed = 0;

  for (const c of OBJECT_EXISTS_CASES) {
    const r = await page.evaluate(({ soql, schema, known, overrideSchema, overrideKnown }) => {
      const s = overrideSchema !== undefined ? overrideSchema : schema;
      const k = overrideKnown !== undefined ? overrideKnown : known;
      return validateSoqlObjectExists(soql, s, k);
    }, { soql: c.soql, schema: buildSchema(), known: KNOWN_OBJECTS, overrideSchema: c.overrideSchema, overrideKnown: c.overrideKnown });

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

  console.log(`\n${BOLD}validateSoqlFieldsExist unit tests${RESET}\n`);

  for (const c of FIELDS_EXIST_CASES) {
    const r = await page.evaluate(({ soql, schema, overrideSchema }) => {
      const s = overrideSchema !== undefined ? overrideSchema : schema;
      return validateSoqlFieldsExist(soql, s);
    }, { soql: c.soql, schema: buildSchema(), overrideSchema: c.overrideSchema });

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

  console.log(`\n${BOLD}validateSoqlLiteralPreservation unit tests${RESET}\n`);

  for (const c of LITERAL_PRESERVATION_CASES) {
    const r = await page.evaluate(({ soql, prompt, schema, overrideSchema }) => {
      const s = overrideSchema !== undefined ? overrideSchema : schema;
      return validateSoqlLiteralPreservation(soql, prompt, s);
    }, { soql: c.soql, prompt: c.prompt, schema: buildSchema(), overrideSchema: c.overrideSchema });

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

  console.log(`\n${BOLD}scoreFieldNameMatch unit tests${RESET}\n`);

  for (const c of FIELD_NAME_SCORING_CASES) {
    const score = await page.evaluate(({ prompt, fields }) => {
      return scoreFieldNameMatch(prompt, fields);
    }, { prompt: c.prompt, fields: c.fields });

    let pass = true;
    const reasons = [];
    if (typeof c.expectScoreAtLeast === 'number' && score < c.expectScoreAtLeast) {
      pass = false;
      reasons.push(`expected score >= ${c.expectScoreAtLeast}, got ${score}`);
    }
    if (typeof c.expectScoreAtMost === 'number' && score > c.expectScoreAtMost) {
      pass = false;
      reasons.push(`expected score <= ${c.expectScoreAtMost}, got ${score}`);
    }

    if (pass) {
      passed++;
      console.log(`  ${GREEN}PASS${RESET} ${c.name} ${DIM}(score=${score})${RESET}`);
    } else {
      failed++;
      console.log(`  ${RED}FAIL${RESET} ${c.name}`);
      reasons.forEach(reason => console.log(`        - ${reason}`));
    }
  }

  console.log(`\n${BOLD}findPicklistMatchesInPrompt unit tests${RESET}\n`);

  for (const c of PICKLIST_INDEX_CASES) {
    const r = await page.evaluate(({ prompt, schema }) => {
      const idx = buildPicklistValueIndex(schema);
      return findPicklistMatchesInPrompt(prompt, idx);
    }, { prompt: c.prompt, schema: buildSchema() });

    let pass = true;
    const reasons = [];
    const tokens = r.map(h => h.token);
    if (c.expectTokens) {
      // Match each expected token case-insensitively against the returned tokens
      for (const t of c.expectTokens) {
        if (!tokens.some(rt => rt.toLowerCase() === t.toLowerCase())) {
          pass = false;
          reasons.push(`expected token "${t}", got [${tokens.join(', ')}]`);
        }
      }
      if (c.expectTokens.length === 0 && tokens.length > 0) {
        pass = false;
        reasons.push(`expected no hits, got [${tokens.join(', ')}]`);
      }
    }
    if (c.expectField) {
      const allFieldNames = r.flatMap(h => h.locations.map(l => l.fieldName));
      if (!allFieldNames.includes(c.expectField)) {
        pass = false;
        reasons.push(`expected location on field "${c.expectField}", got fields [${allFieldNames.join(', ')}]`);
      }
    }

    if (pass) {
      passed++;
      console.log(`  ${GREEN}PASS${RESET} ${c.name}`);
    } else {
      failed++;
      console.log(`  ${RED}FAIL${RESET} ${c.name}`);
      reasons.forEach(reason => console.log(`        - ${reason}`));
      console.log(`        ${DIM}hits:${RESET} ${JSON.stringify(r)}`);
    }
  }

  await browser.close();
  const total = OBJECT_EXISTS_CASES.length + FIELDS_EXIST_CASES.length + LITERAL_PRESERVATION_CASES.length + FIELD_NAME_SCORING_CASES.length + PICKLIST_INDEX_CASES.length;
  console.log(`\n${BOLD}${passed} passed, ${failed} failed${RESET} (out of ${total})\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
