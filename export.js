// @export — run SOQL and view the results in the palette, modeled on
// Salesforce Inspector's Data Export.
//
// Read-only by construction: ensureSelectOnly (shared.js) rejects anything that
// isn't a SELECT before a request is made, and every request goes through
// sfFetch (shared.js), which only allows GET without a body. Results stay in
// the page — nothing is sent to an AI provider.
//
// This file holds the logic (query + pagination, flattening, serializers,
// grid rendering, autocomplete). The panel wiring lives in content.js next
// to the other palette modes.

var EXPORT_HISTORY_KEY = 'sfnavExportHistory';
var EXPORT_HISTORY_MAX = 10;
var EXPORT_MAX_ROWS = 50000;    // hard cap — keeps a runaway query from eating the tab's memory
var EXPORT_RENDER_CHUNK = 1000; // rows added to the DOM per "Show more"; exports always include every row
var EXPORT_AC_MAX = 10;

// ─── Query ────────────────────────────────────────────────────────────────

function _exportErrorDetail(body, status) {
  if (Array.isArray(body) && body.length && body[0].message) {
    return (body[0].errorCode ? body[0].errorCode + ': ' : '') + body[0].message;
  }
  return 'HTTP ' + status;
}

// Runs the query and follows nextRecordsUrl until done, aborted, or capped.
// opts.signal (AbortSignal) stops between or during pages; whatever was
// already fetched is returned with aborted: true.
async function runExportQuery(soql, opts) {
  opts = opts || {};
  soql = String(soql || '').trim().replace(/;\s*$/, '');
  if (!soql) throw new Error('Enter a SOQL query');
  // Check with string literals blanked out, so WHERE Status = 'Update pending'
  // doesn't trip the DML keyword guard.
  ensureSelectOnly(soql.replace(/'(?:\\.|[^'\\])*'/g, "''"));

  var started = Date.now();
  var pre = await sfRestPreamble();
  var url = pre.apiBase + pre.basePath + '/query/?q=' + encodeURIComponent(soql);
  var records = [];
  var totalSize = 0;
  var truncated = false;
  var aborted = false;

  while (url) {
    if (opts.signal && opts.signal.aborted) { aborted = true; break; }
    var resp;
    try {
      resp = await sfFetch(url, { headers: pre.headers, signal: opts.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') { aborted = true; break; }
      throw err;
    }
    var body = null;
    try { body = await resp.json(); } catch (_) {}
    if (!resp.ok) throw new Error(_exportErrorDetail(body, resp.status));

    totalSize = body.totalSize || 0;
    var page = body.records || [];
    for (var i = 0; i < page.length; i++) records.push(page[i]);
    if (opts.onProgress) opts.onProgress(records.length, totalSize);

    if (records.length >= EXPORT_MAX_ROWS && !body.done) { truncated = true; break; }
    url = (!body.done && body.nextRecordsUrl) ? pre.apiBase + body.nextRecordsUrl : null;
  }

  return {
    records: records,
    totalSize: totalSize,
    truncated: truncated,
    aborted: aborted,
    ms: Date.now() - started,
    objectName: exportFindFromObject(soql)
  };
}

// ─── Flattening ───────────────────────────────────────────────────────────

function exportStripAttributes(value) {
  if (Array.isArray(value)) return value.map(exportStripAttributes);
  if (!value || typeof value !== 'object') return value;
  var out = {};
  Object.keys(value).forEach(function (k) {
    if (k === 'attributes') return;
    var v = value[k];
    // Child subquery → keep just the rows
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.records)) {
      out[k] = v.records.map(exportStripAttributes);
    } else {
      out[k] = exportStripAttributes(v);
    }
  });
  return out;
}

// Turns REST records into { columns, rows }. Parent lookups become dotted
// columns (Owner.Name); child subqueries become one cell holding the child
// rows; compound fields (Address, Location) stay as objects. Column order is
// first-seen, with a dotted column slotted next to its parent's other
// columns so a null lookup on row 1 doesn't push Owner.Name to the far end.
function flattenExportRecords(records) {
  var columns = [];
  var seen = {};

  function addColumn(key) {
    if (seen[key]) return;
    seen[key] = true;
    var insertAt = columns.length;
    var parts = key.split('.');
    for (var depth = parts.length - 1; depth > 0; depth--) {
      var ancestor = parts.slice(0, depth).join('.');
      var last = -1;
      for (var i = 0; i < columns.length; i++) {
        if (columns[i] === ancestor || columns[i].indexOf(ancestor + '.') === 0) last = i;
      }
      if (last !== -1) { insertAt = last + 1; break; }
    }
    columns.splice(insertAt, 0, key);
  }

  function walk(rec, prefix, out) {
    Object.keys(rec).forEach(function (k) {
      if (k === 'attributes') return;
      var v = rec[k];
      var key = prefix + k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (Array.isArray(v.records)) {
          addColumn(key);
          out[key] = { childRows: exportStripAttributes(v.records), childCount: v.totalSize };
          return;
        }
        if (v.attributes) { walk(v, key + '.', out); return; }
      }
      addColumn(key);
      out[key] = v;
    });
  }

  var flat = records.map(function (rec) {
    var out = {};
    walk(rec || {}, '', out);
    return out;
  });

  // A lookup that's null on some rows yields both "Owner" (null) and
  // "Owner.Name" — drop the bare parent column when it never holds a value.
  columns = columns.filter(function (col) {
    var hasChildren = columns.some(function (c) { return c.indexOf(col + '.') === 0; });
    if (!hasChildren) return true;
    return flat.some(function (row) { return row[col] != null; });
  });

  var rows = flat.map(function (row) {
    return columns.map(function (col) { return row[col] === undefined ? null : row[col]; });
  });
  return { columns: columns, rows: rows };
}

