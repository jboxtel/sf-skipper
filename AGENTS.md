# Skipper for Salesforce

Chrome MV3 extension: a command palette for Salesforce. No build step. The repo root is the unpacked extension.

## Tests

`test:*` and `eval:*` load the extension's scripts into a `node:vm` context with stubbed Chrome and Salesforce APIs. Plain Node: no browser, no org, no npm install. `eval:*` also calls Claude; `test/README.md` covers the evals and their fixtures, which aren't in the repo.

`npm test` loads the real extension into a browser through [agent-browser](https://github.com/vercel-labs/agent-browser) and runs on the Salesforce login page, signed out. For what it covers, read the `section('…')` calls in `test/e2e.js`. Its header comment lists every subcommand.

Setup: `npm i -g agent-browser && agent-browser install`. Signing in is optional: `npm test -- signed-in` reads `SF_URL`, `SF_USERNAME` and `SF_PASSWORD` from a gitignored `.env.local`; the e2e.js header explains the emailed verification code.

Everything runs in the agent-browser session `skipper-e2e`, with its profile in `.e2e-browser-profile/`. Headless by default; `HEADED=1` shows the window on a machine with a display.

## Driving the extension by hand

`npm test -- open [url]` starts a fresh browser with the extension. Chrome reads the extension's files only at launch, so run it again after every code change; reloading the page is not enough. The content script also runs on the login page, so the palette works signed out. Only the data pickers need an org.

Then pass `--session skipper-e2e` to every agent-browser command, or `export AGENT_BROWSER_SESSION=skipper-e2e`:

```
agent-browser press Control+Shift+K          # toggle the palette
agent-browser fill '#sfnav-input' '@object'
agent-browser press Enter                    # enter the picker
agent-browser press Escape                   # step back one level; repeat to close
```

The extension's own `commands` shortcut never fires in automation, but the content script listens for Ctrl+Shift+K on `document`, so a key press works. The content script runs in an isolated world: `agent-browser eval` sees the DOM, not its variables. `npm test -- palette-state` prints the whole palette, from the DOM, as JSON.

| Selector | What |
|---|---|
| `#sfnav-overlay` | palette root; absent until first opened, `display:none` when closed |
| `#sfnav-input` | search input; `placeholder` changes per mode |
| `#sfnav-breadcrumb` | current mode, e.g. `@object › Account` |
| `#sfnav-hint` | status line: counts, "loading", errors |
| `.sfnav-item` | a result row; `data-url` is where it goes, `.selected` is the highlight |
| `.sfnav-label` / `.sfnav-sublabel` | row text |

## Gotchas

Click palette controls through the DOM, with `clickEl` or `clickItem` from e2e.js. agent-browser's `click` aims at coordinates, and the palette sits at the bottom of the viewport under the page's own layout.

The first-run walkthrough covers the palette whenever the `walkthroughSeen` flag is unset. Options' "Show walkthrough" resets it, so a section that leaves it reset puts the tour in front of later ones. `openPalette` calls `skipTour`; call it yourself after anything else that opens the palette.

Tabs opened by `chrome.runtime.openOptionsPage` don't appear in `agent-browser tab list`. Tabs opened by `window.open` do. The test watches for Options with `chrome.extension.getViews` instead.

For a tab that predates the extension, the on-demand injection path in `background.js`, open `chrome://extensions`, call `chrome.management.setEnabled(id, false)` there, load the page, then enable it again. The extension id derives from the repo's absolute path; e2e.js computes it as `EXT_ID`.
