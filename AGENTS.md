# Skipper for Salesforce

Chrome MV3 extension: a command palette for Salesforce. No build step. The repo root is the unpacked extension.

## Tests

`npm test` runs the `test:*` suites in plain Node, in under a second: they load the extension's scripts into a `node:vm` context with stubbed Chrome and Salesforce APIs. No browser, no org, no npm install. The `eval:*` scripts work the same way but also call Claude; `test/README.md` covers the evals and their fixtures, which aren't in the repo.

`npm run e2e` loads the real extension into a browser through [agent-browser](https://github.com/vercel-labs/agent-browser) and runs on the Salesforce login page, signed out. For what it covers, read the `section('…')` calls in `test/e2e.js`. Its header comment lists every subcommand.

Setup: `npm i -g agent-browser && agent-browser install`. Signing in is optional: `npm run e2e -- signed-in` reads `SF_URL`, `SF_USERNAME` and `SF_PASSWORD` from a gitignored `.env.local`; the e2e.js header explains the emailed verification code.

Everything runs in the agent-browser session `skipper-e2e`, with its profile in `.e2e-browser-profile/`. Headless by default; `HEADED=1` shows the window on a machine with a display.

## Driving the extension by hand

`npm run e2e -- open [url]` starts a fresh browser with the extension. Chrome reads the extension's files only at launch, so run it again after every code change; reloading the page is not enough. The content script also runs on the login page, so the palette works signed out. Only the data pickers need an org.

Then pass `--session skipper-e2e` to every agent-browser command, or `export AGENT_BROWSER_SESSION=skipper-e2e`:

```
agent-browser press Control+Shift+K          # toggle the palette
agent-browser fill '#sfnav-input' '@object'
agent-browser press Enter                    # enter the picker
agent-browser press Escape                   # step back one level; repeat to close
```

The extension's own `commands` shortcut never fires in automation, but the content script listens for Ctrl+Shift+K on `document`, so a key press works. The content script runs in an isolated world: `agent-browser eval` sees the DOM, not its variables. `npm run e2e -- palette-state` prints the whole palette, from the DOM, as JSON. Until the walkthrough has been seen, it covers the palette on open; `agent-browser click .sfnav-cm-skip` dismisses it.

| Selector | What |
|---|---|
| `#sfnav-overlay` | palette root; absent until first opened, `display:none` when closed |
| `#sfnav-input` | search input; `placeholder` changes per mode |
| `#sfnav-breadcrumb` | current mode, e.g. `@object › Account` |
| `#sfnav-hint` | status line: counts, "loading", errors |
| `.sfnav-item` | a result row; `data-url` is where it goes, `.selected` is the highlight |
| `.sfnav-label` / `.sfnav-sublabel` | row text |