function isExportChildCell(v) {
  return !!v && typeof v === 'object' && Array.isArray(v.childRows);
}

// Text for exports. Child rows and compound fields are JSON so nothing is lost.
function exportCellText(v) {
  if (v == null) return '';
  if (isExportChildCell(v)) return JSON.stringify(v.childRows);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ─── Serializers ──────────────────────────────────────────────────────────

function _csvQuote(s) {
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportToCsv(table) {
  var lines = [table.columns.map(_csvQuote).join(',')];
  table.rows.forEach(function (row) {
    lines.push(row.map(function (v) { return _csvQuote(exportCellText(v)); }).join(','));
  });
  return lines.join('\r\n');
}

// Tab-separated for pasting into Excel / Sheets. Tabs and newlines inside a
// value would split cells, so they collapse to spaces.
function exportToTsv(table) {
  function clean(s) { return s.replace(/[\t\r\n]+/g, ' '); }
  var lines = [table.columns.map(clean).join('\t')];
  table.rows.forEach(function (row) {
    lines.push(row.map(function (v) { return clean(exportCellText(v)); }).join('\t'));
  });
  return lines.join('\n');
}

function exportToJson(records) {
  return JSON.stringify(exportStripAttributes(records), null, 2);
}

function exportFileName(objectName, ext) {
  var d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  return (objectName || 'export') + '-' + stamp + '.' + ext;
}

function downloadExportFile(text, fileName, mime) {
  var blob = new Blob([text], { type: mime });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

// ─── Sorting ──────────────────────────────────────────────────────────────

// Nulls always sort last; numbers/booleans compare by value, everything else
// as case-insensitive text with numeric awareness ("Case 10" after "Case 9").
function sortExportRows(rows, colIndex, dir) {
  var sign = dir === 'desc' ? -1 : 1;
  return rows.slice().sort(function (a, b) {
    var x = a[colIndex], y = b[colIndex];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (isExportChildCell(x)) x = x.childCount;
    if (isExportChildCell(y)) y = y.childCount;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    if (typeof x === 'boolean' && typeof y === 'boolean') return ((x ? 1 : 0) - (y ? 1 : 0)) * sign;
    return exportCellText(x).localeCompare(exportCellText(y), undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
}

// ─── Grid rendering ───────────────────────────────────────────────────────

var EXPORT_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

function _isExportIdCell(column, value) {
  if (typeof value !== 'string' || !EXPORT_ID_RE.test(value)) return false;
  var leaf = column.split('.').pop();
  return leaf === 'Id' || /Id$/.test(leaf);
}

// Renders the grid into `container` with DOM APIs only — record values are
// org data and never go through innerHTML. Returns a controller so the
// caller can re-render after sorting without rebuilding state.
function renderExportGrid(container, table, opts) {
  opts = opts || {};
  var sortCol = -1;
  var sortDir = 'asc';
  var rows = table.rows;
  var shown = 0;
  var origin = window.location.origin;

  container.textContent = '';
  var tableEl = document.createElement('table');
  tableEl.className = 'sfnav-export-table';
  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  var tbody = document.createElement('tbody');
  tableEl.appendChild(thead);
  tableEl.appendChild(tbody);
  thead.appendChild(headRow);

  var moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'sfnav-export-more';

  table.columns.forEach(function (col, idx) {
    var th = document.createElement('th');
    th.textContent = col;
    th.title = 'Sort by ' + col;
    th.addEventListener('click', function () {
      if (sortCol === idx) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = idx; sortDir = 'asc'; }
      rows = sortExportRows(table.rows, sortCol, sortDir);
      Array.prototype.forEach.call(headRow.children, function (el, i) {
        el.classList.toggle('sfnav-export-sorted-asc', i === sortCol && sortDir === 'asc');
        el.classList.toggle('sfnav-export-sorted-desc', i === sortCol && sortDir === 'desc');
      });
      tbody.textContent = '';
      shown = 0;
      appendRows();
    });
    headRow.appendChild(th);
  });

  function makeCell(col, v) {
    var td = document.createElement('td');
    if (v == null) {
      td.className = 'sfnav-export-null';
      return td;
    }
    if (isExportChildCell(v)) {
      td.textContent = '[' + v.childCount + ']';
      td.title = JSON.stringify(v.childRows, null, 2);
      td.className = 'sfnav-export-child';
      return td;
    }
    var text = exportCellText(v);
    if (_isExportIdCell(col, v)) {
      var a = document.createElement('a');
      a.href = origin + '/' + v;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = v;
      td.appendChild(a);
    } else {
      td.textContent = text;
    }
    if (text.length > 40) td.title = text;
    return td;
  }

  function appendRows() {
    var end = Math.min(rows.length, shown + EXPORT_RENDER_CHUNK);
    var frag = document.createDocumentFragment();
    for (var r = shown; r < end; r++) {
      var tr = document.createElement('tr');
      for (var c = 0; c < table.columns.length; c++) {
        tr.appendChild(makeCell(table.columns[c], rows[r][c]));
      }
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    shown = end;
    var remaining = rows.length - shown;
    moreBtn.style.display = remaining > 0 ? '' : 'none';
    moreBtn.textContent = 'Show ' + Math.min(remaining, EXPORT_RENDER_CHUNK).toLocaleString() +
      ' more (' + remaining.toLocaleString() + ' not shown)';
  }

  moreBtn.addEventListener('click', appendRows);
  container.appendChild(tableEl);
  container.appendChild(moreBtn);
  appendRows();
}

// ─── Autocomplete ─────────────────────────────────────────────────────────

// Removes balanced (...) groups so the outer query's clauses can be read
// without a subquery's SELECT/FROM getting in the way.
function exportStripSubqueries(text) {
  var prev;
  do {
    prev = text;
    text = text.replace(/\([^()]*\)/g, ' ');
  } while (text !== prev);
  return text;
}

function exportFindFromObject(text) {
  var m = exportStripSubqueries(String(text || '')).match(/\bFROM\s+([A-Za-z_]\w*)/i);
  return m ? m[1] : null;
}

// What the caret is sitting on. Returns null when there's nothing useful to
// suggest. Subqueries aren't resolved in v1 (their FROM is a child
// relationship name, which the cached describe doesn't carry).
//   { kind: 'object', prefix, start }
//   { kind: 'field',  prefix, start, objectName, path: ['Owner'] }
//   { kind: 'value',  prefix, start, objectName, fieldPath: ['StageName'] }
function exportAutocompleteContext(text, caret) {
  var before = text.slice(0, caret);
  var outer = exportStripSubqueries(before);
  if (/\(\s*SELECT\b/i.test(outer)) return null; // caret inside an open subquery

  var objectName = exportFindFromObject(text);

  // Inside a string literal → picklist values for the field on the left.
  var quotes = (outer.replace(/\\'/g, '').match(/'/g) || []).length;
  if (quotes % 2 === 1) {
    var vm = outer.match(/([\w.]+)\s*(?:=|!=|<>)\s*'([^']*)$/) ||
             outer.match(/([\w.]+)\s+(?:NOT\s+)?(?:IN|INCLUDES|EXCLUDES)\s*\([^)]*'([^']*)$/i);
    if (!vm || !objectName) return null;
    return { kind: 'value', prefix: vm[2], start: caret - vm[2].length, objectName: objectName, fieldPath: vm[1].split('.') };
  }

  var token = (before.match(/[\w.]*$/) || [''])[0];

  if (/\bFROM\s+\w*$/i.test(outer)) {
    return { kind: 'object', prefix: token, start: caret - token.length };
  }

  var clauses = outer.match(/\b(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|WITH|FOR)\b/gi);
  if (!clauses || !objectName) return null;
  var clause = clauses[clauses.length - 1].toUpperCase().replace(/\s+/g, ' ');
  if (['SELECT', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING'].indexOf(clause) === -1) return null;

  var parts = token.split('.');
  var prefix = parts.pop();
  return { kind: 'field', prefix: prefix, start: caret - prefix.length, objectName: objectName, path: parts };
}

function _exportCanonicalObject(name) {
  var lower = String(name).toLowerCase();
  var list = typeof getAllObjects === 'function' ? getAllObjects() : [];
  var match = list.find(function (o) { return o.apiName.toLowerCase() === lower; });
  return match ? match.apiName : name;
}

// Polymorphic lookups (Owner → Group, User) — User is nearly always the
// one people want to dot into.
function _exportPickReference(refs) {
  if (!refs || !refs.length) return null;
  return refs.indexOf('User') !== -1 ? 'User' : refs[0];
}

// Walks a relationship path (['Account', 'Owner']) from a root object and
// returns the describe fields of the object at the end, or null.
async function _exportResolvePath(objectName, path) {
  var obj = _exportCanonicalObject(objectName);
  for (var i = 0; i < path.length; i++) {
    var fields = await fetchDescribe(obj);
    var want = path[i].toLowerCase();
    var f = fields.find(function (x) { return x.relationshipName && x.relationshipName.toLowerCase() === want; });
    if (!f) return null;
    obj = _exportPickReference(f.referenceTo);
    if (!obj) return null;
  }
  return fetchDescribe(obj);
}

function _rankExportSuggestions(items, prefix) {
  var p = prefix.toLowerCase();
  if (!p) return items.slice(0, EXPORT_AC_MAX);
  var starts = [], contains = [];
  items.forEach(function (it) {
    var v = it.value.toLowerCase();
    if (v.indexOf(p) === 0) starts.push(it);
    else if (v.indexOf(p) !== -1 || (it.detail && it.detail.toLowerCase().indexOf(p) !== -1)) contains.push(it);
  });
  return starts.concat(contains).slice(0, EXPORT_AC_MAX);
}

// Resolves a context from exportAutocompleteContext into at most
// EXPORT_AC_MAX suggestions: [{ value, detail }]. Describe failures (unknown
// object, no access) quietly yield no suggestions.
async function exportAutocompleteSuggestions(ctx) {
  if (!ctx) return [];
  try {
    if (ctx.kind === 'object') {
      var objs = typeof getSoqlObjects === 'function' ? getSoqlObjects() : getAllObjects();
      return _rankExportSuggestions(objs.map(function (o) {
        return { value: o.apiName, detail: o.label };
      }), ctx.prefix);
    }
    if (ctx.kind === 'field') {
      var fields = await _exportResolvePath(ctx.objectName, ctx.path);
      if (!fields) return [];
      var items = [];
      fields.forEach(function (f) {
        items.push({ value: f.name, detail: f.label + ' · ' + f.type });
        if (f.relationshipName) {
          items.push({ value: f.relationshipName + '.', detail: '→ ' + f.referenceTo.join(', ') });
        }
      });
      return _rankExportSuggestions(items, ctx.prefix);
    }
    if (ctx.kind === 'value') {
      var path = ctx.fieldPath.slice(0, -1);
      var fieldName = ctx.fieldPath[ctx.fieldPath.length - 1].toLowerCase();
      var parentFields = await _exportResolvePath(ctx.objectName, path);
      if (!parentFields) return [];
      var field = parentFields.find(function (f) { return f.name.toLowerCase() === fieldName; });
      if (!field || !field.values) return [];
      return _rankExportSuggestions(field.values.map(function (v) { return { value: v, detail: '' }; }), ctx.prefix);
    }
  } catch (err) {
    console.warn('sfnav: @export autocomplete failed —', err);
  }
  return [];
}

// Applies a chosen suggestion. Returns { text, caret }.
function applyExportSuggestion(text, caret, ctx, suggestion) {
  var insert = suggestion.value;
  var end = caret;
  if (ctx.kind === 'value') {
    insert = insert.replace(/'/g, "\\'") + "'";
    // Replace the rest of the literal up to and including its closing quote,
    // if it has one on this line; otherwise just close it.
    var rest = text.slice(caret).match(/^[^'\n]*'/);
    if (rest) end = caret + rest[0].length;
  } else {
    // Swallow the rest of the word under the caret so completing mid-word
    // doesn't leave a tail behind.
    var tail = (text.slice(caret).match(/^\w*/) || [''])[0];
    end = caret + tail.length;
  }
  var next = text.slice(0, ctx.start) + insert + text.slice(end);
  return { text: next, caret: ctx.start + insert.length };
}

// ─── History ──────────────────────────────────────────────────────────────

function getExportHistory() {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.storage) { resolve([]); return; }
    var key = getOrgCacheKey(EXPORT_HISTORY_KEY);
    chrome.storage.local.get(key, function (data) {
      resolve((data && data[key]) || []);
    });
  });
}

function addToExportHistory(entry) {
  return new Promise(function (resolve) {
    if (typeof chrome === 'undefined' || !chrome.storage) { resolve(); return; }
    var key = getOrgCacheKey(EXPORT_HISTORY_KEY);
    chrome.storage.local.get(key, function (data) {
      var list = ((data && data[key]) || []).filter(function (e) { return e.soql !== entry.soql; });
      list.unshift({ soql: entry.soql, objectName: entry.objectName || '', rows: entry.rows, timestamp: Date.now() });
      var payload = {};
      payload[key] = list.slice(0, EXPORT_HISTORY_MAX);
      chrome.storage.local.set(payload, resolve);
    });
  });
}
