#!/usr/bin/env node

/** Product name in API responses and logs (override: APP_DISPLAY_NAME). */
const APP_DISPLAY_NAME = process.env.APP_DISPLAY_NAME || 'Easy NL2SQL';

function normalizeSqlGenerationMode(raw) {
  const m = String(raw == null ? 'hybrid' : raw).trim().toLowerCase();
  if (m === 'lookup' || m === 'llm' || m === 'hybrid') return m;
  console.warn(`[${APP_DISPLAY_NAME}] Invalid SQL_GENERATION_MODE "${raw}", using hybrid`);
  return 'hybrid';
}


/**
 * Easy NL2SQL — interactive Oracle SQL learning HTTP server (Node.js).
 * Book-grounded explain, natural-language → SQL (lookup / LLM / hybrid), optional Oracle execution via oracledb.
 *
 * SQL generation modes (SQL_GENERATION_MODE=lookup|llm|hybrid, default hybrid):
 *   lookup  – rules from experiments/sql-practice-rules.json
 *   llm     – OpenAI-compatible API
 *   hybrid  – lookup first, LLM fallback
 */

// Load .env (and optional .env.local) into process.env — no external dependency
const path = require('path');
const fs = require('fs');

function loadDotEnvFile(absPath) {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      // Allow spaces around = and optional "export " (common in hand-edited .env files)
      let m = t.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        const hash = val.search(/\s+#/);
        if (hash > 0) val = val.slice(0, hash).trim();
      }
      process.env[m[1]] = val;
    }
  } catch (_) { /* missing file is OK */ }
}

loadDotEnvFile(path.join(__dirname, '.env'));
loadDotEnvFile(path.join(__dirname, '.env.local')); // optional overrides (gitignored)

const http = require('http');
const os = require('os');
const {
  loadBookFromEpub,
  searchChunks,
  selectChunksForContext,
  formatContextForPrompt,
} = require('./book-index');
let oracledb;
try { oracledb = require('oracledb'); } catch (_) { oracledb = null; }

// ── Wallet bootstrap ─────────────────────────────────────────────────────────
// On Render (or any cloud env) the wallet can't be a local path.
// Set ORACLE_WALLET_ZIP_B64 to the base64-encoded contents of your wallet zip
// (e.g. `base64 -i Wallet_prishivdb.zip | tr -d '\n'`).
// The server will extract it to a temp dir and set TNS_ADMIN automatically.
function extractWalletFromEnv() {
  const b64 = process.env.ORACLE_WALLET_ZIP_B64;
  if (!b64) return null;
  try {
    const tmpDir = path.join(os.tmpdir(), 'oracle_wallet_' + process.pid);
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, 'wallet.zip');
    fs.writeFileSync(zipPath, Buffer.from(b64, 'base64'));
    // Use unzip (available on Linux/macOS/Render)
    require('child_process').execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`);
    fs.unlinkSync(zipPath);
    console.log(`[${APP_DISPLAY_NAME}] Wallet extracted to:`, tmpDir);
    return tmpDir;
  } catch (err) {
    console.warn(`[${APP_DISPLAY_NAME}] Failed to extract wallet from ORACLE_WALLET_ZIP_B64:`, err.message);
    return null;
  }
}

// OCI Autonomous DB wallets ship sqlnet.ora with DIRECTORY="?/network/admin". The "?" does not
// resolve reliably for JDBC/thin on Linux (e.g. Render), which can drop the TLS session as
// ORA-17902 (end of TNS data channel). Rewrite to the real wallet directory when "?" is present.
function ensureSqlnetWalletDirectory(walletDir) {
  if (!walletDir) return;
  const sqlnetPath = path.join(walletDir, 'sqlnet.ora');
  if (!fs.existsSync(sqlnetPath)) return;
  try {
    const s = fs.readFileSync(sqlnetPath, 'utf8');
    if (!s.includes('?')) return;
    const norm = path.resolve(walletDir).replace(/\\/g, '/');
    const next = s.replace(
      /DIRECTORY\s*=\s*"[^"]*\?[^"]*"/gi,
      `DIRECTORY="${norm}"`,
    );
    if (next !== s) {
      fs.writeFileSync(sqlnetPath, next, 'utf8');
      console.log(`[${APP_DISPLAY_NAME}] Patched sqlnet.ora WALLET DIRECTORY ->`, norm);
    }
  } catch (err) {
    console.warn(`[${APP_DISPLAY_NAME}] Could not patch sqlnet.ora:`, err.message);
  }
}

const rawWalletPath = extractWalletFromEnv()
  || process.env.ORACLE_WALLET_PATH
  || process.env.TNS_ADMIN
  || null;
const walletPath = rawWalletPath ? path.resolve(rawWalletPath) : null;
if (walletPath) process.env.TNS_ADMIN = walletPath; // Oracle native layer looks for tnsnames.ora here
ensureSqlnetWalletDirectory(walletPath);

const config = {
  httpPort: Number(process.env.PORT || process.env.HTTP_PORT || 3000),
  dbHost: process.env.DB_HOST || null,
  dbPort: process.env.DB_PORT || null,
  dbSid: process.env.DB_SID || null,
  dbUser: process.env.DB_USER || null,
  dbPassword: process.env.DB_PASSWORD || null,
  dbDsn: process.env.DB_DSN || null, // e.g. "prishivdb1_high"
  dbWalletPath: walletPath, // directory containing tnsnames.ora + wallet files (auto-set from ORACLE_WALLET_ZIP_B64)
  enableLLMSqlGeneration: process.env.ENABLE_LLM_SQL_GEN === 'true',
  enableExecuteSql: process.env.EXECUTE_SQL_ENABLED === 'true',
  llmApiUrl: process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 15000),
  sqlGenerationMode: normalizeSqlGenerationMode(process.env.SQL_GENERATION_MODE),
  /** When a book EPUB is loaded, pass retrieved excerpts into Explain SQL (disable: BOOK_CONTEXT_IN_EXPLAIN=false). */
  bookContextInExplain: process.env.BOOK_CONTEXT_IN_EXPLAIN !== 'false',
  /** When book is loaded, search it before /generate-sql LLM; cite chapter when on-topic (disable: BOOK_CONTEXT_IN_GENERATE=false). */
  bookContextInGenerate: process.env.BOOK_CONTEXT_IN_GENERATE !== 'false',
};

let bookIndex = { loaded: false, chunks: [], meta: null, error: null };

const MAX_BOOK_EPUB_FETCH_BYTES = 50 * 1024 * 1024;

function resolveBookEpubPath() {
  const env = (process.env.BOOK_EPUB_PATH || '').trim();
  if (env) return path.resolve(env);
  for (const name of ['latest_book.epub', '.fetched_book.epub']) {
    const local = path.join(__dirname, 'data', name);
    if (fs.existsSync(local)) return local;
  }
  return null;
}

/** If no file on disk yet, download BOOK_EPUB_URL → data/.fetched_book.epub (then loadBookIndex picks it up). */
async function ensureBookEpubFromUrl() {
  if (resolveBookEpubPath()) return;
  const url = (process.env.BOOK_EPUB_URL || '').trim();
  if (!url) return;
  const dest = path.join(__dirname, 'data', '.fetched_book.epub');
  console.log(`[${APP_DISPLAY_NAME}] Book: fetching EPUB from BOOK_EPUB_URL…`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': `${APP_DISPLAY_NAME}/1` } });
  if (!res.ok) {
    throw new Error(`BOOK_EPUB_URL HTTP ${res.status}`);
  }
  const cl = res.headers.get('content-length');
  if (cl && Number(cl) > MAX_BOOK_EPUB_FETCH_BYTES) {
    throw new Error('BOOK_EPUB_URL Content-Length too large');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BOOK_EPUB_FETCH_BYTES) {
    throw new Error('BOOK_EPUB_URL response body too large');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`[${APP_DISPLAY_NAME}] Book: saved fetched EPUB (${buf.length} bytes)`);
}

function loadBookIndex() {
  const p = resolveBookEpubPath();
  if (!p) {
    bookIndex = { loaded: false, chunks: [], meta: null, error: null };
    console.log(
      `[${APP_DISPLAY_NAME}] Book EPUB: not configured (BOOK_EPUB_PATH, BOOK_EPUB_URL, or data/latest_book.epub)`,
    );
    return;
  }
  const r = loadBookFromEpub(p);
  if (r.ok) {
    bookIndex = { loaded: true, chunks: r.chunks, meta: r.meta, error: null };
    console.log(`[${APP_DISPLAY_NAME}] Book: "${r.meta.title}" — ${r.meta.chunkCount} chunks ← ${p}`);
  } else {
    bookIndex = { loaded: false, chunks: [], meta: null, error: r.error };
    console.warn(`[${APP_DISPLAY_NAME}] Book EPUB failed: ${r.error}`);
  }
}

/** Server default from SQL_GENERATION_MODE; body may still pass mode for API overrides (e.g. batch eval, SQL fix). */
function resolveSqlModeFromRequest(bodyMode) {
  const raw = typeof bodyMode === 'string' ? bodyMode.trim().toLowerCase() : '';
  if (raw === 'lookup' || raw === 'llm' || raw === 'hybrid') return raw;
  return config.sqlGenerationMode;
}

// ── SQL Rule Store ────────────────────────────────────────────────────────────

let SQL_GENERATION_RULES = {};
const testQuestionsPath = path.join(__dirname, 'experiments', 'sql-practice-rules.json');
let rulesLastMtimeMs = 0;

function loadSQLRules() {
  try {
    const stats = fs.statSync(testQuestionsPath);
    const content = fs.readFileSync(testQuestionsPath, 'utf8');
    const data = JSON.parse(content);
    const tests = data.test_questions || data.sql_practice_rules || data;

    SQL_GENERATION_RULES = {};
    tests.forEach(test => {
      SQL_GENERATION_RULES[test.question] = test.expected_sql;
    });

    rulesLastMtimeMs = stats.mtimeMs;
    console.log(`[${APP_DISPLAY_NAME}] Loaded ${Object.keys(SQL_GENERATION_RULES).length} SQL generation rules`);
    return true;
  } catch (error) {
    console.warn(`[${APP_DISPLAY_NAME}] Could not load sql-practice-rules.json:`, error.message);
    loadBasicRules();
    return false;
  }
}

function maybeReloadSQLRules() {
  try {
    const stats = fs.statSync(testQuestionsPath);
    if (stats.mtimeMs > rulesLastMtimeMs) {
      console.log(`[${APP_DISPLAY_NAME}] Detected sql-practice-rules.json update, reloading rules...`);
      loadSQLRules();
    }
  } catch (error) {
    console.warn(`[${APP_DISPLAY_NAME}] Could not check rules file mtime:`, error.message);
  }
}

function loadBasicRules() {
  SQL_GENERATION_RULES = {
    "How many regions are in the database?": "SELECT COUNT(*) FROM REGION",
    "How many nations are there?": "SELECT COUNT(*) FROM NATION",
    "Count the total number of suppliers": "SELECT COUNT(*) FROM SUPPLIER",
  };
}

// ── SQL Generation ────────────────────────────────────────────────────────────

function lookupSql(question) {
  const q = String(question || '').trim().toLowerCase();
  for (const [pattern, sql] of Object.entries(SQL_GENERATION_RULES)) {
    if (pattern.toLowerCase() === q) {
      return { sql, source: 'lookup_exact' };
    }
  }
  return { sql: null, source: 'lookup_none' };
}

function extractSqlFromResponse(content) {
  if (!content || typeof content !== 'string') return null;

  const fenced = content.match(/```sql\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : content).trim();
  const noSemicolon = candidate.replace(/;+\s*$/, '').trim();
  const upper = noSemicolon.toUpperCase();

  if (upper.startsWith('SELECT') || upper.startsWith('WITH')) {
    return noSemicolon;
  }
  return null;
}

