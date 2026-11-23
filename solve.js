// solve.js -- a fast, dependency-free drop-in replacement for makefun-site 1.0.0.
//
// run(input) takes one case's input, { site, templates, files }, and returns the
// output tree makefun-site's build returns for it: an object mapping each output
// path to its text, byte for byte. The dialect (front matter, Markdown subset,
// template language, slug rule, build report) is makefun-site's own; this module
// re-implements it as a set of single-pass scanners that share work across the
// build (one slug cache, templates compiled once, no per-file pipelines).
//
// No imports, no I/O, no clock: the answer is a function of the input alone.

// ---------------------------------------------------------------------------
// Small shared helpers

/** Code-unit order, the only ordering the build uses. */
const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The directory part of a "/"-separated path, or "" at the root. */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c) => c >= 48 && c <= 57;

// ---------------------------------------------------------------------------
// Text: HTML escaping, slugs, long dates

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' replaced by their HTML entities, nothing else. */
function escapeHtml(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
    i++;
  }
  if (i === n) return text;
  let out = text.slice(0, i) + ESCAPES[text[i]];
  let seg = i + 1;
  for (i = seg; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      out += text.slice(seg, i) + ESCAPES[text[i]];
      seg = i + 1;
    }
  }
  if (seg < n) out += text.slice(seg);
  return out;
}

const MARKS = /\p{M}/gu;
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD-normalised, combining marks dropped, A-Z lowered,
 * every run of characters outside a-z and 0-9 collapsed to one "-", no "-" at
 * either end, cut to 64 characters (a "-" left at the cut dropped), and
 * "untitled" when nothing is left.
 */
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = null;
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = plain[i];
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
    if (out.length >= SLUG_MAX) break; // the first 64 characters are already fixed
  }
  out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against the `taken` set (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" -> "9 November 2026". */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Front matter: a source opens on a line "---" and its front matter runs to
// the next line "---". Every line between is blank, a "#" comment, or
// "key: value" with one space after the colon and a known key. The first
// failing line refuses the source, with the reason the dialect names.

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** True when `line` holds only spaces and tabs (or nothing). */
function isBlankST(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with trailing spaces and tabs dropped. */
function rtrimST(line) {
  let end = line.length;
  while (end > 0) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return end === line.length ? line : line.slice(0, end);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value from its raw text, or { error } with the refusal reason. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || isDigit(c) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      // a-z and 0-9 segments joined by single "-", at most 64 characters
      if (raw.length > 64 || raw === '') return { error: 'key "slug": not a slug' };
      let seg = 0; // characters in the current segment
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (seg === 0) return { error: 'key "slug": not a slug' };
          seg = 0;
        } else if ((c >= 97 && c <= 122) || isDigit(c)) seg++;
        else return { error: 'key "slug": not a slug' };
      }
      return seg === 0 ? { error: 'key "slug": not a slug' } : { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The closing "---" is
 * located before any line is judged, as the dialect reads it.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // First pass: the line index of the closing "---", and where the body starts.
  let close = -1;
  let bodyStart = -1;
  let pos = firstNl + 1;
  let idx = 1;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    if (text.slice(pos, end) === '---') {
      close = idx;
      bodyStart = end + 1;
      break;
    }
    if (end === text.length) break;
    pos = end + 1;
    idx++;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  // Second pass: the lines between, in order.
  const data = {};
  pos = firstNl + 1;
  for (let i = 1; i < close; i++) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    const line = text.slice(pos, end);
    pos = end + 1;
    if (isBlankST(line) || line.charCodeAt(0) === 35) continue;
    // "key: value": a key of a-z and "_", a colon, then a space or the line's end.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line[k] !== ':') return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line[k + 1] === ' ') raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    raw = rtrimST(raw);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------------------
// Markdown: the body read line by line. Blocks are fences, headings, thematic
// breaks, blockquotes, flat lists and paragraphs; each block is written in
// order and followed by "\n". Inline marks are code spans, strong, emphasis,
// links and backslash escapes; raw HTML is text.

/** A paragraph line as rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence's language when `line` opens one ("" for none), or null. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let lang = '';
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (isAlpha(c) || isDigit(c) || c === 95 || c === 43 || c === 45) lang += line[i];
    else if (c === 32 || c === 9) {
      // only spaces and tabs may follow the language
      for (let j = i + 1; j < line.length; j++) {
        const d = line.charCodeAt(j);
        if (d !== 32 && d !== 9) return null;
      }
      return lang;
    } else return null;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null (the text is never empty). */
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line[depth] === '#') depth++;
  if (depth === 0 || depth > 6 || depth >= line.length) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let i = depth;
  while (i < line.length) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) break;
    i++;
  }
  const text = rtrimST(line.slice(i));
  return text === '' ? null : { depth, text };
}

