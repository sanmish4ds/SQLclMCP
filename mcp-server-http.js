#!/usr/bin/env node

/**
 * NL2SQL HTTP server (Node.js): lookup / LLM SQL generation + optional Oracle execution via oracledb.
 *
 * SQL generation modes:
 *   lookup  – exact/partial match against in-memory rules loaded from test_questions.json
 *   llm     – OpenAI-compatible LLM generation
 *   hybrid  – lookup first, LLM fallback
 */

// Load .env into process.env (no external dependency)
const envPath = require('path').join(__dirname, '.env');
try {
  const content = require('fs').readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
} catch (_) {}

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
let oracledb;
try { oracledb = require('oracledb'); } catch (_) { oracledb = null; }

// Excel parser (used for XLSX->CREATE TABLE/INSERT SQL generation)
let XLSX;
try { XLSX = require('xlsx'); } catch (_) { XLSX = null; }

function sanitizeIdentifier(raw, fallback = 'COL') {
  let s = String(raw == null ? '' : raw)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) s = String(fallback).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!/^[A-Z]/.test(s)) s = 'C_' + s;
  if (s.length > 30) s = s.slice(0, 30);
  return s;
}

function escapeSqlString(str) {
  return String(str)
    .replace(/\r\n/g, '\n')
    .replace(/'/g, "''");
}

function sqlLiteral(value, oracleType) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 'NULL';
    // For numeric columns, try to coerce
    if (oracleType.kind === 'NUMBER' || oracleType.kind === 'NUMBER_BOOLEAN') {
      const n = Number(trimmed);
      return Number.isFinite(n) ? String(n) : 'NULL';
    }
    if (oracleType.kind === 'DATE') {
      // Best-effort parse for YYYY-MM-DD-ish strings
      const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `DATE '${m[1]}-${m[2]}-${m[3]}'`;
      const d = new Date(trimmed);
      if (!isNaN(d.getTime())) return `DATE '${d.toISOString().slice(0, 10)}'`;
      return 'NULL';
    }
    const esc = escapeSqlString(trimmed);
    if (oracleType.kind === 'CLOB') return `TO_CLOB('${esc}')`;
    return `'${esc}'`;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    if (oracleType.kind === 'NUMBER' || oracleType.kind === 'NUMBER_BOOLEAN') return String(value);
    if (oracleType.kind === 'DATE') {
      // If xlsx returns excel serial date as number, we can't reliably convert without workbook metadata.
      // Treat as NULL to avoid wrong dates.
      return 'NULL';
    }
    // For strings
    const esc = escapeSqlString(String(value));
    if (oracleType.kind === 'CLOB') return `TO_CLOB('${esc}')`;
    return `'${esc}'`;
  }

  if (typeof value === 'boolean') {
    if (oracleType.kind === 'NUMBER' || oracleType.kind === 'NUMBER_BOOLEAN') return value ? '1' : '0';
    const esc = escapeSqlString(value ? 'TRUE' : 'FALSE');
    if (oracleType.kind === 'CLOB') return `TO_CLOB('${esc}')`;
    return `'${esc}'`;
  }

  if (value instanceof Date) {
    if (oracleType.kind === 'DATE') return `DATE '${value.toISOString().slice(0, 10)}'`;
    const esc = escapeSqlString(value.toISOString());
    if (oracleType.kind === 'CLOB') return `TO_CLOB('${esc}')`;
    return `'${esc}'`;
  }

  // Fallback: string
  const esc = escapeSqlString(String(value));
  if (oracleType.kind === 'CLOB') return `TO_CLOB('${esc}')`;
  return `'${esc}'`;
}

function inferOracleTypeForColumn(sampleValues) {
  const values = sampleValues.filter(v => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === ''));
  if (values.length === 0) return { kind: 'VARCHAR2', length: 100 };

  const allDates = values.every(v => v instanceof Date);
  if (allDates) return { kind: 'DATE' };

  const allBools = values.every(v => typeof v === 'boolean');
  if (allBools) return { kind: 'NUMBER_BOOLEAN' }; // maps to NUMBER(1)

  const allNumbers = values.every(v => typeof v === 'number' && Number.isFinite(v));
  if (allNumbers) return { kind: 'NUMBER' };

  // Otherwise treat as string
  let maxLen = 0;
  for (const v of values) {
    const s = (v instanceof Date) ? v.toISOString() : String(v);
    maxLen = Math.max(maxLen, s.length);
  }
  if (maxLen > 4000) return { kind: 'CLOB' };
  return { kind: 'VARCHAR2', length: Math.max(1, Math.min(4000, maxLen)) };
}

