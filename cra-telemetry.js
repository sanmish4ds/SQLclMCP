'use strict';

/**
 * CRA-inspired session telemetry for multi-turn NL→SQL flows.
 * Logs append-only JSON lines (no raw PII): hashes, lengths, and heuristic scores.
 *
 * Enable with CRA_TELEMETRY_ENABLED=true and CRA_TELEMETRY_FILE (default data/cra-sessions.jsonl).
 * For Render/hosted Logs (stdout): set CRA_TELEMETRY_STDOUT=true — each event is one line prefixed with [CRA_TELEMETRY].
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STOPWORDS = new Set(
  `the and for are but not you all any can her was one our out day get has him how its let may now see two way who use many then them these this that with from have been into your will would about after again also some than when what which their there could should into each other such only same`.split(
    /\s+/,
  ),
);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function jaccard(tokensA, tokensB) {
  const A = new Set(tokensA);
  const B = new Set(tokensB);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function injectionFlags(text) {
  const s = String(text || '').toLowerCase();
  const patterns = [
    /ignore (all )?(previous|above) (instructions|rules)/,
    /disregard (all )?(previous|above)/,
    /\bsystem prompt\b/,
    /\bdeveloper message\b/,
    /\bjailbreak\b/,
    /<\s*script/,
  ];
  return patterns.some((re) => re.test(s));
}

function sensitiveHits(text) {
  const s = String(text || '');
  let hits = 0;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(s)) hits += 2;
  if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(s)) hits += 1;
  if (/\b(ssn|social security|credit card|password|secret key|api key)\b/i.test(s)) hits += 2;
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(s)) hits += 1;
  return hits;
}

function refusalLabel(text) {
  const s = String(text || '').toLowerCase();
  if (s.length < 8) return 0;
  const cues = [
    'cannot',
    "can't",
    'unable to',
    'not able',
    'i refuse',
    'decline',
    'against policy',
    'not permitted',
    'not allowed',
    'unable to assist',
    "i'm not able",
    'i am not able',
  ];
  return cues.some((c) => s.includes(c)) ? 1 : 0;
}

function sha256Hex(s, bytes = 12) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, bytes * 2);
}

class CraTelemetry {
  constructor(options) {
    this.enabled = !!options.enabled;
    this.logFile = options.logFile;
    /** When true, echo each JSON event to stdout (e.g. Render → Logs). */
    this.logStdout = !!options.logStdout;
    this.windowW = Math.min(32, Math.max(2, Number(options.windowW) || 6));
    this.alpha = Number(options.alpha);
    this.beta = Number(options.beta);
    this.gamma = Number(options.gamma);
    if (!Number.isFinite(this.alpha)) this.alpha = 0.35;
    if (!Number.isFinite(this.beta)) this.beta = 0.45;
    if (!Number.isFinite(this.gamma)) this.gamma = 0.2;
    const sum = this.alpha + this.beta + this.gamma;
    if (sum > 0 && Math.abs(sum - 1) > 1e-6) {
      this.alpha /= sum;
      this.beta /= sum;
      this.gamma /= sum;
    }
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    if (this.enabled) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      } catch (e) {
        console.warn(`[CRA] Could not create log directory: ${e.message}`);
      }
    }
  }

  appendLine(obj) {
    if (!this.enabled) return;
    const payload = JSON.stringify(obj);
    const line = `${payload}\n`;
    try {
      fs.appendFileSync(this.logFile, line, 'utf8');
    } catch (e) {
      console.warn(`[CRA] append failed: ${e.message}`);
    }
    if (this.logStdout) {
      console.log(`[CRA_TELEMETRY] ${payload}`);
    }
  }

  getOrCreateSession(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        intent: '',
        userTexts: [],
        refusalWindow: [],
        turnCount: 0,
        cumulativeSens: 0,
      };
      this.sessions.set(sessionId, s);
    }
    if (this.sessions.size > 5000) {
      const first = this.sessions.keys().next().value;
      this.sessions.delete(first);
    }
    return s;
  }

  /**
   * Record one NL→SQL (or explain) turn. Server owns monotonic turn index per session_id.
   */
  recordTurn({
    sessionId,
    declaredIntent,
    channel,
    question,
    tutorResponse,
    sql,
    mode,
    source,
    success,
    eventType,
  }) {
    if (!this.enabled) return null;
    const sid = String(sessionId || '').trim().slice(0, 128);
    if (!sid) return null;

    const sess = this.getOrCreateSession(sid);
    sess.turnCount += 1;
    const turn = sess.turnCount;

    const di = String(declaredIntent || '').trim();
    if (di && !sess.intent) sess.intent = di.slice(0, 800);
    if (!sess.intent && question) sess.intent = String(question).slice(0, 800);

    sess.userTexts.push(String(question || '').slice(0, 4000));
    if (sess.userTexts.length > 24) sess.userTexts.shift();

    const cumUser = sess.userTexts.join('\n');
    const intentTok = tokenize(sess.intent);
    const userTok = tokenize(cumUser);
    const sim = jaccard(intentTok, userTok);
    const S1 = Math.max(0, Math.min(1, 1 - sim));

    sess.cumulativeSens += sensitiveHits(tutorResponse || '');
    const S2 = Math.max(0, Math.min(1, sess.cumulativeSens / 10));

    const refuse = refusalLabel(tutorResponse || '');
    sess.refusalWindow.push(refuse);
    if (sess.refusalWindow.length > this.windowW) sess.refusalWindow.shift();

    let S3 = 0;
    if (sess.refusalWindow.length >= 2) {
      const w = sess.refusalWindow;
      const half = Math.max(1, Math.floor(w.length / 2));
      const a = w.slice(0, half).reduce((x, y) => x + y, 0) / half;
      const b = w.slice(half).reduce((x, y) => x + y, 0) / (w.length - half);
      const slope = b - a;
      S3 = Math.max(0, Math.min(1, -slope));
    }

    const inj = injectionFlags(`${question || ''}\n${tutorResponse || ''}`);
    const cra = Math.max(
      0,
      Math.min(1, this.alpha * S1 + this.beta * S2 + this.gamma * S3 + (inj ? 0.12 : 0)),
    );

    const event = {
      ts: new Date().toISOString(),
      event: eventType || 'generate_sql',
      channel: String(channel || 'unknown').slice(0, 64),
      session_id: sid,
      turn,
      policy_version: 'cra_telemetry_v1',
      question_sha256: sha256Hex(question || '', 12),
      question_len: String(question || '').length,
      tutor_len: String(tutorResponse || '').length,
      tutor_sha256: tutorResponse ? sha256Hex(tutorResponse, 12) : null,
      sql_len: String(sql || '').length,
      sql_sha256: sql ? sha256Hex(sql, 12) : null,
      mode: mode || null,
      source: source || null,
      success: !!success,
      injection_signal: inj,
      S1,
      S2,
      S3,
      CRA: cra,
      weights: { alpha: this.alpha, beta: this.beta, gamma: this.gamma },
    };
    this.appendLine(event);
    return event;
  }
}

function createCraTelemetryFromEnv(rootDir) {
  const enabled = /^true$/i.test(String(process.env.CRA_TELEMETRY_ENABLED || '').trim());
  const rel = String(process.env.CRA_TELEMETRY_FILE || 'data/cra-sessions.jsonl').trim();
  const logFile = path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
  const logStdout = /^true$/i.test(String(process.env.CRA_TELEMETRY_STDOUT || '').trim());
  return new CraTelemetry({
    enabled,
    logFile,
    logStdout,
    windowW: process.env.CRA_TELEMETRY_WINDOW,
    alpha: process.env.CRA_WEIGHT_ALPHA,
    beta: process.env.CRA_WEIGHT_BETA,
    gamma: process.env.CRA_WEIGHT_GAMMA,
  });
}

module.exports = { CraTelemetry, createCraTelemetryFromEnv };
