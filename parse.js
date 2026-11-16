// Fast drop-in for marked 18.1.3 (default options: GFM on, breaks off).
// Written from scratch against the CommonMark 0.31.2 + GFM 0.29 specs and the
// practice set's expected HTML. Dependency-free, deterministic, no network.
//
// Strategy: a line-based block parser (CommonMark container algorithm) that
// builds a small AST, then a renderer that parses inline content on the fly.
// Inline parsing uses one scanning pass plus a delimiter stack for emphasis,
// strikethrough and links, exactly as the spec's algorithm describes.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
// Attribute escaping that leaves valid entities alone (&ouml; stays &ouml;,
// a bare & becomes &amp;), as marked renders link destinations and titles.
const ESC_ATTR_RE = /[<"']|&(?!#?\w+;)/g;

function escapeText(s) {
  if (!ESC_RE.test(s)) return s;
  ESC_RE.lastIndex = 0;
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

function escapeAttr(s) {
  if (!ESC_ATTR_RE.test(s)) return s;
  ESC_ATTR_RE.lastIndex = 0;
  return s.replace(ESC_ATTR_RE, (c) => (c === '&' ? '&amp;' : ESC_MAP[c]));
}

// Link destinations go through encodeURI (marked's cleanUrl): a backslash
// becomes %5C, a space %20, non-ASCII percent-encoded, while &, ;, ?, #
// and the rest of encodeURI's safe set stay as they are. A literal % is
// NOT encoded (foo%20b stays foo%20b, 98% stays 98%): encodeURI would
// turn it into %25, so restore it afterwards.
function cleanHref(dest) {
  try { return encodeURI(dest).replace(/%25/g, '%'); } catch (e) { return dest; }
}

function isSpaceCh(c) { return c === ' ' || c === '\t'; }
function isAsciiPunct(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}
function isDigit(code) { return code >= 48 && code <= 57; }
function isAlphaNum(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isWordCh(code) { return isAlphaNum(code) || code === 95; } // [A-Za-z0-9_]

// Unicode punctuation test (CommonMark flanking rules), cached per char.
// The spec counts both Unicode punctuation (P) and symbols (S) as
// punctuation: $, £, € are symbols, so *£* is not emphasis.
const PUNCT_RE = /\p{P}|\p{S}/u;
const punctCache = new Map();
function isPunctCh(ch) {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return isAsciiPunct(code);
  let v = punctCache.get(ch);
  if (v === undefined) { v = PUNCT_RE.test(ch); punctCache.set(ch, v); }
  return v;
}
function isSpaceCode(code) { return code === 32 || code === 9 || code === 10 || code === 13; }

// ---- Entities (inline text only) -------------------------------------------
// Named entities pass through verbatim (&copy; stays &copy;, &notanentity;
// stays &notanentity;). Numeric entities decode to the character, with
// 0 -> U+FFFD, surrogates -> U+FFFD, and out-of-range values not an entity.
function decodeNumericEntity(num, isHex) {
  let cp;
  if (isHex) {
    if (!/^[0-9a-fA-F]+$/.test(num)) return null;
    cp = parseInt(num, 16);
  } else {
    if (!/^\d+$/.test(num)) return null;
    cp = parseInt(num, 10);
  }
  if (cp === 0) return '\uFFFD';
  if (cp > 0x10FFFF) return null;
  if (cp >= 0xD800 && cp <= 0xDFFF) return '\uFFFD';
  return String.fromCodePoint(cp);
}

// Try to read an entity at s[i] === '&'. Returns {text, len} where text is
// the HTML to emit (already escaped where needed), or null.
function tryEntity(s, i) {
  const n = s.length;
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const start = j;
    while (j < n && s[j] !== ';' && j - start < 12) j++;
    if (j >= n || s[j] !== ';' || j === start) return null;
    const decoded = decodeNumericEntity(s.slice(start, j), hex);
    if (decoded === null) return null;
    return { text: decoded, len: j - i + 1, verb: false };
  }
  // Named: & + letters/digits + ';' passes through verbatim.
  let j = i + 1;
  while (j < n && ((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) ||
    (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122) ||
    (s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57))) j++;
  if (j > i + 1 && j < n && s[j] === ';') {
    return { text: s.slice(i, j + 1), len: j - i + 1, verb: true };
  }
  return null;
}

// Unescape backslash escapes of ASCII punctuation in a string (used for
// link destinations and titles, which are not entity-decoded).
function unescapeBackslashes(s) {
  if (!s.includes('\\')) return s;
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1]; i += 2;
    } else { out += c; i++; }
  }
  return out;
}

// ---- Block parser ----------------------------------------------------------
// Lines are {s, o, c}: s the raw line, o the current offset, c the absolute
// column of s[o] (tabs advance to multiples of 4). Container prefixes are
// consumed by advancing o/c; leaf content keeps the raw remainder.

function makeLine(s) { return { s, o: 0, c: 0 }; }
function lineRest(L) { return L.s.slice(L.o); }
function lineIsBlank(L) {
  for (let k = L.o; k < L.s.length; k++) {
    const ch = L.s[k];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}
// Columns of leading whitespace from the current offset.
function lineIndent(L) {
  let col = L.c, k = L.o;
  while (k < L.s.length) {
    const ch = L.s[k];
    if (ch === ' ') { col++; k++; }
    else if (ch === '\t') { col += 4 - (col % 4); k++; }
    else break;
  }
  return col - L.c;
}
// Consume n columns of whitespace (tabs may turn into spaces).
function advanceCols(L, n) {
  while (n > 0 && L.o < L.s.length) {
    const ch = L.s[L.o];
    if (ch === ' ') { L.o++; L.c++; n--; }
    else if (ch === '\t') {
      const w = 4 - (L.c % 4);
      if (w <= n) { L.o++; L.c += w; n -= w; }
      else {
        L.s = L.s.slice(0, L.o) + ' '.repeat(w) + L.s.slice(L.o + 1);
        L.o++; L.c++; n--;
      }
    } else break;
  }
}
// Expand leading tabs in the remainder (from L.o) to spaces, in place.
// Marked expands leading whitespace when it strips a list-item or
// blockquote prefix, so a tab that follows a consumed container prefix
// becomes its equivalent spaces (doc-01/05/06: a tab after the item
// indent in fenced code or a paragraph). Only the leading whitespace
// is expanded; interior tabs are literal content and stay as tabs
// (a top-level tab is never expanded, so this is only called when a
// container prefix was consumed, L.o > 0).
// baseCol overrides the starting column: for a CONTINUATION line of a
// blockquote (Phase 1), the tab's base column is 2 (the width of a
// single `> `), ignoring any leading indent before the `>` and any
// outer `>` prefixes (doc-05/09/14/17/19). For a NEW blockquote line
// the absolute column L.c is correct (a first line `  > \tX` is code).
function expandLeadingTabs(L, baseCol) {
  let k = L.o, col = baseCol !== undefined ? baseCol : L.c;
  while (k < L.s.length) {
    const ch = L.s[k];
    if (ch === ' ') { k++; col++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      L.s = L.s.slice(0, k) + ' '.repeat(w) + L.s.slice(k + 1);
      k += w; col += w;
    } else break;
  }
}

// Character index in L.s after consuming `n` columns from the current offset.
function colIndex(L, n) {
  let k = L.o, col = L.c;
  while (n > 0 && k < L.s.length) {
    const ch = L.s[k];
    if (ch === ' ') { k++; col++; n--; }
    else if (ch === '\t') { const w = 4 - (col % 4); if (w <= n) { k++; col += w; n -= w; } else break; }
    else break;
  }
  return k;
}

// Skip up to maxN columns of spaces/tabs, return columns actually skipped.
function skipIndent(L, maxN) {
  let n = 0;
  while (n < maxN && L.o < L.s.length) {
    const ch = L.s[L.o];
    if (ch === ' ') { L.o++; L.c++; n++; }
    else if (ch === '\t') {
      const w = 4 - (L.c % 4);
      if (n + w > maxN) break;
      L.o++; L.c += w; n += w;
    } else break;
  }
  return n;
}

// Strip a fenced code content line's indent the way marked does: a tilde
// fence strips nothing (marked's indentCodeCompensation regex only matches
// backtick fences, so tilde-fenced content keeps its full indent); a
// backtick fence strips up to fenceIndent leading whitespace CHARACTERS
// (a tab counts as one character, not four columns).
function stripFenceIndent(L, code) {
  if (code.fenceChar === '~') return;
  let n = code.fenceIndent;
  while (n > 0 && L.o < L.s.length && (L.s[L.o] === ' ' || L.s[L.o] === '\t')) {
    if (L.s[L.o] === ' ') { L.o++; L.c++; }
    else { L.o++; L.c += 4 - (L.c % 4); }
    n--;
  }
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

function newNode(t) { return { t, children: [] }; }

// Parse a link reference definition starting at lines[li], column off.
// Returns {dest, title, nextLi, nextOff} or null. Mutates nothing.
function tryRefDef(lines, li, off) {
  const line = lines[li];
  if (off >= line.s.length || line.s[off] !== '[') return null;
  const label = parseLinkLabel(lines, li, off);
  if (!label) return null;
  let p = label.endOff, l = label.endLi;
  // skip spaces/tabs on the same line
  while (p < lines[l].s.length && isSpaceCh(lines[l].s[p])) p++;
  if (p >= lines[l].s.length || lines[l].s[p] !== ':') return null;
  p++;
  while (p < lines[l].s.length && isSpaceCh(lines[l].s[p])) p++;
  if (p >= lines[l].s.length) {
    // The destination may sit on the next line.
    if (l + 1 >= lines.length) return null;
    l = l + 1;
    p = 0;
    while (p < lines[l].s.length && isSpaceCh(lines[l].s[p])) p++;
    if (p >= lines[l].s.length) return null;
  }
  // destination: <...> or bare (no spaces, no control chars)
  let dest, angleDest = false;
  if (lines[l].s[p] === '<') {
    angleDest = true;
    let q = p + 1, ok = false;
    while (q < lines[l].s.length) {
      const ch = lines[l].s[q];
      if (ch === '>') { ok = true; break; }
      if (ch === '<' || ch === '\n') break;
      if (ch === '\\' && q + 1 < lines[l].s.length && isAsciiPunct(lines[l].s.charCodeAt(q + 1))) q++;
      q++;
    }
    if (!ok) return null;
    dest = unescapeBackslashes(lines[l].s.slice(p + 1, q));
    p = q + 1;
  } else {
    let q = p;
    while (q < lines[l].s.length) {
      const ch = lines[l].s[q];
      if (isSpaceCh(ch)) break;
      if (ch === '\\' && q + 1 < lines[l].s.length && isAsciiPunct(lines[l].s.charCodeAt(q + 1))) { q += 2; continue; }
      q++;
    }
    if (q === p) return null;
    dest = unescapeBackslashes(lines[l].s.slice(p, q));
    p = q;
  }
  // title: same line (possibly spanning lines), or the next line. A title
  // must be separated from an angle-bracket destination by whitespace:
  // [foo]: <bar>(baz) is not a definition.
  let title = null;
  if (angleDest && p < lines[l].s.length &&
      (lines[l].s[p] === '"' || lines[l].s[p] === "'" || lines[l].s[p] === '(')) return null;
  while (p < lines[l].s.length && isSpaceCh(lines[l].s[p])) p++;
  if (p < lines[l].s.length) {
    const t = parseTitleMulti(lines, l, p);
    if (!t) return null;
    title = t.title; l = t.endLi; p = t.endOff;
    while (p < lines[l].s.length && isSpaceCh(lines[l].s[p])) p++;
    if (p < lines[l].s.length) return null;
  } else if (l + 1 < lines.length) {
    // title may start on the next line (and span lines)
    let q = 0;
    const nl = lines[l + 1];
    while (q < nl.s.length && isSpaceCh(nl.s[q])) q++;
    if (q < nl.s.length) {
      const t = parseTitleMulti(lines, l + 1, q);
      if (t) {
        let r = t.endOff;
        while (r < lines[t.endLi].s.length && isSpaceCh(lines[t.endLi].s[r])) r++;
        if (r >= lines[t.endLi].s.length) { title = t.title; l = t.endLi; p = r; }
      }
    }
  }
  return { dest, title, label: label.text, nextLi: l, nextOff: p };
}

// Parse a title at s[i]: "..." or '...' or (...). Returns {title, end} or null.
// Marked's Lexer.state.inLink: set by an inline `<a ...>` tag, cleared
// by `</a>`. It persists across blocks (never reset per paragraph) and
// suppresses GFM bare-URL/email autolinking. An unclosed `<a>` in an
// earlier paragraph therefore leaves later bare URLs/emails as plain
// text (doc-03, doc-06). Reset per parse() call.
let inLinkState = false;

function parseTitle(s, i) {
  const n = s.length, q0 = s[i];
  if (q0 !== '"' && q0 !== "'" && q0 !== '(') return null;
  const close = q0 === '(' ? ')' : q0;
  let j = i + 1, out = '';
  while (j < n) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) { out += s[j + 1]; j += 2; continue; }
    if (ch === close) return { title: out, end: j + 1 };
    if (q0 === '(' && ch === '(') return null;
    out += ch; j++;
  }
  return null;
}

