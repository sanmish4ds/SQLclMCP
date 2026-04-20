/**
 * Execution-grounded hallucination helpers: static schema checks, query-log RAG, feedback append.
 * Oracle execution stays in sql-learn-server.js; this module is pure Node + fs.
 */

const fs = require('fs');
const path = require('path');

const SQL_KEYWORDS = new Set(
  `WITH,SELECT,FROM,WHERE,AND,OR,NOT,IN,IS,NULL,LIKE,BETWEEN,EXISTS,DISTINCT,ALL,ANY,SOME,
AS,ON,JOIN,INNER,LEFT,RIGHT,FULL,OUTER,CROSS,NATURAL,USING,GROUP,BY,HAVING,ORDER,ASC,DESC,
UNION,INTERSECT,MINUS,EXCEPT,FETCH,FIRST,NEXT,ROWS,ONLY,OFFSET,ROWNUM,FOR,UPDATE,
CASE,WHEN,THEN,ELSE,END,OVER,PARTITION,BY,ROWS,RANGE,PRECEDING,FOLLOWING,UNBOUNDED,CURRENT,
ROW,NUMBER,DENSE,RANK,NTILE,LAG,LEAD,FIRST_VALUE,LAST_VALUE,COUNT,SUM,AVG,MIN,MAX,
CAST,TO_CHAR,TO_DATE,TO_NUMBER,TRUNC,ROUND,COALESCE,NVL,NULLIF,DECODE,EXTRACT,YEAR,MONTH,DAY,
ADD_MONTHS,MONTHS_BETWEEN,DATE,DUAL,TRUE,FALSE,BOOLEAN,INT,INTEGER,NUMBER,VARCHAR2,CHAR,NCHAR,
NVARCHAR2,DATE,TIMESTAMP,INTERVAL,BLOB,CLOB,NCLOB,BINARY_FLOAT,BINARY_DOUBLE,XMLTYPE,
SYSDATE,SYSTIMESTAMP,CONNECT,START,PRIOR,LEVEL,REGEXP_LIKE,REPLACE,SUBSTR,INSTR,LENGTH,
UPPER,LOWER,TRIM,LTRIM,RTRIM,LISTAGG,PIVOT,UNPIVOT,MATCH_RECOGNIZE,QUALIFY`
    .split(/[, \n]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

let schemaCache = { mtimeMs: 0, data: null };

function loadSchemaReference(projectRoot) {
  const p = path.join(projectRoot, 'schema-reference.json');
  let st;
  try {
    st = fs.statSync(p);
  } catch (_) {
    return { tables: [], tips: [], title: '' };
  }
  if (!schemaCache.data || st.mtimeMs !== schemaCache.mtimeMs) {
    schemaCache.data = JSON.parse(fs.readFileSync(p, 'utf8'));
    schemaCache.mtimeMs = st.mtimeMs;
  }
  return schemaCache.data;
}

function buildSchemaIndex(schema) {
  const tablesUpper = new Set();
  const colUpper = new Set();
  for (const t of schema.tables || []) {
    if (t.name) tablesUpper.add(String(t.name).toUpperCase());
    for (const c of t.columns || []) colUpper.add(String(c).toUpperCase());
  }
  return { tablesUpper, colUpper };
}

/** Remove -- and /* *\/ comments; strip single-quoted strings (best-effort). */
function stripCommentsAndStringLiterals(sql) {
  let s = String(sql || '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/--[^\n]*/g, ' ');
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "'") {
      i += 1;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") break;
        i += 1;
      }
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

const ORACLE_BUILTIN_TABLES = new Set(['DUAL']);

/** CTE names from `WITH x AS (` / `, y AS (` (best-effort). */
function extractCteNames(sql) {
  const s = stripCommentsAndStringLiterals(sql).trim();
  const names = new Set();
  if (!/^\s*WITH\b/i.test(s)) return names;
  const head = s.slice(0, 12000);
  let m = head.match(/^\s*WITH\s+([A-Za-z_][A-Za-z0-9_$#]*)\s+AS\s*\(/i);
  if (m) names.add(m[1].toUpperCase());
  const re = /,\s*([A-Za-z_][A-Za-z0-9_$#]*)\s+AS\s*\(/g;
  while ((m = re.exec(head)) !== null) {
    names.add(m[1].toUpperCase());
  }
  return names;
}

/**
 * Table names after FROM / JOIN (comma-separated FROM list, first token per segment).
 * Intentionally naive; sufficient for typical TPC-H SELECT/WITH shapes.
 */
function extractReferencedTables(sql) {
  const flat = stripCommentsAndStringLiterals(sql);
  const upper = flat.toUpperCase();
  const found = new Set();

  let m;
  const reJoin = /\bJOIN\s+([A-Z_][A-Z0-9_$#]*)/gi;
  while ((m = reJoin.exec(flat)) !== null) {
    found.add(m[1].toUpperCase());
  }

  const fromIdx = upper.search(/\bFROM\b/);
  if (fromIdx < 0) return [...found];

  let depth = 0;
  let i = fromIdx + 4;
  while (i < flat.length && /\s/.test(flat[i])) i += 1;
  const start = i;
  for (; i < flat.length; i += 1) {
    const c = flat[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0) {
      const rest = upper.slice(i);
      if (/^\bWHERE\b/.test(rest)) break;
      if (/^\bGROUP\b\s+\bBY\b/.test(rest)) break;
      if (/^\bHAVING\b/.test(rest)) break;
      if (/^\bORDER\b\s+\bBY\b/.test(rest)) break;
      if (/^\bFETCH\b/.test(rest)) break;
      if (/^\bOFFSET\b/.test(rest)) break;
      if (/^\bUNION\b/.test(rest)) break;
      if (/^\bINTERSECT\b/.test(rest)) break;
      if (/^\bMINUS\b/.test(rest)) break;
      if (/^\bEXCEPT\b/.test(rest)) break;
    }
  }
  const fromClause = flat.slice(start, i);
  const parts = fromClause.split(',');
  for (const part of parts) {
    const seg = part.trim();
    if (!seg || seg[0] === '(') continue;
    const first = seg.split(/\s+/)[0];
    if (first && /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(first)) {
      found.add(first.toUpperCase());
    }
  }
  return [...found];
}

function tokenizeIdentifiers(sql) {
  const flat = stripCommentsAndStringLiterals(sql);
  const tokens = [];
  const re = /\b([A-Za-z_][A-Za-z0-9_$#]*)\b/g;
  let m;
  while ((m = re.exec(flat)) !== null) tokens.push(m[1]);
  return tokens;
}

/**
 * Static check: unknown tables from FROM/JOIN; TPC-H-prefixed identifiers that are not real columns.
 */
function staticSchemaCheck(sql, projectRoot) {
  const schema = loadSchemaReference(projectRoot);
  const { tablesUpper, colUpper } = buildSchemaIndex(schema);
  const issues = [];
  const ctes = extractCteNames(sql);
  const refs = extractReferencedTables(sql);
  for (const t of refs) {
    if (ctes.has(t)) continue;
    if (ORACLE_BUILTIN_TABLES.has(t)) continue;
    if (!tablesUpper.has(t)) {
      issues.push({ code: 'unknown_table', identifier: t, message: `Table "${t}" is not in the lab schema reference.` });
    }
  }
  const tokens = tokenizeIdentifiers(sql);
  const seen = new Set();
  for (const tok of tokens) {
    const u = tok.toUpperCase();
    if (SQL_KEYWORDS.has(u)) continue;
    if (tablesUpper.has(u)) continue;
    if (colUpper.has(u)) continue;
    if (u.length < 2) continue;
    if (!/^(C_|O_|L_|N_|R_|S_|P_|PS_)/i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    issues.push({
      code: 'unknown_prefixed_identifier',
      identifier: u,
      message: `Identifier "${u}" looks like a TPC-H column but is not in schema-reference.json.`,
    });
  }
  const risk =
    issues.some((x) => x.code === 'unknown_table') ? 'high'
    : issues.length ? 'medium'
    : 'low';
  return {
    ok: issues.length === 0,
    issues,
    risk,
    tables_referenced: refs,
  };
}

function tokenizeQuestion(q) {
  return String(q || '')
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
}

function scoreQuestionSimilarity(a, b) {
  const A = new Set(tokenizeQuestion(a));
  const B = new Set(tokenizeQuestion(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.sqrt(A.size * B.size);
}

function readQueryLogEntries(logPath, maxLines = 800) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  const slice = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch (_) { /* skip corrupt */ }
  }
  return out;
}

function pickQueryLogRagExamples(question, logPath, { limit = 3, minScore = 0.12 } = {}) {
  const entries = readQueryLogEntries(logPath);
  if (!entries.length) return [];
  const scored = entries
    .map((e) => ({
      e,
      s: scoreQuestionSimilarity(question, e.question || ''),
    }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s);
  const out = [];
  const seenSql = new Set();
  for (const { e, s } of scored) {
    const sql = String(e.sql || '').trim();
    if (!sql || seenSql.has(sql)) continue;
    seenSql.add(sql);
    out.push({ question: e.question, sql, score: s });
    if (out.length >= limit) break;
  }
  return out;
}

/** Extra user message for LLM (markdown-ish, bounded size). */
function formatQueryLogRagUserMessage(question, logPath, options = {}) {
  const picks = pickQueryLogRagExamples(question, logPath, options);
  if (!picks.length) return null;
  const lines = picks.map(
    (p, i) => `${i + 1}. Q: ${p.question}\n   SQL: ${p.sql.replace(/\s+/g, ' ').slice(0, 420)}`,
  );
  return [
    '**Past validated examples from this lab** (same schema; patterns may help — adapt to the current question; do not copy blindly):',
    ...lines,
    '',
    `**Current question:** ${question}`,
  ].join('\n');
}

function appendJsonl(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

function synthesizeVerdict(staticReport, executionReport) {
  const signals = [];
  let risk = staticReport.risk || 'low';

  if (executionReport && executionReport.attempted) {
    if (!executionReport.success) {
      signals.push({ code: 'oracle_execution_error', detail: executionReport.error || 'failed' });
      risk = 'high';
    } else if (executionReport.row_count === 0) {
      signals.push({
        code: 'empty_result_set',
        detail: 'Query ran but returned zero rows — check filters, joins, or whether the question matches the data.',
      });
    }
  }

  for (const iss of staticReport.issues || []) {
    signals.push({ code: iss.code, detail: iss.identifier || iss.message });
  }

  const execution_grounded_ok =
    executionReport &&
    executionReport.attempted &&
    executionReport.success &&
    staticReport.ok;

  return {
    risk,
    signals,
    execution_grounded_ok,
    summary:
      risk === 'high'
        ? 'High risk: fix schema or SQL before relying on this answer.'
        : risk === 'medium'
          ? 'Medium risk: review identifiers and logic against the lab schema.'
          : executionReport && executionReport.success
            ? 'Low risk: static checks passed and Oracle executed the statement.'
            : 'Low risk: static checks passed (execution not verified on this response).',
  };
}

module.exports = {
  loadSchemaReference,
  staticSchemaCheck,
  extractCteNames,
  pickQueryLogRagExamples,
  formatQueryLogRagUserMessage,
  appendJsonl,
  readQueryLogEntries,
  synthesizeVerdict,
  stripCommentsAndStringLiterals,
};
