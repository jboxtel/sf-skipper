# Skipper for Salesforce

**Grounded AI and a command palette for Salesforce — schema-backed, read-only, BYO key.**

Most "AI for Salesforce" tools point an LLM at a screenshot and hope. Skipper goes the other way: every AI feature pulls live context from *your* org — real field API names, picklist values, flow metadata, Apex source, field history — before the model says a word. The model never gets to invent a field, a flow node, or a query.

On top of that grounded AI layer sits a keyboard-first command palette (`⌘⇧K` / `Ctrl+Shift+K`) that fuzzy-matches every object, flow, Lightning app, custom metadata type, custom label, permission set, and Setup page in your org.

Strictly read-only — no DML, no anonymous Apex, no metadata writes. There is no backend; your key and your data stay in your browser.

## Who is this for?

Developers, consultants, and admins who work in multiple orgs and sandboxes. If you switch between orgs all day, you already know the cost of un-grounded AI: a "typical Product2" doesn't exist, every org renames things differently, and a query that works in one sandbox is garbage in the next. Skipper assumes that's the world you live in.

## Install

1. Install from the Chrome Web Store (link to come once approved), or load unpacked for development: clone the repo, open `chrome://extensions`, enable **Developer mode** (top-right), click **Load unpacked**, select the project folder.
2. (For the AI assistants) Right-click the extension icon → **Options** → pick a provider (Gemini, Claude, or GPT) and paste your API key. Gemini has a free tier; the others are pay-as-you-go directly by the provider.

In dev mode, click the reload icon on `chrome://extensions` after editing any source file.

## Screenshots

| | |
|---|---|
| ![Command palette](screenshots/command-palette.jpg) | ![SOQL Generator](screenshots/soql-generator.jpg) |
| Search objects, flows, setup pages, or pick a category | Generate SOQL from natural language |
| ![Flow Debug — paste input](screenshots/flow-debug-input.jpg) | ![Flow Debug — suggested fix](screenshots/flow-debug-suggested-fix.jpg) |
| Paste debug output from Flow Builder | Get a root-cause analysis and suggested fix |
| ![Flow browser](screenshots/flow-browser.jpg) | ![Custom metadata drill-down](screenshots/custom-metadata-drill.jpg) |
| Browse and filter all flows in your org | Drill into custom metadata types |

## AI assistants

Three AI features. Each one grounds the model in your org before answering:

- **`@soql`** fetches the object's describe (real API names, types, references, picklist values) and validates the generated query against the Salesforce planner. Fields that don't exist can't make it through.
- **`@debug`** loads the flow's full metadata from the Tooling API alongside your debug output, so the model reasons about the *actual* flow definition — not your description of it.
- **`@ask`** runs an agentic tool loop that executes read-only SOQL, sObject describes, Apex and Flow source searches, and field-history reads to ground its answer in what's really in your org.

All three are strictly read-only, and **you own the outcome**: Skipper hands you a query, an analysis, or a suggested fix — you decide whether to act on it. 

Bring your own provider key — **Gemini**, **Claude**, or **GPT**, chosen in Options. Your key is stored locally in this browser; prompts go directly to the provider you picked.

### `@ask` — Page Assistant

Take a screenshot of any Salesforce page and ask what's going on — why a validation rule is firing, what a permission setting means, where a custom field gets populated.

Instead of guessing from the screenshot alone, the model works through an agentic tool loop: it runs read-only SOQL, describes sObjects, searches Apex and Flow source, and reads field history until it has enough real org context to answer.

Your last 5 questions and answers are kept per org, so you can reopen `@ask` and page back through previous threads.

### `@soql` — SOQL Generator

Describe what you want in plain English — *"active products in the Hardware family with a standard price set"* — and Skipper:

1. Finds the most likely object from your org's schema (here, `Product2`).
2. Fetches that object's describe (cached for 30 minutes) so the model sees real field API names, types, references, and picklist values *for this org* — including whether `Hardware` is actually a valid `Family` value, what the field is called if your team renamed it, and which custom fields exist alongside the standard ones.
3. Sends the focused schema and your prompt to your chosen provider.
4. Returns a `SELECT` query using only fields that actually exist on the object, validated against the Salesforce planner.

This is what the grounding pipeline buys you: the same prompt against two different orgs produces two different queries, because the model is reading each org's real schema instead of guessing from what a "typical" Product2 looks like.

The query is copied to your clipboard. **Skipper never executes the query for you** — you run it in Developer Console, Workbench, or wherever you normally run SOQL.

### `@debug` — Flow Debug Assistant

When a flow doesn't behave the way you expected:

1. Open the flow in Flow Builder and run a Debug session as you normally would.
2. Copy the **Debug Details** panel output.
3. Press `⌘⇧K` and select **"Debug this flow"** (it appears at the top of the menu when a flow is open).
4. Paste the debug output, optionally add a sentence about what you expected, and click **Analyze**.

