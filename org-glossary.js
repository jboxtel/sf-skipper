// Per-org semantic layer. Accumulates business-term → Salesforce-metadata
// mappings observed across @soql, @ask, and (eventually) @debug. Features call
// glossaryObserve() after a successful interaction; subsequent prompts read via
// glossaryLookupForPrompt() to add org-specific anchors to the model context.
//
// Storage key is org-scoped via getOrgCacheKey so switching tabs across orgs
// keeps each org's vocabulary separate.

var ORG_GLOSSARY_STORAGE_KEY = 'sfnavOrgGlossary';
// v2 introduces:
//   - role (from | related) in the bucket key so the same term can carry
//     independent confidence for "this is the FROM target" vs "this appears
//     in a dot-walk." A v1→v2 entry has no role and would conflate those.
//   - strength (strong | weak) split inside per-feature observation counters.
//     v1 emitted a single counter and refused to record surface-matching
//     tokens at all, so loading v1 entries as either strength would mislead
//     the read side. Clean discard on version mismatch.
var ORG_GLOSSARY_VERSION = 2;
var ORG_GLOSSARY_STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
var ORG_GLOSSARY_STALE_MIN_OBS = 3;                   // total obs (weighted) below this expire on staleness
var ORG_GLOSSARY_MAX_EVIDENCE = 5;                    // ring buffer of recent contexts per entry
var ORG_GLOSSARY_EVIDENCE_TRUNC = 200;
var ORG_GLOSSARY_MAX_ENTRIES = 500;                   // soft cap; compaction kicks in past this
var ORG_GLOSSARY_FEATURES = ['soql', 'ask', 'debug', 'manual'];
var ORG_GLOSSARY_WEAK_WEIGHT = 0.3;                   // weak obs count for less than strong in confidence math

var _glossaryCache = null;        // in-memory copy of the parsed document
var _glossaryLoadPromise = null;  // dedupes concurrent loads
var _glossaryWritePromise = Promise.resolve(); // serialise writes

function _emptyGlossary() {
  return {
    version: ORG_GLOSSARY_VERSION,
    updatedAt: 0,
    objectAliases: {},
    fieldAliases: {},
    valueSemantics: {}
  };
}

function _emptyObservations() {
  var o = {};
  for (var i = 0; i < ORG_GLOSSARY_FEATURES.length; i++) {
    o[ORG_GLOSSARY_FEATURES[i]] = { strong: 0, weak: 0 };
  }
  return o;
}

// Total weighted observation count across all features.
function _entryWeightedTotal(entry) {
  if (!entry || !entry.observations) return 0;
  var total = 0;
  for (var f in entry.observations) {
    if (!Object.prototype.hasOwnProperty.call(entry.observations, f)) continue;
    var bucket = entry.observations[f] || {};
    total += (bucket.strong || 0) + ORG_GLOSSARY_WEAK_WEIGHT * (bucket.weak || 0);
  }
  return total;
}

// Confidence rewards cross-feature corroboration (sources counts features with
// any observation) and penalises corrections. Weak observations contribute at
// ORG_GLOSSARY_WEAK_WEIGHT — they're real signal but noisier than strong
// (surface-matching tokens that could be explained by lexical scoring alone).
function glossaryEntryConfidence(entry) {
  if (!entry || !entry.observations) return 0;
  var total = _entryWeightedTotal(entry);
  var sources = 0;
  for (var f in entry.observations) {
    if (!Object.prototype.hasOwnProperty.call(entry.observations, f)) continue;
    var bucket = entry.observations[f] || {};
    if ((bucket.strong || 0) > 0 || (bucket.weak || 0) > 0) sources += 1;
  }
  if (total === 0) return 0;
  var corrections = entry.corrections || 0;
  return (sources * total) / (total + 2 * corrections + 1);
}

function _isStale(entry, now) {
  if (!entry) return true;
  var lastSeen = entry.lastSeen || 0;
  if ((now - lastSeen) <= ORG_GLOSSARY_STALE_MS) return false;
  return _entryWeightedTotal(entry) < ORG_GLOSSARY_STALE_MIN_OBS;
}