/** Whether `line` is a thematic break: "---" or "***", then spaces or tabs. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text when `line` opens one ("- " or "* "), or null. */
function bulletOf(line) {
  return (line[0] === '-' || line[0] === '*') && line[1] === ' ' ? line.slice(2) : null;
}

/** An ordered item's { num, text } when `line` opens one ("<digits>. "), or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && isDigit(line.charCodeAt(i))) i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

const WS_CHAR = /\s/;

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i >= 2 && i < line.length && !WS_CHAR.test(line[i]);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankST(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// The characters a backslash escapes, by char code.
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one not part of a ** run), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` resolves a link's href. Plain runs are
 * escaped in bulk; only the mark characters are visited one by one.
 */
function renderInline(s, link) {
  let out = '';
  let runStart = 0;
  let i = 0;
  const n = s.length;
  const flush = (end) => {
    if (end > runStart) out += escapeHtml(s.slice(runStart, end));
  };
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        flush(i);
        out += escapeHtml(s[i + 1]);
        i += 2;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out += `<strong>${renderInline(s.slice(i + 2, j), link)}</strong>`;
          i = j + 2;
          runStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<em>${renderInline(s.slice(i + 1, j), link)}</em>`;
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_CHAR.test(target)) {
        flush(i);
        out += `<a href="${escapeHtml(link(target))}">${renderInline(s.slice(i + 1, k), link)}</a>`;
        i = m + 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(n);
  return out;
}

/**
 * `src` rendered: { html, toc, excerpt } -- the HTML (a "\n" after every
 * block), the level 2 and 3 headings (level, id, inline HTML) and the first
 * paragraph's inline HTML (or ""). `slugOf` is the build's cached slugify.
 */
function renderMarkdown(src, link, slugOf) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankST(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      let inner = '';
      while (i < n && !isFenceClose(lines[i])) {
        inner += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      html += lang === '' ? `<pre><code>${inner}</code></pre>\n` : `<pre><code class="language-${escapeHtml(lang)}">${inner}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugOf(heading.text), ids);
      const inner = renderInline(heading.text, link);
      html += `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: inner });
      i++;
      continue;
    }
    if (isHr(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let q = lines[i].slice(1);
        if (q.charCodeAt(0) === 32) q = q.slice(1);
        const t = trimLine(q);
        if (t !== '') kept.push(t);
        i++;
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${renderInline(kept.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const items = [];
      if (ordered === null) {
        while (i < n) {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        html += '<ul>\n';
        for (const parts of items) html += `<li>${renderInline(parts.join('\n'), link)}</li>\n`;
        html += '</ul>\n';
      } else {
        while (i < n) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        html += ordered.num !== 1 ? `<ol start="${ordered.num}">\n` : '<ol>\n';
        for (const parts of items) html += `<li>${renderInline(parts.join('\n'), link)}</li>\n`;
        html += '</ol>\n';
      }
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const inner = renderInline(body.join('\n'), link);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------------------
// Templates: {{ path }} escaped, {{{ path }}} raw, {% for %}, {% if %} /
// {% if not %} with an optional {% else %}, and {% include "name" %} at most
// 8 deep. A {% %} tag alone on its line takes the whole line with it. A
// template that does not parse is reported and left out of the build.

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: the report names it and why. */
class TemplateError extends Error {}

const isNameStart = (c) => isAlpha(c) || c === 95;
const isNameChar = (c) => isAlpha(c) || isDigit(c) || c === 95;

/** Whether `text` is a path: names of [A-Za-z0-9_] from a letter or "_", dot-joined. */
function isPath(text) {
  if (text === '') return false;
  let segStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (segStart) {
      if (!isNameStart(c)) return false;
      segStart = false;
    } else if (c === 46) segStart = true;
    else if (!isNameChar(c)) return false;
  }
  return !segStart;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!isPath(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** A "for <name> in <path>" tag's [name, pathText], or null. */
function matchFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isNameStart(tag.charCodeAt(i))) return null;
  i++;
  while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
  const name = tag.slice(4, i);
  if (!tag.startsWith(' in ', i)) return null;
  const rest = tag.slice(i + 4);
  return rest === '' || WS_CHAR.test(rest) ? null : [name, rest];
}

/** An "if [not] <path>" tag's [not, pathText], or null. */
function matchIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  return rest === '' || WS_CHAR.test(rest) ? null : [not, rest];
}

/** An 'include "<name>"' tag's name ([a-z0-9-]), or null. */
function matchInclude(tag) {
  if (!tag.startsWith('include "') || tag.charCodeAt(tag.length - 1) !== 34) return null;
  const name = tag.slice(9, -1);
  if (name === '') return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || isDigit(c) || c === 45)) return null;
  }
  return name;
}

/** Whether src[a..b) holds only spaces and tabs. */
function isAllST(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  let text = '';
  let i = 0;
  const n = src.length;
  const flushText = () => {
    if (text !== '') {
      body.push({ kind: 'text', text });
      text = '';
    }
  };
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      flushText();
      body.push({ kind: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isAllST(src, lineStart, open) && isAllST(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    flushText();
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = matchFor(tag)) !== null) {
      const node = { kind: 'for', name: m[0], path: pathOf(name, m[1]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = matchIf(tag)) !== null) {
      const node = { kind: 'if', not: m[0], path: pathOf(name, m[1]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = matchInclude(tag)) !== null) {
      body.push({ kind: 'include', name: m });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  flushText();
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }); `templates` maps names to parsed nodes. */
function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'text':
        out += nd.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, nd.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, nd.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) out += renderNodes(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, nd.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [nd.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          out += renderNodes(nd.body, { vars, parent: scope }, templates, depth);
        }
        break;
      }
      case 'include': {
        const t = templates.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The build, in order: sources sorted and split, templates parsed, front
// matter judged, permalinks made unique, Markdown rendered with its links
// resolved, posts collected, tags grouped, every page laid out, static files
// placed, and the report written.

/** The top-level directories the generator writes itself, reserved at the root. */
const RESERVED = ['posts', 'tags', 'page'];

/** Whether `target` opens with a URI scheme (https:, mailto:, ...). */
function hasScheme(target) {
  if (!isAlpha(target.charCodeAt(0))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!isAlpha(c) && !isDigit(c) && c !== 43 && c !== 45 && c !== 46) return false;
  }
  return false;
}

/** `rel` resolved from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The count of a text's words: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCU)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Slugs repeat across a site (titles, tags, headings): cache them per build.
  const slugCache = new Map();
  const slugOf = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

  // 1. The sources, in code-unit order of their paths; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCU(x.path, y.path));
  const rawSources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) rawSources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Front matter: refusals, the generator's own directories, dateless
  // posts, unknown layouts and drafts are reported and dropped, in that order.
  const sources = [];
  for (const s of rawSources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    sources.push(s);
  }

  // 3. Permalinks: a post's directory is "posts", a page's is its source's;
  // the slug (its key, or its title's) made unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, its links resolved against the built pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest date first, equal dates by slug; newer and older set.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: each post's, each slug once, named as first met in the
  // posts' order, grouped, then ordered by count and slug. A page's tags link
  // to the posts' tag of the same slug, or to nothing where none has it.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugOf(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugOf(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));

  // The records templates read.
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts: every page through its own, the index pages (site.per_page
  // posts each, at least one page), each tag page and the tags index; a page
  // whose template is missing is not written. Then the static files, unless
  // a built page has their path.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0);
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every reported line, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCU);
  const pageCount = sources.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