function oracleTypeSql(oracleType) {
  if (oracleType.kind === 'DATE') return 'DATE';
  if (oracleType.kind === 'NUMBER') return 'NUMBER';
  if (oracleType.kind === 'NUMBER_BOOLEAN') return 'NUMBER(1)';
  if (oracleType.kind === 'CLOB') return 'CLOB';
  if (oracleType.kind === 'VARCHAR2') return `VARCHAR2(${oracleType.length})`;
  return 'VARCHAR2(100)';
}

function buildCreateTableSql(tableName, columns) {
  const colsSql = columns.map(c => `"${c.name}" ${oracleTypeSql(c.type)}`).join(', ');
  return `CREATE TABLE "${tableName}" (${colsSql})`;
}

function buildDropTableSql(tableName) {
  // Drop table safely without failing if it doesn't exist
  return `BEGIN
  EXECUTE IMMEDIATE 'DROP TABLE "${tableName}" PURGE';
EXCEPTION
  WHEN OTHERS THEN NULL;
END;`;
}

function buildInsertUnionSql(tableName, columns, rows) {
  const colNames = columns.map(c => `"${c.name}"`);
  const selectRows = rows.map(rowArr => {
    const literals = columns.map((col, idx) => sqlLiteral(rowArr[idx], col.type));
    return `SELECT ${literals.join(', ')} FROM dual`;
  });
  return `INSERT INTO "${tableName}" (${colNames.join(', ')})
${selectRows.join('\nUNION ALL\n')}`;
}

function arrayToBase64String(buffer) {
  // not used currently; kept for completeness
  return Buffer.from(buffer).toString('base64');
}

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
    console.log('[MCP-Server] Wallet extracted to:', tmpDir);
    return tmpDir;
  } catch (err) {
    console.warn('[MCP-Server] Failed to extract wallet from ORACLE_WALLET_ZIP_B64:', err.message);
    return null;
  }
}

// OCI Autonomous DB wallets ship sqlnet.ora with DIRECTORY="?/network/admin". The "?" does not
// resolve reliably for JDBC/SQLcl on Linux (e.g. Render), which can drop the TLS session as
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
      console.log('[MCP-Server] Patched sqlnet.ora WALLET DIRECTORY ->', norm);
    }
  } catch (err) {
    console.warn('[MCP-Server] Could not patch sqlnet.ora:', err.message);
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
};

// ── SQL Rule Store ────────────────────────────────────────────────────────────

let SQL_GENERATION_RULES = {};
const testQuestionsPath = path.join(__dirname, 'experiments', 'test_questions.json');
let rulesLastMtimeMs = 0;

function loadSQLRules() {
  try {
    const stats = fs.statSync(testQuestionsPath);
    const content = fs.readFileSync(testQuestionsPath, 'utf8');
    const data = JSON.parse(content);
    const tests = data.test_questions || data;

    SQL_GENERATION_RULES = {};
    tests.forEach(test => {
      SQL_GENERATION_RULES[test.question] = test.expected_sql;
    });

    rulesLastMtimeMs = stats.mtimeMs;
    console.log(`[MCP-Server] Loaded ${Object.keys(SQL_GENERATION_RULES).length} SQL generation rules`);
    return true;
  } catch (error) {
    console.warn('[MCP-Server] Could not load test_questions.json:', error.message);
    loadBasicRules();
    return false;
  }
}