// Parse a title at lines[li][off], possibly spanning several lines.
// Returns {title, endLi, endOff} or null. Newlines inside the title are
// kept verbatim (marked keeps them in the title attribute).
function parseTitleMulti(lines, li, off) {
  const first = lines[li].s;
  if (off >= first.length) return null;
  const q0 = first[off];
  if (q0 !== '"' && q0 !== "'" && q0 !== '(') return null;
  const close = q0 === '(' ? ')' : q0;
  let l = li, p = off + 1, out = '';
  while (l < lines.length) {
    const s = lines[l].s;
    while (p < s.length) {
      const ch = s[p];
      if (ch === '\\' && p + 1 < s.length && isAsciiPunct(s.charCodeAt(p + 1))) { out += s[p + 1]; p += 2; continue; }
      if (ch === close) return { title: out, endLi: l, endOff: p + 1 };
      if (q0 === '(' && ch === '(') return null;
      out += ch; p++;
    }
    l++; p = 0;
    if (l < lines.length) out += '\n';
  }
  return null;
}

// Parse a link label starting at lines[li][off] === '['. Returns
// {text (normalized), endLi, endOff} or null. Labels are matched on their
// RAW text (backslashes kept): [bar][foo\!] does not match a [foo!]
// definition, but [bar][foo\!] does match [foo\!]. An unescaped [ inside
// the label makes it invalid ([[foo]] is not a definition). Labels longer
// than 999 chars are invalid.
function parseLinkLabel(lines, li, off) {
  let raw = '', l = li, p = off + 1;
  while (l < lines.length) {
    const s = lines[l].s;
    while (p < s.length) {
      const ch = s[p];
      if (ch === '\\' && p + 1 < s.length && isAsciiPunct(s.charCodeAt(p + 1))) { raw += s[p] + s[p + 1]; p += 2; continue; }
      if (ch === '[') return null;
      if (ch === ']') {
        if (raw.length === 0 || raw.length > 999) return null;
        const text = normalizeLabel(raw);
        if (text.length === 0) return null;
        return { text, endLi: l, endOff: p + 1 };
      }
      raw += ch; p++;
    }
    // label may span lines: a newline becomes a space
    raw += '\n'; l++; p = 0;
  }
  return null;
}

// Unicode case folding for link labels (commonmark.js normalizeReference):
// toLowerCase().toUpperCase() folds ß and ẞ to SS, and SS to SS, so they
// match. The dotless-i run split avoids merging ı with i (Turkic-only).
function foldCase(s) {
  if (!s.includes('\u0131')) return s.toLowerCase().toUpperCase();
  return s.replace(/[^\u0131]+/g, (part) => part.toLowerCase().toUpperCase());
}

// Normalize a label string (used for inline reference links).
function normalizeLabel(s) {
  return foldCase(s.replace(/\s+/g, ' ').trim());
}

// ---- Block parser main loop ------------------------------------------------

