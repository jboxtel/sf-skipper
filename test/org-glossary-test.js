// Unit tests for the org glossary library + extractors.
//
// The glossary feeds three AI features and accumulates between sessions, so a
// bug here either silently corrupts the learned vocabulary or fails to learn
// at all — both invisible failure modes. We need a fast regression guard for
// the storage/observation/extraction loop that runs without an Anthropic key.
//
// Pattern mirrors flow-debug-validator-test.js: load the scripts into a
// Playwright page, stub chrome.storage with in-memory state, call the
// functions directly with hand-crafted inputs.
//
// Run:
//   npm run test:org-glossary
//   node test/org-glossary-test.js

const { chromium } = require('playwright');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// Each test is a function that runs in the page context and returns
// { ok: boolean, detail?: string }. The harness collects results and reports.
const CASES = [
  {
    name: 'load returns an empty glossary when storage is empty',
    run: async () => {
      const g = await glossaryGetSnapshot();
      return {
        ok: g.version === 1
          && g.objectAliases && Object.keys(g.objectAliases).length === 0
          && g.fieldAliases && Object.keys(g.fieldAliases).length === 0
          && g.valueSemantics && Object.keys(g.valueSemantics).length === 0,
        detail: JSON.stringify(g)
      };
    }
  },
  {
    name: 'observe creates a new objectAlias entry with feature counter at 1',
    run: async () => {
      await glossaryObserve({
        type: 'objectAlias', feature: 'soql',
        term: 'flight', target: 'Product2',
        evidence: 'prompt: show me flights'
      });
      const g = await glossaryGetSnapshot();
      const bucket = g.objectAliases.flight || [];
      if (bucket.length !== 1) return { ok: false, detail: 'expected 1 entry, got ' + bucket.length };
      const e = bucket[0];
      return {
        ok: e.target === 'Product2'
          && e.observations.soql === 1
          && e.observations.ask === 0
          && e.corrections === 0
          && Array.isArray(e.evidence) && e.evidence.length === 1,
        detail: JSON.stringify(e)
      };
    }
  },
  {
    name: 'repeated observation increments the same feature counter (no new entry)',
    run: async () => {
      const obs = { type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2' };
      await glossaryObserve(obs);
      await glossaryObserve(obs);
      await glossaryObserve(obs);
      const g = await glossaryGetSnapshot();
      const bucket = g.objectAliases.flight || [];
      if (bucket.length !== 1) return { ok: false, detail: 'bucket length: ' + bucket.length };
      return {
        ok: bucket[0].observations.soql === 3,
        detail: 'soql counter: ' + bucket[0].observations.soql
      };
    }
  },
  {
    name: 'observations from different features accumulate independently',
    run: async () => {
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2' });
      await glossaryObserve({ type: 'objectAlias', feature: 'ask',  term: 'flight', target: 'Product2' });
      const g = await glossaryGetSnapshot();
      const e = (g.objectAliases.flight || [])[0];
      return {
        ok: e && e.observations.soql === 1 && e.observations.ask === 1,
        detail: JSON.stringify(e && e.observations)
      };
    }
  },
  {
    name: 'different targets for same term create separate entries in one bucket',
    run: async () => {
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2' });
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Flight__c' });
      const g = await glossaryGetSnapshot();
      const bucket = g.objectAliases.flight || [];
      return {
        ok: bucket.length === 2,
        detail: 'bucket length: ' + bucket.length + ' (' + bucket.map(b => b.target).join(',') + ')'
      };
    }
  },
  {
    name: 'observation with missing required fields is silently ignored',
    run: async () => {
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', target: 'Product2' }); // no term
      await glossaryObserve({ feature: 'soql', term: 'flight', target: 'Product2' });       // no type
      await glossaryObserve({ type: 'objectAlias', term: 'flight', target: 'Product2' });   // no feature
      await glossaryObserve(null);
      const g = await glossaryGetSnapshot();
      return {
        ok: Object.keys(g.objectAliases).length === 0,
        detail: JSON.stringify(g.objectAliases)
      };
    }
  },
  {
    name: 'observation with unknown feature is silently ignored',
    run: async () => {
      await glossaryObserve({ type: 'objectAlias', feature: 'fakefeature', term: 'flight', target: 'Product2' });
      const g = await glossaryGetSnapshot();
      return {
        ok: Object.keys(g.objectAliases).length === 0,
        detail: JSON.stringify(g.objectAliases)
      };
    }
  },
  {
    name: 'term is normalised (case + whitespace)',
    run: async () => {
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: '  FLIGHT  ', target: 'Product2' });
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2' });
      const g = await glossaryGetSnapshot();
      const bucket = g.objectAliases.flight || [];
      return {
        ok: bucket.length === 1 && bucket[0].observations.soql === 2,
        detail: 'flight bucket: ' + JSON.stringify(bucket) + ' all keys: ' + JSON.stringify(Object.keys(g.objectAliases))
      };
    }
  },
  {
    name: 'observeBatch accepts an array and dedupes per the bucket key',
    run: async () => {
      await glossaryObserveBatch([
        { type: 'objectAlias', feature: 'soql', term: 'flight',   target: 'Product2' },
        { type: 'objectAlias', feature: 'soql', term: 'aircraft', target: 'Product2' },
        { type: 'objectAlias', feature: 'soql', term: 'flight',   target: 'Product2' }
      ]);
      const g = await glossaryGetSnapshot();
      const f = (g.objectAliases.flight || [])[0];
      const a = (g.objectAliases.aircraft || [])[0];
      return {
        ok: f && f.observations.soql === 2 && a && a.observations.soql === 1,
        detail: 'flight=' + (f && f.observations.soql) + ' aircraft=' + (a && a.observations.soql)
      };
    }
  },
  {
    name: 'evidence ring buffer caps at 5 entries (most recent first)',
    run: async () => {
      for (let i = 1; i <= 8; i++) {
        await glossaryObserve({
          type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2',
          evidence: 'observation ' + i
        });
      }
      const g = await glossaryGetSnapshot();
      const ev = ((g.objectAliases.flight || [])[0] || {}).evidence || [];
      return {
        ok: ev.length === 5 && ev[0].text === 'observation 8' && ev[4].text === 'observation 4',
        detail: ev.map(e => e.text).join(' | ')
      };
    }
  },
  {
    name: 'evidence is truncated at 200 chars',
    run: async () => {
      const long = 'x'.repeat(500);
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2', evidence: long });
      const g = await glossaryGetSnapshot();
      const ev = ((g.objectAliases.flight || [])[0] || {}).evidence || [];
      return {
        ok: ev[0] && ev[0].text.length === 200,
        detail: 'evidence length: ' + (ev[0] && ev[0].text.length)
      };
    }
  },
  {
    name: 'confidence rises with corroboration across features',
    run: async () => {
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2' });
      const g1 = await glossaryGetSnapshot();
      const c1 = glossaryEntryConfidence(g1.objectAliases.flight[0]);
      await glossaryObserve({ type: 'objectAlias', feature: 'ask', term: 'flight', target: 'Product2' });
      const g2 = await glossaryGetSnapshot();
      const c2 = glossaryEntryConfidence(g2.objectAliases.flight[0]);
      return {
        ok: c2 > c1,
        detail: 'c1=' + c1.toFixed(3) + ' c2=' + c2.toFixed(3)
      };
    }
  },
  {
    name: 'corrections lower the confidence',
    run: async () => {
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2' });
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2' });
      await glossaryObserve({ type: 'objectAlias', feature: 'soql', term: 'flight', target: 'Product2' });
      const g = await glossaryGetSnapshot();
      const entry = g.objectAliases.flight[0];
      const before = glossaryEntryConfidence(entry);
      entry.corrections = 2;
      const after = glossaryEntryConfidence(entry);
      return { ok: after < before, detail: 'before=' + before.toFixed(3) + ' after=' + after.toFixed(3) };
    }
  },
  // ─── Extractor cases ────────────────────────────────────────────────────────
  {
    name: 'tokeniser drops stopwords and short tokens',
    run: async () => {
      const tokens = tokenisePromptForExtraction('show me all the recent flights with attachments');
      // expected to keep: "flight" (singular), "attachment" (singular). everything else is stopword/generic.
      // Generic nouns (attachment) are *not* dropped by the tokeniser itself — only by the candidate filter.
      return {
        ok: tokens.indexOf('flight') !== -1
          && tokens.indexOf('show') === -1
          && tokens.indexOf('recent') === -1
          && tokens.indexOf('with') === -1,
        detail: JSON.stringify(tokens)
      };
    }
  },
  {
    name: 'extractor produces objectAlias candidate when prompt term is absent from object surface',
    run: async () => {
      const candidates = extractObjectAliasCandidates(
        'show me cancelled flights',
        { apiName: 'Product2', label: 'Product' },
        { fields: [{ name: 'Name' }, { name: 'IsActive' }] },
        []
      );
      const found = candidates.find(c => c.term === 'flight');
      return {
        ok: !!found && found.target === 'Product2' && found.type === 'objectAlias',
        detail: JSON.stringify(candidates)
      };
    }
  },
  {
    name: 'extractor filters out generic Salesforce nouns',
    run: async () => {
      const candidates = extractObjectAliasCandidates(
        'show me accounts',
        { apiName: 'Account', label: 'Account' },
        { fields: [] },
        []
      );
      return { ok: candidates.length === 0, detail: JSON.stringify(candidates) };
    }
  },
  {
    name: 'extractor filters out tokens that already appear in the object surface',
    run: async () => {
      const candidates = extractObjectAliasCandidates(
        'show me opportunities by stage',
        { apiName: 'Opportunity', label: 'Opportunity' },
        { fields: [{ name: 'StageName', label: 'Stage' }] },
        []
      );
      // "stage" is in the field surface; "opportunity" is a generic noun. Net: zero candidates.
      return { ok: candidates.length === 0, detail: JSON.stringify(candidates) };
    }
  },
  {
    name: 'extractor filters out tokens that match record-type names',
    run: async () => {
      const candidates = extractObjectAliasCandidates(
        'show me retail accounts',
        { apiName: 'Account', label: 'Account' },
        { fields: [] },
        [{ developerName: 'Retail', name: 'Retail' }]
      );
      return { ok: candidates.length === 0, detail: JSON.stringify(candidates) };
    }
  },
  {
    name: 'noise gate suppresses observations when >3 unfiltered tokens remain',
    run: async () => {
      // None of these are stopwords or generic nouns; none match the surface.
      const candidates = extractObjectAliasCandidates(
        'show me the widget gadget thingy gizmo',
        { apiName: 'Product2', label: 'Product' },
        { fields: [] },
        []
      );
      return { ok: candidates.length === 0, detail: JSON.stringify(candidates) };
    }
  },
  {
    name: 'extractor degrades gracefully without a schema',
    run: async () => {
      const candidates = extractObjectAliasCandidates(
        'cancelled flight',
        { apiName: 'Product2', label: 'Product' },
        null,
        []
      );
      const found = candidates.find(c => c.term === 'flight');
      return { ok: !!found, detail: JSON.stringify(candidates) };
    }
  },
  {
    name: 'extractFromObject parses top-level FROM clause',
    run: async () => {
      return {
        ok: extractFromObject('SELECT Id, Name FROM Product2 WHERE IsActive = true') === 'Product2',
        detail: extractFromObject('SELECT Id, Name FROM Product2 WHERE IsActive = true')
      };
    }
  },
  {
    name: 'extractFromObject ignores subquery sObjects',
    run: async () => {
      const soql = 'SELECT Id, (SELECT Id FROM Cases) FROM Account WHERE Industry = \'Tech\'';
      return {
        ok: extractFromObject(soql) === 'Account',
        detail: extractFromObject(soql)
      };
    }
  },
  {
    name: 'extractFromObject returns null for non-SOQL input',
    run: async () => {
      return {
        ok: extractFromObject('not a query') === null && extractFromObject('') === null && extractFromObject(null) === null,
        detail: 'ok'
      };
    }
  }
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('data:text/html,<html><body></body></html>');

  // Stub chrome.storage with in-memory state. Each test gets a fresh storage
  // by clearing the in-memory map and resetting the glossary cache.
  await page.evaluate(() => {
    window.__storage = {};
    window.chrome = {
      runtime: {},
      storage: {
        local: {
          get: (key, cb) => {
            const out = {};
            if (typeof key === 'string') {
              if (Object.prototype.hasOwnProperty.call(window.__storage, key)) out[key] = window.__storage[key];
            } else if (Array.isArray(key)) {
              key.forEach(k => { if (window.__storage[k] !== undefined) out[k] = window.__storage[k]; });
            }
            setTimeout(() => cb(out), 0);
          },
          set: (obj, cb) => {
            Object.assign(window.__storage, obj);
            if (cb) setTimeout(cb, 0);
          }
        }
      }
    };
    // shared.js defines getOrgCacheKey — we still load shared.js below for the
    // real implementation, but ensure window.location resolves to a stable host
    // so storage keys are deterministic across tests.
  });
  for (const f of ['shared.js', 'org-glossary.js', 'org-glossary-extractors.js']) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }

  console.log(`\n${BOLD}org-glossary unit tests${RESET}\n`);

  let passed = 0;
  let failed = 0;

  for (const c of CASES) {
    // Reset glossary state between cases — clear storage AND the module-level cache.
    await page.evaluate(() => {
      window.__storage = {};
      // glossary.js exposes its cache via the global var name _glossaryCache;
      // wiping it forces the next call to re-read from the (now empty) storage.
      // eslint-disable-next-line no-undef
      _glossaryCache = null;
    });

    const r = await page.evaluate(async (caseSource) => {
      // Reconstruct the test function in page context.
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

  await browser.close();
  console.log(`\n${BOLD}${passed} passed, ${failed} failed${RESET} (out of ${CASES.length})\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
