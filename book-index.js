/**
 * Load an EPUB (ZIP) into searchable text chunks with section labels from nav.
 * No network; loaded from BOOK_EPUB_PATH, data/latest_book.epub, or a URL-fetched copy (see sql-learn-server.js).
 */

const path = require('path');
const AdmZip = require('adm-zip');

const posixDir = (p) => {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '' : s.slice(0, i);
};

const posixJoin = (a, b) => {
  if (!a) return b;
  return a.replace(/\/+$/, '') + '/' + String(b).replace(/^\/+/, '');
};

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ');
}

function stripXhtmlToText(xml) {
  let s = String(xml || '')
    .replace(/<\?xml[^?]*\?>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeXmlEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

function parseManifestItems(opfXml) {
  const byId = {};
  const re = /<item\b([^>]*)\/?>/gi;
  let m;
  while ((m = re.exec(opfXml))) {
    const tag = m[1];
    const idM = tag.match(/\bid="([^"]+)"/i);
    const hrefM = tag.match(/\bhref="([^"]+)"/i);
    if (idM && hrefM) byId[idM[1]] = hrefM[1];
  }
  return byId;
}

function parseSpineIdrefs(opfXml) {
  const ids = [];
  const re = /<itemref\b[^>]*\bidref="([^"]+)"/gi;
  let m;
  while ((m = re.exec(opfXml))) ids.push(m[1]);
  return ids;
}

function findNavHref(opfXml) {
  const re = /<item\b([^>]*)\/?>/gi;
  let m;
  while ((m = re.exec(opfXml))) {
    const tag = m[1];
    if (!/\bproperties="/i.test(tag)) continue;
    if (!/\bnav\b/i.test(tag)) continue;
    const hrefM = tag.match(/\bhref="([^"]+)"/i);
    if (hrefM) return hrefM[1];
  }
  return null;
}

function opfMetadata(opfXml) {
  const title = (opfXml.match(/<dc:title[^>]*>([^<]*)</i) || [, ''])[1].trim();
  const creator = (opfXml.match(/<dc:creator[^>]*>([^<]*)</i) || [, ''])[1].trim();
  return { title: decodeXmlEntities(title), creator: decodeXmlEntities(creator) };
}

function parseNavToc(navXml) {
  const entries = [];
  const navBlock = navXml.match(/<nav[^>]*epub:type="toc"[^>]*>[\s\S]*?<\/nav>/i);
  const block = navBlock ? navBlock[0] : navXml;
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(block))) {
    const href = m[1].trim();
    const title = stripXhtmlToText(m[2]);
    if (href && title) entries.push({ href, title });
  }
  return entries;
}

