# SOQL Grounding Eval Harness

Measures whether `@soql` picks the right object and produces a sensible query against
different org metadata shapes. The variable is the **org shape**, not the prompt —
the same natural-language intent against different metadata layouts should produce
different queries.

## Run

```
ANTHROPIC_API_KEY=sk-ant-... npm run eval:soql
# Filter to one cell:
ANTHROPIC_API_KEY=sk-ant-... node test/soql-eval.js airline-claims-uat all-legal-cases
```

The harness loads `soql.js` + its dependencies into a Playwright page, stubs the
Salesforce REST endpoints with fixture data, and routes `callClaude` through a
real Anthropic call so the model has to actually ground against the fixture.

The query planner is stubbed to always succeed — we measure object choice and
intent, not parser conformance (that's the planner's job in real runs).

## Fixtures

All eval fixtures live under `evals/<name>/`. Each fixture is a snapshot of an
org's metadata — either captured from a real customer org (the preferred case)
or synthesized to exercise a specific grounding pattern.

```
evals/<fixture-name>/
  meta.json           { description, domain, shape }
  sobjects.json       array of { name, label, custom, keyPrefix }
  counts.json         { apiName: recordCount }
  record-types.json   [{ SobjectType, DeveloperName, Name, IsActive }]
  describe/
    <ApiName>.json    describe response — { name, label, fields: [...] }
  prompts.json        natural-language prompts that exercise this fixture
```

Describe field entries follow the real Salesforce shape:
`{ name, label, type, referenceTo?, picklistValues?, inlineHelpText? }`.

## Capturing a fixture from a real org

`docs/grounding.html` includes a prompt template you can feed to an LLM with
read-only Salesforce access (e.g. Claude Code with the Salesfive AI MCP, or
ChatGPT with a Salesforce-connected GPT). It introspects the org, redacts PII,
and prints the fixture files in this exact format plus a starter `prompts.json`.

## Prompt schema

`evals/<name>/prompts.json` is an array of:

```json
{
  "id": "kebab-case-id",
  "prompt": "natural-language request",
  "expect": {
    "<fixture-name>": {
      "object": "ExpectedPrimaryObjectApiName",
      "mustInclude": ["(?i)FROM\\s+Product2\\b", "Cancelled"],
      "mustNotInclude": ["__dlm", "(?i)FROM\\s+Order\\b"]
    }
  },
  "_expectedSoql": "human-review reference SOQL — not consumed by the runner",
  "_rationale": "one-sentence explanation of why this is the correct answer"
}
```

- Default target is the fixture the file lives in. Override with `"orgs": [...]`
  if the same prompt should run against multiple fixtures.
- `mustInclude` / `mustNotInclude`: case-insensitive regex patterns matched
  against the generated SOQL.
- `object`: exact-match against `parsed.objectName`.
- Fields whose names start with `_` are documentation — the runner ignores them.

## Org-shape taxonomy

Reference for what synthetic fixtures cover. Real-org snapshots in `evals/`
typically mix several shapes within a single fixture.

| Shape | Example fixture                 | What it tests                                                    |
|-------|---------------------------------|------------------------------------------------------------------|
| A     | `flights-literal/`              | Literal custom object — pure lexical matching.                   |
| B     | `flights-as-product2/`          | Concept lives on a repurposed standard + record type.            |
| C     | (folded into B)                 | Record-type discriminator.                                       |
| D     | `flights-picklist-only/`        | Picklist-value discriminator (`Product2.Family = 'Flight'`).     |
| E     | (not yet)                       | Hybrid — one part lexical, one part metadata-grounded.           |
| F     | `flights-as-product2/` (lure)   | Misleading Data Cloud DMO sibling alongside real object.         |
| G     | `two-flight-objects/`           | Multi-tenant ambiguity — count-grounding tiebreaker.             |
| H     | `no-flight-concept/`            | Missing concept — should fail clean, not hallucinate.            |
| real  | `airline-claims-uat/`                   | Real-org snapshot — Service Cloud + claims + custom domain.      |

## What's not tested

- Parser conformance (stubbed to always succeed).
- Custom field labels / picklist values as a primary grounding signal — current
  `soql.js` scores object api names, labels, and record-type names. Fixtures
  include the field metadata so future grounding strategies can be measured.
