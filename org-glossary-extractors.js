// Heuristic extractors that convert (prompt, soql, chosenObject, schema,
// relatedObjects) into glossary observation candidates. Pure functions — no
// LLM calls, no I/O — so they can run synchronously after a feature succeeds.

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
    'created', 'modified', 'updated', 'changed', 'owned', 'assigned',
    'group', 'grouped', 'order', 'sort', 'sorted', 'filter', 'filtered'
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
// A prompt token in this set is recorded as a WEAK observation (lexical
// scoring would have caught it anyway). Tokens not in this set are STRONG
// observations (we genuinely learned a vocabulary mapping).
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

// Soft caps per strength. Strong candidates are precious (one prompt rarely
// surfaces more than 2-3 genuinely-novel terms), so we keep the existing tight
// gate. Weak candidates fire more often by design, so we accept more of them
// per interaction; the confidence formula will down-weight them appropriately.
var EXTRACTOR_MAX_STRONG_PER_INTERACTION = 3;
var EXTRACTOR_MAX_WEAK_PER_INTERACTION = 8;

// Extract objectAlias candidates from one successful interaction.
//
// `chosenObject` is { apiName, label } — the FROM target.
// `schema` is the describe result used during generation (may be null).
// `recordTypes` is the record-type list for chosenObject (may be empty).
// `relatedApiNames` is the list of api names the SOQL touched as dot-walks or
//                   subqueries — recorded with role='related' so the read side
//                   can distinguish row-shape vocabulary from dimension
//                   vocabulary.
//
// Returns a flat list with { type, term, target, role, strength, evidence }.
function extractObjectAliasCandidates(prompt, chosenObject, schema, recordTypes, relatedApiNames) {
  if (!chosenObject || !chosenObject.apiName) return [];
  var tokens = tokenisePromptForExtraction(prompt);
  if (!tokens.length) return [];
  var surface = objectSurfaceTokens(chosenObject, schema, recordTypes);
  var evidence = 'prompt: ' + String(prompt).slice(0, 160);

  var strong = [];
  var weak = [];
  for (var i = 0; i < tokens.length; i++) {
    var term = tokens[i];
    if (EXTRACTOR_GENERIC_NOUNS[term]) continue;     // not org-specific
    var strength = surface[term] ? 'weak' : 'strong';
    var entry = {
      type: 'objectAlias',
      term: term,
      target: chosenObject.apiName,
      role: 'from',
      strength: strength,
      evidence: evidence
    };
    if (strength === 'strong') strong.push(entry);
    else weak.push(entry);
  }

  // Cap per strength independently. Strong cap mirrors v1's "if more than N
  // candidates remain, the prompt is too noisy" rule. Weak cap is looser
  // because weak observations are designed to be common.
  if (strong.length > EXTRACTOR_MAX_STRONG_PER_INTERACTION) strong = [];
  if (weak.length > EXTRACTOR_MAX_WEAK_PER_INTERACTION) weak = [];

  var out = strong.concat(weak);

  // Related-object observations: each prompt token (filtered the same way)
  // also gets one observation per related api name with role='related'. We
  // only emit related observations for *strong* terms — recording weak terms
  // against every related object would explode the storage and dilute the
  // signal (every "by" / "of" / generic preposition match would fan out N-way).
  if (relatedApiNames && relatedApiNames.length) {
    for (var s = 0; s < strong.length; s++) {
      for (var r = 0; r < relatedApiNames.length; r++) {
        if (relatedApiNames[r] === chosenObject.apiName) continue;
        out.push({
          type: 'objectAlias',
          term: strong[s].term,
          target: relatedApiNames[r],
          role: 'related',
          strength: 'strong',
          evidence: evidence
        });
      }
    }
  }

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

// Walk a SOQL string and collect every api name reachable from the outer FROM
// via dot-walked relationship fields or subqueries. The schemaObjects argument
// is the list of describe-loaded objects sent to the generator — we use them
// to resolve relationshipName → referenceTo. Returns a deduped array of api
// names, excluding the FROM target itself.
//
// Best-effort: when the related object's schema isn't loaded (couldn't resolve
// the dot-walk to an api name), the path is silently skipped. The read side
// degrades gracefully — missing related observations just mean we don't learn
// from that walk.
function extractRelatedObjectsFromSoql(soql, schemaObjects) {
  if (!soql || !schemaObjects || !schemaObjects.length) return [];

  var fromApi = extractFromObject(soql);
  if (!fromApi) return [];

  var byName = {};
  schemaObjects.forEach(function (o) {
    if (!o || !o.apiName) return;
    var byRel = {};
    (o.fields || []).forEach(function (f) {
      if (f.relationshipName && f.referenceTo && f.referenceTo.length) {
        byRel[f.relationshipName.toLowerCase()] = f.referenceTo[0];
      }
    });
    byName[o.apiName] = { fieldsByRel: byRel };
  });

  if (!byName[fromApi]) return [];

  var found = {};

  // Dot-walks in SELECT / WHERE / ORDER BY. Strip subqueries first because
  // their relationship chains resolve against the child object, not FROM.
  var outer = String(soql).replace(/\(\s*SELECT\b[^)]*\)/gi, ' ');
  var pathRe = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\b/g;
  var m;
  while ((m = pathRe.exec(outer)) !== null) {
    var segs = m[1].split('.');
    var currentApi = fromApi;
    for (var i = 0; i < segs.length - 1; i++) {
      var schema = byName[currentApi];
      if (!schema) break;
      var relTarget = schema.fieldsByRel[segs[i].toLowerCase()];
      if (!relTarget) break;
      if (relTarget !== fromApi) found[relTarget] = true;
      currentApi = relTarget;
    }
  }

  // Subqueries — (SELECT ... FROM <ChildRelationshipName>). The child
  // relationship name doesn't map to an api name directly without child
  // relationship metadata in describe (we don't capture those today), so we
  // can't resolve these to api names yet. Left as a TODO when populationality
  // / describe captures childRelationships.

  return Object.keys(found);
}
