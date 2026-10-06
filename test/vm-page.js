// A blank "page" for the unit tests and evals that don't need a DOM.
//
// Loads the extension's scripts into one node:vm context. Each script runs
// like a <script> tag: top-level const/let/function declarations land in one
// shared global scope. The methods mirror the bits of Playwright's Page the
// harnesses used, so the harness code reads the same as before.

const fs = require('fs');
const vm = require('vm');

function newPage() {
  const context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone,
    Event, EventTarget, CustomEvent,
    // What a blank data: URL page reports.
    location: { href: 'data:text/html,', origin: 'null', protocol: 'data:', host: '', hostname: '', pathname: 'text/html,', search: '', hash: '' },
    navigator: { platform: 'Linux x86_64', userAgent: 'node' },
    // objects.js and cache-factory.js announce cache loads on document.
    document: new EventTarget(),
  });
  context.window = context.self = vm.runInContext('globalThis', context);

  return {
    addScriptTag({ path }) {
      vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
    },
    // Like page.evaluate: fn runs from its source text, so it can't close over
    // test variables, and arg crosses over as a JSON copy.
    async evaluate(fn, arg) {
      const run = vm.runInContext(`(json) => (${fn})(json === undefined ? undefined : JSON.parse(json))`, context);
      return run(arg === undefined ? undefined : JSON.stringify(arg));
    },
    async exposeFunction(name, fn) {
      context[name] = fn;
    },
  };
}

module.exports = { newPage };