Skipper fetches the flow's metadata from the Tooling API, sends it together with your debug output to your chosen provider, and returns a **summary**, **root cause**, **suggested fix**, and **execution path**.

## Command palette

Press `⌘⇧K` (Mac) or `Ctrl+Shift+K` (Windows/Linux) on any Salesforce page. Start typing to fuzzy-match across every object, flow, Lightning app, custom metadata type, custom label, permission set, and Setup quick-link in your org. Type `@` alone to see every scoped picker.

| Shortcut | What it does |
| --- | --- |
| `@object` | Drill into any object's Fields & Relationships, Validation Rules, Page Layouts, Triggers, Record Types, Sharing Rules, and more |
| `@flow` | Browse every active and inactive flow in your org |
| `@app` | Fuzzy-search Lightning apps and jump to `/lightning/app/<DurableId>` |
| `@cmd` | Browse Custom Metadata Types and jump straight to **Manage Records** or the Object Manager definition — skips four clicks through Setup |
| `@label` | Fuzzy-search Custom Labels across MasterLabel, API name, and value |
| `@permset` | Open any permission set in the org by name (real admin-managed sets, not the hidden profile-backed ones) |
| `@setup` | Filter the full Setup pages registry without leaving the palette |
| `refresh` | Re-fetch flows, apps, objects, labels, and permission set caches |

Type the shortcut alone to open the picker, or `@cmd foo` / `@flow foo` / `@object foo` to open it pre-filtered. Backspace on an empty input goes back; Escape closes the palette.

Works in production and sandboxes — `*.lightning.force.com`, `*.my.salesforce.com`, `*.salesforce-setup.com`, and `*.force.com`.

## Privacy and credentials

Full policy in [PRIVACY.md](PRIVACY.md). Short version:

**There is no backend.** No server, no analytics, no telemetry. Your data stays in your browser. The only outbound traffic this extension produces is:

- Calls to your own Salesforce org — the same REST and Tooling APIs the UI you're using already calls.
- Calls to your chosen AI provider (`generativelanguage.googleapis.com` for Gemini, `api.anthropic.com` for Claude, or `api.openai.com` for GPT), but **only** when you actively use an AI feature and **only** if you've configured a key for that provider. If you never set a key, no data ever leaves your browser to any AI provider.

When you do use an AI feature, the prompt — and for `@debug` the flow metadata, for `@ask` the page screenshot plus any tool-call results — is sent to the provider you selected under your own API key, subject to that provider's terms. None of it passes through infrastructure I control.

Your API key is stored in `chrome.storage.local` (local to this browser profile, not synced) and is read by the extension's service worker, not by page scripts — so it never lands in a context where a third-party script on the Salesforce page could see it.

## Permissions

| Permission | Why |
| --- | --- |
| `cookies` (Salesforce hosts) | Read the `sid` session cookie so we can call your org's REST API for the object/flow lists. The cookie value never leaves the browser except as the `Authorization` header on a request to that same org. |
| `storage` | Cache custom-object metadata, flow list, SOQL history, your provider choice, and the API key locally. |
| `scripting` + `activeTab` | Inject the palette UI into the active Salesforce tab when you press the shortcut. |
| `host_permissions` (Salesforce hosts) | Call the Salesforce REST and Tooling APIs against the org you're already logged into. |
| `host_permissions` (AI providers) | Call the provider you selected when you use `@soql`, `@debug`, or `@ask`. Traffic only goes to the provider you have a key for. |

## Architecture

```
manifest.json          Manifest v3 declaration
background.js          Service worker — session cookie lookup + AI provider proxy
providers.js           Adapter layer that translates Anthropic-shaped requests
                       to/from Gemini and OpenAI so content scripts stay
                       provider-agnostic
shared.js              Cross-file helpers (session, REST base path cache)
content.js             Palette UI + state machine
content.css            Palette styles
commands.js            Search resolution + fuzzy matching
objects.js             Object cache (REST describeGlobal + storage)
flows.js               Flow cache (FlowDefinitionView SOQL)
apps.js                Lightning app cache (AppDefinition SOQL)
labels.js              Custom Label cache (ExternalString Tooling API query)
permsets.js            Permission set cache (PermissionSet SOQL, excludes profile-backed)
flow-debug.js          Flow Debug Assistant: Tooling API fetch, prompt, parser
ask.js                 @ask agentic loop + read-only askFetch transport gate
salesforce-urls.js     URL builders + Setup quick-links registry
soql.js                SOQL generator: schema fetch, prompt, history
options.{html,js,css}  Settings page (provider, API key, model)
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the version history.

## License

MIT
