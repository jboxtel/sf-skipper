// HTML-escaping + minimal markdown rendering for AI-feature panels.
// Loaded into the same content-script isolated world as content.js, so these
// functions are globals visible to the palette and panel code.

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Render `…` as <code>…</code>, escaping HTML in everything else. Used by the
// Flow Debug panel for inline API names / field references in answer text.
function renderInlineCode(s) {
  var out = '';
  var inCode = false;
  var buf = '';
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (ch === '`') {
      if (inCode) {
        out += '<code class="sfnav-flowdebug-code">' + esc(buf) + '</code>';
      } else {
        out += esc(buf);
      }
      buf = '';
      inCode = !inCode;
    } else {
      buf += ch;
    }
  }
  // Unclosed backtick — flush remainder as plain text.
  out += esc(buf);
  return out;
}

// Bold (**x**) and inline `code` only — no links/images, since the model
// shouldn't be producing them.
function renderAskInline(s) {
  var out = esc(s);
  out = out.replace(/`([^`]+)`/g, function (_, code) {
    return '<code class="sfnav-ask-code">' + code + '</code>';
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return out;
}

// Tiny markdown subset for @ask answers: paragraphs, blank-line separation,
// and `- ` / `* ` bullet lists. Anything else passes through renderAskInline.
function renderAskMarkdown(text) {
  if (!text) return '';
  var lines = text.split(/\r?\n/);
  var html = '';
  var inList = false;
  var paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    html += '<p>' + renderAskInline(paragraph.join(' ')) + '</p>';
    paragraph = [];
  }
  function openList()  { if (!inList) { html += '<ul>';  inList = true;  } }
  function closeList() { if (inList)  { html += '</ul>'; inList = false; } }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      openList();
      html += '<li>' + renderAskInline(bullet[1]) + '</li>';
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    if (inList) closeList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  return html;
}