/** Pull runnable TPC-H SQL (if any) and remaining prose for interview / teaching answers. */
function splitSqlAndTutorFromLlmContent(content) {
  const raw = String(content || '').trim();
  if (!raw) return { sql: null, tutor_response: null };
  const sql = extractSqlFromResponse(raw);
  if (!sql) {
    return { sql: null, tutor_response: raw };
  }
  let tutor = raw.replace(/```(?:sql)?\s*[\s\S]*?```/i, '').trim();
  tutor = tutor.replace(/```\s*[\s\S]*?```/, '').trim();
  return { sql, tutor_response: tutor.length > 0 ? tutor : null };
}

/** Search indexed EPUB for question; return full chunks for LLM context (same scoring as /book/search). */
function pickBookContextForQuestion(question, { maxChunks = 4, searchLimit = 18 } = {}) {
  const q = String(question || '').trim();
  if (!bookIndex.loaded || !bookIndex.chunks.length || !q) {
    return { chunks: [], book_citations: [], book_context_used: false };
  }
  const hits = searchChunks(bookIndex.chunks, q, searchLimit);
  if (!hits.length) {
    return { chunks: [], book_citations: [], book_context_used: false };
  }
  const byId = new Map(bookIndex.chunks.map((c) => [c.id, c]));
  const chunks = [];
  const seen = new Set();
  for (const h of hits) {
    const c = byId.get(h.id);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    chunks.push(c);
    if (chunks.length >= maxChunks) break;
  }
  const sections = [...new Set(chunks.map((c) => c.section).filter(Boolean))];
  const book_citations = sections.map((section) => ({ section }));
  return { chunks, book_citations, book_context_used: chunks.length > 0 };
}

