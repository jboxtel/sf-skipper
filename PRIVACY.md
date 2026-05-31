# Privacy Policy — Skipper for Salesforce

_Last updated: 2026-05-25_

Skipper for Salesforce ("the extension") is a Chrome extension that adds a keyboard command palette to Salesforce, plus three optional AI assistants. This document describes what data the extension touches, where it goes, and what we (don't) do with it.

## TL;DR

- **No backend.** The extension has no server. There is no analytics, no telemetry, no usage reporting.
- **Two destinations.** Network traffic only ever goes to (a) the Salesforce org you are already signed into and (b) the AI provider you yourself configure. Nothing else.
- **Local storage only.** Your API key, settings, and the small per-org caches stay in `chrome.storage.local` on your machine. Not synced, not uploaded.
- **Read-only on Salesforce.** Hard-enforced in code: only `GET` requests against a small allowlist of read endpoints. No DML, no anonymous Apex, no metadata writes.

## Data the extension reads

### Your Salesforce session cookie
The extension reads the `sid` cookie that Salesforce sets on your authenticated org so it can call the same REST and Tooling APIs that the Salesforce UI uses. The cookie value never leaves your browser except as the `Authorization` header on a request to that same Salesforce org. It is not transmitted to any other host, not stored persistently, and not visible to scripts on the Salesforce page (the cookie is HttpOnly).

### Salesforce metadata from your org
Once authenticated, the extension fetches and caches in `chrome.storage.local`:
- The list of custom and standard objects (`describeGlobal`)
- The list of Flows, Lightning Apps, Custom Labels, Permission Sets, and Custom Metadata Types
- On demand: object describes, record-type lists, Apex/Flow source bodies, validation rule formulas, field history — only when an AI feature requests them, and only via read-only endpoints.

This data is per-browser-profile and never leaves your machine except to the AI provider you chose, and only when you actively use an AI feature.

### Your AI provider API key
When you configure an AI provider in the Options page, the API key you paste is stored in `chrome.storage.local`. It is read by the extension's service worker (not by content scripts on the Salesforce page), and sent only as an authentication header to the provider you selected. It is never synced across browsers, never uploaded to any third party, never logged.

### Your AI prompts and (for @ask) screenshots
When you use an AI feature, the following is sent to the AI provider you selected:
- **`@soql`** — your natural-language request, the target object's describe (field names, types, picklist values), and a small set of recent SOQL prompts kept for history.
- **`@debug`** — the debug output you pasted, your optional "what I expected" note, and the flow's metadata fetched from the Tooling API.
- **`@ask`** — a screenshot of your current Salesforce browser tab, the URL context, and any tool-call results the model fetches from your org (read-only SOQL rows, sObject describes, Apex/Flow bodies, field-history rows).

This data is transmitted directly from your browser to your chosen provider's API under your own API key, subject to that provider's privacy policy and terms:
- Gemini (Google): https://ai.google.dev/terms
- Claude (Anthropic): https://www.anthropic.com/legal/privacy
- GPT (OpenAI): https://openai.com/policies/privacy-policy

The extension's developer has no access to this traffic, no copy of your prompts, and no relationship with the provider on your behalf.

## What the extension does NOT do

- Does **not** send any data to any server controlled by the developer. There is no developer-controlled backend.
- Does **not** collect analytics, usage metrics, or crash reports.
- Does **not** track which features you use, which orgs you connect to, or what queries you run.
- Does **not** read or transmit any content from non-Salesforce tabs. Content scripts only load on Salesforce hosts (declared in `manifest.json` `content_scripts.matches`).
- Does **not** make writes to your Salesforce org. The extension's transport layer (`sfFetch` / `askFetch`) hard-rejects any non-`GET` request and any request body before the call leaves the browser.
- Does **not** sync your API key or settings across browsers. `chrome.storage.local` is local to this browser profile only.

## Permissions and why

| Permission | Purpose |
| --- | --- |
| `cookies` (Salesforce hosts) | Read the `sid` session cookie to authenticate REST API calls against the same org you're already signed into. |
| `storage` | Cache object/flow/app/label metadata, SOQL history, and store your AI provider choice + API key locally. |
| `scripting` + `activeTab` | Inject the palette UI into the active Salesforce tab when you press the keyboard shortcut. |
| `host_permissions` for Salesforce hosts (`*.lightning.force.com`, `*.my.salesforce.com`, etc.) | Make read-only REST and Tooling API requests against the org you're using. |
| `host_permissions` for `generativelanguage.googleapis.com`, `api.anthropic.com`, `api.openai.com` | Send your AI prompt (and, for `@ask`, a screenshot of your current Salesforce tab) to whichever provider you selected and configured a key for. Traffic only goes to providers you have explicitly configured. |

## Data retention

All data the extension stores is in `chrome.storage.local` on your device. To clear it: remove the extension via `chrome://extensions`, or open the Options page and clear individual fields, or use Chrome's developer tools to inspect `chrome.storage.local` directly.

The extension's developer has no copy of your data and cannot remove anything on your behalf — there is nothing on a server to remove.

## Changes to this policy

If this policy changes materially, the change will be reflected in this file with an updated date at the top. Because the policy lives in the same Git repository as the source code, the full revision history is public at `https://github.com/jboxtel/sf-skipper/commits/main/PRIVACY.md`.

## Contact

Questions about this policy or about how the extension handles data: open an issue at `https://github.com/jboxtel/sf-skipper/issues` or email `skipperforsalesforce@gmail.com`.
