// Cross-file utilities: session lookup + cached Salesforce REST basePath.
// Loaded as the first content script so flows.js / objects.js / soql.js can rely on it.

// HARD safety gate: every Salesforce HTTP request issued from a content script
// MUST go through sfFetch. The wrapper hard-rejects any method other than GET
// and any request body, so DML, anonymous Apex, metadata deploys, bulk jobs,
// composite POSTs, etc. cannot leave the extension. The agentic @ask surface
// further narrows this with a path allowlist in askFetch (ask.js). See
// security.md for the layered model.
async function sfFetch(url, init) {
  init = init || {};
  if (init.method && String(init.method).toUpperCase() !== 'GET') {
    throw new Error('sfFetch: only GET is allowed (attempted ' + init.method + ')');
  }
  if (init.body != null) {
    throw new Error('sfFetch: request bodies are not allowed (read-only transport)');
  }
  return fetch(url, Object.assign({}, init, { method: 'GET', body: undefined }));
}

// Per-org cache key. The flow/app/object lists are tenant-specific, so caches
// must be scoped by hostname or switching tabs across orgs surfaces stale data
// from the previously-loaded org for up to the cache TTL.
function getOrgCacheKey(base) {
  var host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  return host ? base + ':' + host : base;
}

// SOQL string-literal escape. Both backslash and single quote must be escaped;
// escape backslash first so the second pass doesn't double-escape its output.
// Use this anywhere a value is interpolated into a SOQL/SOSL string literal.
function escapeSoqlLiteral(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

var _basePathCache = null; // { basePath, ts }
var BASEPATH_TTL_MS = 60 * 60 * 1000; // 1 hour

function getSessionFromBackground(sfHost) {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'getSession', sfHost: sfHost }, function (resp) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp && resp.sid ? resp.sid : null);
      });
    } catch (_) { resolve(null); }
  });
}

// Resolve and cache the Salesforce REST API base path (e.g. "/services/data/v60.0").
// Salesforce adds a new version every release, so the result is stable for the session.
async function getApiBasePath(apiBase, headers) {
  if (_basePathCache && (Date.now() - _basePathCache.ts) < BASEPATH_TTL_MS) {
    return _basePathCache.basePath;
  }
  var resp = await sfFetch(apiBase + '/services/data/', { headers: headers });
  if (!resp.ok) throw new Error('Version probe failed: ' + resp.status);
  var versions = await resp.json();
  var latest = versions[versions.length - 1];
  var basePath = (latest && latest.url)
    ? latest.url.replace(/\/$/, '')
    : '/services/data/v' + (latest && latest.version);
  _basePathCache = { basePath: basePath, ts: Date.now() };
  return basePath;
}

// Helper for the common "auth + basePath" preamble in REST calls
async function sfRestPreamble() {
  var apiBase = getApiBase();
  var apiHost = apiBase.replace(/^https?:\/\//, '');
  var sid = await getSessionFromBackground(apiHost);
  var headers = { 'Accept': 'application/json' };
  if (sid) headers['Authorization'] = 'Bearer ' + sid;
  var basePath = await getApiBasePath(apiBase, headers);
  return { apiBase: apiBase, headers: headers, basePath: basePath };
}

// Send a system+user prompt to the background, which proxies to Anthropic.
// By default returns the raw text from the model. Options:
//   - cacheSystem: mark system prompt as an ephemeral cache breakpoint
//   - tools + toolChoice: force structured output via tool_use. When set,
//     resolves to the tool's parsed input object (already a JS object) instead
//     of a string. Use this whenever you need a JSON-shaped response — far
//     more robust than asking the model to emit JSON and then JSON.parse-ing.
function callClaude(systemPrompt, userMessage, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(
      {
        type: 'soql.generate',
        system: systemPrompt,
        user: userMessage,
        cacheSystem: !!opts.cacheSystem,
        tools: opts.tools || null,
        toolChoice: opts.toolChoice || null
      },
      function (resp) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!resp) { reject(new Error('No response from background')); return; }
        if (!resp.ok) { reject(new Error(resp.error || 'Unknown error')); return; }
        if (opts.tools && opts.tools.length) {
          if (!resp.toolInput) { reject(new Error('Model did not call the requested tool')); return; }
          resolve(resp.toolInput);
          return;
        }
        resolve(resp.text);
      }
    );
  });
}