async function generateSqlWithLLM(question) {
  const emptyBookMeta = { book_citations: [], book_context_used: false };

  if (!config.enableLLMSqlGeneration) {
    return {
      sql: null,
      tutor_response: null,
      source: 'llm_disabled',
      error: 'LLM SQL generation is disabled',
      ...emptyBookMeta,
    };
  }
  if (!config.llmApiKey) {
    return {
      sql: null,
      tutor_response: null,
      source: 'llm_disabled',
      error: 'LLM_API_KEY is missing',
      ...emptyBookMeta,
    };
  }

  const schemaHint = [
    'CRITICAL: The user Oracle database has ONLY these eight tables—no Sales, Employees, Products, or other invented names.',
    'Every ```sql example the user might run MUST use only: REGION, NATION, CUSTOMER, ORDERS, LINEITEM, SUPPLIER, PART, PARTSUPP.',
    'TPC-H columns (exact spellings; Oracle rejects wrong names):',
    'LINEITEM: L_PARTKEY on LINEITEM (never P_PARTKEY on L). PART table has P_PARTKEY.',
    'REGION: R_REGIONKEY, R_NAME, R_COMMENT',
    'NATION: N_NATIONKEY, N_NAME, N_REGIONKEY, N_COMMENT',
    'CUSTOMER: C_CUSTKEY, C_NAME, C_ADDRESS, C_NATIONKEY, C_PHONE, C_ACCTBAL, C_MKTSEGMENT, C_COMMENT',
    'ORDERS: O_ORDERKEY, O_CUSTKEY, O_ORDERSTATUS, O_TOTALPRICE, O_ORDERDATE, O_ORDERPRIORITY, O_CLERK, O_SHIPPRIORITY, O_COMMENT',
    'LINEITEM: L_ORDERKEY, L_PARTKEY, L_SUPPKEY, L_LINENUMBER, L_QUANTITY, L_EXTENDEDPRICE, L_DISCOUNT, L_TAX, L_RETURNFLAG, L_LINESTATUS, L_SHIPDATE, L_COMMITDATE, L_RECEIPTDATE, L_SHIPINSTRUCT, L_SHIPMODE, L_COMMENT',
    'SUPPLIER: S_SUPPKEY, S_NAME, S_ADDRESS, S_NATIONKEY, S_PHONE, S_ACCTBAL, S_COMMENT',
    'PART: P_PARTKEY, P_NAME, P_MFGR, P_BRAND, P_TYPE, P_SIZE, P_CONTAINER, P_RETAILPRICE, P_COMMENT',
    'PARTSUPP: PS_PARTKEY, PS_SUPPKEY, PS_AVAILQTY, PS_SUPPLYCOST, PS_COMMENT',
    'Pattern examples: rank customers by balance → FROM CUSTOMER … RANK() OVER (ORDER BY C_ACCTBAL DESC).',
    'Rank order lines by line revenue → FROM LINEITEM … ORDER BY L_EXTENDEDPRICE * (1 - L_DISCOUNT).',
    'Rank orders by total → FROM ORDERS … ORDER BY O_TOTALPRICE DESC.',
    'Oracle: FETCH FIRST n ROWS ONLY (not LIMIT). EXTRACT has no QUARTER — use CEIL(EXTRACT(MONTH FROM d)/3) or TO_CHAR(d,\'Q\').',
    'Prefer year filters as date ranges: d >= DATE \'YYYY-01-01\' AND d < ADD_MONTHS(DATE \'YYYY-01-01\',12).',
  ].join(' ');

  const tutorSystem = [
    'You are an expert SQL tutor for technical interviews and Oracle SQL. The user may ask ANYTHING about SQL:',
    'concepts (joins, keys, indexes, window functions, CTEs, etc.), comparisons, or questions about their practice database.',
    '',
    'Schema-bound examples (non-negotiable):',
    'The app connects to Oracle with ONLY the TPC-H tables listed below. The user often copies ```sql straight into the database.',
    'Therefore EVERY ```sql block you output must run on that schema: use ONLY those eight tables and their real column names.',
    'Never use placeholder tables (Sales, Employees, orders lowercase, products, etc.). If you need a minimal demo with no base table,',
    'you may use only `SELECT … FROM dual` with literals—but prefer a realistic TPC-H example instead.',
    'For interview topics (e.g. RANK vs DENSE_RANK, window frames), illustrate with TPC-H: e.g. rank CUSTOMER by C_ACCTBAL,',
    'or LINEITEM rows by L_EXTENDEDPRICE, or ORDERS by O_TOTALPRICE—always FETCH FIRST … ROWS ONLY for samples.',
    '',
    'How to respond:',
    '1) Markdown: ## / ### headings, - bullets, **bold**, `code` for identifiers.',
    '2) Multi-line SQL only inside ```sql fences—never loose SQL after paragraphs.',
    '3) **Runnable-only rule:** Every ```sql fence = **one** complete Oracle **SELECT** or **WITH … SELECT** that runs **as-is** on the lab DB (TPC-H tables only).',
    '4) No placeholders (no YOUR_TABLE, <id>, …, TODO). No multi-statement batches. **No DDL/DML** (INSERT/UPDATE/DELETE/MERGE/CREATE/…) inside ```sql** — explain those in prose; still give a runnable SELECT that illustrates the idea.',
    '5) When a query is needed: put **exactly one** primary lab query in the **last** ```sql block; no prose inside that fence.',
    '6) Conceptual answers: any ```sql must still be runnable TPC-H SELECT/WITH—never generic or fake schemas.',
    '7) Use only columns from the schema reference; never invent table or column names.',
    '',
    'Schema reference:\n',
    schemaHint,
  ].join(' ');

  const userQ = String(question || '').trim();
  const userWithSchemaReminder =
    userQ +
    '\n\n[Assistant: Every ```sql block must be one runnable Oracle SELECT or WITH … SELECT on TPC-H only—copy-paste ready, no DDL/DML, no placeholders.]';

  const useBook =
    config.bookContextInGenerate &&
    bookIndex.loaded &&
    bookIndex.chunks.length > 0;
  const { chunks: bookChunks, book_citations, book_context_used } = useBook
    ? pickBookContextForQuestion(userQ)
    : { chunks: [], book_citations: [], book_context_used: false };

  const bookTitle = bookIndex.meta?.title || 'the course book';
  let bookUserMessage = null;
  if (book_context_used && bookChunks.length) {
    bookUserMessage =
      formatContextForPrompt(bookChunks) +
      '\n\n---\n\n' +
      `**How to use the book excerpts above (title: "${bookTitle}"):**\n` +
      '1) Decide whether these passages **clearly discuss** the user’s question (e.g. UNION vs UNION ALL, joins, windows—whatever they asked).\n' +
      '2) **If yes:** Optionally start with one short line, e.g. **Course book:** … in **«section/chapter name»** (*' +
      bookTitle +
      '*). Use the **exact section title** from the excerpt headers `[n] Section: …`. Then give the full Markdown answer; any ```sql must be **runnable** Oracle SELECT/WITH on TPC-H only.\n' +
      '3) **If no** (excerpts are off-topic, too narrow, or a poor match—common for very broad questions like “what is SQL?”): **Ignore the excerpts** and answer fully from **general SQL / interview knowledge** and TPC-H rules. **Do not** say the book does not cover the topic, **do not** say you were “not given” passages, and **do not** apologize for missing book material—just teach the answer. **Do not** invent a chapter name.\n' +
      '4) Never quote long passages verbatim; paraphrase and teach.\n';
  }

  const messages = [{ role: 'system', content: tutorSystem }];
  if (bookUserMessage) {
    messages.push({ role: 'user', content: bookUserMessage });
  }
  messages.push({ role: 'user', content: userWithSchemaReminder });

  const payload = {
    model: config.llmModel,
    temperature: 0.15,
    messages,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs);

  try {
    const response = await fetch(config.llmApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      return {
        sql: null,
        tutor_response: null,
        source: 'llm_error',
        error: `LLM HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
        book_citations,
        book_context_used,
      };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const { sql, tutor_response } = splitSqlAndTutorFromLlmContent(content);
    if (!sql && !tutor_response) {
      return {
        sql: null,
        tutor_response: null,
        source: 'llm_error',
        error: 'LLM returned an empty response',
        book_citations,
        book_context_used,
      };
    }
    return {
      sql,
      tutor_response,
      source: 'llm',
      book_citations,
      book_context_used,
    };
  } catch (error) {
    const isAbort = error && error.name === 'AbortError';
    return {
      sql: null,
      tutor_response: null,
      source: 'llm_error',
      error: isAbort ? 'LLM request timed out' : String(error),
      book_citations,
      book_context_used,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function explainSqlWithLLM(sql, contextQuestion = '', explainOpts = {}) {
  if (!config.enableLLMSqlGeneration) {
    return { explanation: null, source: 'llm_disabled', error: 'LLM explanations are disabled', book_citations: [] };
  }
  if (!config.llmApiKey) {
    return { explanation: null, source: 'llm_disabled', error: 'LLM_API_KEY is missing', book_citations: [] };
  }

  const sqlClean = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!sqlClean) return { explanation: null, source: 'bad_request', error: 'No SQL provided', book_citations: [] };

  const wantBook =
    explainOpts.useBookContext !== false &&
    config.bookContextInExplain &&
    bookIndex.loaded &&
    bookIndex.chunks.length > 0;
  let bookUserMsg = null;
  let bookCitations = [];
  if (wantBook) {
    const selected = selectChunksForContext(bookIndex.chunks, sqlClean, contextQuestion, 5);
    if (selected.length) {
      bookCitations = selected.map((c) => ({ section: c.section, file: c.file }));
      bookUserMsg = {
        role: 'user',
        content:
          formatContextForPrompt(selected) +
          '\n\nIf an excerpt clearly relates to the SQL or question, you may start with one line: **Course book:** … (**exact section title** from the headers). ' +
          'If excerpts are not on-topic, do not claim the book covers this—explain from the query only.',
      };
    }
  }

  const payload = {
    model: config.llmModel,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You are a SQL tutor for learners and interview prep. Explain SQL clearly and concisely. ' +
          'Format your answer in Markdown: use ## for sections, - bullet lists, **bold** for emphasis, `code` for identifiers. ' +
          'Put any sample or alternative SQL in ```sql fenced blocks (not loose plain text). ' +
          '**Every** ```sql block must be **one** complete, **directly runnable** Oracle **SELECT** or **WITH … SELECT** on the practice schema (no DDL/DML, no placeholders). ' +
          'For queries, cover: goal, tables, joins, filters, grouping/aggregation, ordering, limits. ' +
          'For conceptual or interview-style questions, define terms, give intuition, and note common pitfalls. ' +
          'Example SQL must use only: REGION, NATION, CUSTOMER, ORDERS, LINEITEM, SUPPLIER, PART, PARTSUPP ' +
          'with TPC-H column prefixes (C_, O_, L_, N_, R_, S_, P_, PS_). Never suggest fake tables like Sales or employees. ' +
          'Add 3 short "Try changing" suggestions when it fits. ' +
          'Do NOT execute SQL. If something is unknown, say so. ' +
          'When book excerpts were provided, you may reference those ideas and optionally mention the section name in passing; do not quote long passages.',
      },
      ...(bookUserMsg ? [bookUserMsg] : []),
      ...(contextQuestion ? [{ role: 'user', content: `Original question/context: ${contextQuestion}` }] : []),
      { role: 'user', content: `Explain this Oracle SQL:\n\n${sqlClean}` },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const response = await fetch(config.llmApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      return {
        explanation: null,
        source: 'llm_error',
        error: `LLM HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
        book_citations: bookCitations,
      };
    }

    const data = await response.json();
    const content = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!content) {
      return { explanation: null, source: 'llm_error', error: 'LLM returned empty explanation', book_citations: bookCitations };
    }
    return { explanation: content, source: 'llm', book_citations: bookCitations };
  } catch (error) {
    const isAbort = error && error.name === 'AbortError';
    return {
      explanation: null,
      source: 'llm_error',
      error: isAbort ? 'LLM request timed out' : String(error),
      book_citations: bookCitations,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Guided chapter LLM expansion (interactive SQL learning) ───────────────────

let guidedCurriculumCache = { mtimeMs: -1, data: null };

function getGuidedCurriculum() {
  const curriculumPath = path.join(__dirname, 'app', 'guided-curriculum.json');
  let st;
  try {
    st = fs.statSync(curriculumPath);
  } catch (_) {
    return null;
  }
  if (!guidedCurriculumCache.data || st.mtimeMs !== guidedCurriculumCache.mtimeMs) {
    guidedCurriculumCache.data = JSON.parse(fs.readFileSync(curriculumPath, 'utf8'));
    guidedCurriculumCache.mtimeMs = st.mtimeMs;
  }
  return guidedCurriculumCache.data;
}

/**
 * LLM-generated SQL lesson for one curriculum chapter (no book / EPUB context).
 */
async function expandGuidedChapterWithLLM(chapterId, level) {
  const noRefs = { book_citations: [], book_context_used: false };

  if (!config.enableLLMSqlGeneration) {
    return {
      markdown: null,
      source: 'llm_disabled',
      error: 'LLM is disabled (set ENABLE_LLM_SQL_GEN=true)',
      ...noRefs,
    };
  }
  if (!config.llmApiKey) {
    return {
      markdown: null,
      source: 'llm_disabled',
      error: 'LLM_API_KEY is not set',
      ...noRefs,
    };
  }

  const curriculum = getGuidedCurriculum();
  if (!curriculum || !curriculum.chapters) {
    return {
      markdown: null,
      source: 'error',
      error: 'guided-curriculum.json not available',
      ...noRefs,
    };
  }

  const ch = curriculum.chapters[chapterId];
  if (!ch) {
    return {
      markdown: null,
      source: 'error',
      error: `Unknown chapter: ${chapterId}`,
      ...noRefs,
    };
  }

  let nextHint = '';
  let prevHint = '';
  const track = curriculum.learningChapterTracks && curriculum.learningChapterTracks[level];
  if (track && Array.isArray(track)) {
    const idx = track.indexOf(chapterId);
    if (idx >= 0) {
      if (idx < track.length - 1) {
        const nextCh = curriculum.chapters[track[idx + 1]];
        if (nextCh) {
          nextHint = `Next on the path: **${nextCh.label || 'Part'}** — ${nextCh.title}.`;
        }
      }
      if (idx > 0) {
        const prevCh = curriculum.chapters[track[idx - 1]];
        if (prevCh) {
          prevHint = `Previous: **${prevCh.label || 'Part'}** — ${prevCh.title}.`;
        }
      }
    }
  }

  const schemaTables =
    'Oracle lab tables: REGION, NATION, CUSTOMER, ORDERS, LINEITEM, SUPPLIER, PART, PARTSUPP (TPC-H-style columns: C_, O_, L_, N_, R_, S_, P_, PS_ prefixes).';

  const focus = String(ch.llmFocus || '').trim();
  const focusLine = focus ? `**Depth hints for this part:** ${focus}` : '';

  const system = [
    'You are an expert SQL educator. The page has **no static lesson text** — your Markdown **is** this part’s lesson.',
    'Teach **practical SQL** for this topic: ANSI where it applies, **Oracle** specifics when relevant (FETCH FIRST, ROWNUM, NVL, dates, etc.).',
    'Do **not** mention textbooks, EPUBs, or that content is automated. Write as a tight course note.',
    'Use **short** Markdown: ## headings, bullets, **bold** terms. No long essays — every line should earn its place.',
    '**Exactly one** ```sql fence: a **complete, copy-paste runnable** Oracle **SELECT** or **WITH … SELECT** on TPC-H tables only. **No second fence.** Teach INSERT/UPDATE/DDL/transaction topics in **prose only**—never put DDL/DML inside ```sql**.',
    'Touch the **depth hints** (if any) but **summarize**; do not lecture on every keyword.',
    '**2** self-check questions under ## Quick check as a **markdown bullet list** (`-` lines), one full question per line (so the UI can open each in Guided practice). **What’s next:** **exactly 2 bullets** (next path part if given + one related skill).',
    'Use **real** TPC-H identifiers only in SQL—**no** placeholders or pseudo-code. Hard cap: **~220–380 words** plus that single query.',
  ].join(' ');

  const user = [
    `**Chapter:** ${ch.label || 'Part'} — ${ch.title}`,
    `**Learner level:** ${level} (beginner = more definitions and step-by-step; advanced = edge cases, optimizer and modeling depth).`,
    focusLine,
    '',
    '**Use exactly these ## headings (keep each section brief):**',
    '## At a glance — 3–5 bullets: outcomes for this part.',
    `## Essentials — one tight section: concepts, Oracle vs standard, 1–2 pitfalls or interview hooks. Tables: ${schemaTables}`,
    '## Lab — **one** ```sql fence only**: a single Oracle SELECT or WITH … SELECT that runs **unchanged** on the lab DB (no DDL/DML, no placeholders). Minimal intro line above the fence.',
    '## Quick check — 2 questions, each its own `-` bullet with the full question text.',
    '## What’s next — 2 bullets only.',
    '',
    prevHint || nextHint ? `**Path:** ${[prevHint, nextHint].filter(Boolean).join(' ')}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const payload = {
    model: config.llmModel,
    temperature: 0.28,
    messages,
  };
  const expandMaxTok = Math.min(
    2048,
    Math.max(512, Number(process.env.GUIDED_EXPAND_MAX_TOKENS) || 1400),
  );
  payload.max_tokens = expandMaxTok;

  const controller = new AbortController();
  const expandTimeoutMs = Math.min(
    Math.max(config.llmTimeoutMs * 2, 35000),
    Number(process.env.GUIDED_EXPAND_TIMEOUT_MS || 55000) || 55000,
  );
  const timeout = setTimeout(() => controller.abort(), expandTimeoutMs);

  try {
    const res = await fetch(config.llmApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const bodyText = await res.text();
      return {
        markdown: null,
        source: 'llm_error',
        error: `LLM HTTP ${res.status}: ${bodyText.slice(0, 400)}`,
        ...noRefs,
      };
    }

    const data = await res.json();
    const content = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!content) {
      return {
        markdown: null,
        source: 'llm_error',
        error: 'LLM returned empty content',
        ...noRefs,
      };
    }
    return {
      markdown: content,
      source: 'llm',
      error: null,
      ...noRefs,
    };
  } catch (error) {
    const isAbort = error && error.name === 'AbortError';
    return {
      markdown: null,
      source: 'llm_error',
      error: isAbort ? 'LLM request timed out' : String(error),
      ...noRefs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSql(question, mode = 'hybrid') {
  const noBook = { book_citations: [], book_context_used: false };

  if (mode === 'lookup') {
    const hit = lookupSql(question);
    return {
      sql: hit.sql,
      tutor_response: null,
      source: hit.source,
      error: hit.sql ? null : 'No SQL rule found for question',
      ...noBook,
    };
  }

  if (mode === 'llm') {
    return generateSqlWithLLM(question);
  }

  // hybrid: exact rule match only, then LLM (handles interview + open-ended questions)
  const hit = lookupSql(question);
  if (hit.sql) {
    return { sql: hit.sql, tutor_response: null, source: hit.source, error: null, ...noBook };
  }
  return generateSqlWithLLM(question);
}

// ── ElevenLabs podcast TTS (guided lesson “Listen”) — API key stays on server ──
function sanitizeElevenLabsApiKey(raw) {
  let k = String(raw || '').trim();
  k = k.replace(/^\uFEFF/, '');
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(k)) k = k.replace(/^bearer\s+/i, '').trim();
  return k;
}

/** Turn ElevenLabs JSON error body into a short message for logs and JSON API errors. */
function formatElevenLabsErrorBody(errBody, httpStatus) {
  const raw = String(errBody || '').trim();
  if (!raw) return `ElevenLabs HTTP ${httpStatus}`;
  try {
    const j = JSON.parse(raw);
    const d = j.detail;
    if (typeof d === 'object' && d !== null && d.message) {
      let msg = String(d.message);
      if (d.status === 'invalid_api_key' || httpStatus === 401) {
        msg += ' Use the xi-api-key from https://elevenlabs.io → profile (not an OpenAI sk-… key). Check .env for extra spaces or quotes.';
      }
      return msg;
    }
    if (typeof d === 'string') return d;
  } catch (_) { /* not JSON */ }
  return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}

const ELEVENLABS_API_KEY = sanitizeElevenLabsApiKey(process.env.ELEVENLABS_API_KEY || '');
const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM').trim();
/** Default multilingual model works on more accounts; override with eleven_turbo_v2_5 if you prefer. */
const ELEVENLABS_MODEL_ID = (process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2').trim();
const ELEVENLABS_FALLBACK_MODEL_ID = (process.env.ELEVENLABS_FALLBACK_MODEL_ID || 'eleven_turbo_v2_5').trim();
const ELEVENLABS_OUTPUT_FORMAT = (process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128').trim();
const ELEVENLABS_TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS || 120000) || 120000;

function chunkTextForElevenLabs(text, maxLen) {
  const t = String(text || '').trim();
  if (!t) return [];
  const max = Math.min(Math.max(500, maxLen), 4500);
  if (t.length <= max) return [t];
  const parts = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < 240) cut = rest.lastIndexOf('. ', max);
    if (cut < 240) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function elevenLabsTtsOneSegment(segmentText, modelId, prevSlice, nextSlice) {
  const payload = { text: segmentText, model_id: modelId };
  if (prevSlice) payload.previous_text = prevSlice;
  if (nextSlice) payload.next_text = nextSlice;
  const q = new URLSearchParams({ output_format: ELEVENLABS_OUTPUT_FORMAT });
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}?${q.toString()}`;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), ELEVENLABS_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(tid);
  }
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    const msg = formatElevenLabsErrorBody(errBody, r.status);
    const err = new Error(msg);
    err.statusCode = r.status;
    throw err;
  }
  return Buffer.from(await r.arrayBuffer());
}

async function synthesizeElevenLabsPodcastMp3(fullText) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY is not set');
  }
  const segments = chunkTextForElevenLabs(fullText, 4500);
  if (!segments.length) {
    throw new Error('Empty text');
  }
  const buffers = [];
  for (let i = 0; i < segments.length; i += 1) {
    const prev = i > 0 ? segments[i - 1] : null;
    const next = i < segments.length - 1 ? segments[i + 1] : null;
    const prevSlice = prev ? (prev.length > 800 ? prev.slice(prev.length - 800) : prev) : null;
    const nextSlice = next ? (next.length > 800 ? next.slice(0, 800) : next) : null;
    const tryModels = [ELEVENLABS_MODEL_ID];
    if (ELEVENLABS_FALLBACK_MODEL_ID && ELEVENLABS_FALLBACK_MODEL_ID !== ELEVENLABS_MODEL_ID) {
      tryModels.push(ELEVENLABS_FALLBACK_MODEL_ID);
    }
    let buf = null;
    for (let mi = 0; mi < tryModels.length; mi += 1) {
      const mid = tryModels[mi];
      try {
        buf = await elevenLabsTtsOneSegment(segments[i], mid, prevSlice, nextSlice);
        break;
      } catch (e) {
        const sc = e && e.statusCode;
        if (sc === 401 || sc === 403) throw e;
        if (mi === tryModels.length - 1) throw e;
      }
    }
    buffers.push(buf);
  }
  return Buffer.concat(buffers);
}