// Drop stale entries from a term→entries map. Mutates in place; returns count removed.
function _pruneStale(map, now) {
  var removed = 0;
  for (var term in map) {
    if (!Object.prototype.hasOwnProperty.call(map, term)) continue;
    var kept = (map[term] || []).filter(function (e) { return !_isStale(e, now); });
    if (!kept.length) { delete map[term]; removed += 1; continue; }
    if (kept.length !== map[term].length) removed += map[term].length - kept.length;
    map[term] = kept;
  }
  return removed;
}

function _totalEntries(g) {
  var n = 0;
  ['objectAliases', 'fieldAliases', 'valueSemantics'].forEach(function (k) {
    var map = g[k] || {};
    for (var term in map) {
      if (Object.prototype.hasOwnProperty.call(map, term)) n += (map[term] || []).length;
    }
  });
  return n;
}

// Compact when over the soft cap by dropping lowest (confidence × recency) entries.
function _compactIfNeeded(g, now) {
  if (_totalEntries(g) <= ORG_GLOSSARY_MAX_ENTRIES) return;
  var flat = [];
  ['objectAliases', 'fieldAliases', 'valueSemantics'].forEach(function (k) {
    var map = g[k] || {};
    for (var term in map) {
      if (!Object.prototype.hasOwnProperty.call(map, term)) continue;
      (map[term] || []).forEach(function (e) {
        var age = Math.max(1, now - (e.lastSeen || 0));
        var recency = 1 / age;
        flat.push({ kind: k, term: term, entry: e, score: glossaryEntryConfidence(e) * recency });
      });
    }
  });
  flat.sort(function (a, b) { return a.score - b.score; });
  var toDrop = _totalEntries(g) - ORG_GLOSSARY_MAX_ENTRIES;
  for (var i = 0; i < toDrop && i < flat.length; i++) {
    var bucket = g[flat[i].kind][flat[i].term] || [];
    var idx = bucket.indexOf(flat[i].entry);
    if (idx !== -1) bucket.splice(idx, 1);
    if (!bucket.length) delete g[flat[i].kind][flat[i].term];
  }
}

function _validateShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.version !== ORG_GLOSSARY_VERSION) return null;
  var out = _emptyGlossary();
  out.updatedAt = parsed.updatedAt || 0;
  ['objectAliases', 'fieldAliases', 'valueSemantics'].forEach(function (k) {
    var m = parsed[k];
    if (m && typeof m === 'object') out[k] = m;
  });
  return out;
}

async function glossaryLoad() {
  if (_glossaryCache) return _glossaryCache;
  if (_glossaryLoadPromise) return _glossaryLoadPromise;
  _glossaryLoadPromise = new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      _glossaryCache = _emptyGlossary();
      resolve(_glossaryCache);
      return;
    }
    var key = getOrgCacheKey(ORG_GLOSSARY_STORAGE_KEY);
    chrome.storage.local.get(key, function (data) {
      var raw = data && data[key];
      var parsed = _validateShape(raw);
      if (!parsed) parsed = _emptyGlossary();
      var now = Date.now();
      _pruneStale(parsed.objectAliases, now);
      _pruneStale(parsed.fieldAliases, now);
      _pruneStale(parsed.valueSemantics, now);
      _glossaryCache = parsed;
      _glossaryLoadPromise = null;
      resolve(_glossaryCache);
    });
  });
  return _glossaryLoadPromise;
}

function _persist() {
  // Serialise writes so back-to-back observe calls don't race the get/set pair.
  _glossaryWritePromise = _glossaryWritePromise.then(function () {
    return new Promise(function (resolve) {
      if (typeof chrome === 'undefined' || !chrome.storage || !_glossaryCache) { resolve(); return; }
      _glossaryCache.updatedAt = Date.now();
      var key = getOrgCacheKey(ORG_GLOSSARY_STORAGE_KEY);
      var payload = {};
      payload[key] = _glossaryCache;
      chrome.storage.local.set(payload, function () { resolve(); });
    });
  });
  return _glossaryWritePromise;
}

function _normTerm(t) {
  return String(t || '').trim().toLowerCase();
}

function _normRole(role) {
  return role === 'related' ? 'related' : 'from';
}