function hrefToZipPath(href, opfDir) {
  const clean = String(href || '').split('#')[0].trim();
  if (!clean) return null;
  const joined = opfDir ? posixJoin(opfDir, clean) : clean.replace(/^\//, '');
  return joined.replace(/\\/g, '/');
}

function chunkText(text, maxLen, overlap) {
  const chunks = [];
  const t = String(text || '').trim();
  if (!t) return chunks;
  const step = Math.max(400, maxLen - overlap);
  let start = 0;
  let id = 0;
  while (start < t.length) {
    let end = Math.min(start + maxLen, t.length);
    if (end < t.length) {
      const slice = t.slice(start, end);
      const dot = slice.lastIndexOf('. ');
      const nl = slice.lastIndexOf('\n');
      const br = Math.max(dot, nl);
      if (br > maxLen * 0.45) end = start + br + 1;
    }
    const piece = t.slice(start, end).trim();
    if (piece.length > 40) chunks.push({ id: id++, text: piece });
    if (end >= t.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

// Note: do not stopword "sql" — questions like "What is SQL?" must retrieve book chunks about SQL.
const STOP = new Set(
  'a an the and or for to of in on at by is are was were be been being it as if with from this that these those select where join left right inner outer on group by order having limit fetch first rows only null not'.split(
    ' ',
  ),
);

function tokenizeForSearch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function scoreChunk(queryTokens, chunk) {
  if (!queryTokens.length) return 0;
  const hay = chunk.searchBlob || `${chunk.section || ''} ${chunk.text}`.toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    if (!tok) continue;
    let idx = 0;
    while ((idx = hay.indexOf(tok, idx)) !== -1) {
      score += 1;
      idx += tok.length;
    }
  }
  const sec = (chunk.section || '').toLowerCase();
  for (const tok of queryTokens) {
    if (tok.length > 2 && sec.includes(tok)) score += 2;
  }
  return score;
}

/**
 * @param {string} epubPath absolute path to .epub
 * @returns {{ ok: boolean, error?: string, meta?: object, chunks?: object[] }}
 */
function loadBookFromEpub(epubPath) {
  let zip;
  try {
    zip = new AdmZip(epubPath);
  } catch (e) {
    return { ok: false, error: `Cannot open EPUB: ${e.message}` };
  }

  let container;
  try {
    container = zip.readAsText('META-INF/container.xml', 'utf8');
  } catch (_) {
    return { ok: false, error: 'Missing META-INF/container.xml' };
  }
  const rootM = container.match(/full-path="([^"]+)"/);
  if (!rootM) return { ok: false, error: 'No OPF path in container.xml' };
  const opfPath = rootM[1].replace(/\\/g, '/');
  let opfXml;
  try {
    opfXml = zip.readAsText(opfPath, 'utf8');
  } catch (_) {
    return { ok: false, error: `Cannot read OPF: ${opfPath}` };
  }

  const meta = opfMetadata(opfXml);
  const manifest = parseManifestItems(opfXml);
  const spineIds = parseSpineIdrefs(opfXml);
  const opfDir = posixDir(opfPath);

  const spineHrefs = spineIds.map((id) => {
    const href = manifest[id];
    return href ? href.replace(/\\/g, '/') : null;
  }).filter(Boolean);

  const spineZipPaths = spineHrefs.map((h) => posixJoin(opfDir, h));

  let navHref = findNavHref(opfXml);
  if (!navHref) navHref = 'nav.xhtml';
  let navEntries = [];
  try {
    const navPath = posixJoin(opfDir, navHref);
    const navXml = zip.readAsText(navPath, 'utf8');
    navEntries = parseNavToc(navXml);
  } catch (_) {
    /* optional */
  }

  const navStarts = [];
  for (const e of navEntries) {
    const rel = e.href.split('#')[0].trim();
    const zipPath = hrefToZipPath(rel, opfDir);
    const spineIdx = spineZipPaths.findIndex((zp) => zp === zipPath || zp.endsWith('/' + rel));
    if (spineIdx >= 0) navStarts.push({ spineIdx, title: e.title });
  }
  navStarts.sort((a, b) => a.spineIdx - b.spineIdx);

  function sectionForSpineIndex(i) {
    let title = 'Body';
    for (const ns of navStarts) {
      if (ns.spineIdx <= i) title = ns.title;
    }
    return title;
  }

  const chunks = [];
  let globalId = 0;

  for (let i = 0; i < spineZipPaths.length; i++) {
    const zp = spineZipPaths[i];
    if (!zp.endsWith('.xhtml') && !zp.endsWith('.html') && !zp.endsWith('.htm')) continue;
    let raw;
    try {
      raw = zip.readAsText(zp, 'utf8');
    } catch (_) {
      continue;
    }
    const text = stripXhtmlToText(raw);
    if (!text || text.length < 30) continue;
    const section = sectionForSpineIndex(i);
    const fileLabel = path.posix.basename(zp);
    const parts = chunkText(text, 3200, 280);
    for (const p of parts) {
      const searchBlob = `${section} ${fileLabel} ${p.text}`.toLowerCase();
      chunks.push({
        id: globalId++,
        bookTitle: meta.title,
        bookAuthor: meta.creator,
        section,
        file: fileLabel,
        spineIndex: i,
        text: p.text,
        searchBlob,
      });
    }
  }

  if (!chunks.length) return { ok: false, error: 'No text chunks extracted from EPUB' };

  return {
    ok: true,
    meta: {
      title: meta.title,
      author: meta.creator,
      epubPath,
      chunkCount: chunks.length,
      spineDocuments: spineZipPaths.length,
    },
    chunks,
  };
}

/**
 * Jaccard similarity on significant tokens from the start of two texts (catches repeated “SQL Universe” intro chunks).
 */
function jaccardTokenSimilarity(textA, textB, maxChars = 400) {
  const sig = (s) => {
    const t = new Set(tokenizeForSearch(String(s || '').slice(0, maxChars)));
    for (const w of [...t]) {
      if (w.length < 3) t.delete(w);
    }
    return t;
  };
  const a = sig(textA);
  const b = sig(textB);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function excerptsTooSimilar(textA, textB, threshold) {
  return jaccardTokenSimilarity(textA, textB, 450) >= threshold;
}

/** Trim to maxLen, preferably at a sentence boundary. */
function makeExcerpt(text, maxLen = 700) {
  const t = String(text || '').trim();
  if (!t || t.length <= maxLen) return t;
  let cut = t.slice(0, maxLen);
  const dot = cut.lastIndexOf('. ');
  if (dot > maxLen * 0.5) cut = cut.slice(0, dot + 1);
  return cut.trim() + '…';
}

/**
 * Start excerpt near the first match of a significant query token so UI snippets skip shared chapter headers.
 */
function excerptAnchoredOnQuery(fullText, query, excerptMax) {
  const t = String(fullText || '').trim();
  if (!t) return '';
  const tokens = tokenizeForSearch(query).filter((w) => w.length > 3);
  const lower = t.toLowerCase();
  let best = -1;
  for (const tok of tokens) {
    const i = lower.indexOf(tok);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  let start = 0;
  if (best > 100) {
    let s = lower.lastIndexOf('. ', best - 1);
    if (s < 0) s = lower.lastIndexOf('\n', best - 1);
    if (s < 0) s = lower.lastIndexOf(' ', best - 1);
    start = s >= 0 ? Math.min(s + (lower[s] === '.' ? 2 : 1), best) : Math.max(0, best - 60);
  }
  return makeExcerpt(t.slice(start), excerptMax);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.diverse] — skip chunks too similar to already-picked ones (better for UI snippets)
 * @param {number} [options.excerptMax] — max excerpt length (default 700)
 * @param {number} [options.diversityThreshold] — Jaccard threshold 0–1 (default 0.3)
 * @param {number} [options.poolCap] — max ranked candidates to scan when diverse (default 120)
 * @param {boolean} [options.excerptAnchorQuery] — align brief excerpt to first query-token hit in chunk
 */
function searchChunks(chunks, query, limit = 12, options = {}) {
  const q = String(query || '').trim();
  if (!q || !chunks || !chunks.length) return [];
  const tokens = tokenizeForSearch(q);
  const lim = Math.min(Math.max(1, Number(limit) || 12), 50);
  const excerptMax = Number(options.excerptMax) > 0 ? Number(options.excerptMax) : 700;
  const diverse = !!options.diverse;
  const simThreshold =
    typeof options.diversityThreshold === 'number' ? options.diversityThreshold : 0.3;
  const poolCap = Math.min(
    200,
    Math.max(lim * 20, Number(options.poolCap) || 120),
  );

  const scored = chunks
    .map((c) => ({ c, s: scoreChunk(tokens.length ? tokens : [q.toLowerCase()], c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  let chosen;
  if (diverse) {
    const pool = scored.slice(0, poolCap);
    chosen = [];
    for (const x of pool) {
      if (chosen.length >= lim) break;
      const txt = x.c.text || '';
      let skip = false;
      for (const y of chosen) {
        if (excerptsTooSimilar(txt, y.c.text || '', simThreshold)) {
          skip = true;
          break;
        }
      }
      if (!skip) chosen.push(x);
    }
  } else {
    chosen = scored.slice(0, lim);
  }

  const anchor = !!options.excerptAnchorQuery && String(query || '').trim().length > 0;
  return chosen.map((x) => ({
    id: x.c.id,
    section: x.c.section,
    file: x.c.file,
    score: x.s,
    excerpt: anchor
      ? excerptAnchoredOnQuery(x.c.text, query, excerptMax)
      : makeExcerpt(x.c.text, excerptMax),
  }));
}

function selectChunksForContext(chunks, sql, question, limit = 5) {
  const raw = `${sql || ''} ${question || ''}`;
  const tokens = tokenizeForSearch(raw);
  if (!tokens.length) return [];
  const scored = chunks
    .map((c) => ({ c, s: scoreChunk(tokens, c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const n = Math.min(Number(limit) || 5, 12);
  return scored.slice(0, n).map((x) => x.c);
}

function formatContextForPrompt(selected) {
  if (!selected.length) return '';
  const blocks = selected.map((c, i) => {
    const head = `[${i + 1}] Section: ${c.section} (${c.file})`;
    return `${head}\n${c.text.slice(0, 4500)}`;
  });
  return (
    'The following excerpts are from the canonical course book for this app. ' +
    'Prefer aligning your explanation with these ideas when relevant; do not invent book content beyond them.\n\n' +
    blocks.join('\n\n---\n\n')
  );
}

module.exports = {
  loadBookFromEpub,
  searchChunks,
  jaccardTokenSimilarity,
  makeExcerpt,
  excerptAnchoredOnQuery,
  selectChunksForContext,
  formatContextForPrompt,
  tokenizeForSearch,
};