function parseBlocks(src) {
  src = src.replace(/\r\n?/g, '\n');
  let raw = src.split('\n');
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  // The source ends with a single newline after its last content line
  // (not with a blank line, and not without a newline at all). Only
  // then does a final top-level HTML block keep a trailing newline.
  const endsWithNL = src.endsWith('\n') && raw.length > 0 && raw[raw.length - 1].trim() !== '';
  const lines = raw.map(makeLine);
  const doc = newNode('doc');
  const refs = new Map();
  const stack = [doc];
  let blankPending = false;
  // Set by an empty container line (a lone `>`): like a blank line, but
  // it loosens a list only when a new block is added inside an item that
  // already has content — never when a new item is added to the list.
  // emptyLineTop records the container the empty line was directly in,
  // so a new item after it loosens the list only when that container
  // was an item of the list (not a child block of the item, cm-320).
  let emptyLinePending = false;
  let emptyLineTop = null;
  // Base column for expanding a leading tab after a blockquote prefix:
  // the innermost `>` marker's width (its leading spaces + `>`) plus 1
  // for the space after it, in that quote level's own coordinates.
  // Set by matchQuote during phase 1 (the last call wins = innermost).
  // lastQuoteContentCol is the column just after that marker + space:
  // a tab's expansion column is lastQuoteBase plus the columns consumed
  // after the quote (a list item's indent counts: marked expands the tab
  // at the quote level, before the item dedents it).
  let lastQuoteBase = 0;
  let lastQuoteContentCol = 0;

  function parentOf(node) { return stack[stack.length - 1]; }

  // Add node as a child of the current top of stack, tracking looseness.
  function addChild(node) {
    const p = stack[stack.length - 1];
    if (blankPending) {
      if (p.t === 'list' && node.t === 'item' && p.children.length > 0) p.loose = true;
      else if (p.t === 'item' && p.children.length > 0 && p._list) p._list.loose = true;
    } else if (emptyLinePending) {
      if (p.t === 'item' && p.children.length > 0 && p._list) p._list.loose = true;
      // An empty container line (lone `>`) directly inside an item
      // separates that item from the next one, so a new item after it
      // loosens the list — but only when the empty line was directly in
      // an item of this list, not nested in a child block of the item
      // (cm-320: a `>` line inside a blockquote in the item does not
      // loosen the list).
      else if (p.t === 'list' && node.t === 'item' && p.children.length > 0 &&
        emptyLineTop && emptyLineTop.t === 'item' && emptyLineTop._list === p) p.loose = true;
    }
    p.children.push(node);
    return node;
  }

  function finalize(node) {
    if (node.t === 'para') finalizeParagraph(node, refs);
    else if (node.t === 'code' && !node.fenced) {
      while (node.lines.length > 0 && node.lines[node.lines.length - 1] === '') node.lines.pop();
    }
  }

  // Pop nodes from the stack down to (but not including) index `to`,
  // finalizing each. Returns the popped leaf if it was a paragraph that
  // vanished (so callers can drop it) — handled inside finalizeParagraph.
  function popTo(to) {
    while (stack.length > to) popNode();
  }

  // Pop the top node, finalize it, and drop it from its parent if it
  // turned out to be an empty paragraph (only link reference definitions).
  function popNode() {
    const node = stack.pop();
    finalize(node);
    if (node._gone) {
      const par = stack[stack.length - 1];
      const i = par.children.indexOf(node);
      if (i >= 0) par.children.splice(i, 1);
    }
    return node;
  }

  function handleBlank(L) {
    const top = stack[stack.length - 1];
    if (top.t === 'code' && top.fenced) {
      // A blank line inside a fenced code block keeps its spaces, less the
      // fence indent (measured from the container content start).
      advanceCols(L, top.baseCol);
      stripFenceIndent(L, top);
      top.lines.push(lineRest(L));
      return;
    }
    if (top.t === 'code' && !top.fenced) {
      // A blank line inside an indented code block keeps its spaces, less
      // the 4-column code indent (measured from the block's content start).
      advanceCols(L, top.contentCol);
      top.lines.push(lineRest(L));
      blankPending = true;
      return;
    }
    if (top.t === 'html' && (top.htype === 1 || top.htype === 2 || top.htype === 3 || top.htype === 4 || top.htype === 5)) {
      top.lines.push(''); return;
    }
    if (top.t === 'html' && (top.htype === 6 || top.htype === 7)) { top.endedAtBlank = true; popNode(); }
    else if (top.t === 'table') { popNode(); }
    else if (top.t === 'para') { popNode(); }
    blankPending = true;
  }

  function matchQuote(L) {
    const saveO = L.o, saveC = L.c;
    const ind = lineIndent(L);
    if (ind > 3) return false;
    advanceCols(L, ind);
    if (L.o >= L.s.length || L.s[L.o] !== '>') { L.o = saveO; L.c = saveC; return false; }
    L.o++; L.c++;
    let after = 0;
    if (L.o < L.s.length && L.s[L.o] === ' ') { L.o++; L.c++; after = 1; }
    else if (L.o < L.s.length && L.s[L.o] === '\t') {
      // The tab after `>` expands with the marker's own width as the
      // base (marked dedents enclosing list items before the quote
      // pass, so the absolute column overstates the width when the
      // quote sits inside a list item: `       >\tX` expands the tab
      // at column 1, giving 3 spaces, then the quote strips 1, leaving
      // 2 — not 4 spaces at the absolute column 8, leaving 3).
      const w = 4 - ((ind + 1) % 4);
      if (w > 1) L.s = L.s.slice(0, L.o) + ' '.repeat(w) + L.s.slice(L.o + 1);
      L.o++; L.c++; after = 1;
    }
    // The tab base for this quote level: the marker's width (leading
    // spaces + `>`) plus 1 for the space after it. Marked expands the
    // whitespace after each `>` with the marker's own width as the base
    // (its blockquoteMarkerWhitespace pass), so an indented marker
    // (`  >`) gives a larger base than a bare `>`; a nested quote's
    // inner marker counts from its own level, not the absolute column.
    lastQuoteBase = ind + 1 + after;
    lastQuoteContentCol = L.c;
    return true;
  }

  function matchItem(L, item) {
    // A blank remainder is allowed inside an item: the blank line ends
    // the paragraph but not the item.
    if (L.s.slice(L.o).trim() === '') return true;
    // An item that still holds no block cannot be continued after a blank
    // line: the blank line closes it (cm-280). An item that already has
    // content may continue after a blank line (a loose list).
    if (blankPending && item.children.length === 0) return false;
    if (lineIndent(L) < item.indent) return false;
    advanceCols(L, item.indent);
    return true;
  }

  // Does the line (at its current offset) start a block that can interrupt
  // a paragraph? Setext and table delimiters are handled separately.
  // paraInItem: the paragraph is directly inside a list item, in which
  // case an ordered marker interrupts it whatever its start number.
  function startsInterrupt(L, paraInItem) {
    const ind = lineIndent(L);
    if (ind > 3) return false;
    const rest = L.s.slice(colIndex(L, ind));
    if (rest === '') return false;
    const c0 = rest[0];
    if (c0 === '#') {
      let k = 0;
      while (k < rest.length && rest[k] === '#') k++;
      if (k >= 1 && k <= 6 && (k === rest.length || rest[k] === ' ' || rest[k] === '\t')) return true;
      return false;
    }
    if (c0 === '`' || c0 === '~') {
      // A fence only interrupts if it is a valid fence: matchFence
      // rejects a backtick fence whose info contains a backtick.
      return !!matchFence(L, ind);
    }
    if (c0 === '>' ) return true;
    if (c0 === '*' || c0 === '-' || c0 === '_') {
      // thematic break?
      let k = 0, n = 0;
      while (k < rest.length) {
        const ch = rest[k];
        if (ch === c0) { n++; k++; }
        else if (ch === ' ' || ch === '\t') k++;
        else break;
      }
      if (n >= 3 && k === rest.length) return true;
      // list marker? An empty item does not interrupt a paragraph. The
      // character right after the marker must be a space or tab.
      if (c0 !== '_' && (rest[1] === ' ' || rest[1] === '\t')) {
        let k2 = 1;
        while (k2 < rest.length && (rest[k2] === ' ' || rest[k2] === '\t')) k2++;
        if (k2 < rest.length) return true;
      }
      return false;
    }
    if (c0 === '<') {
      // Marked's rule, verified against its output: an HTML block start
      // interrupts a paragraph except for type 7 (a complete tag alone on
      // the line, e.g. <a>) and the closing tags of type-1 blocks
      // (</pre>, </script>, </style>, </textarea>). Type-6 closing tags
      // (</div>, </table>) DO interrupt, as do types 2-5.
      const hb = htmlBlockStart(rest);
      if (!hb) return false;
      if (hb.type === 7) return false;
      if (rest.startsWith('</')) {
        const m = /^<\/([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
        if (m && /^(pre|script|style|textarea)$/i.test(m[1])) return false;
      }
      return true;
    }
    if (c0 >= '0' && c0 <= '9') {
      let k = 0;
      while (k < rest.length && rest[k] >= '0' && rest[k] <= '9') k++;
      if (k >= 1 && k <= 9 && k < rest.length && (rest[k] === '.' || rest[k] === ')')) {
        // An ordered marker interrupts a paragraph only if it starts at
        // 1 and the item is not empty — unless the paragraph is inside
        // a list item, where any start number interrupts. The character
        // right after the delimiter must be a space or tab.
        if (rest[k + 1] === ' ' || rest[k + 1] === '\t') {
          let k2 = k + 1;
          while (k2 < rest.length && (rest[k2] === ' ' || rest[k2] === '\t')) k2++;
          if (k2 < rest.length) {
            const num = parseInt(rest.slice(0, k), 10);
            return num === 1 || paraInItem === true;
          }
        }
      }
      return false;
    }
    if (c0 === '+') {
      // An empty item does not interrupt a paragraph. The character
      // right after the marker must be a space or tab.
      if (rest[1] === ' ' || rest[1] === '\t') {
        let k2 = 1;
        while (k2 < rest.length && (rest[k2] === ' ' || rest[k2] === '\t')) k2++;
        return k2 < rest.length;
      }
      return false;
    }
    return false;
  }

  // Loose fence check for lazy continuation: a line starting with 3+
  // backticks or tildes (at indent <= 3) ends a lazy paragraph line
  // even if the fence info contains a backtick (so it is not a valid
  // fence). Marked treats such a line as a block start, not a lazy
  // continuation (doc-19: a ```inner backticks``` line indented below
  // the item content indent closes the list item).
  function isFenceLike(L) {
    const ind = lineIndent(L);
    if (ind > 3) return false;
    const rest = L.s.slice(colIndex(L, ind));
    if (rest === '') return false;
    const c0 = rest[0];
    if (c0 !== '`' && c0 !== '~') return false;
    let k = 0;
    while (k < rest.length && rest[k] === c0) k++;
    return k >= 3;
  }

  // Is the line (at current offset) a setext underline? Returns 1 or 2, else 0.
  function setextLevel(L) {
    const ind = lineIndent(L);
    if (ind > 3) return 0;
    const rest = L.s.slice(colIndex(L, ind));
    if (!/^=+ *$/.test(rest) && !/^-+ *$/.test(rest)) return 0;
    // tabs count as spaces here; accept trailing tabs too
    if (/^[=\-]+[ \t]*$/.test(rest)) return rest[0] === '=' ? 1 : 2;
    return 0;
  }

  // Split a table row line into cells (handles \| escapes). A \| in the
  // source is an escaped pipe: it becomes a literal | in the cell text
  // (the backslash is consumed by the table split, so a code span
  // containing \| renders as |, not \|).
  function splitRow(s) {
    const cells = [];
    let cur = '', i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        if (s[i + 1] === '|') { cur += '|'; i += 2; continue; }
        cur += s[i] + s[i + 1]; i += 2; continue;
      }
      if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
      cur += ch; i++;
    }
    cells.push(cur);
    if (cells.length > 0 && cells[0].trim() === '') cells.shift();
    if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
    return cells;
  }

  // Is the line a valid table delimiter row with `ncols` cells?
  // Returns the alignments array or null.
  function tableDelimiter(L, ncols) {
    const ind = lineIndent(L);
    if (ind > 3) return null;
    const rest = L.s.slice(colIndex(L, ind));
    if (!rest.includes('|')) return null;
    const cells = splitRow(rest);
    if (cells.length !== ncols) return null;
    const aligns = [];
    for (const cell of cells) {
      const t = cell.trim();
      if (/^:?-+:?$/.test(t)) {
        aligns.push(t.startsWith(':') ? (t.endsWith(':') ? 'center' : 'left') : (t.endsWith(':') ? 'right' : null));
      } else return null;
    }
    return aligns;
  }

  // Body row of a table: any non-blank line that does not start a block.
  function isTableRowLine(L) {
    const ind = lineIndent(L);
    if (ind > 3) return true;
    const rest = L.s.slice(colIndex(L, ind));
    if (rest === '') return false;
    const c0 = rest[0];
    if (c0 === '#') {
      let k = 0;
      while (k < rest.length && rest[k] === '#') k++;
      if (k >= 1 && k <= 6 && (k === rest.length || rest[k] === ' ' || rest[k] === '\t')) return false;
    }
    if (c0 === '`' || c0 === '~') {
      // A valid fence ends the table; a backtick fence whose info
      // contains a backtick is not a fence, so it stays a table row.
      if (matchFence(L, ind)) return false;
    }
    if (c0 === '>') return false;
    if (c0 === '*' || c0 === '-' || c0 === '_' || c0 === '+') {
      let k = 0, n = 0;
      while (k < rest.length) {
        const ch = rest[k];
        if (ch === c0) { n++; k++; }
        else if (ch === ' ' || ch === '\t') k++;
        else break;
      }
      if (n >= 3 && k === rest.length) return false;
      if (c0 !== '_' && (rest[1] === ' ' || rest[1] === '\t' || rest.length === 1)) return false;
    }
    if (c0 >= '0' && c0 <= '9') {
      let k = 0;
      while (k < rest.length && rest[k] >= '0' && rest[k] <= '9') k++;
      if (k >= 1 && k <= 9 && k < rest.length && (rest[k] === '.' || rest[k] === ')')) {
        const after = rest[k + 1];
        if (after === ' ' || after === '\t' || k + 1 === rest.length) return false;
      }
    }
    if (c0 === '<' && htmlBlockStart(rest) !== null) return false;
    return true;
  }

  // The paragraph's lines with leading link reference definitions stripped
  // (registered in refs as a side effect). Returns the remaining lines.
  function paraTextLines(para) {
    const lines = para.lines.map((s) => ({ s, o: 0, c: 0 }));
    const rest = consumeRefDefs(lines, refs);
    return rest === null ? para.lines : rest;
  }

  // Convert a paragraph into a table (delimiter already checked). The
  // header is the paragraph's single remaining line after ref defs.
  // Returns false when there is no single header line or no delimiter.
  function convertToTable(para, L) {
    const textLines = paraTextLines(para);
    if (textLines.length !== 1 || !textLines[0].includes('|')) return false;
    const headerCells = splitRow(textLines[0].trim());
    const aligns = tableDelimiter(L, headerCells.length);
    if (!aligns) return false;
    const table = newNode('table');
    table.head = headerCells;
    table.aligns = aligns;
    table.rows = [];
    const p = stack[stack.length - 2];
    const idx = p.children.indexOf(para);
    p.children[idx] = table;
    stack.pop();
    stack.push(table);
    return true;
  }

  // Convert a paragraph into a setext heading in place (after stripping
  // leading ref defs). Returns false when nothing but definitions remains,
  // in which case the caller drops the paragraph and re-handles the line.
  function convertToSetext(para, level) {
    const textLines = paraTextLines(para);
    if (textLines.join('').trim() === '') return false;
    const head = newNode('head');
    head.level = level;
    head.text = textLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    const p = stack[stack.length - 2];
    const idx = p.children.indexOf(para);
    p.children[idx] = head;
    stack.pop();
    return true;
  }

  // Simulate phase 1 for the line at index idx, and return true if it
  // matches containers to at least curDepth (i.e. it continues in the
  // same innermost container). Used to decide whether a whitespace-only
  // line is a blank line or a paragraph line.
  function nextContinuesContainer(idx, curDepth) {
    if (idx + 1 >= lines.length) return false;
    // lines[] already holds line objects; copy the raw string so the
    // simulation's offset advances cannot corrupt the real next line.
    const L2 = makeLine(lines[idx + 1].s);
    let d = 1;
    while (d < stack.length) {
      const node = stack[d];
      if (node.t === 'quote') {
        if (!matchQuote(L2)) break;
        d++;
      } else if (node.t === 'list') { d++; }
      else if (node.t === 'item') {
        if (!matchItem(L2, node)) break;
        d++;
      } else break;
    }
    return d >= curDepth;
  }

  // Index of the line currently being processed (shared with phase2,
  // whose function is declared outside the loop body).
  let curLi = 0;

  for (let li = 0; li < lines.length; li++) {
    curLi = li;
    const L = lines[li];
    lastQuoteBase = 0;
    lastQuoteContentCol = 0;

    // Phase 1: match open containers. A blank remainder matches list
    // and item containers (a blank line is allowed inside them) but not
    // blockquotes, so a blank line with no '>' prefix closes the quote
    // and everything inside it.
    let depth = 1, failedAt = -1;
    while (depth < stack.length) {
      const node = stack[depth];
      if (node.t === 'quote') {
        if (!matchQuote(L)) { failedAt = depth; break; }
        depth++;
      } else if (node.t === 'list') { depth++; }
      else if (node.t === 'item') {
        if (!matchItem(L, node)) { failedAt = depth; break; }
        depth++;
      } else break;
    }

    // A tab that follows a consumed container prefix expands to spaces
    // (see expandLeadingTabs); a top-level tab stays a raw tab. For a
    // continuation line inside a blockquote, the base column is the
    // innermost `>` marker's width plus the space after it
    // (lastQuoteBase, set by matchQuote in phase 1), plus any columns
    // consumed after the quote (a list item's indent counts: marked
    // expands the tab at the quote level, before the item dedents it,
    // so `>   \tX` in an item expands the tab at column 4, not 2).
    // Marked expands the whitespace after each `>` with that marker's
    // own width as the base, so `  > \tX` expands the tab at column 4
    // (not 2) while a nested quote's inner `>` counts from its own
    // level. Otherwise use the absolute column.
    if (L.o > 0) {
      const prefix = L.s.slice(0, L.o);
      const gt = prefix.lastIndexOf('>');
      const base = gt >= 0 && /^[ \t]*$/.test(prefix.slice(gt + 1)) ? lastQuoteBase + (L.c - lastQuoteContentCol) : undefined;
      expandLeadingTabs(L, base);
    }

    // A blank remainder (after the containers that matched) is a blank
    // line for the innermost block. A line that is only whitespace after
    // the prefixes is a blank line too, unless it is the last line of its
    // container and the top is a paragraph (then the whitespace is the
    // paragraph's final line, e.g. "> foo\n>  " keeps the space).
    const remEmpty = L.o >= L.s.length;
    const remWsOnly = !remEmpty && /^[ \t]+$/.test(L.s.slice(L.o));
    if (remEmpty && L.s.trim() !== '') {
      // A line that matched a container marker but carries no content (a
      // lone `>` line, say) is NOT a blank line: it ends the paragraph but
      // does not count as blank between items (cm-320). It does loosen the
      // list if the same item gains another block afterwards (cm-259), so
      // it sets emptyLinePending instead of blankPending. But inside a
      // code block (fenced or indented) or an HTML block, an empty
      // remainder IS a blank content line: let the blank branch below
      // add it as content (doc-05/10/14: a `> ` line inside fenced code
      // in a quote keeps its blank line).
      const topB0 = stack[stack.length - 1];
      if (failedAt >= 0 || (topB0.t !== 'code' && topB0.t !== 'html')) {
        if (failedAt >= 0) popTo(failedAt);
        else {
          const topB = stack[stack.length - 1];
          if (topB.t === 'para') popNode();
        }
        emptyLinePending = true;
        emptyLineTop = stack[stack.length - 1];
        continue;
      }
    }
    if (remEmpty || remWsOnly) {
      const topB = stack[stack.length - 1];
      // Marked quirk (doc-02): a whitespace-only line that is spaces
      // followed by exactly one tab (`/^ *\t$/`) is a table row of empty
      // cells, not a blank line — it does not end the table, and the
      // following lines keep forming rows. (A spaces-only line, an empty
      // line, or a line with two tabs or a trailing space DOES end it.)
      if (remWsOnly && topB.t === 'table' && /^ *\t$/.test(L.s.slice(L.o))) {
        topB.rows.push([]);
        blankPending = false;
        emptyLinePending = false;
        continue;
      }
      // A whitespace-only line is a blank line, except when it
      // explicitly belongs to a block quote (phase 1 consumed a `>`
      // marker, so L.o advanced): then it is paragraph content when
      // nothing follows it in the quote, and a blank line when the
      // next line continues the container (cm-241: `> foo` + `>  `
      // keeps a trailing space in the paragraph; a following `> bar`
      // makes it a blank line). A bare whitespace-only line (no marker
      // consumed) is always a blank line (doc-02: a tab-only line in a
      // list item ends the paragraph and the list; a spaces-only line
      // is not a hard break).
      let isBlankLine = remEmpty || topB.t !== 'para';
      if (remWsOnly && topB.t === 'para') {
        isBlankLine = L.o === 0 || nextContinuesContainer(li, depth);
      }
      if (isBlankLine) {
        if (failedAt >= 0) {
          // The blank line failed to match a container (a quote): close
          // it and everything inside it.
          popTo(failedAt);
        } else if (topB.t === 'para' || topB.t === 'table') {
          popNode();
        } else if (topB.t === 'html' && (topB.htype === 6 || topB.htype === 7)) {
          topB.endedAtBlank = true;
          popNode();
        } else if (topB.t === 'code' && !topB.fenced) {
          // A blank line inside indented code keeps its spaces, less 4.
          advanceCols(L, 4);
          topB.lines.push(lineRest(L));
        } else if (topB.t === 'code' && topB.fenced) {
          // A blank line inside fenced code is content.
          stripFenceIndent(L, topB);
          topB.lines.push(lineRest(L));
        } else if (topB.t === 'html') {
          // HTML types 1-5: a blank line is content.
          topB.lines.push(lineRest(L));
        }
        // quote / list / item / doc: just a blank line in the container.
        // A real blank line supersedes a pending empty container line.
        emptyLinePending = false;
        blankPending = true;
        continue;
      }
      // Not a blank line: the whitespace is a paragraph line. Fall through
      // to the normal failedAt / leaf handling.
    }

    if (failedAt >= 0) {
      const leaf = stack[stack.length - 1];
      if (leaf.t === 'para') {
        // A list marker matching the open list continues it, even if it
        // would not interrupt a paragraph on its own (an empty item, or
        // an ordered marker not starting at 1).
        let continuesList = false;
        const m = matchListMarker(L);
        if (stack[failedAt].t === 'item') {
          const plist = stack[failedAt - 1];
          if (plist && plist.t === 'list' && m && listTypeMatches(plist, m)) continuesList = true;
        }
        // A list-marker line never lazily continues a paragraph once its
        // container has failed: it ends the container and starts (or
        // continues) a list (cm-302: `3) baz` after `1./2.` starts a new
        // `<ol start="3">` instead of joining the paragraph). A fence-like
        // line (3+ backticks/tildes, even with a backtick in the info)
        // also never lazily continues (doc-19).
        if (!continuesList && !startsInterrupt(L) && !isFenceLike(L) && !m) {
          // Lazy continuation (setext / table delimiter included). A setext
          // underline as a lazy line does not convert the paragraph: it stays
          // a paragraph line, indented 4 spaces so it cannot be mistaken
          // for an underline.
          const lv = setextLevel(L);
          if (lv) { leaf.lines.push('    ' + lineRest(L)); blankPending = false; emptyLinePending = false; continue; }
          if (lineRest(L).includes('|')) {
            const tl = paraTextLines(leaf);
            if (tl.length === 1 && tl[0].includes('|')) {
              const hc = splitRow(tl[0].trim());
              if (tableDelimiter(L, hc.length)) { convertToTable(leaf, L); blankPending = false; emptyLinePending = false; continue; }
            }
          }
          // A lazy line that is indented 4+ columns has its code indent
          // stripped (it cannot start an indented code block here).
          // Marked quirk (doc-02): a lazy line indented 4+ followed by a
          // lazy line indented <4 gets a blank line between them in the
          // paragraph (the indented line is treated as a block boundary).
          const lazyInd = lineIndent(L);
          if (leaf._lastLazyInd !== undefined && leaf._lastLazyInd >= 4 && lazyInd < 4) leaf.lines.push('');
          if (lazyInd >= 4) advanceCols(L, 4);
          leaf.lines.push(lineRest(L));
          leaf._lastLazyInd = lazyInd;
          blankPending = false;
          emptyLinePending = false;
          continue;
        }
      }
      // A fenced code block keeps lines that fail an enclosing list item:
      // the content is literal, so a line indented less than the item
      // stays in the code block instead of closing it (doc-02: an
      // unindented line inside a fenced block in a list item). Only a
      // plain paragraph line stays: a line that starts a new block
      // (list marker, heading, fence, quote, HTML block, ...) closes
      // the item instead, as does any line after a blank line.
      // But an under-indented line ends an EMPTY fenced code block in a
      // list item (doc-38): the block closes with no content and the
      // line becomes a paragraph outside the list. Once the block has a
      // content line, under-indented lines stay as content.
      if (leaf.t === 'code' && leaf.fenced && stack[failedAt].t === 'item' &&
          leaf.lines.length > 0 &&
          !remEmpty && !remWsOnly && !blankPending && !startsInterrupt(L, true)) {
        stripFenceIndent(L, leaf);
        leaf.lines.push(lineRest(L));
        blankPending = false;
        emptyLinePending = false;
        continue;
      }
      popTo(failedAt);
    }

    // Top-of-stack leaf handling.
    let top = stack[stack.length - 1];
    let handled = false;
    while (!handled) {
      top = stack[stack.length - 1];
      if (top.t === 'code' && top.fenced) {
        if (isClosingFence(L, top)) { top.closed = true; popNode(); }
        else {
          stripFenceIndent(L, top);
          top.lines.push(lineRest(L));
        }
        handled = true;
      } else if (top.t === 'code') {
        if (lineIndent(L) >= 4) {
          advanceCols(L, 4);
          top.lines.push(lineRest(L));
          handled = true;
        } else { popNode(); }
      } else if (top.t === 'html') {
        top.lines.push(lineRest(L));
        if (top.htype >= 1 && top.htype <= 5 && top.endRe.test(lineRest(L))) {
          // Only a truly empty next line ends the block with no trailing
          // newline; a whitespace-only next line keeps it (marked renders
          // '</pre>\n' after a tab-only line but '</pre>' after an empty one).
          top.endedAtBlank = li + 1 < lines.length && lines[li + 1].s === '';
          popNode();
        }
        handled = true;
      } else if (top.t === 'table') {
        if (isTableRowLine(L)) {
          top.rows.push(splitRow(lineRest(L).trim()));
          handled = true;
        } else { popNode(); }
      } else if (top.t === 'para') {
        const lv = setextLevel(L);
        if (lv) {
          if (convertToSetext(top, lv)) handled = true;
          else popNode(); // only ref defs: drop the paragraph, re-handle line
        }
        else if (lineRest(L).includes('|') && convertToTable(top, L)) { handled = true; }
        else if (startsInterrupt(L, stack.length >= 2 && stack[stack.length - 2].t === 'item')) { popNode(); }
        else { top.lines.push(lineRest(L)); top._lastLazyInd = undefined; handled = true; }
      } else if (top.t === 'list') {
        // A list only continues with a matching item; anything else closes it.
        // A thematic break line ends the list (it also looks like an item).
        const lind = lineIndent(L);
        if (lind <= 3 && isThematicBreak(L.s.slice(colIndex(L, lind)))) { popNode(); continue; }
        const m = matchListMarker(L);
        if (m && listTypeMatches(top, m)) {
          startItem(top, m, L);
          handled = true;
        } else { popNode(); }
      } else {
        handled = phase2(L);
      }
    }
    blankPending = false;
    emptyLinePending = false;
  }

  // Close everything left open.
  popTo(1);
  // Finalize paragraphs that were never popped is handled by popTo.
  return { doc, refs, endsWithNL };

  // ---- phase 2: start new blocks at the current line -----------------------
  function phase2(L) {
    // Returns true when the line is fully consumed.
    for (;;) {
      const ind = lineIndent(L);
      const rest = L.s.slice(colIndex(L, ind));
      if (rest === '') return true; // nothing left on this line
      const top = stack[stack.length - 1];
      if (ind >= 4) {
        const node = newNode('code');
        node.fenced = false;
        node.lines = [];
        advanceCols(L, 4);
        node.contentCol = L.c;
        node.lines.push(lineRest(L));
        addChild(node);
        stack.push(node);
        return true;
      }

      // Fenced code
      const fence = matchFence(L, ind);
      if (fence) {
        const node = newNode('code');
        node.fenced = true;
        node.fenceChar = fence.ch;
        node.fenceLen = fence.len;
        node.fenceIndent = ind;
        node.baseCol = L.c;
        node.closed = false;
        node.info = fence.info;
        node.lines = [];
        addChild(node);
        stack.push(node);
        return true;
      }
      // ATX heading
      if (rest[0] === '#') {
        let k = 0;
        while (k < rest.length && rest[k] === '#') k++;
        if (k >= 1 && k <= 6 && (k === rest.length || rest[k] === ' ' || rest[k] === '\t')) {
          const node = newNode('head');
          node.level = k;
          node.text = parseAtxText(rest.slice(k));
          addChild(node);
          return true;
        }
      }
      // HTML block
      const hb = htmlBlockStart(rest);
      if (hb) {
        const node = newNode('html');
        node.htype = hb.type;
        node.endRe = hb.endRe;
        node.lines = [lineRest(L)];
        addChild(node);
        if (hb.type >= 1 && hb.type <= 5 && hb.endRe.test(lineRest(L))) {
          // Types 1-5 that end on this very line are complete already.
          // Only a truly empty next line drops the trailing newline.
          node.endedAtBlank = curLi + 1 < lines.length && lines[curLi + 1].s === '';
        } else {
          // Types 6 and 7 continue until a blank line (or the end).
          stack.push(node);
        }
        return true;
      }
      // Thematic break
      if (isThematicBreak(rest)) {
        addChild(newNode('hr'));
        return true;
      }
      // Blockquote
      if (rest[0] === '>') {
        const node = newNode('quote');
        addChild(node);
        stack.push(node);
        advanceCols(L, ind);
        L.o++; L.c++;
        let after = 0;
        if (L.o < L.s.length && L.s[L.o] === ' ') { L.o++; L.c++; after = 1; }
        else if (L.o < L.s.length && L.s[L.o] === '\t') { advanceCols(L, 1); after = 1; }
        // A tab in the remainder expands to spaces (doc-05: a new
        // blockquote line `> \tX` must not keep a literal tab). The base
        // is the marker's width (its leading indent + `>`) plus 1 for
        // the space after it — the same rule as a continuation line.
        // At the top level this equals the absolute column (a first
        // line `  > \tX` is code); inside a container it counts from
        // the marker, not from the line start.
        expandLeadingTabs(L, ind + 1 + after);
        continue; // re-run phase 2 on the remainder
      }
      // List item
      const m = matchListMarker(L);
      if (m) {
        if (top.t === 'list' && listTypeMatches(top, m)) {
          startItem(top, m, L);
        } else {
          if (top.t === 'list') { popNode(); }
          const list = newNode('list');
          list.bullet = m.bullet;
          list.marker = m.marker;
          list.delim = m.delim;
          list.start = m.start;
          list.loose = false;
          addChild(list);
          stack.push(list);
          startItem(list, m, L);
        }
        return true;
      }
      // Paragraph (keeps its leading spaces: they are part of the text)
      const node = newNode('para');
      node.lines = [lineRest(L)];
      addChild(node);
      stack.push(node);
      return true;
    }
  }

  function startItem(list, m, L) {
    const item = newNode('item');
    item._list = list;
    const ind = lineIndent(L);
    advanceCols(L, ind);
    const markerStartCol = L.c;
    const markerWidth = m.bullet ? 1 : m.numLen + 1;
    if (m.bullet) { L.o++; L.c++; }
    else { L.o += m.numLen + 1; L.c += m.numLen + 1; }
    // Count the whitespace columns after the marker (up to 5).
    let spaces = 0, scanO = L.o, scanC = L.c;
    while (scanO < L.s.length && spaces < 5) {
      const ch = L.s[scanO];
      if (ch === ' ') { spaces++; scanO++; scanC++; }
      else if (ch === '\t') { const w = 4 - (scanC % 4); spaces += w; scanO++; scanC += w; }
      else break;
    }
    if (scanO >= L.s.length) {
      // Empty item: content indent is marker width + 1.
      item.indent = ind + markerWidth + 1;
      item.empty = true;
      advanceCols(L, spaces);
    } else if (spaces >= 5) {
      // 5+ spaces: content indent is marker width + 1; the rest stays content.
      item.indent = ind + markerWidth + 1;
      advanceCols(L, 1);
    } else {
      item.indent = ind + markerWidth + spaces;
      advanceCols(L, spaces);
    }
    addChild(item);
    stack.push(item);
    // Task list marker, only when the item has content on this line.
    if (L.o < L.s.length) {
      const r = L.s.slice(L.o);
      const tm = /^\[( |x|X)\](?:[ \t]|$)/.exec(r);
      if (tm) {
        item.task = tm[1];
        L.o += 3;
        L.c += 3;
        if (L.o < L.s.length && (L.s[L.o] === ' ' || L.s[L.o] === '\t')) { L.o++; L.c++; }
      }
    }
    // The remainder of the line starts the item's first block.
    if (L.o < L.s.length) {
      phase2(L);
    }
  }
}

