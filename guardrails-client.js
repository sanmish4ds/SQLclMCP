/**
 * Guardrails for Easy NL2SQL.
 *
 * 1. sqlFirewall(sql): local, dependency-free Oracle SQL check (always on). Mirrors the
 *    lexical layer of guardrails/easynlsql_guards/sql_policy.py so the server stays safe
 *    when the NeMo sidecar is down.
 * 2. NeMo Guardrails sidecar client (guardrails/server.py), enabled by GUARDRAILS_URL:
 *    input rails (PII/secrets, prompt injection, LLM topic/jailbreak self-check) and
 *    output rails (SQL firewall, unsafe ```sql fence redaction, secret leaks, XSS, LLM self-check).
 *
 * Env: GUARDRAILS_URL, GUARDRAILS_TOKEN, GUARDRAILS_TIMEOUT_MS (default 8000),
 *      GUARDRAILS_FAIL_MODE = open (default: fall back to local checks) | closed (reject with 503).
 */

const FORBIDDEN_KEYWORD = /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|commit|rollback|savepoint|begin|declare|execute|exec|call|pragma|rename|purge|flashback|audit|noaudit|analyze|shutdown)\b/i;
const WITH_PLSQL = /\bwith\s+(function|procedure)\b/i;
const FOR_UPDATE = /\bfor\s+update\b/i;
const LOCK_TABLE = /\block\s+table\b/i;
const DANGEROUS_PKG = /(?<![A-Z0-9_$#])(DBMS_|UTL_|OWA_|HTP\b|HTF\b|CTXSYS|ORDSYS|MDSYS|XDB|SYS_CONTEXT|USERENV|HTTPURITYPE|DBURITYPE|XDBURITYPE|SYS\.|SYSTEM\.|APEX_|WWV_|JAVA)/i;
// USER_* dictionary views are allowed (own schema only; the SQL lab's DESC / SHOW TABLES use them).
const SYSTEM_OBJECT = /(?<![A-Z0-9_$#])(DBA_|ALL_|CDB_|V\$|GV\$|X\$|V_\$|GV_\$|AUDSYS\.)[A-Z0-9_$#]*/i;

/** Replace string literals, q-quotes and comments with blanks so keyword scans ignore them. */
function stripStringsAndComments(sql) {
  const s = String(sql || '');
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const nx = s[i + 1] || '';
    if (c === '-' && nx === '-') {
      const j = s.indexOf('\n', i);
      i = j < 0 ? n : j;
      out += ' ';
    } else if (c === '/' && nx === '*') {
      const j = s.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      out += ' ';
    } else if ((c === 'q' || c === 'Q') && nx === "'" && i + 2 < n) {
      const open = s[i + 2];
      const close = { '[': ']', '{': '}', '(': ')', '<': '>' }[open] || open;
      const j = s.indexOf(close + "'", i + 3);
      i = j < 0 ? n : j + 2;
      out += " '' ";
    } else if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; }
        if (s[j] === "'") break;
        j += 1;
      }
      i = j + 1;
      out += " '' ";
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** @returns {{ allowed: boolean, violations: string[] }} */
function sqlFirewall(sql) {
  const raw = String(sql || '').trim();
  const v = [];
  if (!raw) return { allowed: false, violations: ['empty'] };
  if (raw.length > 20000) return { allowed: false, violations: ['too_long'] };
  const body = stripStringsAndComments(raw).trim().replace(/;\s*$/, '').trim();
  if (body.includes(';')) v.push('multiple_statements');
  if (!/^\(*\s*(select|with)\b/i.test(body)) v.push('not_select');
  if (WITH_PLSQL.test(body)) v.push('inline_plsql');
  const kw = body.match(FORBIDDEN_KEYWORD);
  if (kw) v.push(`forbidden_keyword:${kw[1].toLowerCase()}`);
  if (FOR_UPDATE.test(body)) v.push('row_lock');
  if (LOCK_TABLE.test(body)) v.push('lock_table');
  if (body.includes('@')) v.push('db_link');
  const pkg = body.match(DANGEROUS_PKG);
  if (pkg) v.push(`dangerous_package:${pkg[1].replace(/[._]+$/, '').toLowerCase()}`);
  const sys = body.match(SYSTEM_OBJECT);
  if (sys) v.push(`system_catalog:${sys[0].toLowerCase()}`);
  return { allowed: v.length === 0, violations: v };
}

function createGuardrailsClient(env = process.env) {
  const baseUrl = String(env.GUARDRAILS_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.GUARDRAILS_TOKEN || '').trim();
  const timeoutMs = Math.min(60000, Math.max(500, Number(env.GUARDRAILS_TIMEOUT_MS || 8000) || 8000));
  const failClosed = String(env.GUARDRAILS_FAIL_MODE || 'open').trim().toLowerCase() === 'closed';
  const enabled = !!baseUrl;

  async function post(route, payload) {
    if (!enabled) return { allowed: true, skipped: true };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Guardrails-Token'] = token;
      const res = await fetch(baseUrl + route, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      // The sidecar fails closed on a crashed rail (status "error"); honour the fail mode for that too.
      if (out.status === 'error') throw new Error(out.message || 'rail error');
      return out;
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err.message || String(err));
      console.warn(`[guardrails] ${route} unavailable: ${reason}`);
      if (failClosed) {
        return {
          allowed: false,
          unavailable: true,
          code: 'guardrails_unavailable',
          message: 'Safety checks are temporarily unavailable. Please try again shortly.',
        };
      }
      return { allowed: true, unavailable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled,
    failClosed,
    baseUrl,
    /** Input rails on a user question. */
    checkInput: (text) => post('/v1/check/input', { text: String(text || '') }),
    /** Output rails on generated SQL + tutor text. `text` in the result may be rewritten (unsafe fences redacted). */
    checkOutput: ({ question = '', sql = '', text = '' } = {}) =>
      post('/v1/check/output', { question: String(question || ''), sql: String(sql || ''), text: String(text || '') }),
    async status() {
      if (!enabled) return { enabled: false };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(baseUrl + '/health', { signal: ctrl.signal });
        const h = await res.json();
        return { enabled: true, reachable: res.ok, fail_mode: failClosed ? 'closed' : 'open', ...h };
      } catch (err) {
        return { enabled: true, reachable: false, fail_mode: failClosed ? 'closed' : 'open', error: err.message };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = { sqlFirewall, stripStringsAndComments, createGuardrailsClient };
