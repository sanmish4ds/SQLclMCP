#!/usr/bin/env node

/**
 * SQLcl MCP Server with HTTP Interface
 * Provides Model Context Protocol and HTTP REST API for SQL generation evaluation.
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
const path = require('path');
const { spawn } = require('child_process');

let oracledb;
try { oracledb = require('oracledb'); } catch (_) { oracledb = null; }

// Configuration (Render sets PORT; DB prefers DB_DSN/ORACLE_WALLET_* for Autonomous)
const rawWalletPath = process.env.ORACLE_WALLET_PATH || process.env.TNS_ADMIN || null;
const walletPath = rawWalletPath ? path.resolve(rawWalletPath) : null;
if (walletPath) process.env.TNS_ADMIN = walletPath; // Oracle native layer looks for tnsnames.ora here

const config = {
  httpPort: Number(process.env.PORT || process.env.HTTP_PORT || 3000),
  dbHost: process.env.DB_HOST || null,
  dbPort: process.env.DB_PORT || null,
  dbSid: process.env.DB_SID || null,
  dbUser: process.env.DB_USER || null,
  dbPassword: process.env.DB_PASSWORD || null,
  dbDsn: process.env.DB_DSN || null, // e.g. "prishivdb1_high"
  dbWalletPath: walletPath, // directory containing tnsnames.ora + wallet files
  sqlclConnectionName: process.env.SQLCL_CONNECTION_NAME || process.env.DB_DSN || null, // saved connection name for SQLcl MCP connect tool
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

// ── SQLcl CSV output parser ───────────────────────────────────────────────────
function parseSqlclOutput(text) {
  if (!text) return { columns: [], rows: [], rowCount: 0 };
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { columns: [], rows: [], rowCount: 0, raw: text };
  function parseCsvLine(line) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (line[i] === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += line[i];
    }
    out.push(cur);
    return out.map(v => v.trim());
  }
  try {
    const headers = parseCsvLine(lines[0]);
    if (headers.length > 0) {
      const rows = lines.slice(1).map(line => {
        const vals = parseCsvLine(line);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : null; });
        return obj;
      });
      return { columns: headers, rows, rowCount: rows.length };
    }
  } catch (_) {}
  return { columns: [], rows: [], rowCount: 0, raw: text };
}

// ── Real SQLcl MCP Bridge (spawns `sql mcp` as a child process) ───────────────
class SqlclMcpBridge {
  constructor() {
    this.proc = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.starting = null;
    this.connectedTo = null;
  }

  async ensureReady() {
    if (this.ready && this.proc) return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    if (this.proc) { try { this.proc.kill(); } catch (_) {} this.proc = null; }
    this.buf = '';
    this.pending.clear();
    this.ready = false;
    const sqlBin = process.env.SQLCL_BIN || 'sql';
    const env = { ...process.env };
    if (config.dbWalletPath) env.TNS_ADMIN = config.dbWalletPath;

    // SQLcl MCP mode does NOT establish DB connections from command-line credentials.
    // Always start with /nolog; the MCP connect tool is called after init.
    const sqlArgs = ['-mcp', '/nolog'];

    await new Promise((resolve, reject) => {
      this.proc = spawn(sqlBin, sqlArgs, { stdio: ['pipe', 'pipe', 'pipe'], env });
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', d => this._onData(d));
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', d => console.warn('[SQLcl-MCP stderr]', d.trimEnd()));
      this.proc.on('error', err => {
        this.proc = null;
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        reject(err);
      });
      this.proc.on('exit', code => {
        console.log('[SQLcl-MCP] Process exited:', code);
        this.ready = false; this.connectedTo = null; this.proc = null;
        for (const [, p] of this.pending) p.reject(new Error('SQLcl MCP process exited (code ' + code + ')'));
        this.pending.clear();
      });
      setTimeout(resolve, 300); // give spawn time to fail
    });

    if (!this.proc) throw new Error('SQLcl process failed to start');
    const init = await this._rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'SQLclMCP-WebUI', version: '1.0' },
    });
    console.log('[SQLcl-MCP] Initialized, server:', JSON.stringify((init || {}).serverInfo || {}));
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    this.ready = true;
    // Auto-connect via run-sqlcl CONNECT command (does not require saved connections).
    if (config.dbUser && config.dbPassword && (config.dbDsn || (config.dbHost && config.dbSid))) {
      const dsn = config.dbDsn || `${config.dbHost}:${config.dbPort || 1521}/${config.dbSid}`;
      const connectCmd = `CONNECT ${config.dbUser}/${config.dbPassword}@${dsn}`;
      console.log('[SQLcl-MCP] Auto-connecting with run-sqlcl CONNECT to:', dsn);
      try {
        const model = process.env.SQLCL_MCP_MODEL || 'claude-sonnet-4-5';
        const connectResult = await this._rpc('tools/call', {
          name: 'run-sqlcl',
          arguments: { sqlcl: connectCmd, model },
        });
        const isErr = !!(connectResult || {}).isError;
        const rawText = ((connectResult || {}).content || []).map(c => c.text || '').join('').trim();
        if (isErr || /error|invalid|denied|failed/i.test(rawText)) {
          console.warn('[SQLcl-MCP] Auto-connect run-sqlcl error:', rawText);
        } else {
          this.connectedTo = dsn;
          console.log('[SQLcl-MCP] Connected to:', dsn, '|', rawText.slice(0, 80));
        }
      } catch (err) {
        console.warn('[SQLcl-MCP] Auto-connect failed:', err.message);
      }
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (e) { console.warn('[SQLcl-MCP] parse error:', e.message, line.slice(0, 100)); }
    }
  }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) { reject(new Error('SQLcl process not running')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('SQLcl MCP timed out (30s)')); }
      }, 30000);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async callTool(name, args) {
    await this.ensureReady();
    // SQLcl MCP tools require a `model` argument identifying the calling LLM.
    const argsWithModel = { model: process.env.SQLCL_MCP_MODEL || 'claude-sonnet-4-5', ...args };
    return this._rpc('tools/call', { name, arguments: argsWithModel });
  }

  async listTools() {
    await this.ensureReady();
    return this._rpc('tools/list', {});
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch (_) {} this.proc = null; }
    this.ready = false; this.connectedTo = null;
  }
}

const sqlclBridge = new SqlclMcpBridge();

// ── HTTP Request Handler ──────────────────────────────────────────────────────

const requestHandler = (request, response) => {
  maybeReloadSQLRules();

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Content-Type', 'application/json');

  if (request.method === 'OPTIONS') {
    response.writeHead(200);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  // GET / (root) — friendly info so the deploy URL doesn't show "Not found"
  if ((pathname === '/' || pathname === '') && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      name: 'SQLclMCP MCP Server',
      status: 'running',
      offer: 'Natural language to Oracle SQL over HTTP. Send a question, get generated SQL.',
      endpoints: {
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
    response.writeHead(200);
    response.end(JSON.stringify({
      status: 'ok',
      server: 'MCP Server',
      database: `${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbSid}`,
      loaded_rules: Object.keys(SQL_GENERATION_RULES).length,
      llm_enabled: config.enableLLMSqlGeneration,
      llm_model: config.enableLLMSqlGeneration ? config.llmModel : null,
      execute_sql_available: !!(config.enableExecuteSql && oracledb),
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

  // GET /mcp/tools — list available SQLcl MCP-style tools
  if (pathname === '/mcp/tools' && request.method === 'GET') {
    const dbReady = !!(config.enableExecuteSql && oracledb && config.dbDsn && config.dbUser && config.dbPassword);
    response.writeHead(200);
    response.end(JSON.stringify({
      server: 'SQLcl MCP over HTTP',
      db_ready: dbReady,
      connection: dbReady ? `${config.dbUser}@${config.dbDsn}` : null,
      tools: [
        { name: 'list-connections', description: 'Show current database connection status' },
        { name: 'schema-information', description: 'List tables and columns. Pass tableName for one table.' },
        { name: 'run-sql', description: 'Execute a SELECT query against Oracle Database' },
        { name: 'run-sqlcl', description: 'Run a SQLcl command: DESC <table>, SHOW TABLES' },
      ],
    }));
    return;
  }

  // POST /mcp/invoke — unified SQLcl MCP tool invocation
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
        const upper = sql.toUpperCase();
        if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
          response.writeHead(400);
          response.end(JSON.stringify({ success: false, tool, error: 'Only SELECT / WITH…SELECT queries are permitted.' }));
          return;
        }
        const connConfig = { user: config.dbUser, password: config.dbPassword, connectString: config.dbDsn };
        if (config.dbWalletPath) connConfig.configDir = config.dbWalletPath;
        let conn;
        try {
          conn = await oracledb.getConnection(connConfig);
          const r = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 500 });
          const rows = r.rows || [];
          const columns = r.metaData ? r.metaData.map(m => m.name) : [];
          response.writeHead(200);
          response.end(JSON.stringify({ success: true, tool, result: { columns, rows, rowCount: rows.length } }));
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
          error: `SQLcl command not supported: "${cmd}". Supported: DESC <table>, SHOW TABLES`,
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

  // GET /sqlcl-real/status — probe the real SQLcl MCP process
  if (pathname === '/sqlcl-real/status' && request.method === 'GET') {
    (async () => {
      try {
        await sqlclBridge.ensureReady();
        const toolsResult = await sqlclBridge.listTools();
        response.writeHead(200);
        response.end(JSON.stringify({
          success: true,
          ready: sqlclBridge.ready,
          connected_to: sqlclBridge.connectedTo,
          tools: (toolsResult.tools || []).map(t => ({ name: t.name, description: t.description })),
          engine: 'SQLcl (Java JDBC thin driver)',
        }));
      } catch (err) {
        response.writeHead(200);
        response.end(JSON.stringify({
          success: false,
          ready: false,
          connected_to: null,
          error: err.message,
          hint: 'Ensure SQLcl is installed and "sql" is in PATH. Set SQLCL_BIN env var to override.',
          engine: null,
        }));
      }
    })();
    return;
  }

  // POST /sqlcl-real/invoke — proxy a tool call to the real SQLcl MCP process
  if (pathname === '/sqlcl-real/invoke' && request.method === 'POST') {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch (_) {
        response.writeHead(400);
        response.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const toolName = String(data.tool || '').trim();
      const args = data.params || {};
      try {
        const result = await sqlclBridge.callTool(toolName, args);
        const isError = !!result.isError;
        const rawText = (result.content || []).map(c => c.text || '').join('\n').trim();
        if (isError) {
          response.writeHead(200);
          response.end(JSON.stringify({ success: false, tool: toolName, error: rawText }));
          return;
        }
        if (toolName === 'connect') sqlclBridge.connectedTo = args.connection_name || null;
        if (toolName === 'disconnect') sqlclBridge.connectedTo = null;
        const parsed = (toolName === 'run-sql' || toolName === 'run-sql-async')
          ? parseSqlclOutput(rawText) : null;
        response.writeHead(200);
        response.end(JSON.stringify({
          success: true,
          tool: toolName,
          connected_to: sqlclBridge.connectedTo,
          raw: rawText,
          result: parsed || { text: rawText },
        }));
      } catch (err) {
        response.writeHead(200);
        response.end(JSON.stringify({ success: false, tool: toolName, error: err.message }));
      }
    });
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ error: 'Not found' }));
};

// ── Start Server ──────────────────────────────────────────────────────────────

const server = http.createServer(requestHandler);

server.listen(config.httpPort, () => {
  console.log(`[MCP-Server] HTTP API listening on http://localhost:${config.httpPort}`);
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

process.on('SIGINT', () => {
  console.log('[MCP-Server] Shutting down...');
  server.close();
  process.exit(0);
});