// ---- Block start matchers --------------------------------------------------

// Fenced code start: returns {ch, len, info} or null.
function matchFence(L, ind) {
  const rest = L.s.slice(colIndex(L, ind));
  const c0 = rest[0];
  if (c0 !== '`' && c0 !== '~') return null;
  let k = 0;
  while (k < rest.length && rest[k] === c0) k++;
  if (k < 3) return null;
  const info = rest.slice(k);
  if (c0 === '`' && info.includes('`')) return null;
  return { ch: c0, len: k, info: info.trim() };
}

function isClosingFence(L, code) {
  const ind = lineIndent(L);
  if (ind > 3) return false;
  const rest = L.s.slice(colIndex(L, ind));
  const c0 = rest[0];
  if (c0 !== code.fenceChar) return false;
  let k = 0;
  while (k < rest.length && rest[k] === c0) k++;
  if (k < code.fenceLen) return false;
  return /^[ \t]*$/.test(rest.slice(k));
}

function isThematicBreak(rest) {
  const c0 = rest[0];
  if (c0 !== '*' && c0 !== '-' && c0 !== '_') return false;
  let k = 0, n = 0;
  while (k < rest.length) {
    const ch = rest[k];
    if (ch === c0) { n++; k++; }
    else if (ch === ' ' || ch === '\t') k++;
    else return false;
  }
  return n >= 3;
}

// ATX heading text: strip the closing sequence of #s (only when preceded by
// a space) and surrounding whitespace.
function parseAtxText(s) {
  // The closing sequence must be preceded by a space, so test it on the
  // raw text after the opening hashes before trimming the leading spaces.
  let t = s;
  const m = /[ \t]+#+[ \t]*$/.exec(t);
  if (m) t = t.slice(0, m.index);
  return t.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// HTML block start (types 1-6, plus type 7 detection for paragraph
// interruption). Returns {type, endRe} or null. `rest` is the line remainder
// after the (<=3 space) indent.
function htmlBlockStart(rest) {
  const s = rest;
  // Type 1: pre, script, style, textarea
  let m = /^<(pre|script|style|textarea)(?:[ \t>]|$)/i.exec(s);
  if (m) {
    const tag = m[1].toLowerCase();
    return { type: 1, endRe: new RegExp(`</${tag}(?:[ \t>]|$)`, 'i') };
  }
  // Type 2: comment
  if (s.startsWith('<!--')) return { type: 2, endRe: /-->/ };
  // Type 3: processing instruction
  if (s.startsWith('<?')) return { type: 3, endRe: /\?>/ };
  // Type 4: declaration <!A
  if (/^<![A-Za-z]/.test(s)) return { type: 4, endRe: />/ };
  // Type 5: CDATA
  if (s.startsWith('<![CDATA[')) return { type: 5, endRe: /\]\]>/ };
  // Type 6: block-level tag (open or close), followed by space, >, />, EOL
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>]|\/>|$)/.exec(s);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { type: 6, endRe: null };
  // Type 7: a complete open or close tag alone on the line
  if (htmlType7(s) !== null) return { type: 7, endRe: null };
  return null;
}