function _normStrength(strength) {
  return strength === 'weak' ? 'weak' : 'strong';
}

function _bucketKeyFor(observation) {
  // Each bucket disambiguates entries with the same term but different
  // (target, recordType, role) tuples. Role means "did this term appear as
  // the FROM object or only as a dot-walked related object" — separate
  // confidence threads matter for read-side ranking.
  switch (observation.type) {
    case 'objectAlias':
      return (observation.target || '') + '|'
           + (observation.recordTypeDeveloperName || '') + '|'
           + _normRole(observation.role);
    case 'fieldAlias':
      return (observation.object || '') + '.' + (observation.field || '');
    case 'valueSemantic':
      return (observation.object || '') + '.' + (observation.field || '') + '=' + (observation.value || '');
    default:
      return '';
  }
}

function _bucketMapFor(g, type) {
  if (type === 'objectAlias') return g.objectAliases;
  if (type === 'fieldAlias') return g.fieldAliases;
  if (type === 'valueSemantic') return g.valueSemantics;
  return null;
}

function _findEntry(bucket, observation) {
  var k = _bucketKeyFor(observation);
  for (var i = 0; i < bucket.length; i++) {
    if (_bucketKeyFor(_obsFromEntry(bucket[i])) === k) return bucket[i];
  }
  return null;
}

function _obsFromEntry(entry) {
  // Reverse-map an entry back to a comparable observation shape for bucket-key
  // comparison. Role is part of the entry now; pass it through.
  return {
    type: entry.type,
    target: entry.target,
    recordTypeDeveloperName: entry.recordTypeDeveloperName,
    role: entry.role,
    object: entry.object,
    field: entry.field,
    value: entry.value
  };
}

function _newEntry(observation, now) {
  var entry = {
    type: observation.type,
    observations: _emptyObservations(),
    corrections: 0,
    firstSeen: now,
    lastSeen: now,
    evidence: []
  };
  if (observation.type === 'objectAlias') {
    entry.target = observation.target;
    entry.recordTypeDeveloperName = observation.recordTypeDeveloperName || null;
    entry.role = _normRole(observation.role);
  } else if (observation.type === 'fieldAlias') {
    entry.object = observation.object;
    entry.field = observation.field;
  } else if (observation.type === 'valueSemantic') {
    entry.object = observation.object;
    entry.field = observation.field;
    entry.value = observation.value;
  }
  return entry;
}

function _pushEvidence(entry, observation, now) {
  if (!observation.evidence) return;
  var snippet = String(observation.evidence).slice(0, ORG_GLOSSARY_EVIDENCE_TRUNC);
  entry.evidence.unshift({ feature: observation.feature, ts: now, text: snippet });
  if (entry.evidence.length > ORG_GLOSSARY_MAX_EVIDENCE) {
    entry.evidence.length = ORG_GLOSSARY_MAX_EVIDENCE;
  }
}

// Record a single observation. Caller specifies type + feature + payload; we
// upsert into the appropriate bucket and persist. Returns silently on bad
// input so an extractor bug can't crash the calling feature.
async function glossaryObserve(observation) {
  if (!observation || !observation.type || !observation.feature) return;
  if (ORG_GLOSSARY_FEATURES.indexOf(observation.feature) === -1) return;
  var term = _normTerm(observation.term);
  if (!term) return;

  var g = await glossaryLoad();
  var map = _bucketMapFor(g, observation.type);
  if (!map) return;
  if (!map[term]) map[term] = [];
  var bucket = map[term];

  var entry = _findEntry(bucket, observation);
  var now = Date.now();
  if (!entry) {
    entry = _newEntry(observation, now);
    bucket.push(entry);
  }
  // Ensure the per-feature shape exists before mutating (older callers / tests
  // could end up with a half-populated observations map).
  if (!entry.observations[observation.feature]) {
    entry.observations[observation.feature] = { strong: 0, weak: 0 };
  }
  var bucketCounter = entry.observations[observation.feature];
  var strength = _normStrength(observation.strength);
  bucketCounter[strength] = (bucketCounter[strength] || 0) + 1;
  entry.lastSeen = now;
  _pushEvidence(entry, observation, now);

  _compactIfNeeded(g, now);
  return _persist();
}