// Load rules on startup (book loads in startServer after optional URL fetch)
loadSQLRules();

// ── HTTP Request Handler ──────────────────────────────────────────────────────

const requestHandler = (request, response) => {
  maybeReloadSQLRules();

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.writeHead(200);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  // GET / — browser UI (app/index.html; Netlify publishes the same folder)
  if ((pathname === '/' || pathname === '') && request.method === 'GET') {
    const appDir = path.join(__dirname, 'app');
    let html;
    for (const name of ['index.html', 'sql-learn-ui.html']) {
      const p = path.join(appDir, name);
      if (fs.existsSync(p)) {
        try {
          html = fs.readFileSync(p, 'utf8');
          break;
        } catch (_) { /* try next */ }
      }
    }
    if (!html) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Missing app/index.html (or sql-learn-ui.html)');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }

  response.setHeader('Content-Type', 'application/json');

  // GET /api-info — machine-readable root (formerly GET /)
  if (pathname === '/api-info' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      name: APP_DISPLAY_NAME,
      tagline: 'Natural language to Oracle SQL — course book, AI explain, optional live runs',
      status: 'running',
      offer: 'Easy NL2SQL turns questions into SQL with an indexed course book, AI explanations, and optional Oracle execution.',
      endpoints: {
        ui: 'GET / — browser UI',
        api_info: 'GET /api-info — this JSON',
        health: 'GET /health',
        egress_ip: 'GET /egress-ip — outbound IP (Oracle ACL allow list)',
        generate_sql:
          'POST /generate-sql — body: { "question": "…", "mode": "llm|lookup|hybrid" } — returns generated_sql and/or tutor_response; when EPUB is loaded, searches book first (BOOK_CONTEXT_IN_GENERATE) and returns book_citations',
        generate_batch: 'POST /generate-batch — body: { "questions": ["q1"], "mode": "…" }',
        explain_sql: 'POST /explain-sql — body: { "sql": "…", "question": "…", "use_book_context": true }',
        execute_sql: 'POST /execute-sql — body: { "sql": "…" } (opt-in)',
        schema: 'GET /schema — tables and columns',
        api_tools: 'GET /api/tools — lab tool list (DB readiness)',
        api_invoke: 'POST /api/invoke — body: { "tool": "run-sql|…", "params": {…} }',
        reload_rules: 'POST /reload-rules',
        book_status: 'GET /book/status — EPUB index',
        book_search:
          'GET /book/search?q=…&limit=12 — optional diverse=1 (dissimilar excerpts), brief=1 (shorter excerpts)',
        book_reload: 'POST /book/reload',
        guided_curriculum: 'GET /guided-curriculum.json — interactive path (same file ships in app/ for Netlify)',
        guided_expand_chapter:
          'POST /guided-expand-chapter — body: { "chapter_id": "…", "level": "…" } — short markdown lesson; env: GUIDED_EXPAND_MAX_TOKENS (default 1400, cap 2048), GUIDED_EXPAND_TIMEOUT_MS (default 55000); book_context_used always false; requires ENABLE_LLM_SQL_GEN + LLM_API_KEY',
        guided_podcast_tts_status: 'GET /guided-podcast-tts-status — JSON { enabled, voice_id, model_id } when ELEVENLABS_API_KEY is set',
        guided_podcast_tts:
          'POST /guided-podcast-tts — body: { "text": "…" } — returns audio/mpeg (ElevenLabs); env: ELEVENLABS_API_KEY, optional ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, ELEVENLABS_FALLBACK_MODEL_ID, ELEVENLABS_OUTPUT_FORMAT, ELEVENLABS_TIMEOUT_MS',
      },
      docs: process.env.APP_DOCS_URL || '',
    }));
    return;
  }

  // GET /guided-curriculum.json — learning / interview paths (also static on Netlify publish=app)
  if (pathname === '/guided-curriculum.json' && request.method === 'GET') {
    const curriculumPath = path.join(__dirname, 'app', 'guided-curriculum.json');
    try {
      const raw = fs.readFileSync(curriculumPath, 'utf8');
      JSON.parse(raw);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(raw);
    } catch (err) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'guided-curriculum.json not found', detail: err.message }));
    }
    return;
  }

  // POST /guided-expand-chapter — LLM builds on a learning chapter
  if (pathname === '/guided-expand-chapter' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk.toString(); });
    request.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const chapterId = String(data.chapter_id || data.chapterId || '').trim();
        let level = String(data.level || 'beginner').trim().toLowerCase();
        if (!chapterId) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ success: false, error: 'chapter_id is required' }));
          return;
        }
        if (!['beginner', 'intermediate', 'advanced'].includes(level)) {
          level = 'beginner';
        }
        const r = await expandGuidedChapterWithLLM(chapterId, level);
        if (r.markdown) {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({
            success: true,
            markdown: r.markdown,
            source: r.source,
            chapter_id: chapterId,
            level,
            book_context_used: !!r.book_context_used,
            book_citations: r.book_citations || [],
          }));
          return;
        }
        const code = r.source === 'llm_disabled' ? 503 : 502;
        response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          success: false,
          error: r.error || 'Chapter expansion failed',
          source: r.source,
          book_context_used: !!r.book_context_used,
          book_citations: r.book_citations || [],
        }));
      } catch (err) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ success: false, error: err.message || String(err) }));
      }
    });
    return;
  }

  // GET /guided-podcast-tts-status — UI: enable ElevenLabs podcast when API key is configured
  if (pathname === '/guided-podcast-tts-status' && request.method === 'GET') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.writeHead(200);
    response.end(JSON.stringify({
      enabled: !!ELEVENLABS_API_KEY,
      voice_id: ELEVENLABS_API_KEY ? ELEVENLABS_VOICE_ID : null,
      model_id: ELEVENLABS_API_KEY ? ELEVENLABS_MODEL_ID : null,
    }));
    return;
  }

  // POST /guided-podcast-tts — full lesson script → single MP3 (ElevenLabs)
  if (pathname === '/guided-podcast-tts' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk.toString(); });
    request.on('end', async () => {
      if (!ELEVENLABS_API_KEY) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ success: false, error: 'ElevenLabs is not configured (set ELEVENLABS_API_KEY).' }));
        return;
      }
      try {
        const data = JSON.parse(body || '{}');
        const text = String(data.text || '').trim();
        if (text.length < 20) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ success: false, error: 'text is required (min ~20 characters).' }));
          return;
        }
        if (text.length > 120000) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ success: false, error: 'text too long (max 120000 characters).' }));
          return;
        }
        const mp3 = await synthesizeElevenLabsPodcastMp3(text);
        response.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(mp3.length),
          'Cache-Control': 'no-store',
        });
        response.end(mp3);
      } catch (err) {
        response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          success: false,
          error: err.message || String(err),
        }));
      }
    });
    return;
  }

  // GET /schema — tables and columns (live from DB when possible, else static)
  if (pathname === '/schema' && request.method === 'GET') {
    const fallbackSchema = {
      title: 'Reference tables',
      description:
        'These tables mirror a standard analytics warehouse shape. Use the exact names below when you ask questions—the app turns your wording into Oracle SQL using this layout.',
      tips: [
        'Identifiers must match this list exactly (same spelling and prefix: C_ for CUSTOMER, O_ for ORDERS, L_ for LINEITEM, P_ for PART, etc.).',
        'LINEITEM is one row per order line: join to ORDERS on L_ORDERKEY = O_ORDERKEY, to PART on L_PARTKEY = P_PARTKEY, to SUPPLIER on L_SUPPKEY = S_SUPPKEY.',
        'ORDERS holds order headers (customer, date, total); LINEITEM holds quantities, discounts, ship dates, and line revenue.',
        'PARTSUPP links each part to suppliers (PS_PARTKEY, PS_SUPPKEY) with availability and supply cost—use it for sourcing or cost questions.',
        'CUSTOMER.C_CUSTKEY joins to ORDERS.O_CUSTKEY; NATION.N_NATIONKEY links CUSTOMER, SUPPLIER, and REGION for geography.',
        'Money-like fields include O_TOTALPRICE, L_EXTENDEDPRICE, L_DISCOUNT, L_TAX, C_ACCTBAL, S_ACCTBAL, P_RETAILPRICE, PS_SUPPLYCOST.',
        'Dates on LINEITEM include L_SHIPDATE, L_COMMITDATE, L_RECEIPTDATE; order date is O_ORDERDATE on ORDERS.',
        'For aggregates (totals, counts, averages), prefer grouping by keys you join on so results stay one row per grain you care about.',
      ],
      tables: [
        { name: 'REGION', hint: 'Regions: R_REGIONKEY is the key. Join NATION.N_REGIONKEY here for country-to-region rollups.', columns: ['R_REGIONKEY', 'R_NAME', 'R_COMMENT'] },
        { name: 'NATION', hint: 'Countries: N_NATIONKEY primary key; N_REGIONKEY → REGION for continent/region.', columns: ['N_NATIONKEY', 'N_NAME', 'N_REGIONKEY', 'N_COMMENT'] },
        { name: 'CUSTOMER', hint: 'Customers: C_CUSTKEY joins ORDERS.O_CUSTKEY. C_NATIONKEY → NATION. C_ACCTBAL is account balance.', columns: ['C_CUSTKEY', 'C_NAME', 'C_ADDRESS', 'C_NATIONKEY', 'C_PHONE', 'C_ACCTBAL', 'C_MKTSEGMENT', 'C_COMMENT'] },
        { name: 'SUPPLIER', hint: 'Suppliers: S_SUPPKEY joins LINEITEM.L_SUPPKEY and PARTSUPP.PS_SUPPKEY. S_NATIONKEY → NATION.', columns: ['S_SUPPKEY', 'S_NAME', 'S_ADDRESS', 'S_NATIONKEY', 'S_PHONE', 'S_ACCTBAL', 'S_COMMENT'] },
        { name: 'PART', hint: 'Parts/products: P_PARTKEY joins LINEITEM.L_PARTKEY and PARTSUPP.PS_PARTKEY. P_RETAILPRICE is list price.', columns: ['P_PARTKEY', 'P_NAME', 'P_MFGR', 'P_BRAND', 'P_TYPE', 'P_SIZE', 'P_CONTAINER', 'P_RETAILPRICE', 'P_COMMENT'] },
        { name: 'ORDERS', hint: 'Order header: O_ORDERKEY is the key to LINEITEM. O_CUSTKEY → CUSTOMER. O_TOTALPRICE and O_ORDERDATE are common filters.', columns: ['O_ORDERKEY', 'O_CUSTKEY', 'O_ORDERSTATUS', 'O_TOTALPRICE', 'O_ORDERDATE', 'O_ORDERPRIORITY', 'O_CLERK', 'O_SHIPPRIORITY', 'O_COMMENT'] },
        { name: 'LINEITEM', hint: 'Line-level detail per order: L_LINENUMBER + L_ORDERKEY uniquely define a line. Revenue ≈ L_EXTENDEDPRICE × (1 − L_DISCOUNT) × (1 + L_TAX) (adjust per your conventions).', columns: ['L_ORDERKEY', 'L_PARTKEY', 'L_SUPPKEY', 'L_LINENUMBER', 'L_QUANTITY', 'L_EXTENDEDPRICE', 'L_DISCOUNT', 'L_TAX', 'L_RETURNFLAG', 'L_LINESTATUS', 'L_SHIPDATE', 'L_COMMITDATE', 'L_RECEIPTDATE', 'L_SHIPINSTRUCT', 'L_SHIPMODE', 'L_COMMENT'] },
        { name: 'PARTSUPP', hint: 'Bridge part ↔ supplier: composite key PS_PARTKEY + PS_SUPPKEY. PS_AVAILQTY and PS_SUPPLYCOST support inventory and costing questions.', columns: ['PS_PARTKEY', 'PS_SUPPKEY', 'PS_AVAILQTY', 'PS_SUPPLYCOST', 'PS_COMMENT'] },
      ],
    };

    (async () => {
      let schema = null;

      if (config.enableExecuteSql && oracledb && config.dbDsn && config.dbUser && config.dbPassword) {
        try {
          const connectString = config.dbDsn || `${config.dbHost}:${config.dbPort}/${config.dbSid}`;
          const connConfig = {
            user: config.dbUser,
            password: config.dbPassword,
            connectString,
          };
          if (config.dbWalletPath) {
            connConfig.configDir = config.dbWalletPath;
          }
          const conn = await oracledb.getConnection(connConfig);
          try {
            const tablesResult = await conn.execute(
              'SELECT TABLE_NAME FROM USER_TABLES ORDER BY TABLE_NAME',
              [],
              { outFormat: oracledb.OUT_FORMAT_OBJECT }
            );
            const tableNames = (tablesResult.rows || []).map(r => r.TABLE_NAME);

            const colsResult = await conn.execute(
              'SELECT TABLE_NAME, COLUMN_NAME FROM USER_TAB_COLUMNS ORDER BY TABLE_NAME, COLUMN_ID',
              [],
              { outFormat: oracledb.OUT_FORMAT_OBJECT }
            );
            const columnsByTable = {};
            for (const row of (colsResult.rows || [])) {
              const t = row.TABLE_NAME;
              if (!columnsByTable[t]) columnsByTable[t] = [];
              columnsByTable[t].push(row.COLUMN_NAME);
            }

            schema = {
              title: 'Database tables (live from Oracle)',
              description:
                'Tables and columns from your database. Ask questions in plain English. Use exact names as listed; join keys follow the same conventions as in the reference guide below.',
              source: 'database',
              tables: tableNames.map(name => ({
                name,
                hint: `${(columnsByTable[name] || []).length} column(s) — open the card to copy names`,
                columns: columnsByTable[name] || [],
              })),
            };
            try {
              const rawTips = fs.readFileSync(path.join(__dirname, 'schema-reference.json'), 'utf8');
              const tipsObj = JSON.parse(rawTips);
              if (Array.isArray(tipsObj.tips) && tipsObj.tips.length) {
                schema.tips = tipsObj.tips;
              }
            } catch (_) {
              /* optional */
            }
          } finally {
            await conn.close();
          }
        } catch (err) {
          console.warn(`[${APP_DISPLAY_NAME}] Schema from DB failed:`, err.message);
        }
      }

      if (!schema) {
        try {
          const raw = fs.readFileSync(path.join(__dirname, 'schema-reference.json'), 'utf8');
          schema = JSON.parse(raw);
        } catch (_) {
          schema = fallbackSchema;
        }
      }

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(schema));
    })();
    return;
  }

  // GET /health
  if (pathname === '/health' && request.method === 'GET') {
    const execOk = !!(config.enableExecuteSql && oracledb);
    response.writeHead(200);
    response.end(JSON.stringify({
      status: 'ok',
      server: APP_DISPLAY_NAME,
      database: `${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbSid}`,
      db_connection: (execOk && config.dbUser && config.dbDsn)
        ? `${config.dbUser}@${config.dbDsn}`
        : null,
      loaded_rules: Object.keys(SQL_GENERATION_RULES).length,
      llm_enabled: config.enableLLMSqlGeneration,
      guided_chapter_llm_ready: !!(config.enableLLMSqlGeneration && config.llmApiKey),
      llm_model: config.enableLLMSqlGeneration ? config.llmModel : null,
      sql_generation_mode: config.sqlGenerationMode,
      execute_sql_available: execOk,
      guided_podcast_elevenlabs: !!ELEVENLABS_API_KEY,
      book: bookIndex.loaded
        ? {
            loaded: true,
            title: bookIndex.meta.title,
            author: bookIndex.meta.author,
            chunks: bookIndex.meta.chunkCount,
          }
        : { loaded: false, error: bookIndex.error || null },
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // GET /book/status — canonical EPUB index for the learning UI
  if (pathname === '/book/status' && request.method === 'GET') {
    response.writeHead(200);
    response.end(JSON.stringify({
      loaded: bookIndex.loaded,
      title: bookIndex.meta?.title || null,
      author: bookIndex.meta?.author || null,
      chunk_count: bookIndex.meta?.chunkCount ?? 0,
      epub_path: bookIndex.meta?.epubPath || null,
      error: bookIndex.error || null,
      context_in_explain: config.bookContextInExplain,
      context_in_generate: config.bookContextInGenerate,
    }));
    return;
  }

  // GET /book/search?q=…
  if (pathname === '/book/search' && request.method === 'GET') {
    if (!bookIndex.loaded || !bookIndex.chunks.length) {
      response.writeHead(503);
      response.end(JSON.stringify({
        error: 'Book not loaded',
        hint: 'Set BOOK_EPUB_PATH, BOOK_EPUB_URL, or add data/latest_book.epub to the server',
        results: [],
      }));
      return;
    }
    const q = url.searchParams.get('q') || '';
    const limit = Number(url.searchParams.get('limit') || 12);
    const diverse =
      url.searchParams.get('diverse') === '1' || url.searchParams.get('diverse') === 'true';
    const brief = url.searchParams.get('brief') === '1' || url.searchParams.get('brief') === 'true';
    const thRaw = url.searchParams.get('diversity_threshold');
    const diversityThreshold = thRaw != null && thRaw !== '' ? Number(thRaw) : undefined;
    const results = searchChunks(bookIndex.chunks, q, limit, {
      diverse,
      excerptMax: brief ? 360 : 700,
      excerptAnchorQuery: diverse && brief,
      ...(Number.isFinite(diversityThreshold) && diversityThreshold > 0 && diversityThreshold < 1
        ? { diversityThreshold }
        : {}),
    });
    response.writeHead(200);
    response.end(JSON.stringify({ query: q, results, diverse, brief }));
    return;
  }

  // POST /book/reload — re-index EPUB after file edits
  if (pathname === '/book/reload' && request.method === 'POST') {
    loadBookIndex();
    response.writeHead(200);
    response.end(JSON.stringify({
      success: true,
      loaded: bookIndex.loaded,
      chunk_count: bookIndex.meta?.chunkCount ?? 0,
      title: bookIndex.meta?.title || null,
      error: bookIndex.error || null,
    }));
    return;
  }

  // GET /egress-ip — returns this server's outbound IP (add to Oracle DB allow list)
  if (pathname === '/egress-ip' && request.method === 'GET') {
    fetch('https://api.ipify.org?format=json')
      .then(res => res.json())
      .then(data => {
        const ip = data.ip || 'unknown';
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          egress_ip: ip,
          hint: 'Add this IP to Oracle Cloud → your Autonomous DB → Network → Access Control List (allowlisted IPs).',
        }));
      })
      .catch(err => {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: err.message, egress_ip: null }));
      });
    return;
  }

  // POST /reload-rules
  if (pathname === '/reload-rules' && request.method === 'POST') {
    const ok = loadSQLRules();
    if (!ok) {
      response.writeHead(500);
      response.end(JSON.stringify({ success: false, error: 'Could not reload SQL generation rules' }));
      return;
    }
    response.writeHead(200);
    response.end(JSON.stringify({
      success: true,
      loaded_rules: Object.keys(SQL_GENERATION_RULES).length,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // POST /generate-sql
  if (pathname === '/generate-sql' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const question = data.question || '';
        const mode = resolveSqlModeFromRequest(data.mode);

        if (!question) {
          response.writeHead(400);
          response.end(JSON.stringify({ error: 'No question provided' }));
          return;
        }

        const result = await generateSql(question, mode);

        if (!result.sql && !result.tutor_response) {
          response.writeHead(404);
          response.end(JSON.stringify({
            error: result.error || 'No answer generated',
            question,
            source: result.source,
            mode,
          }));
          return;
        }

        response.writeHead(200);
        response.end(JSON.stringify({
          question,
          generated_sql: result.sql || null,
          tutor_response: result.tutor_response || null,
          source: result.source,
          mode,
          success: true,
          book_context_used: !!result.book_context_used,
          book_citations: result.book_citations || [],
        }));
      } catch (error) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // POST /explain-sql — explain a SQL query for learning
  if (pathname === '/explain-sql' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const sql = String(data.sql || '');
        const question = String(data.question || '');
        const useBookContext = data.use_book_context !== false;
        const r = await explainSqlWithLLM(sql, question, { useBookContext });
        if (!r.explanation) {
          response.writeHead(400);
          response.end(JSON.stringify({
            success: false,
            error: r.error || 'No explanation generated',
            source: r.source,
            book_citations: r.book_citations || [],
          }));
          return;
        }
        response.writeHead(200);
        response.end(JSON.stringify({
          success: true,
          explanation: r.explanation,
          source: r.source,
          book_citations: r.book_citations || [],
        }));
      } catch (error) {
        response.writeHead(400);
        response.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // POST /execute-sql — run SELECT only (opt-in via EXECUTE_SQL_ENABLED; DB must be reachable)
  if (pathname === '/execute-sql' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', async () => {
      if (!config.enableExecuteSql || !oracledb || !config.dbDsn || !config.dbUser || !config.dbPassword) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          success: false,
          error: 'SQL execution is disabled on this server. Copy the SQL and run it in your database client (e.g. SQL Developer).',
          execute_available: false,
        }));
        return;
      }
      try {
        const data = JSON.parse(body);
        const sql = (data.sql || '').trim().replace(/;\s*$/, '');
        if (!sql) {
          response.writeHead(400);
          response.end(JSON.stringify({ success: false, error: 'No SQL provided' }));
          return;
        }
        const upper = sql.toUpperCase();
        if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
          response.writeHead(400);
          response.end(JSON.stringify({
            success: false,
            error: 'Only SELECT (and WITH … SELECT) queries are allowed for execution.',
          }));
          return;
        }
        const connectString = config.dbDsn || `${config.dbHost}:${config.dbPort}/${config.dbSid}`;
        const connConfig = {
          user: config.dbUser,
          password: config.dbPassword,
          connectString,
        };
        if (config.dbWalletPath) {
          connConfig.configDir = config.dbWalletPath;
        }
        const conn = await oracledb.getConnection(connConfig);
        try {
          const result = await conn.execute(sql, [], {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            maxRows: 500,
          });
          const rows = result.rows || [];
          const meta = result.metaData ? result.metaData.map(m => m.name) : [];
          response.writeHead(200);
          response.end(JSON.stringify({
            success: true,
            columns: meta,
            rows,
            rowCount: rows.length,
          }));
        } finally {
          await conn.close();
        }
      } catch (err) {
        response.writeHead(500);
        response.end(JSON.stringify({
          success: false,
          error: err.message || String(err),
          execute_available: true,
        }));
      }
    });
    return;
  }

  // POST /generate-batch
  if (pathname === '/generate-batch' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const questions = data.questions || [];
        const mode = resolveSqlModeFromRequest(data.mode);

        const results = await Promise.all(
          questions.map(async (q) => {
            const generated = await generateSql(q, mode);
            return {
              question: q,
              generated_sql: generated.sql,
              tutor_response: generated.tutor_response || null,
              source: generated.source,
              success: generated.sql !== null || !!generated.tutor_response,
              error: generated.sql || generated.tutor_response ? null : generated.error,
              book_context_used: !!generated.book_context_used,
              book_citations: generated.book_citations || [],
            };
          })
        );

        response.writeHead(200);
        response.end(JSON.stringify({
          total: questions.length,
          mode,
          results,
          timestamp: new Date().toISOString(),
        }));
      } catch (error) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // GET /api/tools — lab capabilities (oracledb readiness, tool names)
  if (pathname === '/api/tools' && request.method === 'GET') {
    const dbReady = !!(config.enableExecuteSql && oracledb && config.dbDsn && config.dbUser && config.dbPassword);
    response.writeHead(200);
    response.end(JSON.stringify({
      server: `${APP_DISPLAY_NAME} (Node.js + oracledb)`,
      db_ready: dbReady,
      connection: dbReady ? `${config.dbUser}@${config.dbDsn}` : null,
      tools: [
        { name: 'list-connections', description: 'Show configured database connection status' },
        { name: 'schema-information', description: 'List tables and columns. Pass tableName for one table.' },
        { name: 'run-sql', description: 'Run Oracle SQL (SELECT / WITH, or DDL/DML when execution is enabled)' },
        { name: 'run-sqlcl', description: 'Schema shortcuts: DESC <table>, SHOW TABLES' },
      ],
    }));
    return;
  }

  // POST /api/invoke — browser SQL lab (oracledb)
  if (pathname === '/api/invoke' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch (_) {
        response.writeHead(400);
        response.end(JSON.stringify({ success: false, tool: null, error: 'Invalid JSON body' }));
        return;
      }

      const tool = String(data.tool || '').trim().toLowerCase();
      const params = data.params || {};
      const dbReady = !!(config.enableExecuteSql && oracledb && config.dbDsn && config.dbUser && config.dbPassword);

      // ── list-connections ──────────────────────────────────────
      if (tool === 'list-connections') {
        response.writeHead(200);
        response.end(JSON.stringify({
          success: true, tool,
          result: {
            connections: (config.dbDsn && config.dbUser)
              ? [{ name: config.dbDsn, user: config.dbUser, status: dbReady ? 'configured' : 'not available', execute_enabled: !!config.enableExecuteSql }]
              : [],
            oracledb_available: !!oracledb,
            execute_enabled: !!config.enableExecuteSql,
          },
        }));
        return;
      }

      // ── schema-information ────────────────────────────────────
      if (tool === 'schema-information') {
        const tableName = params.tableName
          ? String(params.tableName).toUpperCase().replace(/[^A-Z0-9_$#]/g, '')
          : null;
        if (dbReady) {
          const connConfig = { user: config.dbUser, password: config.dbPassword, connectString: config.dbDsn };
          if (config.dbWalletPath) connConfig.configDir = config.dbWalletPath;
          let conn;
          try {
            conn = await oracledb.getConnection(connConfig);
            if (tableName) {
              const r = await conn.execute(
                `SELECT COLUMN_NAME, DATA_TYPE,
                        CASE WHEN DATA_TYPE IN ('VARCHAR2','CHAR','NVARCHAR2','RAW') THEN TO_CHAR(DATA_LENGTH)
                             WHEN DATA_PRECISION IS NOT NULL THEN TO_CHAR(DATA_PRECISION) || ',' || TO_CHAR(DATA_SCALE)
                             ELSE NULL END AS SIZE_PREC,
                        NULLABLE
                 FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :t ORDER BY COLUMN_ID`,
                { t: tableName },
                { outFormat: oracledb.OUT_FORMAT_OBJECT }
              );
              response.writeHead(200);
              response.end(JSON.stringify({ success: true, tool, source: 'database', result: { tableName, columns: r.rows || [] } }));
            } else {
              const r = await conn.execute(
                `SELECT TABLE_NAME FROM USER_TABLES ORDER BY TABLE_NAME`,
                [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
              );
              response.writeHead(200);
              response.end(JSON.stringify({ success: true, tool, source: 'database', result: { tables: (r.rows || []).map(row => row.TABLE_NAME) } }));
            }
          } catch (err) {
            response.writeHead(500);
            response.end(JSON.stringify({ success: false, tool, error: err.message }));
          } finally {
            if (conn) { try { await conn.close(); } catch (_) {} }
          }
        } else {
          try {
            const raw = fs.readFileSync(path.join(__dirname, 'schema-reference.json'), 'utf8');
            const schema = JSON.parse(raw);
            const tables = (schema.tables || []).map(t => t.name);
            if (tableName) {
              const tableInfo = (schema.tables || []).find(t => t.name === tableName);
              if (!tableInfo) {
                response.writeHead(404);
                response.end(JSON.stringify({ success: false, tool, error: `Table ${tableName} not found in static schema` }));
              } else {
                const columns = (tableInfo.columns || []).map(c => ({ COLUMN_NAME: c, DATA_TYPE: '—', SIZE_PREC: null, NULLABLE: '—' }));
                response.writeHead(200);
                response.end(JSON.stringify({ success: true, tool, source: 'static', result: { tableName, columns } }));
              }
            } else {
              response.writeHead(200);
              response.end(JSON.stringify({ success: true, tool, source: 'static', result: { tables } }));
            }
          } catch (_) {
            response.writeHead(503);
            response.end(JSON.stringify({ success: false, tool, error: 'DB execution not available and schema-reference.json could not be read' }));
          }
        }
        return;
      }

      // ── run-sql ───────────────────────────────────────────────
      if (tool === 'run-sql') {
        if (!dbReady) {
          response.writeHead(503);
          response.end(JSON.stringify({ success: false, tool, error: 'SQL execution not enabled. Set EXECUTE_SQL_ENABLED=true and configure DB_DSN/DB_USER/DB_PASSWORD in .env' }));
          return;
        }
        const sql = String(params.sql || '').trim().replace(/;\s*$/, '');
        if (!sql) {
          response.writeHead(400);
          response.end(JSON.stringify({ success: false, tool, error: 'Missing params.sql' }));
          return;
        }
        const upper = sql.toUpperCase().trim();
        const isSelect = upper.startsWith('SELECT') || upper.startsWith('WITH');
        const isMutating = /^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|BEGIN)\b/.test(upper);
        if (!isSelect && !isMutating) {
          response.writeHead(400);
          response.end(JSON.stringify({
            success: false,
            tool,
            error: 'Only SELECT / WITH, or supported DDL/DML statements, are permitted.',
          }));
          return;
        }
        const connConfig = { user: config.dbUser, password: config.dbPassword, connectString: config.dbDsn };
        if (config.dbWalletPath) connConfig.configDir = config.dbWalletPath;
        let conn;
        try {
          conn = await oracledb.getConnection(connConfig);
          if (isSelect) {
            const r = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 500 });
            const rows = r.rows || [];
            const columns = r.metaData ? r.metaData.map(m => m.name) : [];
            response.writeHead(200);
            response.end(JSON.stringify({ success: true, tool, result: { columns, rows, rowCount: rows.length } }));
          } else {
            const r = await conn.execute(sql, [], { autoCommit: true });
            let n = r.rowsAffected;
            if (Array.isArray(n)) n = n.reduce((a, b) => a + (Number(b) || 0), 0);
            else n = Number(n) || 0;
            response.writeHead(200);
            response.end(JSON.stringify({
              success: true,
              tool,
              raw: `Rows affected: ${n}`,
              result: {
                columns: ['ROWS_AFFECTED'],
                rows: [{ ROWS_AFFECTED: String(n) }],
                rowCount: 1,
                rowsAffected: n,
                mutating: true,
              },
            }));
          }
        } catch (err) {
          response.writeHead(500);
          response.end(JSON.stringify({ success: false, tool, error: err.message }));
        } finally {
          if (conn) { try { await conn.close(); } catch (_) {} }
        }
        return;
      }

      // ── run-sqlcl ─────────────────────────────────────────────
      if (tool === 'run-sqlcl') {
        const cmd = String(params.command || '').trim();
        if (!cmd) {
          response.writeHead(400);
          response.end(JSON.stringify({ success: false, tool, error: 'Missing params.command' }));
          return;
        }

        // DESC / DESCRIBE <table>
        const descMatch = cmd.match(/^(?:desc(?:ribe)?)\s+(\w+)\s*$/i);
        if (descMatch) {
          const tbl = descMatch[1].toUpperCase().replace(/[^A-Z0-9_$#]/g, '');
          if (!dbReady) {
            response.writeHead(503);
            response.end(JSON.stringify({ success: false, tool, error: 'DB execution not enabled.' }));
            return;
          }
          const connConfig = { user: config.dbUser, password: config.dbPassword, connectString: config.dbDsn };
          if (config.dbWalletPath) connConfig.configDir = config.dbWalletPath;
          let conn;
          try {
            conn = await oracledb.getConnection(connConfig);
            const r = await conn.execute(
              `SELECT COLUMN_NAME,
                      DATA_TYPE,
                      CASE WHEN DATA_TYPE IN ('VARCHAR2','CHAR','NVARCHAR2','RAW') THEN TO_CHAR(DATA_LENGTH)
                           WHEN DATA_PRECISION IS NOT NULL THEN TO_CHAR(DATA_PRECISION) || ',' || TO_CHAR(DATA_SCALE)
                           ELSE NULL END AS SIZE_PREC,
                      NULLABLE
               FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :t ORDER BY COLUMN_ID`,
              { t: tbl },
              { outFormat: oracledb.OUT_FORMAT_OBJECT }
            );
            if (!r.rows || r.rows.length === 0) {
              response.writeHead(404);
              response.end(JSON.stringify({ success: false, tool, error: `Table ${tbl} not found.` }));
            } else {
              response.writeHead(200);
              response.end(JSON.stringify({
                success: true, tool, command: cmd,
                result: { columns: ['COLUMN_NAME', 'DATA_TYPE', 'SIZE_PREC', 'NULLABLE'], rows: r.rows, rowCount: r.rows.length },
              }));
            }
          } catch (err) {
            response.writeHead(500);
            response.end(JSON.stringify({ success: false, tool, error: err.message }));
          } finally {
            if (conn) { try { await conn.close(); } catch (_) {} }
          }
          return;
        }

        // SHOW TABLES
        if (/^show\s+tables?\s*$/i.test(cmd)) {
          if (!dbReady) {
            response.writeHead(503);
            response.end(JSON.stringify({ success: false, tool, error: 'DB execution not enabled.' }));
            return;
          }
          const connConfig = { user: config.dbUser, password: config.dbPassword, connectString: config.dbDsn };
          if (config.dbWalletPath) connConfig.configDir = config.dbWalletPath;
          let conn;
          try {
            conn = await oracledb.getConnection(connConfig);
            const r = await conn.execute(
              `SELECT TABLE_NAME, NUM_ROWS FROM USER_TABLES ORDER BY TABLE_NAME`,
              [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
            );
            const rows = r.rows || [];
            response.writeHead(200);
            response.end(JSON.stringify({
              success: true, tool, command: cmd,
              result: { columns: ['TABLE_NAME', 'NUM_ROWS'], rows, rowCount: rows.length },
            }));
          } catch (err) {
            response.writeHead(500);
            response.end(JSON.stringify({ success: false, tool, error: err.message }));
          } finally {
            if (conn) { try { await conn.close(); } catch (_) {} }
          }
          return;
        }

        // Unsupported command
        response.writeHead(422);
        response.end(JSON.stringify({
          success: false, tool,
          error: `Command not supported: "${cmd}". Supported: DESC <table>, SHOW TABLES`,
        }));
        return;
      }

      response.writeHead(400);
      response.end(JSON.stringify({
        success: false,
        error: `Unknown tool: "${data.tool}". Available: list-connections, schema-information, run-sql, run-sqlcl`,
      }));
    });
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ error: 'Not found' }));
};

