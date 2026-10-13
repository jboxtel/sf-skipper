// Unit tests for @export's query, flattening, serializers and autocomplete.
//
// These replace the fetch-mocked @export checks from the old Playwright
// test.js. The e2e run covers the panel wiring; this covers the logic that
// would otherwise only be exercised against a real org: pagination, the
// read-only guard, lookup flattening, clipboard/CSV output and field
// completion through relationships.
//
// Run:
//   npm run test:export
//   node test/export-test.js

const { newPage } = require('./vm-page');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// Each case runs in the page context and returns { ok, detail? }.
// beforeEach resets window.__queryUrls and the canned query responses.
const CASES = [
  {
    name: 'runExportQuery follows nextRecordsUrl and returns every row',
    run: async () => {
      const r = await runExportQuery('SELECT Id, Name, Owner.Name FROM Account');
      return {
        ok: r.records.length === 3
          && r.totalSize === 3
          && r.objectName === 'Account'
          && !r.truncated && !r.aborted
          && window.__queryUrls.length === 2
          && window.__queryUrls[1] === 'https://myorg.my.salesforce.com/services/data/v61.0/query-more/01g-2000',
        detail: JSON.stringify({ n: r.records.length, urls: window.__queryUrls })
      };
    }
  },
  {
    name: 'a trailing semicolon is dropped before the query is sent',
    run: async () => {
      await runExportQuery('SELECT Id FROM Account;  ');
      const q = decodeURIComponent(window.__queryUrls[0].split('?q=')[1]);
      return { ok: q === 'SELECT Id FROM Account', detail: q };
    }
  },
  {
    name: 'non-SELECT queries are rejected before any request',
    run: async () => {
      let msg = '';
      try { await runExportQuery('DELETE FROM Account'); } catch (e) { msg = e.message; }
      return { ok: /Only SELECT/.test(msg) && window.__queryUrls.length === 0, detail: msg };
    }
  },
  {
    name: 'DML keywords inside the query are rejected',
    run: async () => {
      let msg = '';
      try { await runExportQuery('SELECT Id FROM Account WHERE Id IN (DELETE)'); } catch (e) { msg = e.message; }
      return { ok: /DML/.test(msg) && window.__queryUrls.length === 0, detail: msg };
    }
  },
  {
    name: 'a DML word inside a string literal is allowed',
    run: async () => {
      let msg = '';
      try { await runExportQuery("SELECT Id FROM Case WHERE Status = 'Update pending'"); } catch (e) { msg = e.message; }
      return { ok: !msg && window.__queryUrls.length === 2, detail: msg };
    }
  },
  {
    name: 'a REST error surfaces errorCode and message',
    run: async () => {
      window.__queryResponse = () => ({ ok: false, status: 400, body: [{ errorCode: 'INVALID_FIELD', message: 'No such column Foo' }] });
      let msg = '';
      try { await runExportQuery('SELECT Foo FROM Account'); } catch (e) { msg = e.message; }
      return { ok: msg === 'INVALID_FIELD: No such column Foo', detail: msg };
    }
  },
  {
    name: 'flatten turns parent lookups into dotted columns next to their parent',
    run: async () => {
      const r = await runExportQuery('SELECT Id, Name, Owner.Name FROM Account');
      const t = flattenExportRecords(r.records);
      return {
        ok: t.columns.join(',') === 'Id,Name,Owner.Name'
          && t.rows.length === 3
          && t.rows[0][2] === null
          && t.rows[1][2] === 'Jo',
        detail: JSON.stringify(t)
      };
    }
  },
  {
    name: 'flatten keeps child subqueries as one cell with their rows',
    run: async () => {
      const t = flattenExportRecords([{
        attributes: { type: 'Account' }, Id: '001000000000001AAA',
        Contacts: { totalSize: 2, done: true, records: [
          { attributes: { type: 'Contact' }, LastName: 'Ng' },
          { attributes: { type: 'Contact' }, LastName: 'Ode' }
        ] }
      }]);
      const cell = t.rows[0][1];
      return {
        ok: t.columns.join(',') === 'Id,Contacts'
          && isExportChildCell(cell)
          && cell.childCount === 2
          && exportCellText(cell) === '[{"LastName":"Ng"},{"LastName":"Ode"}]',
        detail: JSON.stringify(t)
      };
    }
  },
  {
    name: 'TSV for Excel has a header row, one line per record and no stray tabs',
    run: async () => {
      const tsv = exportToTsv({
        columns: ['Id', 'Name', 'Owner.Name'],
        rows: [['001A', 'Acme\tWest', null], ['001B', 'Multi\nline', 'Kim'], ['001C', 'Plain', 'Jo']]
      });
      const lines = tsv.split('\n');
      return {
        ok: lines.length === 4
          && lines[0] === 'Id\tName\tOwner.Name'
          && lines[1] === '001A\tAcme West\t'
          && lines[2] === '001B\tMulti line\tKim',
        detail: JSON.stringify(tsv)
      };
    }
  },
  {
    name: 'CSV quotes commas, quotes and newlines',
    run: async () => {
      const csv = exportToCsv({ columns: ['Name', 'Description'], rows: [['Acme, Inc.', 'Said "hi"\nthen left']] });
      return {
        ok: csv === 'Name,Description\r\n"Acme, Inc.","Said ""hi""\nthen left"',
        detail: JSON.stringify(csv)
      };
    }
  },
  {
    name: 'sort puts nulls last in both directions and compares numbers numerically',
    run: async () => {
      const rows = [['Case 10', 5], [null, 1], ['Case 9', 40]];
      const asc = sortExportRows(rows, 0, 'asc').map(r => r[0]);
      const desc = sortExportRows(rows, 0, 'desc').map(r => r[0]);
      const byNum = sortExportRows(rows, 1, 'asc').map(r => r[1]);
      return {
        ok: JSON.stringify(asc) === '["Case 9","Case 10",null]'
          && JSON.stringify(desc) === '["Case 10","Case 9",null]'
          && JSON.stringify(byNum) === '[1,5,40]',
        detail: JSON.stringify({ asc, desc, byNum })
      };
    }
  },
  {
    name: 'autocomplete suggests a field and applying it completes the word',
    run: async () => {
      const text = 'SELECT Na FROM Account';
      const ctx = exportAutocompleteContext(text, 9);
      const sugg = await exportAutocompleteSuggestions(ctx);
      if (!ctx || ctx.kind !== 'field' || !sugg.length) return { ok: false, detail: JSON.stringify({ ctx, sugg }) };
      const applied = applyExportSuggestion(text, 9, ctx, sugg[0]);
      return {
        ok: sugg[0].value === 'Name' && applied.text === 'SELECT Name FROM Account' && applied.caret === 11,
        detail: JSON.stringify({ sugg, applied })
      };
    }
  },
  {
    name: 'autocomplete follows a relationship to the parent object\'s fields',
    run: async () => {
      const text = 'SELECT Owner.Em FROM Account';
      const ctx = exportAutocompleteContext(text, 15);
      const sugg = await exportAutocompleteSuggestions(ctx);
      return {
        ok: ctx && ctx.kind === 'field' && ctx.path.join('.') === 'Owner'
          && sugg.length === 1 && sugg[0].value === 'Email',
        detail: JSON.stringify({ ctx, sugg })
      };
    }
  },
  {
    name: 'autocomplete offers picklist values inside a string literal',
    run: async () => {
      const text = "SELECT Id FROM Account WHERE Industry = 'Ba";
      const ctx = exportAutocompleteContext(text, text.length);
      const sugg = await exportAutocompleteSuggestions(ctx);
      const applied = sugg.length && applyExportSuggestion(text, text.length, ctx, sugg[0]);
      return {
        ok: ctx && ctx.kind === 'value'
          && sugg.length === 1 && sugg[0].value === 'Banking'
          && applied.text === "SELECT Id FROM Account WHERE Industry = 'Banking'",
        detail: JSON.stringify({ ctx, sugg, applied })
      };
    }
  },
  {
    name: 'FROM detection ignores a subquery\'s FROM',
    run: async () => {
      const name = exportFindFromObject('SELECT Id, (SELECT LastName FROM Contacts) FROM Account');
      return { ok: name === 'Account', detail: name };
    }
  }
];