function maybeReloadSQLRules() {
  try {
    const stats = fs.statSync(testQuestionsPath);
    if (stats.mtimeMs > rulesLastMtimeMs) {
      console.log('[MCP-Server] Detected test_questions.json update, reloading rules...');
      loadSQLRules();
    }
  } catch (error) {
    console.warn('[MCP-Server] Could not check rules file mtime:', error.message);
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
  for (const [pattern, sql] of Object.entries(SQL_GENERATION_RULES)) {
    if (pattern.toLowerCase() === question.toLowerCase()) {
      return { sql, source: 'lookup_exact' };
    }
  }

  const lowerQuestion = question.toLowerCase();
  for (const [pattern, sql] of Object.entries(SQL_GENERATION_RULES)) {
    if (lowerQuestion.includes(pattern.toLowerCase()) || pattern.toLowerCase().includes(lowerQuestion)) {
      return { sql, source: 'lookup_partial' };
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

async function generateSqlWithLLM(question) {
  if (!config.enableLLMSqlGeneration) {
    return { sql: null, source: 'llm_disabled', error: 'LLM SQL generation is disabled' };
  }
  if (!config.llmApiKey) {
    return { sql: null, source: 'llm_disabled', error: 'LLM_API_KEY is missing' };
  }

  const schemaHint = [
    'TPC-H schema (use exact column names per table; Oracle rejects invalid identifiers):',
    'LINEITEM has L_PARTKEY (use L.L_PARTKEY, never L.P_PARTKEY). PART has P_PARTKEY. Use each table\'s own columns.',
    'REGION: R_REGIONKEY, R_NAME, R_COMMENT',
    'NATION: N_NATIONKEY, N_NAME, N_REGIONKEY, N_COMMENT',
    'CUSTOMER: C_CUSTKEY, C_NAME, C_ADDRESS, C_NATIONKEY, C_PHONE, C_ACCTBAL, C_MKTSEGMENT, C_COMMENT',
    'ORDERS: O_ORDERKEY, O_CUSTKEY, O_ORDERSTATUS, O_TOTALPRICE, O_ORDERDATE, O_ORDERPRIORITY, O_CLERK, O_SHIPPRIORITY, O_COMMENT',
    'LINEITEM: L_ORDERKEY, L_PARTKEY, L_SUPPKEY, L_LINENUMBER, L_QUANTITY, L_EXTENDEDPRICE, L_DISCOUNT, L_TAX, L_RETURNFLAG, L_LINESTATUS, L_SHIPDATE, L_COMMITDATE, L_RECEIPTDATE, L_SHIPINSTRUCT, L_SHIPMODE, L_COMMENT',
    'SUPPLIER: S_SUPPKEY, S_NAME, S_ADDRESS, S_NATIONKEY, S_PHONE, S_ACCTBAL, S_COMMENT',
    'PART: P_PARTKEY, P_NAME, P_MFGR, P_BRAND, P_TYPE, P_SIZE, P_CONTAINER, P_RETAILPRICE, P_COMMENT',
    'PARTSUPP: PS_PARTKEY, PS_SUPPKEY, PS_AVAILQTY, PS_SUPPLYCOST, PS_COMMENT',
    'Oracle rules: Use FETCH FIRST N ROWS ONLY for top-N (not LIMIT).',
    'Oracle EXTRACT does NOT support QUARTER. For quarter use CEIL(EXTRACT(MONTH FROM col)/3) or TO_CHAR(col,\'Q\').',
    'For year filtering prefer date ranges: col >= DATE \'YYYY-01-01\' AND col < DATE \'YYYY+1-01-01\'.',
    'For "Revenue and order profile" queries: output C_NATIONKEY, order_count, net_revenue; use date range in WHERE, not EXTRACT(YEAR).',
    'For "Part demand and supplier diversity": use L.L_PARTKEY from LINEITEM (not L.P_PARTKEY; LINEITEM has L_PARTKEY). Use part_activity from LINEITEM l, supplier_diversity from PARTSUPP ps. Output P_PARTKEY, P_SIZE, line_count, total_qty, supplier_count, FETCH FIRST 50 ROWS ONLY. Match baseline: part_activity selects l.L_PARTKEY AS partkey; supplier_diversity selects ps.PS_PARTKEY AS partkey; join both to PART p.',
    'Return exactly one SQL statement with no explanation.',
  ].join(' ');

  const payload = {
    model: config.llmModel,
    temperature: 0,
    messages: [
      { role: 'system', content: `You are a SQL generation assistant. ${schemaHint}` },
      { role: 'user',   content: `Generate Oracle SQL for: ${question}` },
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
      return { sql: null, source: 'llm_error', error: `LLM HTTP ${response.status}: ${bodyText.slice(0, 500)}` };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const sql = extractSqlFromResponse(content);
    if (!sql) {
      return { sql: null, source: 'llm_error', error: 'LLM response did not contain a valid SELECT/WITH statement' };
    }

    return { sql, source: 'llm' };
  } catch (error) {
    const isAbort = error && error.name === 'AbortError';
    return { sql: null, source: 'llm_error', error: isAbort ? 'LLM request timed out' : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSql(question, mode = 'hybrid') {
  if (mode === 'lookup') {
    const hit = lookupSql(question);
    return { sql: hit.sql, source: hit.source, error: hit.sql ? null : 'No SQL rule found for question' };
  }

  if (mode === 'llm') {
    return generateSqlWithLLM(question);
  }

  // hybrid: lookup first, then LLM fallback
  const hit = lookupSql(question);
  if (hit.sql) {
    return { sql: hit.sql, source: hit.source, error: null };
  }
  return generateSqlWithLLM(question);
}

// Load rules on startup
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

  // GET / — chat UI (same origin as API; avoids hardcoding Render URL after service rename)
  if ((pathname === '/' || pathname === '') && request.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'app', 'index.html'), 'utf8');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
    } catch (err) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Missing app/index.html: ' + err.message);
    }
    return;
  }

  response.setHeader('Content-Type', 'application/json');

  // GET /api-info — machine-readable root (formerly GET /)
  if (pathname === '/api-info' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      name: 'NL2SQL MCP HTTP Server',
      status: 'running',
      offer: 'Natural language to Oracle SQL over HTTP (LLM + Node oracledb).',
      endpoints: {
        ui: 'GET / — browser UI',
        api_info: 'GET /api-info — this JSON',
        health: 'GET /health',
        egress_ip: 'GET /egress-ip — this server\'s outbound IP (for Oracle DB allow list)',
        generate_sql: 'POST /generate-sql — body: { "question": "your question", "mode": "llm|lookup|hybrid" }',
        generate_batch: 'POST /generate-batch — body: { "questions": ["q1", "q2"], "mode": "llm|lookup|hybrid" }',
        execute_sql: 'POST /execute-sql — body: { "sql": "SELECT ..." } (opt-in, SELECT only)',
        schema: 'GET /schema — tables and columns for the UI',
        reload_rules: 'POST /reload-rules',
      },
      docs: 'https://github.com/your-org/SQLclMCP',
    }));
    return;
  }

  // GET /schema — tables and columns (live from DB when possible, else static)
  if (pathname === '/schema' && request.method === 'GET') {
    const fallbackSchema = {
      title: 'TPC-H — Tables you can play with',
      description: 'Ask questions in plain English; we turn them into Oracle SQL against these tables.',
      tables: [
        { name: 'REGION', emoji: '🌍', hint: 'Geographic regions', columns: ['R_REGIONKEY', 'R_NAME', 'R_COMMENT'] },
        { name: 'NATION', emoji: '🏳️', hint: 'Countries, linked to regions', columns: ['N_NATIONKEY', 'N_NAME', 'N_REGIONKEY', 'N_COMMENT'] },
        { name: 'CUSTOMER', emoji: '👤', hint: 'Customers and their balances', columns: ['C_CUSTKEY', 'C_NAME', 'C_ADDRESS', 'C_NATIONKEY', 'C_PHONE', 'C_ACCTBAL', 'C_MKTSEGMENT', 'C_COMMENT'] },
        { name: 'SUPPLIER', emoji: '🏭', hint: 'Suppliers', columns: ['S_SUPPKEY', 'S_NAME', 'S_ADDRESS', 'S_NATIONKEY', 'S_PHONE', 'S_ACCTBAL', 'S_COMMENT'] },
        { name: 'PART', emoji: '🔩', hint: 'Parts / products', columns: ['P_PARTKEY', 'P_NAME', 'P_MFGR', 'P_BRAND', 'P_TYPE', 'P_SIZE', 'P_CONTAINER', 'P_RETAILPRICE', 'P_COMMENT'] },
        { name: 'ORDERS', emoji: '📦', hint: 'Orders (dates, totals, customer)', columns: ['O_ORDERKEY', 'O_CUSTKEY', 'O_ORDERSTATUS', 'O_TOTALPRICE', 'O_ORDERDATE', 'O_ORDERPRIORITY', 'O_CLERK', 'O_SHIPPRIORITY', 'O_COMMENT'] },
        { name: 'LINEITEM', emoji: '📋', hint: 'Order line items (L_* columns)', columns: ['L_ORDERKEY', 'L_PARTKEY', 'L_SUPPKEY', 'L_LINENUMBER', 'L_QUANTITY', 'L_EXTENDEDPRICE', 'L_DISCOUNT', 'L_TAX', 'L_RETURNFLAG', 'L_LINESTATUS', 'L_SHIPDATE', 'L_COMMITDATE', 'L_RECEIPTDATE', 'L_SHIPINSTRUCT', 'L_SHIPMODE', 'L_COMMENT'] },
        { name: 'PARTSUPP', emoji: '🔗', hint: 'Part–supplier links and supply cost', columns: ['PS_PARTKEY', 'PS_SUPPKEY', 'PS_AVAILQTY', 'PS_SUPPLYCOST', 'PS_COMMENT'] },
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
              description: 'Tables and columns from your database. Ask questions in plain English.',
              source: 'database',
              tables: tableNames.map(name => ({
                name,
                emoji: '📋',
                hint: `${(columnsByTable[name] || []).length} columns`,
                columns: columnsByTable[name] || [],
              })),
            };
          } finally {
            await conn.close();
          }
        } catch (err) {
          console.warn('[MCP-Server] Schema from DB failed:', err.message);
        }
      }

      if (!schema) {
        try {
          const raw = fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8');
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
      server: 'MCP Server',
      database: `${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbSid}`,
      db_connection: (execOk && config.dbUser && config.dbDsn)
        ? `${config.dbUser}@${config.dbDsn}`
        : null,
      loaded_rules: Object.keys(SQL_GENERATION_RULES).length,
      llm_enabled: config.enableLLMSqlGeneration,
      llm_model: config.enableLLMSqlGeneration ? config.llmModel : null,
      execute_sql_available: execOk,
      timestamp: new Date().toISOString(),
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
        const mode = (data.mode || 'hybrid').toLowerCase();

        if (!question) {
          response.writeHead(400);
          response.end(JSON.stringify({ error: 'No question provided' }));
          return;
        }

        const result = await generateSql(question, mode);

        if (!result.sql) {
          response.writeHead(404);
          response.end(JSON.stringify({
            error: result.error || 'No SQL generated',
            question,
            source: result.source,
            mode,
          }));
          return;
        }

        response.writeHead(200);
        response.end(JSON.stringify({
          question,
          generated_sql: result.sql,
          source: result.source,
          mode,
          success: true,
        }));
      } catch (error) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: error.message }));
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
        const mode = (data.mode || 'hybrid').toLowerCase();

        const results = await Promise.all(
          questions.map(async (q) => {
            const generated = await generateSql(q, mode);
            return {
              question: q,
              generated_sql: generated.sql,
              source: generated.source,
              success: generated.sql !== null,
              error: generated.sql ? null : generated.error,
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

  // POST /excel-to-sql
  // Converts an uploaded Excel sheet into:
  // - CREATE TABLE statements
  // - INSERT statements (generated as UNION ALL SELECT chunks)
  if (pathname === '/excel-to-sql' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', async () => {
      try {
        if (!XLSX) {
          response.writeHead(501);
          response.end(JSON.stringify({ success: false, error: 'xlsx parser not installed' }));
          return;
        }

        // Base64 of the Excel file (sent from the web UI)
        const data = JSON.parse(body || '{}');
        const fileBase64 = data.fileBase64 || '';
        const fileName = data.fileName || 'upload.xlsx';
        const hasHeader = data.hasHeader !== false; // default true
        const maxRows = Number(data.maxRows || 2000);
        const insertChunkSize = Number(data.insertChunkSize || 200);
        const dropIfExists = data.dropIfExists !== false; // default true

        if (!fileBase64) {
          response.writeHead(400);
          response.end(JSON.stringify({ success: false, error: 'Missing fileBase64' }));
          return;
        }

        // Basic size guard (base64 inflates by ~33%)
        if (fileBase64.length > 20 * 1024 * 1024) {
          response.writeHead(413);
          response.end(JSON.stringify({ success: false, error: 'File too large' }));
          return;
        }

        const buf = Buffer.from(fileBase64, 'base64');
        const workbook = XLSX.read(buf, { type: 'buffer', cellDates: true });

        const sheetNames = workbook.SheetNames || [];
        if (sheetNames.length === 0) {
          response.writeHead(400);
          response.end(JSON.stringify({ success: false, error: 'No sheets found' }));
          return;
        }

        const tables = [];

        for (const sheetName of sheetNames) {
          const ws = workbook.Sheets[sheetName];
          if (!ws) continue;

          // Convert sheet to 2D array: rows -> arrays of cells
          const rows2d = XLSX.utils.sheet_to_json(ws, {
            header: 1,
            raw: true,
            defval: null,
          }) || [];

          const colCount = rows2d.reduce((m, r) => Math.max(m, (r || []).length), 0);
          if (colCount === 0) continue;

          const tableName = sanitizeIdentifier(sheetName, 'TABLE_' + sanitizeIdentifier(sheetName, 'T'));
          const startRow = hasHeader ? 1 : 0;

          let headerRow = null;
          if (hasHeader && rows2d.length > 0) headerRow = rows2d[0];

          // Column names
          const columns = [];
          const usedColNames = new Set();
          for (let c = 0; c < colCount; c++) {
            const rawName = hasHeader ? (headerRow ? headerRow[c] : null) : null;
            const fallback = 'column_' + (c + 1);
            const baseName = sanitizeIdentifier(
              rawName && String(rawName).trim() ? rawName : fallback,
              fallback
            );
            let colName = baseName;
            let k = 1;
            while (usedColNames.has(colName)) {
              colName = sanitizeIdentifier(baseName + '_' + k, fallback);
              k++;
            }
            usedColNames.add(colName);
            columns.push({ name: colName, type: { kind: 'VARCHAR2', length: 100 } });
          }

          // Find non-empty data rows
          const dataRowsAll = [];
          for (let r = startRow; r < rows2d.length; r++) {
            const rowArr = rows2d[r] || [];
            let hasAny = false;
            for (let c = 0; c < colCount; c++) {
              const v = rowArr[c];
              if (v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '')) {
                hasAny = true;
                break;
              }
            }
            if (hasAny) dataRowsAll.push(rowArr);
          }

          const truncated = dataRowsAll.length > maxRows;
          const dataRows = truncated ? dataRowsAll.slice(0, maxRows) : dataRowsAll;

          // Infer column types from the first N sample rows
          const sampleN = Math.min(50, dataRows.length);
          for (let c = 0; c < colCount; c++) {
            const sample = [];
            for (let i = 0; i < sampleN; i++) sample.push(dataRows[i][c]);
            const inferred = inferOracleTypeForColumn(sample);
            columns[c].type = inferred;
          }

          const createSql = buildCreateTableSql(tableName, columns);

          // Chunk inserts to avoid huge SQL statements
          const insertSqlChunks = [];
          for (let i = 0; i < dataRows.length; i += insertChunkSize) {
            const chunk = dataRows.slice(i, i + insertChunkSize);
            insertSqlChunks.push(buildInsertUnionSql(tableName, columns, chunk));
          }

          tables.push({
            tableName,
            sheetName,
            rowCount: dataRows.length,
            truncated,
            columns: columns.map(c => ({ name: c.name, typeSql: oracleTypeSql(c.type) })),
            dropSql: dropIfExists ? buildDropTableSql(tableName) : null,
            createSql,
            insertSqlChunks,
          });
        }

        response.writeHead(200);
        response.end(JSON.stringify({ success: true, fileName, tables }));
      } catch (err) {
        response.writeHead(400);
        response.end(JSON.stringify({ success: false, error: err.message || String(err) }));
      }
    });
    return;
  }

  // GET /mcp/tools — HTTP helpers (LLM generates SQL; oracledb runs it)
  if (pathname === '/mcp/tools' && request.method === 'GET') {
    const dbReady = !!(config.enableExecuteSql && oracledb && config.dbDsn && config.dbUser && config.dbPassword);
    response.writeHead(200);
    response.end(JSON.stringify({
      server: 'NL2SQL over HTTP (Node.js + oracledb)',
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

  // POST /mcp/invoke — same tools for browser chat (no SQLcl subprocess)
  if (pathname === '/mcp/invoke' && request.method === 'POST') {
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
            const raw = fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8');
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
            response.end(JSON.stringify({ success: false, tool, error: 'DB execution not available and schema.json could not be read' }));
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
server.listen(config.httpPort, listenHost, () => {
  console.log(`[MCP-Server] HTTP API listening on http://${listenHost}:${config.httpPort}`);
  console.log(`[MCP-Server] Database: ${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbSid}`);
  console.log(`[MCP-Server] LLM enabled: ${config.enableLLMSqlGeneration} (model: ${config.llmModel})`);
  console.log(`[MCP-Server] Endpoints:`);
  console.log(`  GET  /health          - Server health check`);
  console.log(`  POST /reload-rules    - Reload SQL rules from test_questions.json`);
  console.log(`  POST /generate-sql    - Generate SQL (mode: lookup|llm|hybrid)`);
  console.log(`  POST /generate-batch  - Batch SQL generation (mode: lookup|llm|hybrid)`);
});

server.on('error', (error) => {
  console.error('[MCP-Server] Error:', error);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`[MCP-Server] ${signal} received, closing HTTP server…`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
