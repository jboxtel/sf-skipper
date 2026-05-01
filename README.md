# Salesforce Commander

A Chrome extension that adds a command palette (`⌘⇧K` / `Ctrl+Shift+K`) to any Salesforce page. Jump to any object, field, flow, or setup page in two keystrokes — and generate SOQL from natural language with Claude.

## Features

- **Instant navigation** — Fuzzy-search every object (standard + custom), every Setup page, and every Flow in your org.
- **Object Manager shortcuts** — Drill into an object and jump to Fields & Relationships, Validation Rules, Page Layouts, Triggers, etc.
- **Flow picker** — Browse all active and inactive flows with one keystroke.
- **SOQL Generator** — Type natural language ("all open cases assigned to me last week"), get a ready-to-run SOQL query. Powered by Claude (Anthropic API).
- **Recent SOQL history** — Last 10 queries are saved locally and clickable to re-load.

## Install (development)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the cloned directory.
4. (Optional, for SOQL Generator) Right-click the extension icon → **Options** → paste your Anthropic API key.

## Usage

| Action | How |
|---|---|
| Open palette | `⌘⇧K` / `Ctrl+Shift+K` on any Salesforce page |
| Browse all objects | Type `object` → Enter |
| Browse all flows | Type `flow` → Enter |
| Open SOQL Generator | Type `soql` → Enter |
| Search Setup quick-links | Type freely (e.g. `profiles`, `permission set`) |
| Drill into an object | Select an object → Enter |
| Back / cancel | Backspace on empty input / Escape |

## SOQL Generator

The SOQL Generator sends your prompt and a focused schema (matching object's fields, types, picklist values) to Claude and returns a `SELECT` query. It does **not** execute the query — copy it and run it in Developer Console or Workbench yourself.

The Anthropic API key is stored in `chrome.storage.local` (your browser only) and is sent only to `api.anthropic.com`. The extension talks to the Anthropic API from the service worker, so the key never enters page context.

## Architecture

```
manifest.json          # Manifest v3, host permissions, options page
background.js          # Service worker — session cookie + Anthropic proxy
content.js             # Palette UI + state machine
content.css            # Palette styles
commands.js            # Search resolution, fuzzy matching
objects.js             # Object cache (REST describeGlobal + storage)
flows.js               # Flow cache (FlowDefinitionView SOQL)
salesforce-urls.js     # URL builders + setup quick-links
soql.js                # SOQL generator: schema fetch, prompt, history
options.{html,js,css}  # Settings page (API key, model)
```

## License

MIT