// ── Start Server ──────────────────────────────────────────────────────────────

const server = http.createServer(requestHandler);

// Keep-alive: ping /health every 14 min to prevent Render free-tier spin-down
const RENDER_KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL
  ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/health'
  : null;
if (RENDER_KEEP_ALIVE_URL) {
  setInterval(() => {
    fetch(RENDER_KEEP_ALIVE_URL).catch(() => {});
  }, 14 * 60 * 1000);
}

const listenHost = process.env.BIND_HOST || '0.0.0.0';

async function startServer() {
  try {
    await ensureBookEpubFromUrl();
  } catch (e) {
    console.warn(`[${APP_DISPLAY_NAME}] Book EPUB URL fetch skipped:`, e.message || e);
  }
  loadBookIndex();

  server.listen(config.httpPort, listenHost, () => {
    console.log(`[${APP_DISPLAY_NAME}] HTTP API listening on http://${listenHost}:${config.httpPort}`);
    console.log(`[${APP_DISPLAY_NAME}] Database: ${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbSid}`);
    console.log(`[${APP_DISPLAY_NAME}] LLM enabled: ${config.enableLLMSqlGeneration} (model: ${config.llmModel})`);
    console.log(`[${APP_DISPLAY_NAME}] Endpoints:`);
    console.log(`  GET  /health          - Server health check`);
    console.log(`  POST /reload-rules    - Reload SQL rules from experiments/sql-practice-rules.json`);
    console.log(`  POST /generate-sql    - Generate SQL (SQL_GENERATION_MODE=${config.sqlGenerationMode})`);
    console.log(`  POST /generate-batch  - Batch SQL generation (SQL_GENERATION_MODE=${config.sqlGenerationMode})`);
    if (bookIndex.loaded) {
      console.log(`  GET  /book/search     - Search "${bookIndex.meta.title}" (${bookIndex.meta.chunkCount} chunks)`);
    }
  });
}

startServer();

server.on('error', (error) => {
  console.error(`[${APP_DISPLAY_NAME}] Error:`, error);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`[${APP_DISPLAY_NAME}] ${signal} received, closing HTTP server…`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