// Complete open/close tag alone on the line (type 7). Returns the tag or null.
// An open tag may carry attributes; a closing tag is the tag name and
// optional whitespace only — no attributes, no self-closing slash (cm-624:
// `</a href="foo">` is not a complete closing tag).
function htmlType7(s) {
  const open = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>[ \t]*$/.exec(s);
  if (open) return open[0];
  const close = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/.exec(s);
  return close ? close[0] : null;
}

// List marker at the current offset (indent already skipped by caller
// context): returns {bullet, delim, start, numLen} or null.
function matchListMarker(L) {
  const ind = lineIndent(L);
  if (ind > 3) return null;
  const rest = L.s.slice(colIndex(L, ind));
  if (rest === '') return null;
  const c0 = rest[0];
  if (c0 === '-' || c0 === '+' || c0 === '*') {
    if (rest.length === 1 || rest[1] === ' ' || rest[1] === '\t') {
      return { bullet: true, marker: c0, numLen: 0 };
    }
    return null;
  }
  if (c0 >= '0' && c0 <= '9') {
    let k = 0;
    while (k < rest.length && rest[k] >= '0' && rest[k] <= '9') k++;
    if (k >= 1 && k <= 9 && k < rest.length && (rest[k] === '.' || rest[k] === ')')) {
      const after = rest[k + 1];
      if (after === ' ' || after === '\t' || k + 1 === rest.length) {
        return { bullet: false, delim: rest[k], start: parseInt(rest.slice(0, k), 10), numLen: k };
      }
    }
    return null;
  }
  return null;
}

function listTypeMatches(list, m) {
  if (list.bullet !== m.bullet) return false;
  if (m.bullet) return list.marker === m.marker;
  return list.delim === m.delim;
}

// Consume leading link reference definitions from an array of line
// objects (only .s is read). Registers them in refs (first definition
// wins). Returns the remaining lines, or null when no definition was
// consumed. Shared by paragraph finalization and by setext/table
// conversion, which must see the paragraph with its definitions stripped.
function consumeRefDefs(lines, refs) {
  let li = 0, off = 0;
  while (li < lines.length) {
    const L = lines[li];
    while (off < L.s.length && isSpaceCh(L.s[off])) off++;
    if (off < L.s.length) break;
    li++; off = 0;
  }
  let consumedAny = false;
  while (li < lines.length) {
    const L = lines[li];
    let p = off;
    while (p < L.s.length && isSpaceCh(L.s[p])) p++;
    if (p >= L.s.length || L.s[p] !== '[') break;
    const def = tryRefDef(lines, li, p);
    if (!def) break;
    const norm = normalizeLabel(def.label);
    if (!refs.has(norm)) refs.set(norm, { dest: def.dest, title: def.title });
    consumedAny = true;
    li = def.nextLi; off = def.nextOff;
    while (off < lines[li].s.length && isSpaceCh(lines[li].s[off])) off++;
    if (off < lines[li].s.length) break; // junk after the definition: stop
    li++; off = 0;
    while (li < lines.length) {
      const L2 = lines[li];
      let q = 0;
      while (q < L2.s.length && isSpaceCh(L2.s[q])) q++;
      if (q < L2.s.length) break;
      li++;
    }
    off = 0;
  }
  if (!consumedAny) return null;
  const rest = [];
  if (li < lines.length) {
    rest.push(lines[li].s.slice(off));
    for (let k = li + 1; k < lines.length; k++) rest.push(lines[k].s);
  }
  return rest;
}

// ---- Paragraph finalization: link reference definitions --------------------
function finalizeParagraph(para, refs) {
  const lines = para.lines.map((s) => ({ s, o: 0, c: 0 }));
  const rest = consumeRefDefs(lines, refs);
  if (rest === null) return;
  if (rest.join('').trim() === '') {
    para._gone = true;
  } else {
    para.lines = rest;
  }
}

// ---- Inline parser ---------------------------------------------------------
// Flat token list + delimiter stack, following the CommonMark algorithm:
// links form during the scan (a link's text may not itself contain a link),
// emphasis/strikethrough resolve afterwards over the delimiter stack, and a
// delimiter inside a link can only match one inside the same link.

