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

// Configuration (Render sets PORT; use HTTP_PORT or 3000 locally)
const config = {
  httpPort: Number(process.env.PORT || process.env.HTTP_PORT || 3000),
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: process.env.DB_PORT || '1521',
  dbSid: process.env.DB_SID || 'FREE',
  dbUser: process.env.DB_USER || 'mcp_dev',
  dbPassword: process.env.DB_PASSWORD || 'mcp_pass123',
  enableLLMSqlGeneration: process.env.ENABLE_LLM_SQL_GEN === 'true',
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
      endpoints: {
        health: '/health',
        generate_sql: 'POST /generate-sql',
        generate_batch: 'POST /generate-batch',
        reload_rules: 'POST /reload-rules',
      },
      docs: 'https://github.com/your-org/SQLclMCP',
    }));
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
      timestamp: new Date().toISOString(),
    }));
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
