# SOQL Grounding Eval Harness

Measures whether `@soql` picks the right object and produces a sensible query against
different org metadata shapes. The variable is the **org shape**, not the prompt —
the same natural-language intent against different metadata layouts should produce
different queries.

## Run

```
ANTHROPIC_API_KEY=sk-ant-... npm run eval:soql
# Filter to one cell:
ANTHROPIC_API_KEY=sk-ant-... node test/soql-eval.js flights-as-product2 cancelled-flight-with-assignments
```

The harness loads `soql.js` + its dependencies into a Playwright page, stubs the
Salesforce REST endpoints with fixture data, and routes `callClaude` through a
real Anthropic call so the model has to actually ground against the fixture.

The query planner is stubbed to always succeed — we measure object choice and
intent, not parser conformance (that's the planner's job in real runs).

## Org-shape taxonomy

| Shape | Example fixture                 | What it tests                                                    |
|-------|---------------------------------|------------------------------------------------------------------|
| A     | (not yet)                       | Literal custom object — pure lexical matching.                   |
| B     | `flights-as-product2/`          | Domain concept lives on a repurposed standard object.            |
| C     | (not yet)                       | Standard object discriminated by record type.                    |
| D     | (not yet)                       | Standard object discriminated by picklist value.                 |
| E     | (not yet)                       | Hybrid — one part lexical, one part metadata-grounded.           |
| F     | `flights-as-product2/` (lure)   | Misleading Data Cloud DMO sibling alongside real object.         |
| G     | (not yet)                       | Multi-tenant ambiguity — count-grounding tiebreaker.             |
| H     | (not yet)                       | Missing concept — should fail clean, not hallucinate.            |

## Adding a fixture

```
test/fixtures/orgs/<shape-name>/
  meta.json           { description, domain, shape }
  sobjects.json       array of { name, label, custom, keyPrefix }
  counts.json         { apiName: recordCount }       (optional)
  record-types.json   [{ SobjectType, DeveloperName, Name, IsActive }]  (optional)
  describe/
    <ApiName>.json    describe response — at least { name, label, fields: [...] }
```

Field describe entries should match the real shape Salesforce returns:
`{ name, label, type, referenceTo?, picklistValues?, inlineHelpText? }`.

## Adding a prompt

Append to `test/fixtures/prompts.json`:

```json
{
  "id": "kebab-case-id",
  "prompt": "natural-language request",
  "orgs": ["flights-as-product2"],
  "expect": {
    "flights-as-product2": {
      "object": "Product2",
      "mustInclude": ["Cancelled"],
      "mustNotInclude": ["__dlm"]
    }
  }
}
```

`mustInclude` / `mustNotInclude` are case-insensitive regex patterns matched
against the generated SOQL. `object` is exact-match against `parsed.objectName`.

## What's not tested

- Parser conformance (stubbed to always succeed).
- Record-type-aware scoring or field-label scoring — current `soql.js` only does
  lexical matching on object label/apiName. Fixtures include `record-types.json`
  and rich field metadata so future grounding strategies can be measured against
  the same baseline.