(async () => {
  const page = newPage();

  await page.evaluate(() => {
    window.getOrgBase = () => 'https://myorg.lightning.force.com';
    window.getApiBase = () => 'https://myorg.my.salesforce.com';
    window.chrome = { runtime: { sendMessage: (_, cb) => cb && cb({ ok: false }) }, storage: { local: { get: (_k, cb) => cb({}), set: () => {} } } };
    window.getAllObjects = () => [{ apiName: 'Account', label: 'Account' }, { apiName: 'User', label: 'User' }];
    window.fetchDescribe = (apiName) => Promise.resolve({
      Account: [
        { name: 'Id', label: 'Account ID', type: 'id' },
        { name: 'Name', label: 'Account Name', type: 'string' },
        { name: 'Industry', label: 'Industry', type: 'picklist', values: ['Banking', 'Biotechnology', 'Energy'] },
        { name: 'OwnerId', label: 'Owner ID', type: 'reference', referenceTo: ['User'], relationshipName: 'Owner' }
      ],
      User: [
        { name: 'Id', label: 'User ID', type: 'id' },
        { name: 'Name', label: 'Full Name', type: 'string' },
        { name: 'Email', label: 'Email', type: 'email' }
      ]
    }[apiName] || []);

    const rec = (n, owner) => ({
      attributes: { type: 'Account' }, Id: '00100000000000' + n + 'AAA', Name: 'Acme ' + n,
      Owner: owner ? { attributes: { type: 'User' }, Name: owner } : null
    });
    // Two pages: the first points at a query-more locator, the second is done.
    window.__defaultQueryResponse = (url) => url.indexOf('/query-more/') !== -1
      ? { ok: true, status: 200, body: { totalSize: 3, done: true, records: [rec(3, 'Kim')] } }
      : { ok: true, status: 200, body: { totalSize: 3, done: false, nextRecordsUrl: '/services/data/v61.0/query-more/01g-2000', records: [rec(1, null), rec(2, 'Jo')] } };
    window.fetch = (url) => {
      window.__queryUrls.push(url);
      const r = window.__queryResponse(url);
      return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body) });
    };
  });
  for (const f of ['salesforce-urls.js', 'shared.js', 'export.js']) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }
  // shared.js asks the background for the session; there is none here.
  await page.evaluate(() => {
    window.sfRestPreamble = () => Promise.resolve({
      apiBase: 'https://myorg.my.salesforce.com', headers: {}, basePath: '/services/data/v61.0'
    });
  });

  console.log(`\n${BOLD}@export unit tests${RESET}\n`);

  let passed = 0;
  let failed = 0;

  for (const c of CASES) {
    await page.evaluate(() => {
      window.__queryUrls = [];
      window.__queryResponse = window.__defaultQueryResponse;
    });
    const r = await page.evaluate(async (caseSource) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('return (' + caseSource + ')')();
      try {
        return await fn();
      } catch (e) {
        return { ok: false, detail: 'threw: ' + (e && e.message) };
      }
    }, c.run.toString());

    if (r.ok) {
      passed++;
      console.log(`  ${GREEN}PASS${RESET} ${c.name}`);
    } else {
      failed++;
      console.log(`  ${RED}FAIL${RESET} ${c.name}`);
      console.log(`        ${DIM}${r.detail || '(no detail)'}${RESET}`);
    }
  }

  console.log(`\n${BOLD}${passed} passed, ${failed} failed${RESET} (out of ${CASES.length})\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
