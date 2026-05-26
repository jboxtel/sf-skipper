// Per-org semantic layer. Accumulates business-term → Salesforce-metadata
// mappings observed across @soql, @ask, and (eventually) @debug. Phase 1 is
// write-only: features call glossaryObserve() after a successful interaction
// and the entries sit in chrome.storage.local. No reader has shipped yet — by
// the time the inspector UI + read-side wiring lands in v1.1, early users will
// already have populated glossaries from organic v1.0 usage.
//
// Storage key is org-scoped via getOrgCacheKey so switching tabs across orgs
// keeps each org's vocabulary separate.

var ORG_GLOSSARY_STORAGE_KEY = 'sfnavOrgGlossary';
var ORG_GLOSSARY_VERSION = 1;
var ORG_GLOSSARY_STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
var ORG_GLOSSARY_STALE_MIN_OBS = 3;                   // entries below this threshold expire on staleness
var ORG_GLOSSARY_MAX_EVIDENCE = 5;                    // ring buffer of recent contexts per entry
var ORG_GLOSSARY_EVIDENCE_TRUNC = 200;
var ORG_GLOSSARY_MAX_ENTRIES = 500;                   // soft cap; compaction kicks in past this
var ORG_GLOSSARY_FEATURES = ['soql', 'ask', 'debug', 'manual'];

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
  for (var i = 0; i < ORG_GLOSSARY_FEATURES.length; i++) o[ORG_GLOSSARY_FEATURES[i]] = 0;
  return o;
}

// Future read side will surface entries with effectiveConfidence above the
// configured tier threshold (see plan). Computed on demand — sources count is
// the number of independent features with at least one observation, which
// rewards cross-feature corroboration.
function glossaryEntryConfidence(entry) {
  if (!entry || !entry.observations) return 0;
  var total = 0;
  var sources = 0;
  for (var f in entry.observations) {
    if (!Object.prototype.hasOwnProperty.call(entry.observations, f)) continue;
    var n = entry.observations[f] || 0;
    total += n;
    if (n > 0) sources += 1;
  }
  if (total === 0) return 0;
  var corrections = entry.corrections || 0;
  return (sources * total) / (total + 2 * corrections + 1);
}

function _isStale(entry, now) {
  if (!entry) return true;
  var lastSeen = entry.lastSeen || 0;
  if ((now - lastSeen) <= ORG_GLOSSARY_STALE_MS) return false;
  var total = 0;
  for (var f in entry.observations || {}) {
    if (Object.prototype.hasOwnProperty.call(entry.observations, f)) total += entry.observations[f] || 0;
  }
  return total < ORG_GLOSSARY_STALE_MIN_OBS;
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
// Phase 1 cap is generous — this is defensive against runaway storage in a long-
// lived tab; real-world volume should stay well under in normal usage.
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

function _bucketKeyFor(observation) {
  // Each bucket disambiguates entries with the same term but different targets
  // — e.g. "flight" could observe both Product2 and Flight__c. Different bucket
  // keys mean separate entries that accumulate confidence independently.
  switch (observation.type) {
    case 'objectAlias':
      return (observation.target || '') + '|' + (observation.recordTypeDeveloperName || '');
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
  // Reverse-map an entry back to a comparable observation shape, just for
  // _findEntry's bucket-key comparison.
  return {
    type: entry.type,
    target: entry.target,
    recordTypeDeveloperName: entry.recordTypeDeveloperName,
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
  entry.observations[observation.feature] = (entry.observations[observation.feature] || 0) + 1;
  entry.lastSeen = now;
  _pushEvidence(entry, observation, now);

  _compactIfNeeded(g, now);
  return _persist();
}

// Multiple observations in one shot — common from a single extractor pass.
// Avoids waiting on the write between observations.
async function glossaryObserveBatch(observations) {
  if (!Array.isArray(observations) || !observations.length) return;
  // Run sequentially so each observation sees the previous one's mutation; the
  // shared in-memory cache makes this cheap (no I/O between iterations).
  for (var i = 0; i < observations.length; i++) {
    await glossaryObserve(observations[i]);
  }
}

// For dev inspection — exposes the in-memory snapshot. Read side proper
// (UI inspector + feature-side consumers) ships in v1.1.
async function glossaryGetSnapshot() {
  var g = await glossaryLoad();
  return JSON.parse(JSON.stringify(g));
}