// Multiple observations in one shot — common from a single extractor pass.
async function glossaryObserveBatch(observations) {
  if (!Array.isArray(observations) || !observations.length) return;
  for (var i = 0; i < observations.length; i++) {
    await glossaryObserve(observations[i]);
  }
}

// Read-side: given a prompt, return the highest-confidence object-alias hits
// for each non-stopword token. Used by features to anchor the model on this
// org's vocabulary. Returns an array of { term, entries[] } where entries are
// pre-sorted by confidence descending. Both roles (from, related) are kept
// separately so callers can prefer FROM-role for FROM-target ranking.
//
// Minimum confidence gate filters out single-evidence entries that wouldn't
// be reliable enough to publish to the model as "this is what your org calls
// it." Tune via ORG_GLOSSARY_READ_MIN_CONFIDENCE.
var ORG_GLOSSARY_READ_MIN_CONFIDENCE = 0.5;

async function glossaryLookupForPrompt(prompt, opts) {
  opts = opts || {};
  var minConf = typeof opts.minConfidence === 'number' ? opts.minConfidence : ORG_GLOSSARY_READ_MIN_CONFIDENCE;
  if (!prompt) return [];
  if (typeof tokenisePromptForExtraction !== 'function') return [];

  var tokens = tokenisePromptForExtraction(prompt);
  if (!tokens.length) return [];

  var g = await glossaryLoad();
  var byTerm = g.objectAliases || {};
  var hits = [];
  for (var i = 0; i < tokens.length; i++) {
    var term = tokens[i];
    var bucket = byTerm[term];
    if (!bucket || !bucket.length) continue;
    var ranked = bucket
      .map(function (e) { return { entry: e, confidence: glossaryEntryConfidence(e) }; })
      .filter(function (x) { return x.confidence >= minConf; })
      .sort(function (a, b) { return b.confidence - a.confidence; });
    if (!ranked.length) continue;
    hits.push({ term: term, entries: ranked });
  }
  return hits;
}

// Render glossary hits as an anchor block for inclusion in the model's user
// message. Format is plain text designed to read clearly inside the existing
// schema-section formatting. Returns '' when there are no hits to render.
function formatGlossaryAnchorBlock(hits) {
  if (!hits || !hits.length) return '';
  var lines = [
    'Org-specific vocabulary learned from prior successful queries in this org.',
    'Treat these as strong priors when picking FROM and dot-walk targets — the org has historically used these mappings.'
  ];
  for (var i = 0; i < hits.length; i++) {
    var h = hits[i];
    // For each term, list role=from entries first (the answer to "what's the
    // FROM target for this term"), then role=related entries (the answer to
    // "if this term appears in the prompt, what object owns the related
    // field"). Both are useful but they answer different questions.
    var fromEntries = h.entries.filter(function (x) { return x.entry.role !== 'related'; });
    var relatedEntries = h.entries.filter(function (x) { return x.entry.role === 'related'; });
    var bits = [];
    fromEntries.forEach(function (x) {
      bits.push(x.entry.target + ' [FROM, ' + _formatStrengthSummary(x.entry) + ']');
    });
    relatedEntries.forEach(function (x) {
      bits.push(x.entry.target + ' [related, ' + _formatStrengthSummary(x.entry) + ']');
    });
    lines.push('  "' + h.term + '" → ' + bits.join('; '));
  }
  return lines.join('\n');
}

function _formatStrengthSummary(entry) {
  var s = 0, w = 0, features = 0;
  for (var f in entry.observations) {
    if (!Object.prototype.hasOwnProperty.call(entry.observations, f)) continue;
    var b = entry.observations[f] || {};
    s += b.strong || 0;
    w += b.weak || 0;
    if ((b.strong || 0) > 0 || (b.weak || 0) > 0) features += 1;
  }
  var parts = [];
  if (s) parts.push(s + ' strong');
  if (w) parts.push(w + ' weak');
  if (features > 1) parts.push(features + ' features');
  return parts.join(', ');
}

// For dev inspection — exposes the in-memory snapshot.
async function glossaryGetSnapshot() {
  var g = await glossaryLoad();
  return JSON.parse(JSON.stringify(g));
}