const INLINE_SPECIAL = /[\\`*_[\]<&!~\n]/g;
const EMAIL_LOCAL = new Set();
for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-") EMAIL_LOCAL.add(c.charCodeAt(0));
function isEmailLocal(code) { return EMAIL_LOCAL.has(code); }
function isAlpha(code) { return (code >= 65 && code <= 90) || (code >= 97 && code <= 122); }
function isWsCode(code) { return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12; }
function isWsCh(ch) {
  if (ch === '') return true;
  const code = ch.charCodeAt(0);
  if (code < 128) return isWsCode(code);
  return /\s/u.test(ch);
}

// Match a domain (labels separated by dots, at least 2 labels) at src[k].
// Returns the end index, or -1.
function matchDomain(src, k) {
  let labels = 0, de = k;
  const n = src.length;
  while (true) {
    if (de >= n || !isAlphaNum(src.charCodeAt(de))) return -1;
    const ls = de;
    de++;
    while (de < n && (isAlphaNum(src.charCodeAt(de)) || src.charCodeAt(de) === 45)) de++;
    if (src.charCodeAt(de - 1) === 45) return -1; // label ends with '-'
    if (de - ls > 63) return -1;
    labels++;
    if (src[de] === '.' && de + 1 < n && isAlphaNum(src.charCodeAt(de + 1))) { de++; continue; }
    break;
  }
  return labels >= 2 ? de : -1;
}

// Trim trailing punctuation / unbalanced parens / entity tails off an
// autolink [start, end).
// Marked's _backpedal: a '(' without a matching ')' truncates the URL
// (the regex can only match a (...) as a complete balanced group), so
// `https://a.io)](https://b.io` stops at `https://a.io)]`.
const backpedalRe = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimAutolink(src, start, end) {
  const bp = backpedalRe.exec(src.slice(start, end));
  if (bp && start + bp[0].length < end) end = start + bp[0].length;
  if (end > start && src[end - 1] === ';') {
    const amp = src.lastIndexOf('&', end - 1);
    if (amp >= start && /^&[A-Za-z0-9]+;$/.test(src.slice(amp, end))) end = amp;
  }
  for (;;) {
    if (end <= start) break;
    const ch = src[end - 1];
    if (ch === '?' || ch === '!' || ch === '.' || ch === ',' || ch === ':' || ch === ';' || ch === '*' || ch === '_' || ch === '~' || ch === "'") { end--; continue; }
    if (ch === ')') {
      // A trailing ')' is kept iff it closes a '(' group: the last '('
      // before it must have no ')' between it and the trailing ')'
      // (marked's backpedal keeps a ')' that closes a (...) group, even
      // when an earlier unmatched ')' makes the total counts unbalanced,
      // e.g. `x)](y)` keeps its final ')').
      const openIdx = src.lastIndexOf('(', end - 1);
      if (openIdx < start || src.indexOf(')', openIdx + 1) < end - 1) { end--; continue; }
    }
    break;
  }
  return end;
}

// Extend a bare URL past ']' (and any '[' / '(' / ')') up to whitespace or
// '<', then trim trailing punctuation. Used when a URL inside a bracket
// that will not form a link swallows the ']' and the following '[ref]' /
// '(dest)' into the URL, as marked's greedy url regex does.
function extendBareUrl(src, start, end) {
  let e = end;
  while (e < src.length && !isWsCode(src.charCodeAt(e)) && src[e] !== '<') e++;
  return trimAutolink(src, start, e);
}

// Match a bare email whose '@' is at src[j]. Returns {start, end} or null.
// True when the char at p is escaped by a backslash: it must be ASCII
// punctuation preceded by an odd run of backslashes (`\+` escapes the
// `+`; `\x` does not escape the `x`; `\\+` leaves the `+` unescaped).
function isEscapedAt(src, p) {
  if (p <= 0 || !isAsciiPunct(src.charCodeAt(p))) return false;
  let n = 0;
  for (let q = p - 1; q >= 0 && src[q] === '\\'; q--) n++;
  return n % 2 === 1;
}

function matchEmailAt(src, j, allowTrailingUnd) {
  let ls = j;
  // The local part stops at an escaped char: `a\+b@c.com` autolinks
  // only `b@c.com`, and `x\+@bar.example.com` autolinks nothing (cm-606).
  while (ls > 0 && isEmailLocal(src.charCodeAt(ls - 1)) && !isEscapedAt(src, ls - 1)) ls--;
  if (ls === j) return null;
  const de = matchDomain(src, j + 1);
  if (de < 0) return null;
  if (de < src.length) {
    const c = src.charCodeAt(de);
    if (isWordCh(c) || c === 45) {
      // A trailing '_' run closes an emphasis (the email sits inside
      // `_..._` / `__...__`), it is not part of the address — but only
      // when the run is followed by a non-word char (so `_foo` does not
      // count) and the caller says an '_' emphasis is open.
      if (allowTrailingUnd && c === 95) {
        let k = de;
        while (k < src.length && src.charCodeAt(k) === 95) k++;
        if (k >= src.length || !isWordCh(src.charCodeAt(k))) return { start: ls, end: de };
      }
      return null;
    }
  }
  return { start: ls, end: de };
}

// True when position p lies inside a bare email autolink's local part
// (an `@` + valid domain follow, and the autolink starts at or before
// p). A `_` or `*` inside such a local part is part of the address,
// not an emphasis delimiter (gfm-632: `a.b-c_d@a.b` links whole).
function inEmailLocal(src, p) {
  let j = p;
  while (j < src.length && isEmailLocal(src.charCodeAt(j))) j++;
  if (j >= src.length || src[j] !== '@') return false;
  const m = matchEmailAt(src, j);
  return m !== null && m.start <= p && p < m.end;
}

function matchWwwAt(src, j) {
  const de = matchDomain(src, j + 4);
  if (de < 0) return null;
  let end = de;
  // A `[` or `]` ends the URL: it closes (or opens) a link label, so a
  // bare URL inside link text must not swallow the `]` and the
  // destination (doc-06/08/09/12: [path (https://…)](#…) forms a link).
  while (end < src.length && !isWsCode(src.charCodeAt(end)) && src[end] !== '<' && src[end] !== '[' && src[end] !== ']') end++;
  // rawEnd is the pre-trim scan end: the caller needs it to decide
  // whether the URL swallows a following ']' (see processTextRun).
  const rawEnd = end;
  end = trimAutolink(src, j, end);
  if (end <= j + 4) return null;
  return { start: j, end, rawEnd };
}

function matchSchemeAt(src, j) {
  const n = src.length;
  let k = j;
  if (!isAlpha(src.charCodeAt(k))) return null;
  k++;
  while (k < n && k - j < 32 && (isAlphaNum(src.charCodeAt(k)) || src.charCodeAt(k) === 43 || src.charCodeAt(k) === 45 || src.charCodeAt(k) === 46)) k++;
  if (k - j < 2 || k - j > 32 || src[k] !== ':') return null;
  const after = k + 1;
  if (src.startsWith('//', after)) {
    const de = matchDomain(src, after + 2);
    if (de < 0) return null;
    let end = de;
    // A `[` or `]` ends the URL: it closes (or opens) a link label, so a
    // bare URL inside link text must not swallow the `]` and the
    // destination (doc-06/08/09/12: [path (https://…)](#…) forms a link).
    while (end < n && !isWsCode(src.charCodeAt(end)) && src[end] !== '<' && src[end] !== '[' && src[end] !== ']') end++;
    // rawEnd is the pre-trim scan end: the caller needs it to decide
    // whether the URL swallows a following ']' (see processTextRun).
    const rawEnd = end;
    end = trimAutolink(src, j, end);
    return { start: j, end, rawEnd };
  }
  // scheme:email form, with an optional single path segment
  let ls = after;
  while (ls < n && isEmailLocal(src.charCodeAt(ls))) ls++;
  if (ls === after || src[ls] !== '@') return null;
  const de = matchDomain(src, ls + 1);
  if (de < 0) return null;
  if (de < n) {
    const c = src.charCodeAt(de);
    if (isWordCh(c) || c === 45) return null;
  }
  let end = de;
  if (src[end] === '/' && end + 1 < n && !isWsCode(src.charCodeAt(end + 1)) && src[end + 1] !== '<' && src[end + 1] !== '/') {
    let se = end + 1;
    while (se < n && !isWsCode(src.charCodeAt(se)) && src[se] !== '<' && src[se] !== '/' && src[se] !== '[' && src[se] !== ']') se++;
    end = trimAutolink(src, j, se);
  } else {
    end = trimAutolink(src, j, end);
  }
  return { start: j, end };
}

// Does the link text src[start:end] match marked's label regex (the `re`
// used by its link tokenizer)? The label must be fully consumable by: a
// nested [...], an escaped char, a code span (`+ non-backtick `+), a ``+
// run right before ']', or a single non-special char. A code span whose
// content holds a lone backtick (`` a ` b ``) is matched by marked as
// `` a ` (opening run + content + single backtick), leaving a dangling
// `` run that only matches if it sits right before ']' — otherwise the
// link does not form (doc-16/20/22/23).
function labelMatches(src, start, end) {
  let p = start;
  while (p < end) {
    const ch = src[p];
    if (ch === '[') {
      // Nested bracket: scan to its matching ']' (content may hold a
      // backtick — marked's nested-bracket pattern Le allows any char
      // except '[', ']' and backslash, so a code span inside is fine).
      let depth = 1, q = p + 1, ok = false;
      while (q < end) {
        if (src[q] === '\\' && q + 1 < end) { q += 2; continue; }
        if (src[q] === '[') depth++;
        else if (src[q] === ']') { depth--; if (depth === 0) { ok = true; break; } }
        q++;
      }
      if (!ok) return false;
      p = q + 1;
      continue;
    }
    if (ch === '\\') {
      if (p + 1 < end) { p += 2; continue; }
      return false;
    }
    if (ch === '`') {
      // Code span: opening run, then content up to the next backtick
      // run (the closing run is the FIRST backtick run found, even a
      // single one — the regex's [^`]*? is lazy).
      let k = p;
      while (k < end && src[k] === '`') k++;
      const openLen = k - p;
      let c = k;
      while (c < end && src[c] !== '`') c++;
      if (c >= end) {
        // No closing backtick: only a ``+ run right before ']' matches.
        if (openLen >= 2 && k === end) { p = end; continue; }
        return false;
      }
      let cEnd = c;
      while (cEnd < end && src[cEnd] === '`') cEnd++;
      p = cEnd;
      continue;
    }
    if (ch === ']') return false;
    p++;
  }
  return p === end;
}

// Find the ')' matching the '(' at src[openPos] (depth-aware, skips
// escaped chars). Returns its index, or -1 when the paren is unclosed.
function findClosingParen(src, openPos) {
  let depth = 0;
  for (let k = openPos; k < src.length; k++) {
    const ch = src[k];
    if (ch === '\\' && k + 1 < src.length) { k++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

// Parse a link label at src[i] === '[' (string version). Returns
// {text (normalized), end} or null. Labels are matched on their RAW text
// (backslashes kept); an unescaped [ inside makes it invalid.
function parseLabelAt(src, i) {
  let raw = '', p = i + 1;
  const n = src.length;
  while (p < n) {
    const ch = src[p];
    if (ch === '\\' && p + 1 < n && isAsciiPunct(src.charCodeAt(p + 1))) { raw += src[p] + src[p + 1]; p += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') {
      if (raw.length === 0 || raw.length > 999) return null;
      const text = normalizeLabel(raw);
      if (text.length === 0) return null;
      return { text, end: p + 1 };
    }
    raw += ch; p++;
  }
  return null;
}

// Parse an inline link destination/title starting after '(' at src[i].
// Returns {dest, title, end} (end = index after ')') or null.
function parseInlineDest(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && isWsCode(src.charCodeAt(j))) j++;
  if (j >= n) return null;
  // An empty destination is a valid link with href="" ([link](), [foo]( )).
  if (src[j] === ')') return { dest: '', title: null, end: j + 1 };
  let dest;
  if (src[j] === '<') {
    let k = j + 1, ok = false;
    while (k < n) {
      const ch = src[k];
      if (ch === '>') { ok = true; break; }
      if (ch === '<' || ch === '\n') break;
      if (ch === '\\' && k + 1 < n && isAsciiPunct(src.charCodeAt(k + 1))) k++;
      k++;
    }
    if (!ok) return null;
    dest = unescapeBackslashes(src.slice(j + 1, k));
    j = k + 1;
    // A title must be separated from an angle-bracket destination by
    // whitespace: [a](<b>(c)) is not a link.
    if (j < n && (src[j] === '"' || src[j] === "'" || src[j] === '(')) return null;
  } else {
    let k = j, depth = 0;
    while (k < n) {
      const ch = src[k];
      if (ch === '\\' && k + 1 < n && isAsciiPunct(src.charCodeAt(k + 1))) { k += 2; continue; }
      if (ch === '(') { depth++; k++; continue; }
      if (ch === ')') { if (depth === 0) break; depth--; k++; continue; }
      if (isWsCode(src.charCodeAt(k))) break;
      if (src.charCodeAt(k) < 32) return null;
      k++;
    }
    if (k === j) return null;
    dest = unescapeBackslashes(src.slice(j, k));
    j = k;
  }
  while (j < n && isWsCode(src.charCodeAt(j))) j++;
  let title = null;
  if (j < n && (src[j] === '"' || src[j] === "'" || src[j] === '(')) {
    const t = parseTitle(src, j);
    if (!t) return null;
    title = t.title; j = t.end;
    while (j < n && isWsCode(src.charCodeAt(j))) j++;
  }
  if (j >= n || src[j] !== ')') return null;
  return { dest, title, end: j + 1 };
}

// Match an angle autolink or inline HTML tag at src[i] === '<'.
// Returns {kind: 'link'|'email'|'html', end, href?, text?} or null.
function matchAngle(src, i) {
  const n = src.length;
  // autolink: <scheme:...> or <email>
  const m = /^<[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*>/.exec(src.slice(i, i + 400));
  if (m) {
    const text = m[0].slice(1, -1);
    return { kind: 'link', end: i + m[0].length, href: text, text };
  }
  const em = /^<[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+>/.exec(src.slice(i, i + 400));
  if (em) {
    const text = em[0].slice(1, -1);
    return { kind: 'email', end: i + em[0].length, href: 'mailto:' + text, text };
  }
  // inline HTML: comment, processing instruction, declaration, CDATA, tag.
  // `<!-->` and `<!--->` are complete comments on their own (cm-626):
  // the general comment form must not swallow a later `-->` as its end.
  const s = src.slice(i);
  let hm = /^<!-->/.exec(s);
  if (hm) return { kind: 'html', end: i + hm[0].length, text: hm[0] };
  hm = /^<!--->/.exec(s);
  if (hm) return { kind: 'html', end: i + hm[0].length, text: hm[0] };
  hm = /^<!--(?:(?!-->)[\s\S])*?-->/.exec(s);
  if (hm) return { kind: 'html', end: i + hm[0].length, text: hm[0] };
  hm = /^<\?(?:(?!\?>)[\s\S])*?\?>/.exec(s);
  if (hm) return { kind: 'html', end: i + hm[0].length, text: hm[0] };
  hm = /^<![A-Z]+[^>]*>/.exec(s);
  if (hm) return { kind: 'html', end: i + hm[0].length, text: hm[0] };
  hm = /^<!\[CDATA\[(?:(?!\]\]>)[\s\S])*?\]\]>/.exec(s);
  if (hm) return { kind: 'html', end: i + hm[0].length, text: hm[0] };
  // Open tag: attributes are separated by whitespace, newlines included,
  // and a quoted value may hold <, > and newlines (cm-491, cm-615,
  // cm-616). Attribute names are [a-zA-Z_:][a-zA-Z0-9_.:-]*, so `!`
  // in a name ends the tag (cm-621).
  hm = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.exec(s);
  if (hm) return { kind: 'html', end: i + hm[0].length, text: hm[0] };
  // Closing tag: tag name and optional whitespace only — no attributes
  // and no self-closing slash (cm-624).
  hm = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(s);
  if (hm) return { kind: 'html', end: i + hm[0].length, text: hm[0] };
  return null;
}

function parseInline(src, refs, opts) {
  const plain = !!(opts && opts.plain);
  const allowLinks = !opts || opts.allowLinks !== false;
  const toks = [];
  const delims = [];
  const brackets = [];
  // Ranges [start, end) that marked's emStrong/del masking swallows: a
  // code span that our tokenizer blocks (because it crosses a `]` that
  // forms a link) is still a code span in marked's masked source, so any
  // emphasis/strikethrough delimiter inside it is invisible to emStrong
  // and renders literally (doc-09: the `` `` `` in `[docs each ``url`]`
  // pairs with the `` `` `` before ` a `, swallowing `_issue table_`).
  const maskedRanges = [];
  let linkSeq = 0;
  const n = src.length;
  let i = 0;

  function pushText(raw) { if (raw !== '') toks.push({ k: 't', v: raw }); }
  function pushHtml(v) { toks.push({ k: 'h', v }); }

  // Would a link form if the bracket br closed at closePos (a ']')?
  // Mirrors tryFormLink's resolution without side effects. Used by the
  // bare-URL scan: a URL inside a bracket that will form a link must stop
  // at the ']' (so the link can form); a URL inside a bracket that will
  // NOT form a link swallows the ']' and the following '[ref]' / '(dest)'
  // into the URL, as marked's greedy url regex does.
  function bracketFormsLink(br, closePos) {
    if (!allowLinks) return false;
    const linkTextSrc = src.slice(br.pos, closePos);
    let forms = false;
    if (src[closePos + 1] === '(') {
      const d = parseInlineDest(src, closePos + 2);
      if (d) forms = true;
      else if (refs.get(normalizeLabel(linkTextSrc))) forms = true;
    } else if (src[closePos + 1] === '[') {
      if (src[closePos + 2] === ']') {
        if (refs.get(normalizeLabel(linkTextSrc))) forms = true;
      } else {
        const lab = parseLabelAt(src, closePos + 1);
        if (lab && refs.get(lab.text)) forms = true;
      }
    } else {
      if (refs.get(normalizeLabel(linkTextSrc))) forms = true;
    }
    if (!forms) return false;
    // A link's text may not contain a (live) link.
    if (!br.image) {
      for (let t = br.ti + 1; t < toks.length; t++) {
        if (toks[t].k === 'a' && !toks[t].dead) return false;
      }
    }
    return true;
  }

  // Process a plain-text run [a, b) for GFM autolinks. Returns the new scan
  // position (may be past b when a URL runs past the run's end).
  // Marked suppresses bare-URL/email autolinks while inLink is set.
  function processTextRun(a, b) {
    if (inLinkState) { if (b > a) pushText(src.slice(a, b)); return b; }
    let seg = a, j = a;
    // True when an '_' emphasis delimiter is open: a trailing '_' after
    // an email address then closes that emphasis instead of invalidating
    // the address (doc-26/31/34/37/38: `_... email@x.com_` links it).
    let inUndEmph = false;
    for (let d = 0; d < delims.length; d++) {
      const dt = toks[delims[d]];
      if (dt.k === 'd' && dt.ch === '_' && dt.canOpen) { inUndEmph = true; break; }
    }
    while (j < b) {
      let m = null, prefix = '';
      const code = src.charCodeAt(j);
      if (src.startsWith('www.', j) && (j === 0 || (!isWordCh(src.charCodeAt(j - 1)) && src.charCodeAt(j - 1) !== 47))) {
        m = matchWwwAt(src, j); prefix = 'http://';
      } else if (isAlpha(code) && (j === 0 || (!isWordCh(src.charCodeAt(j - 1)) && src.charCodeAt(j - 1) !== 47))) {
        // quick scheme check: scheme chars then ':'
        let k = j + 1;
        while (k < n && k - j < 32 && (isAlphaNum(src.charCodeAt(k)) || src.charCodeAt(k) === 43 || src.charCodeAt(k) === 45 || src.charCodeAt(k) === 46)) k++;
        if (k - j >= 2 && k - j <= 32 && src[k] === ':') { m = matchSchemeAt(src, j); prefix = ''; }
      } else if (src[j] === '@') {
        m = matchEmailAt(src, j, inUndEmph); prefix = 'mailto:';
      }
      if (m) {
        // A bare URL whose raw scan hits a ']' swallows the ']' and the
        // following '[ref]' / '(dest)' unless that ']' closes a bracket
        // that will form a link (marked's url regex is greedy up to
        // whitespace). In plain text (no open bracket) there is no link
        // to form, so the URL always swallows the ']'. The raw (pre-trim)
        // scan end is used because trimAutolink may have cut a trailing
        // ')' that sits before the ']'.
        if (m.rawEnd !== undefined && m.rawEnd < n && src[m.rawEnd] === ']') {
          let extend = false;
          if (brackets.length === 0) extend = true;
          else if (!bracketFormsLink(brackets[brackets.length - 1], m.rawEnd)) extend = true;
          if (extend) m = { start: m.start, end: extendBareUrl(src, m.start, m.rawEnd) };
        }
        if (m.start > seg) pushText(src.slice(seg, m.start));
        const urlText = src.slice(m.start, m.end);
        toks.push({ k: 'u', href: prefix + urlText, text: urlText });
        seg = m.end; j = m.end;
        if (m.end > b) return m.end;
        continue;
      }
      j++;
    }
    if (b > seg) pushText(src.slice(seg, b));
    return b;
  }

  function flanking(i0, k) {
    const prev = i0 > 0 ? src[i0 - 1] : '';
    const nextCh = k < n ? src[k] : '';
    const prevIsSpace = isWsCh(prev);
    const nextIsSpace = isWsCh(nextCh);
    const prevIsPunct = prev !== '' && isPunctCh(prev);
    const nextIsPunct = nextCh !== '' && isPunctCh(nextCh);
    const leftFlanking = !nextIsSpace && (!nextIsPunct || prevIsSpace || prevIsPunct);
    const rightFlanking = !prevIsSpace && (!prevIsPunct || nextIsSpace || nextIsPunct);
    return { leftFlanking, rightFlanking, prevIsPunct, nextIsPunct };
  }

  // Disable the emphasis delimiters inside a bracket's label (they
  // render as literal text). Used when a '[label](...)' with a balanced
  // but invalid destination is literal text in marked: the failed link
  // match consumed the label as text, suppressing its emphasis.
  function suppressLabelDelims(br) {
    for (let t = br.ti + 1; t < toks.length; t++) {
      const tk = toks[t];
      if (tk.k === 'd' && tk.linkId === 0) { tk.canOpen = false; tk.canClose = false; }
    }
  }

  // Try to form a link/image whose opener is bracket br and whose ']' is at
  // position closePos. Returns {end} (scan position after the link) or null.
  function tryFormLink(br, closePos) {
    if (!allowLinks) return null;
    const textStart = br.pos;
    const linkTextSrc = src.slice(textStart, closePos);
    // Marked's link tokenizer matches the label with a regex that
    // mishandles a code span holding a lone backtick (`` a ` b ``): the
    // span is read as `` a `, leaving a dangling `` run, so the link
    // does not form unless that run sits right before ']'.
    if (linkTextSrc.includes('`') && !labelMatches(src, textStart, closePos)) {
      if (src[closePos + 1] === '(' && findClosingParen(src, closePos + 1) >= 0) suppressLabelDelims(br);
      return null;
    }
    let dest = null, title = null, end = -1;
    if (src[closePos + 1] === '(') {
      const d = parseInlineDest(src, closePos + 2);
      if (d) { dest = d.dest; title = d.title; end = d.end; }
      else {
        // The (...) is not a valid inline destination: fall back to the
        // shortcut reference ([foo](not a link) resolves [foo] and leaves
        // "(not a link)" as literal text).
        const ref = refs.get(normalizeLabel(linkTextSrc));
        if (!ref) {
          // A '[label](...)' with a balanced but invalid destination is
          // literal text in marked, and emphasis inside the label is
          // suppressed (the failed link match consumed the label as
          // text). An unclosed '(' does not suppress it.
          if (findClosingParen(src, closePos + 1) >= 0) suppressLabelDelims(br);
          return null;
        }
        dest = ref.dest; title = ref.title; end = closePos + 1;
      }
    } else if (src[closePos + 1] === '[') {
      if (src[closePos + 2] === ']') {
        // Collapsed reference [foo][]: the label is the link text.
        const ref = refs.get(normalizeLabel(linkTextSrc));
        if (!ref) return null;
        dest = ref.dest; title = ref.title; end = closePos + 3;
      } else {
        const lab = parseLabelAt(src, closePos + 1);
        if (!lab) return null;
        const ref = refs.get(lab.text);
        if (!ref) return null;
        dest = ref.dest; title = ref.title; end = lab.end;
      }
    } else {
      // Shortcut reference: the label is the link text (raw, backslashes
      // kept: [Foo*bar\]] looks up "foo*bar\]").
      const ref = refs.get(normalizeLabel(linkTextSrc));
      if (!ref) return null;
      dest = ref.dest; title = ref.title; end = closePos + 1;
    }
    // A link's text may not contain a (live) link. An image's description
    // MAY contain one: it renders as plain text in the alt attribute.
    if (!br.image) {
      for (let t = br.ti + 1; t < toks.length; t++) {
        if (toks[t].k === 'a' && !toks[t].dead) return null;
      }
    }
    const id = ++linkSeq;
    // Delimiters inside the link can only match inside the same link.
    for (let d = 0; d < delims.length; d++) {
      const ti = delims[d];
      if (ti > br.ti && ti < toks.length && toks[ti].k === 'd') toks[ti].linkId = id;
    }
    // Autolinks inside a link's text render as plain text, not as nested
    // links ([a@b.com](url) shows a@b.com, not a mailto: link).
    if (!br.image) {
      for (let t = br.ti + 1; t < toks.length; t++) {
        if (toks[t].k === 'u' && !toks[t].dead) toks[t] = { k: 't', v: toks[t].text };
      }
    }
    if (br.image) {
      const alt = parseInline(linkTextSrc, refs, { plain: true });
      const img = '<img src="' + escapeAttr(cleanHref(dest)) + '" alt="' + escapeAttr(alt) + '"' +
        (title !== null ? ' title="' + escapeAttr(title) + '"' : '') + '>';
      toks[br.ti] = { k: 'i', v: img, alt };
      for (let t = br.ti + 1; t < toks.length; t++) toks[t].dead = true;
      // drop dead delimiters and brackets from the stacks
      for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d] > br.ti) delims.splice(d, 1);
      }
      for (let b = brackets.length - 1; b >= 0; b--) {
        if (brackets[b].ti > br.ti) brackets.splice(b, 1);
      }
    } else {
      toks[br.ti] = { k: 'a', href: dest, title };
      toks.push({ k: 'z' });
      for (let b = brackets.length - 1; b >= 0; b--) {
        if (brackets[b].ti > br.ti) brackets.splice(b, 1);
      }
    }
    return { end };
  }

  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    let m = INLINE_SPECIAL.exec(src);
    let next = m ? m.index : n;
    // A `_` or `*` inside an email local part belongs to the autolink,
    // not to emphasis: keep scanning past it so the text run (and the
    // autolink scan) sees the whole address (gfm-632).
    while (m && (src[next] === '_' || src[next] === '*') && inEmailLocal(src, next)) {
      m = INLINE_SPECIAL.exec(src);
      next = m ? m.index : n;
    }
    if (next > i) {
      i = processTextRun(i, next);
      if (i >= n) break;
      continue;
    }
    if (!m) break;
    i = next;
    const ch = src[i];
    if (ch === '\\') {
      if (i + 1 < n) {
        const nc = src[i + 1];
        if (nc === '\n') {
          toks.push({ k: 'b' });
          i += 2;
          // A hard break strips the next line's leading whitespace.
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          continue;
        }
        if (isAsciiPunct(nc.charCodeAt(0))) { pushText(nc); i += 2; continue; }
      }
      pushText('\\'); i++; continue;
    }
    if (ch === '`') {
      let k = i;
      while (k < n && src[k] === '`') k++;
      const runLen = k - i;
      let close = -1, p = k;
      while (p < n) {
        if (src[p] === '`') {
          let q = p;
          while (q < n && src[q] === '`') q++;
          if (q - p === runLen) { close = p; break; }
          p = q;
        } else p++;
      }
      if (close < 0) { pushText(src.slice(i, k)); i = k; continue; }
      // A code span inside a bracket (link text) cannot extend past the
      // bracket's ']' when that bracket forms a link — marked tokenizes
      // the link first, so the span is bounded by the link text. But if
      // the bracket does NOT form a link (no inline dest, no matching
      // ref), the code span CAN cross the ']' (doc-35: `[run ``response`]`
      // with no ref forms a code span, not a link). So only block the
      // span when bracketFormsLink says the link resolves.
      if (brackets.length > 0) {
        const br = brackets[brackets.length - 1];
        let crosses = false;
        for (let s = i; s < close; s++) {
          if (src[s] === ']' && labelMatches(src, br.pos, s) && bracketFormsLink(br, s)) { crosses = true; break; }
        }
        if (crosses) {
          // Blocked as a code span, but marked's emStrong masking still
          // sees it: record the range so delimiters inside it are
          // disabled (they render literally).
          maskedRanges.push([i, close + runLen]);
          pushText(src.slice(i, k)); i = k; continue;
        }
      }
      let content = src.slice(k, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      toks.push({ k: 'c', v: content });
      i = close + runLen;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let k = i;
      while (k < n && src[k] === ch) k++;
      const runLen = k - i;
      const f = flanking(i, k);
      let canOpen, canClose;
      if (ch === '*') { canOpen = f.leftFlanking; canClose = f.rightFlanking; }
      else {
        canOpen = f.leftFlanking && (!f.rightFlanking || f.prevIsPunct);
        canClose = f.rightFlanking && (!f.leftFlanking || f.nextIsPunct);
      }
      delims.push(toks.length);
      toks.push({ k: 'd', ch, n: runLen, orig: runLen, canOpen, canClose, linkId: 0, openTags: [], closeTags: [], pos: i });
      i = k;
      continue;
    }
    if (ch === '~') {
      let k = i;
      while (k < n && src[k] === '~') k++;
      const runLen = k - i;
      if (runLen === 1 || runLen === 2) {
        const f = flanking(i, k);
        delims.push(toks.length);
        toks.push({ k: 'd', ch: '~', n: runLen, orig: runLen, canOpen: f.leftFlanking, canClose: f.rightFlanking, linkId: 0, openTags: [], closeTags: [], pos: i });
      } else {
        pushText(src.slice(i, k));
      }
      i = k;
      continue;
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const image = ch === '!';
      const ti = toks.length;
      toks.push({ k: 't', v: image ? '![' : '[' });
      brackets.push({ ti, pos: i + (image ? 2 : 1), image, active: true });
      i += image ? 2 : 1;
      continue;
    }
    if (ch === ']') {
      let bi = -1;
      for (let b = brackets.length - 1; b >= 0; b--) {
        if (brackets[b].active) { bi = b; break; }
      }
      if (bi < 0) { pushText(']'); i++; continue; }
      const br = brackets[bi];
      const formed = tryFormLink(br, i);
      if (formed) {
        brackets.splice(bi, 1);
        i = formed.end;
      } else {
        br.active = false;
        pushText(']'); i++;
      }
      continue;
    }
    if (ch === '<') {
      const a = matchAngle(src, i);
      if (a) {
        if (a.kind === 'html') {
          // Marked's tag tokenizer sets inLink on `<a ` (a + space) and
          // clears it on `</a>`. Plain (alt-text) tokenization must not
          // leak into the shared state.
          if (!plain) {
            if (!inLinkState && /^<a /i.test(a.text)) inLinkState = true;
            else if (inLinkState && /^<\/a>/i.test(a.text)) inLinkState = false;
          }
          if (plain) { /* inline HTML drops out of plain text */ }
          else toks.push({ k: 'g', v: a.text });
        } else {
          // Angle autolinks (<https://x> and <a@b.com>) are a distinct
          // token from bare GFM autolinks: unlike bare autolinks, they
          // DO render as nested links inside a link's text (doc-04/08/
          // 09/10), so tryFormLink's bare-autolink suppression must not
          // touch them.
          toks.push({ k: 'U', href: a.href, text: a.text });
        }
        i = a.end;
        continue;
      }
      pushText('<'); i++; continue;
    }
    if (ch === '&') {
      const e = tryEntity(src, i);
      if (e) {
        toks.push({ k: 'e', v: e.text, verb: e.verb });
        i += e.len;
        continue;
      }
      pushText('&'); i++; continue;
    }
    if (ch === '\n') {
      // Soft break, unless the line ends with 2+ spaces (hard break).
      let t = toks.length - 1;
      let hard = false;
      while (t >= 0 && toks[t].k === 't') {
        const v = toks[t].v;
        let sp = 0;
        for (let q = v.length - 1; q >= 0 && v[q] === ' '; q--) sp++;
        if (sp >= 2) { toks[t].v = v.slice(0, v.length - sp); hard = true; }
        break;
      }
      if (hard) toks.push({ k: 'b' });
      else pushText('\n');
      i++;
      // A hard break strips the next line's leading whitespace (cm-636,
      // cm-637). A soft break keeps it.
      if (hard) { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; }
      continue;
    }
    // '!' not followed by '['
    pushText(ch); i++;
  }

  // ---- Marked's masked-code-span quirk ----------------------------------
  // A delimiter inside a masked code span (recorded above) is invisible
  // to marked's emStrong/del, so it renders literally: disable it.
  // EXCEPT delimiters inside a link's text: marked re-tokenizes link
  // text separately (with its own masked source), so the paragraph-level
  // masking does not suppress them (doc-35: `*fast*` inside
  // `[default run*fast*](...)` still forms even though a masked code
  // span covers the whole link).
  if (maskedRanges.length > 0) {
    for (let di = 0; di < delims.length; di++) {
      const dt = toks[delims[di]];
      if (!dt || dt.k !== 'd' || dt.pos === undefined) continue;
      if (dt.linkId !== 0) continue;
      for (let r = 0; r < maskedRanges.length; r++) {
        if (dt.pos >= maskedRanges[r][0] && dt.pos < maskedRanges[r][1]) {
          dt.canOpen = false; dt.canClose = false; break;
        }
      }
    }
  }

  // ---- Marked's nested-emphasis quirk -----------------------------------
  // Marked's regex-based emStrong leaves an outer '*'/'**' opener literal
  // when it encloses a '**'/'*' pair whose closer is followed directly by
  // a word character (the inner closer is then both open and close, and
  // the outer opener is preceded by a space so the inner opener cannot
  // close). E.g. '*a **b**c*' renders '*a <strong>b</strong>c*' while
  // '*a **b** c*' and '*a**b**c*' do form the outer emphasis. Replicate
  // it by disabling such an outer opener (it then renders literally and
  // the inner pair still forms). The inner pair is identified by its
  // opener (canClose false: preceded by space) and closer (canOpen true:
  // followed by a word char), with no other same-char delimiter between
  // them, and an outer closer of the same run length after it.
  for (let oi = 0; oi < delims.length; oi++) {
    const ot = toks[delims[oi]];
    if (!ot || ot.k !== 'd' || ot.ch !== '*' || !ot.canOpen) continue;
    if (ot.orig !== 1 && ot.orig !== 2) continue;
    const ro = ot.orig, ri = ro === 1 ? 2 : 1;
    for (let ii = oi + 1; ii < delims.length; ii++) {
      const it = toks[delims[ii]];
      if (!it || it.k !== 'd' || it.ch !== '*') continue;
      if (it.orig !== ri || !it.canOpen || it.canClose) break;
      // it is the inner opener (run ri, can open, cannot close).
      let hasCloser = false, outerCloserTok = null;
      for (let ji = ii + 1; ji < delims.length; ji++) {
        const jt = toks[delims[ji]];
        if (!jt || jt.k !== 'd' || jt.ch !== '*') continue;
        if (jt.orig === ri && jt.canClose && jt.canOpen) { hasCloser = true; continue; }
        // The outer closer must be a run of 1 or 2 (the {1,2} pair);
        // a run of 3+ is split by marked and the outer span still forms
        // ('**return that *old*two***' keeps its <strong>).
        if (jt.orig >= ro && jt.orig <= 2 && jt.canClose) { outerCloserTok = jt; break; }
        if (jt.orig === ri) break;
        break;
      }
      // Disable the outer opener AND its closer: the closer must not
      // fall back to pairing with an earlier opener (marked consumes
      // the outer span first, so the orphaned closer stays literal).
      if (hasCloser && outerCloserTok) {
        ot.canOpen = false;
        outerCloserTok.canOpen = false;
        outerCloserTok.canClose = false;
      }
      break;
    }
  }

  // ---- Emphasis / strikethrough pass (CommonMark phase 2) -----------------
  // Follows commonmark.js processEmphasis: closers are scanned left to
  // right; for each, look back for the first matching opener, applying the
  // odd-match (rule of 3) test on the ORIGINAL run lengths. When a span is
  // created, the delimiters strictly between opener and closer are removed
  // from the stack (they cannot match outside the span). openers_bottom
  // limits re-searching after a failed match.
  const openersBottom = new Map();
  function obKey(ch, canOpen, orig, linkId) {
    return ch + '|' + (canOpen ? 1 : 0) + '|' + (orig % 3) + '|' + linkId;
  }
  let di = 0;
  while (di < delims.length) {
    const cti = delims[di];
    const closer = toks[cti];
    if (!closer || closer.k !== 'd' || closer.n === 0 || !closer.canClose) { di++; continue; }
    const key = obKey(closer.ch, closer.canOpen, closer.orig, closer.linkId);
    const bottom = openersBottom.has(key) ? openersBottom.get(key) : -1;
    // Look back for an opener.
    let openerIdx = -1;
    for (let oj = di - 1; oj >= 0; oj--) {
      const oti = delims[oj];
      if (bottom >= 0 && oti === bottom) break;
      const opener = toks[oti];
      if (!opener || opener.k !== 'd' || opener.n === 0) continue;
      if (opener.ch !== closer.ch || !opener.canOpen) continue;
      if (opener.linkId !== closer.linkId) continue;
      const oddMatch = (closer.canOpen || opener.canClose) &&
        closer.orig % 3 !== 0 &&
        (opener.orig + closer.orig) % 3 === 0;
      if (oddMatch) continue;
      openerIdx = oj;
      break;
    }
    if (openerIdx < 0) {
      // No opener: set the lower bound for future searches, and drop a
      // closer that cannot also open (it can never match).
      openersBottom.set(key, di > 0 ? delims[di - 1] : -1);
      if (!closer.canOpen) delims.splice(di, 1);
      else di++;
      continue;
    }
    const oti = delims[openerIdx];
    const opener = toks[oti];
    // Marked's emStrong skips a closer shorter than the opener's
    // remaining length when a later, longer closer can satisfy it (the
    // `m` accumulator): `**foo *bar*baz* qux**` leaves the middle `*`
    // literal and closes the strong at the final `**`. Replicate: if
    // this closer is shorter than the opener and a later closer of the
    // same char with n >= opener.n exists, skip this closer (it stays
    // in the stack and becomes literal inside the eventual span).
    if (closer.n < opener.n) {
      let later = false;
      for (let lj = di + 1; lj < delims.length; lj++) {
        const lt = toks[delims[lj]];
        if (!lt || lt.k !== 'd' || lt.n === 0) continue;
        if (lt.ch !== closer.ch || !lt.canClose) continue;
        if (lt.linkId !== opener.linkId) continue;
        if (lt.n >= opener.n) { later = true; break; }
      }
      if (later) { di++; continue; }
    }
    const use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    const tag = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    opener.openTags.push(tag);
    closer.closeTags.push(tag);
    opener.n -= use;
    closer.n -= use;
    // Marked's emStrong pulls leftover stars of a longer closer run
    // INSIDE the emphasis when an earlier closer was skipped by the
    // rule of 3 (the `f` accumulator): `**return that *old*two***`
    // renders `<strong>...two*</strong>`, not `<strong>...</strong>*`.
    // Detect such a skip among the delimiters inside the span (a
    // same-char delimiter that can both open and close, whose length
    // with the opener sums to a multiple of 3 while the opener alone
    // does not); if one exists, the closer's leftover renders inside.
    if (closer.n > 0 && opener.orig % 3 !== 0) {
      let f = false;
      for (let ti = oti + 1; ti < cti; ti++) {
        const dt = toks[ti];
        if (!dt || dt.k !== 'd' || dt.ch !== opener.ch) continue;
        if (!dt.canOpen || !dt.canClose) continue;
        if ((opener.orig + dt.orig) % 3 === 0) { f = true; break; }
      }
      if (f) { closer.innerLit = (closer.innerLit || 0) + closer.n; closer.n = 0; }
    }
    // Delimiters strictly between opener and closer are inside the new
    // span: remove them from the stack.
    if (openerIdx + 1 < di) {
      delims.splice(openerIdx + 1, di - openerIdx - 1);
      di = openerIdx + 1;
    }
    if (opener.n === 0) {
      delims.splice(openerIdx, 1);
      di--;
    }
    if (closer.n === 0) {
      delims.splice(di, 1);
    }
    // Otherwise the closer still has length: keep di on it so it looks
    // for another opener on the next iteration.
  }

  // ---- Render ---------------------------------------------------------------
  let out = '';
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t];
    if (tok.dead) continue;
    switch (tok.k) {
      case 't': out += plain ? tok.v : escapeText(tok.v); break;
      case 'c': out += plain ? tok.v : '<code>' + escapeText(tok.v) + '</code>'; break;
      case 'd': {
        const left = tok.n;
        if (plain) {
          if (left > 0) out += tok.ch.repeat(left);
          if (tok.innerLit) out += tok.ch.repeat(tok.innerLit);
        } else {
          // Leftover delimiters pulled inside the span by marked's
          // rule-of-3 (`f`) accumulator render before the closing tag.
          if (tok.innerLit) out += tok.ch.repeat(tok.innerLit);
          for (let q = 0; q < tok.closeTags.length; q++) out += '</' + tok.closeTags[q] + '>';
          if (left > 0) out += tok.ch.repeat(left);
          for (let q = tok.openTags.length - 1; q >= 0; q--) out += '<' + tok.openTags[q] + '>';
        }
        break;
      }
      case 'a':
        if (!plain) {
          out += '<a href="' + escapeAttr(cleanHref(tok.href)) + '"' +
            (tok.title !== null && tok.title !== undefined ? ' title="' + escapeAttr(tok.title) + '"' : '') + '>';
        }
        break;
      case 'z': if (!plain) out += '</a>'; break;
      case 'i': out += plain ? tok.alt : tok.v; break;
      case 'u':
      case 'U':
        if (plain) out += tok.text;
        else out += '<a href="' + escapeAttr(cleanHref(tok.href)) + '">' + escapeText(tok.text) + '</a>';
        break;
      case 'e':
        out += (tok.verb || plain) ? tok.v : escapeText(tok.v);
        break;
      case 'g': if (!plain) out += tok.v; break;
      case 'h': if (!plain) out += tok.v; break;
      case 'b': out += plain ? ' ' : '<br>'; break;
    }
  }
  return out;
}

