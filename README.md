# Salesforce Commander

A keyboard-first command palette for Salesforce. Press `⌘⇧K` (Mac) or `Ctrl+Shift+K` (Windows/Linux) on any Salesforce page and jump to any object, field, flow, or setup page in seconds. 

> Built for admins, developers, and consultants who live in Salesforce Setup all day and would like to spend less time clicking through menus.

## Why

Salesforce Setup is powerful but slow to navigate. Finding a specific validation rule on a custom object can take five clicks and three page loads. Salesforce Commander turns that into two keystrokes:

- `⌘⇧K`, type `account val`, Enter → you're on **Validation Rules** for **Account**.
- `⌘⇧K`, type `permission set`, Enter → you're on the Permission Sets list.
- `⌘⇧K`, type `soql`, Enter, "all open cases assigned to me this week" → you have a working SOQL query in the clipboard.

No backend. No subscriptions. Your Salesforce session and (optionally) your Anthropic API key live in your browser only.

## Features

- **Universal search** — Fuzzy-match across every standard object, every custom object in your org, every Setup quick-link, and every Flow.
- **Custom metadata picker** — Browse every custom metadata type in your org and jump directly to its records or its Object Manager definition. Skips the four clicks through Setup → Custom Metadata Types → row → Manage Records. 
- **Object drill-down** — Pick an object and jump straight to Fields & Relationships, Validation Rules, Page Layouts, Triggers, Record Types, Sharing Rules, and more.
- **Flow picker** — Browse every active and inactive flow with one keystroke.
- **Lightning app picker** — Type `@app` to fuzzy-search every Lightning app in the org and jump straight to it (`/lightning/app/<DurableId>`).
- **Inline filter** — Type `@cmd account`, `@flow opportunity`, `@object case`, or `@app sales` and the picker opens already filtered. No need to press Enter first.
- **Manual refresh** — Caches refresh automatically every 30 minutes. Type `@refresh` to force-refresh the flow, app, and object caches immediately (handy after creating a new flow or installing a managed package).
- **SOQL Generator** — Describe what you want; get a `SELECT` query that uses real field names from the object's describe (no hallucinated fields). The query is copied to your clipboard — execution stays in your hands.
- **Flow Debug Assistant** — Open a flow in the Flow Builder, run a debug session, paste the Debug-panel output into Commander, and Claude tells you which path the flow took, what went wrong, and how to fix it.
- **Works in production and sandboxes** — `*.lightning.force.com`, `*.my.salesforce.com`, `*.salesforce-setup.com`, and `*.force.com`.

## Install (developer mode)

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the project folder.
4. (Optional, for the SOQL Generator) Right-click the extension icon → **Options** → paste your Anthropic API key.

> The extension is not yet published to the Chrome Web Store. Until then, "Load unpacked" is the supported install path.

After changing any source file, click the reload icon for the extension on `chrome://extensions`.

## Usage

| Action | How |
| --- | --- |
| Open the palette | `⌘⇧K` / `Ctrl+Shift+K` on any Salesforce page |
| **See all shortcuts** | Type `@` (alone) — palette lists every available shortcut |
| Browse all objects | Type `object` → Enter |
| Browse all flows | Type `flow` → Enter |
| Browse Lightning apps | Type `app` → Enter |
| Browse custom metadata types | Type `cmd` (or `cmdt` / `mdt`) → Enter, pick a type, then **Manage Records** or **Object Definition** |
| Filter inline | Type `@cmd foo` / `@flow foo` / `@object foo` / `@app foo` — the picker opens pre-filtered |
| Refresh caches | Type `refresh` → Enter (re-fetches flows, apps, and objects) |
| Open SOQL Generator | Type `soql` → Enter |
| Debug a flow | Open a flow → press `⌘⇧K` → "Debug this flow" (or type `debug` → Enter) |
| Search Setup quick-links | Type freely — e.g. `profiles`, `permission set`, `audit trail` |
| Drill into an object | Select an object → Enter, then pick a section |
| Back / cancel | Backspace on empty input / Escape |

## SOQL Generator

The SOQL Generator turns natural language into a Salesforce SOQL query:

1. You type a request — e.g. *"all open cases assigned to me this week"*.
2. The extension finds the most likely object from your org's schema and fetches that object's describe (cached for 30 minutes).
3. The object name plus a focused schema (field API names, types, references, picklist values) is sent to Claude along with your prompt.
4. Claude returns a `SELECT` query using only fields that actually exist on the object.
5. The query is shown in the palette — copy it and run it in Developer Console, Workbench, or wherever you usually run SOQL.

**The extension never executes the query for you.** You always copy and run it yourself.

## Flow Debug Assistant

When something in a flow doesn't behave as expected:

1. Open the flow in Flow Builder and run a Debug session as you normally would.
2. Copy the **Debug Details** panel output (the right-hand panel that shows the path the flow took).
3. Press `⌘⇧K` and select **"Debug this flow"** (it appears at the top of the menu when a flow is open).
4. Paste the debug output, optionally add a sentence about what you expected, and click **Analyze**.

Commander fetches the flow's metadata from the Tooling API, sends it together with your debug output to Claude, and returns a **summary**, **root cause**, **suggested fix**, and the **execution path**. Like the SOQL Generator, it's read-only — no changes are made to the flow.

### Privacy and credentials

- Your Anthropic API key is stored in `chrome.storage.local` — local to this browser profile, not synced.
- The Anthropic API call happens in the extension's service worker, not in the page. Your key never enters page context where a third-party script could see it.
- The only outbound network calls are to your Salesforce org and to `api.anthropic.com`.
- No telemetry. No analytics.

## Permissions

| Permission | Why |
| --- | --- |
| `cookies` (Salesforce hosts) | Read the `sid` session cookie so we can call your org's REST API for the object/flow lists. |
| `storage` | Cache custom-object metadata, flow list, SOQL history, and your Anthropic key locally. |
| `scripting` + `activeTab` | Inject the palette UI into the active Salesforce tab when you press the shortcut. |
| `host_permissions` (Salesforce + `api.anthropic.com`) | Call the Salesforce REST API and (optionally) the Anthropic Messages API. |

## Architecture

```
manifest.json          Manifest v3 declaration
background.js          Service worker — session cookie lookup + Anthropic proxy
shared.js              Cross-file helpers (session, REST base path cache)
content.js             Palette UI + state machine
content.css            Palette styles
commands.js            Search resolution + fuzzy matching
objects.js             Object cache (REST describeGlobal + storage)
flows.js               Flow cache (FlowDefinitionView SOQL)
apps.js                Lightning app cache (AppDefinition SOQL)
flow-debug.js          Flow Debug Assistant: Tooling API fetch, prompt, parser
salesforce-urls.js     URL builders + Setup quick-links registry
soql.js                SOQL generator: schema fetch, prompt, history
options.{html,js,css}  Settings page (API key, model)
test.js                Playwright smoke tests
```

## License

MIT
