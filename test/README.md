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

## What each fixture tests

Synthetic fixtures are named by the **grounding signal** they isolate, not by
the example they happen to use. The aviation theme inside each is just a
concrete realization of the abstract concept the fixture is testing.

| Fixture                          | Concept under test                                                                                  |
|----------------------------------|-----------------------------------------------------------------------------------------------------|
| `signal-in-object-name/`         | Domain term lexically matches the object's api name or label.                                       |
| `signal-in-record-type/`         | Domain term lives on a record type attached to a generic standard object.                           |
| `signal-in-picklist-value/`      | Domain term lives only as a picklist value — no record type, no api-name match.                     |
| `signal-via-count-tiebreaker/`   | Two objects score equally on the prompt; record counts disambiguate operational from legacy.        |
| `signal-absent/`                 | The org has no signal for the prompt — must not hallucinate objects, record types, or filter values.|
| `airline-claims-uat/`            | Real-org snapshot — mixes most of the above plus label hijack, zero-record traps, multi-record-type discriminators, German legal terminology. |

Real-org snapshots are the primary source of eval coverage as the matrix grows;
synthetic fixtures isolate single concepts for diagnostic purposes.

## What's not tested

- Parser conformance (stubbed to always succeed).
- Custom field labels / picklist values as a primary grounding signal — current
  `soql.js` scores object api names, labels, and record-type names. Fixtures
  include the field metadata so future grounding strategies can be measured.
