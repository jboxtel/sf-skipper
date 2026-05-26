// Heuristic extractors that convert (prompt, soql, chosenObject, schema) into
// glossary observation candidates. Pure functions — no LLM calls, no I/O — so
// they can run synchronously after a feature succeeds. Phase 1 only emits
// objectAlias candidates; fieldAlias and valueSemantic extraction lands with
// the read-side rollout in v1.1 when there's a UI to surface and correct them.

// Words that almost never carry org-specific meaning. Anything in this set is
// dropped during prompt tokenisation so we don't try to learn that "show",
// "find", "active" etc. map to whichever object the user asked about.
var EXTRACTOR_STOPWORDS = (function () {
  var list = [
    'show', 'list', 'give', 'find', 'fetch', 'pull', 'return', 'select', 'query',
    'all', 'every', 'each', 'any', 'some', 'most', 'last', 'first', 'recent',
    'open', 'closed', 'active', 'inactive', 'new', 'old', 'current',
    'where', 'with', 'from', 'that', 'this', 'these', 'those', 'their', 'there',
    'have', 'has', 'had', 'are', 'were', 'was', 'been', 'being',
    'and', 'but', 'for', 'the', 'not', 'than', 'then', 'when', 'who', 'whom',
    'what', 'which', 'how', 'why', 'about', 'into', 'over', 'under', 'between',
    'count', 'total', 'sum', 'average', 'many', 'much', 'more', 'less',
    'today', 'yesterday', 'tomorrow', 'week', 'month', 'year', 'quarter',
    'this', 'last', 'next', 'days', 'months', 'years',
    'please', 'just', 'only', 'also', 'really', 'still', 'always', 'never',
    'me', 'my', 'mine', 'our', 'we', 'us', 'you', 'your',
    'records', 'record', 'rows', 'row', 'data', 'list', 'lists',
    'created', 'modified', 'updated', 'changed', 'owned', 'assigned'
  ];
  var set = {};
  for (var i = 0; i < list.length; i++) set[list[i]] = true;
  return set;
})();

// Tokenise a natural-language prompt into candidate business terms. We keep
// alphabetic words of length 4+ that aren't stopwords. Numbers, punctuation,
// SOQL fragments leaking into the prompt all get dropped.
function tokenisePromptForExtraction(prompt) {
  if (!prompt) return [];
  var lowered = String(prompt).toLowerCase().replace(/[-']/g, '');
  var raw = lowered.split(/[^a-z]+/);
  var tokens = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var t = raw[i];
    if (!t || t.length < 4) continue;
    if (EXTRACTOR_STOPWORDS[t]) continue;
    // Strip simple plural so "flights" matches "flight" in the schema check.
    var singular = t.replace(/(?:es|s)$/, '');
    if (singular.length >= 3) t = singular;
    if (seen[t]) continue;
    seen[t] = true;
    tokens.push(t);
  }
  return tokens;
}

// Build the set of "surface" tokens for an object — every token that already
// appears in its api name, label, record-type names, or field names/labels.
// If a prompt token isn't in this set, yet the object was chosen anyway, we
// have a candidate alias.
function objectSurfaceTokens(chosenObject, schema, recordTypes) {
  var tokens = {};
  function add(s) {
    if (!s) return;
    var lowered = String(s).toLowerCase().replace(/[-']/g, '');
    var parts = lowered.split(/[^a-z]+/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p.length < 3) continue;
      tokens[p] = true;
      var singular = p.replace(/(?:es|s)$/, '');
      if (singular.length >= 3) tokens[singular] = true;
    }
  }
  if (chosenObject) {
    add(chosenObject.apiName);
    add((chosenObject.apiName || '').replace(/__c$/, '').replace(/_/g, ' '));
    add(chosenObject.label);
  }
  if (Array.isArray(recordTypes)) {
    for (var r = 0; r < recordTypes.length; r++) {
      add(recordTypes[r].name);
      add((recordTypes[r].developerName || '').replace(/_/g, ' '));
    }
  }
  if (schema && Array.isArray(schema.fields)) {
    for (var f = 0; f < schema.fields.length; f++) {
      var fld = schema.fields[f];
      add(fld.name);
      add((fld.name || '').replace(/__c$/, '').replace(/_/g, ' '));
      add(fld.label);
    }
  }
  return tokens;
}

// Strip extremely common Salesforce noun tokens that aren't org-specific aliases
// — they're shared vocabulary across every Salesforce org. We don't want to
// record "account → Account" or "case → Case" as a learned mapping.
var EXTRACTOR_GENERIC_NOUNS = (function () {
  var list = [
    'account', 'accounts', 'contact', 'contacts', 'lead', 'leads',
    'opportunity', 'opportunities', 'case', 'cases', 'product', 'products',
    'user', 'users', 'task', 'tasks', 'event', 'events',
    'campaign', 'campaigns', 'order', 'orders', 'quote', 'quotes',
    'contract', 'contracts', 'asset', 'assets', 'email', 'emails',
    'attachment', 'attachments', 'note', 'notes', 'file', 'files'
  ];
  var set = {};
  for (var i = 0; i < list.length; i++) {
    set[list[i]] = true;
    var singular = list[i].replace(/(?:es|s)$/, '');
    if (singular.length >= 3) set[singular] = true;
  }
  return set;
})();

// Max candidates per interaction. If filtering leaves more than this, the
// prompt is too noisy to learn from cleanly — we'd be guessing which token is
// the alias vs. which are value-semantic noise. Phase 1 prefers fewer, higher-
// signal observations over volume.
var EXTRACTOR_MAX_CANDIDATES_PER_INTERACTION = 3;

// Extract objectAlias candidates from one successful SOQL interaction.
// `chosenObject` is { apiName, label }. `schema` is the describe result used
// during generation (may be null in @ask paths where the model used its own
// describe call — surface tokens degrade gracefully). `recordTypes` is the
// record-type list for chosenObject (may be empty).
function extractObjectAliasCandidates(prompt, chosenObject, schema, recordTypes) {
  if (!chosenObject || !chosenObject.apiName) return [];
  var tokens = tokenisePromptForExtraction(prompt);
  if (!tokens.length) return [];
  var surface = objectSurfaceTokens(chosenObject, schema, recordTypes);
  var out = [];
  for (var i = 0; i < tokens.length; i++) {
    var term = tokens[i];
    if (EXTRACTOR_GENERIC_NOUNS[term]) continue;     // not org-specific
    if (surface[term]) continue;                      // already in the object's surface — model picked it from lexical signal, not an alias
    out.push({
      type: 'objectAlias',
      term: term,
      target: chosenObject.apiName,
      evidence: 'prompt: ' + String(prompt).slice(0, 160)
    });
  }
  // Conservative gate: too many candidates means the prompt is full of nouns
  // we can't disambiguate without read-side feedback. Skip entirely rather
  // than poison the glossary with weak observations.
  if (out.length > EXTRACTOR_MAX_CANDIDATES_PER_INTERACTION) return [];
  return out;
}

// Parse the FROM clause out of a SOQL string. Returns the top-level object api
// name, or null. Handles "SELECT ... FROM X", ignores subqueries.
function extractFromObject(soql) {
  if (!soql) return null;
  // Strip subqueries — anything inside parentheses — so we don't grab the
  // child sObject from an inner SELECT.
  var stripped = String(soql).replace(/\([^)]*\)/g, ' ');
  var m = stripped.match(/\bFROM\s+([A-Za-z][A-Za-z0-9_]*)/i);
  return m ? m[1] : null;
}
