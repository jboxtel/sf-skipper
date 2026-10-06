# Skipper for Salesforce

Chrome MV3 extension: a command palette for Salesforce. No build step. The repo root is the unpacked extension.

## Tests

- `npm test` and the `test:*` / `eval:*` scripts load the extension's scripts into a blank Playwright page with stubbed Chrome and Salesforce APIs. No org needed. `eval:*` needs `ANTHROPIC_API_KEY`.
- `npm run e2e` runs against a real Salesforce dev org through [agent-browser](https://github.com/vercel-labs/agent-browser). Setup and use are below. The tests in `test/e2e.js` come in two groups: palette basics that run signed out on the login page, then the org pickers and `@export`, which run after signing in.

## End-to-end: setup

1. Install agent-browser: `npm i -g agent-browser && agent-browser install`
2. Create `.env.local` in the repo root. It is gitignored.

   ```
   SF_URL=https://login.salesforce.com
   SF_USERNAME=...
   SF_PASSWORD=...
   ```

Everything runs in the agent-browser session `skipper-e2e`. The browser profile lives in `.e2e-browser-profile/`, so cookies and the "trusted device" flag survive between runs. Headless by default. `HEADED=1` shows the window, but only on a machine with a display.

## End-to-end: the three steps

### 1. Open a browser with the extension

```
npm run e2e -- open [url]
```

This always starts a fresh browser, because Chrome only reads the extension's files at launch. Run it again after every code change. Reloading the page is not enough.

`url` defaults to `SF_URL`. The content script runs on every Salesforce host, including the login page, so you can poke the palette without signing in. Only the data pickers (objects, flows, labels…) need a signed-in org.

### 2. Sign in (optional)

```
npm run e2e -- login
npm run e2e -- otp <code>      # only if login says a code was emailed
```

The Salesforce login asks for the username first, then the password on a second screen. The script handles both. A new browser profile triggers an email verification code. The browser waits on that page until you submit the code with `otp`, which ticks "don't ask again". After that, `.e2e-browser-profile/` stays trusted. Deleting `.e2e-browser-profile/` means a new code.

Every login attempt from an untrusted profile emails a fresh code to the org owner. Don't loop on it.

agent-browser's `auth save` / `auth login` vault doesn't fit here: it expects the username and password fields on one screen.

### 3. Drive the extension

Use agent-browser against the open session. Add `--session skipper-e2e` to every command, or `export AGENT_BROWSER_SESSION=skipper-e2e`.

```
agent-browser --session skipper-e2e press Control+Shift+K    # open the palette
agent-browser --session skipper-e2e wait '#sfnav-overlay'
agent-browser --session skipper-e2e snapshot -i -s '#sfnav-overlay'
agent-browser --session skipper-e2e fill '#sfnav-input' '@object'
agent-browser --session skipper-e2e press Enter              # enter the @object picker
agent-browser --session skipper-e2e press Escape             # step back; repeat to close
```

How the palette works:

- **Open:** Ctrl+Shift+K (Cmd+Shift+K on a Mac) toggles it. The content script listens on `document`, so a key press through agent-browser works. The extension's own `commands` shortcut does not fire in automation.
- **Root menu:** it lists the `@` keywords: `@object`, `@flow`, `@app`, `@cmd`, `@label`, `@permset`, `@user`, `@setup`, `@ask`, `@soql`, followed by setup links. Type a keyword and press Enter to enter that picker. Typing other text filters the list.
- **Inside a picker:** typing filters the list. Enter or a click opens the selected item. Arrow keys move the selection. Escape steps back one level: object-scoped, then the picker, then the root, then closed.

DOM to read, all ids prefixed `sfnav-`:

| Selector | What |
|---|---|
| `#sfnav-overlay` | palette root; absent until first opened, hidden with `display:none` when closed |
| `#sfnav-input` | search input; `placeholder` changes per mode |
| `#sfnav-breadcrumb` | current mode, e.g. `@object › Account` |
| `#sfnav-hint` | status line: counts, "loading", errors |
| `.sfnav-item` | a result row; `data-url` is where it navigates; `.selected` marks the highlighted one |
| `.sfnav-item .sfnav-label` / `.sfnav-sublabel` | row text |
| `.sfnav-section-header` | group headings in the root menu |

The content script runs in an isolated world. `agent-browser eval` sees the DOM but not the content script's variables. Read state from the DOM:

```
agent-browser --session skipper-e2e eval "[...document.querySelectorAll('.sfnav-item')].map(e => e.querySelector('.sfnav-label').textContent)"
```

`npm run e2e -- close` closes the browser.

