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

---

# Flow Debug Grounding Eval Harness

Measures whether `@debug` correctly identifies the failing element in a flow
and produces a Flow-Builder-actionable fix, given the flow's metadata, the
debug-panel output, the user's expectation, and the describe schema for every
object the flow touches.

## Run

```
ANTHROPIC_API_KEY=sk-ant-... npm run eval:flow-debug
# Filter to one case:
ANTHROPIC_API_KEY=sk-ant-... node test/flow-debug-eval.js decision-equality-too-narrow
```

The harness loads `flow-debug.js` + its dependencies into a Playwright page,
stubs the Tooling API + describe endpoints with fixture data, and routes
`callClaude` through a real Anthropic call so the model has to ground against
the fixture's metadata and picklist values.

## Fixtures

Each case is one `(flow, debug output, expectation)` triple under
`evals/flow-debug/<case-name>/`:

```
evals/flow-debug/<case-name>/
  meta.json                { description, signal }
  flow.json                { Id, MasterLabel, Metadata }  — the Tooling API record
  debug.txt                pasted Flow Builder Debug-panel output
  expectation.txt          what the user expected (optional)
  record-types.json        [{ SobjectType, DeveloperName, Name }] (can be [])
  describes/
    <ApiName>.json         describe response for each object the flow touches
  expect.json              { summaryInclude, rootCauseInclude, fixInclude,
                             summaryExclude, rootCauseExclude, fixExclude,
                             fixMinSteps }
```

Each `*Include` / `*Exclude` is an array of case-insensitive regex patterns
matched against the corresponding field of the parsed JSON response.

## What each fixture tests

| Fixture                              | Concept under test                                                              |
|--------------------------------------|---------------------------------------------------------------------------------|
| `decision-equality-too-narrow/`      | Decision `Equals` against a single picklist value; describe surfaces the real value set so the model can spot that the filter excludes obviously-matching siblings. |

## Structural validator + retry

`analyzeFlowDebug` runs `validateFlowFix(parsed, meta, describesByObject)` on
the model's response and re-prompts on failure (up to two extra attempts),
mirroring the SOQL validate-and-retry loop. The validator only fires on the
high-confidence hallucination cases — false positives here burn retries
without improving the answer, so it stays conservative:

- Backtick-and-single-quoted names like `` `'Is_Technology'` `` must match an
  element, outcome, or resource defined in the flow metadata. (String
  literals must use double quotes per the system prompt convention, so this
  pattern is reserved for names.)
- `{!$Record.<Field>}` must be a real api name on the trigger object's
  describe. Skipped when describe is unavailable.
- `{!<Name>}` (no `$` prefix) must be a defined resource or element.
  Other `$`-prefixed system refs (`$User`, `$GlobalConstant`, …) are not
  validated.

Each retry includes the **cumulative** failure context (same shape as the
SOQL retry message) so the model cannot regress between attempts. If the
final attempt still fails, the response carries a `validationErrors` array
the UI can surface.

## validateFlowFix unit tests

```
node test/flow-debug-validator-test.js
```

Pure unit tests for the validator — no model calls, no API key, runs in a
second. The validator is hard to exercise via the eval (the model usually
produces clean output for our small fixtures, so the validator stays silent),
but a misfiring validator silently burns retries in production, so it's worth
direct coverage. Add a case here whenever you tighten or loosen the rules.

## What's not tested

- Whether the suggested fix actually resolves the bug when applied. The
  harness asserts on response structure and key references; only a human
  (or a Salesforce simulator we don't have) can confirm the flow runs
  correctly after applying the steps.
- Fields referenced on non-trigger objects (e.g. an Account flow that does
  a Get Records on Case and the fix mentions `Case.Status`). The validator
  currently only walks `$Record.<Field>` against the trigger object.