// ---- Block rendering -------------------------------------------------------

function renderBlocks(node, out, refs, tight) {
  switch (node.t) {
    case 'doc':
      for (const c of node.children) renderBlocks(c, out, refs, false);
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const c of node.children) renderBlocks(c, out, refs, false);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = node.bullet ? 'ul' : 'ol';
      let open = '<' + tag;
      if (!node.bullet && node.start !== 1) open += ' start="' + node.start + '"';
      out.push(open + '>\n');
      for (let ii = 0; ii < node.children.length; ii++) renderItem(node.children[ii], out, refs, !node.loose, ii === node.children.length - 1);
      out.push('</' + tag + '>\n');
      break;
    }
    case 'para':
      if (tight) {
        out.push(parseInline(node.lines.join('\n'), refs));
      } else {
        out.push('<p>' + parseInline(node.lines.join('\n'), refs) + '</p>\n');
      }
      break;
    case 'head':
      out.push('<h' + node.level + '>' + parseInline(node.text, refs) + '</h' + node.level + '>\n');
      break;
    case 'code': {
      let s = '<pre><code';
      if (node.fenced && node.info) {
        const lang = unescapeBackslashes(node.info.split(/[ \t]/, 1)[0]);
        if (lang !== '') s += ' class="language-' + escapeAttr(lang) + '"';
      }
      // A fence that never closes drops its trailing blank lines: they sit
      // outside the block. A closed fence keeps them (they are content).
      let ls = node.lines;
      if (node.fenced && !node.closed) {
        let end = ls.length;
        while (end > 0 && ls[end - 1].trim() === '') end--;
        ls = ls.slice(0, end);
      }
      // The last line contributes its newline, unless it is empty: then the
      // join already ends with one.
      s += '>' + escapeText(ls.join('\n') + (ls.length && ls[ls.length - 1] !== '' ? '\n' : '')) + '</code></pre>\n';
      out.push(s);
      break;
    }
    case 'html':
      out.push(node.lines.join('\n') + (node.trailingNL ? '\n' : ''));
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let c = 0; c < node.head.length; c++) {
        const a = node.aligns[c];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(node.head[c].trim(), refs) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          for (let c = 0; c < node.head.length; c++) {
            const a = node.aligns[c];
            const cell = c < row.length ? row[c].trim() : '';
            out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(cell, refs) + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody></table>\n');
      } else {
        out.push('</table>\n');
      }
      break;
    }
  }
}

function renderItem(item, out, refs, tight, isLast) {
  const task = item.task;
  const check = task === undefined ? '' :
    task === ' ' ? '<input disabled="" type="checkbox">' :
    '<input checked="" disabled="" type="checkbox">';
  // Marked strips trailing whitespace from the end of a list's content
  // — only the LAST item's last paragraph is trimmed; other items keep
  // their line-end spaces, and a paragraph keeps its trailing spaces.
  const paraSrc = (c, last) => {
    const s = c.lines.join('\n');
    return (last && isLast) ? s.replace(/[ \t]+$/, '') : s;
  };
  if (tight) {
    out.push('<li>');
    const kids = item.children;
    for (let ci = 0; ci < kids.length; ci++) {
      const c = kids[ci];
      if (c.t === 'para') {
        if (ci === 0 && check !== '') {
          out.push(check + ' ' + parseInline(paraSrc(c, ci === kids.length - 1), refs));
        } else {
          out.push(parseInline(paraSrc(c, ci === kids.length - 1), refs));
        }
      } else {
        if (ci === 0 && check !== '') out.push(check + ' ');
        renderBlocks(c, out, refs, false);
      }
    }
    out.push('</li>\n');
  } else {
    out.push('<li>');
    const kids = item.children;
    for (let ci = 0; ci < kids.length; ci++) {
      const c = kids[ci];
      if (c.t === 'para') {
        if (ci === 0 && check !== '') {
          out.push('<p>' + check + ' ' + parseInline(paraSrc(c, ci === kids.length - 1), refs) + '</p>\n');
        } else {
          out.push('<p>' + parseInline(paraSrc(c, ci === kids.length - 1), refs) + '</p>\n');
        }
      } else {
        if (ci === 0 && check !== '') out.push(check + ' ');
        renderBlocks(c, out, refs, false);
      }
    }
    out.push('</li>\n');
  }
}

// Mark trailing newlines on html blocks. A block keeps one only when it
// is followed by a sibling in the same parent, or when it is the last
// block of the document and the source ends with a single newline. A
// block that ends its parent (nested in a quote, list or item) gets none:
// its container's closing tag follows immediately (gfm-657). A block
// ended by a blank line gets none either.
function markHtmlTrailing(node, endsWithNL) {
  const kids = node.children;
  const isTopLevel = node.t === 'doc';
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    const isLastChild = i === kids.length - 1;
    if (c.t === 'html') {
      c.trailingNL = !c.endedAtBlank && (!isLastChild || (isTopLevel && endsWithNL));
    }
    markHtmlTrailing(c, endsWithNL);
  }
}

export function parse(markdown) {
  inLinkState = false;
  const { doc, refs, endsWithNL } = parseBlocks(markdown);
  markHtmlTrailing(doc, endsWithNL);
  const out = [];
  renderBlocks(doc, out, refs, false);
  return out.join('');
}
