#!/usr/bin/env python3
"""MCP SQL Evaluation Engine.

Answers four research questions against a 500-question TPC-H Oracle dataset:

  RQ1  Semantic Correctness  — Does the generated query return the same results
                               as the human-written baseline?
  RQ2  Execution Efficiency  — What is the latency overhead vs the baseline?
  RQ3  Optimization Potential— Are generated queries cheaper or more expensive
                               per Oracle EXPLAIN PLAN cost?
  RQ4  Robustness Across Complexity — How does accuracy degrade from simple →
                               medium → complex queries?
"""

import argparse
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import oracledb
import requests

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
TEST_QUESTIONS_FILE = SCRIPT_DIR / "test_questions.json"
RESULTS_DIR = SCRIPT_DIR / "results"
MCP_SERVER_JS = PROJECT_ROOT / "mcp-server-http.js"
RESULTS_DIR.mkdir(exist_ok=True)

COMPLEXITY_TIERS = ("simple", "medium", "complex")


# ── ANSI colors (disabled when stdout is not a TTY) ────────────────────────────

def _color_enabled():
    return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()


class C:
    R = "\033[0m"       # reset
    B = "\033[1m"       # bold
    D = "\033[2m"       # dim
    G = "\033[32m"      # green
    Y = "\033[33m"      # yellow
    R_ = "\033[31m"     # red
    C = "\033[36m"      # cyan
    M = "\033[35m"      # magenta
    W = "\033[97m"      # bright white

    @staticmethod
    def maybe(*codes):
        return "".join(codes) if _color_enabled() else ""


# ── Value normalisation ───────────────────────────────────────────────────────

def normalize_value(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def normalize_rows(rows):
    if rows is None:
        return None
    return [tuple(normalize_value(v) for v in row) for row in rows]


def semantic_match(a_rows, b_rows):
    """Order-independent row-set equality."""
    if a_rows is None or b_rows is None:
        return False
    return sorted(normalize_rows(a_rows)) == sorted(normalize_rows(b_rows))


def exact_order_match(a_rows, b_rows):
    """Same rows, same values, same order."""
    if a_rows is None or b_rows is None:
        return False
    return normalize_rows(a_rows) == normalize_rows(b_rows)


def extract_string_match(a_rows, b_rows):
    """Canonical JSON string comparison (order-independent set)."""
    if a_rows is None or b_rows is None:
        return False
    na, nb = normalize_rows(a_rows), normalize_rows(b_rows)
    return json.dumps(sorted(na), default=str, sort_keys=True) == json.dumps(sorted(nb), default=str, sort_keys=True)


# ── Database ──────────────────────────────────────────────────────────────────

class Database:
    def __init__(self, user, password, dsn):
        self.conn = oracledb.connect(user=user, password=password, dsn=dsn)

    def execute(self, sql):
        try:
            cursor = self.conn.cursor()
            t0 = time.perf_counter()
            cursor.execute(sql)
            rows = cursor.fetchall()
            latency_ms = (time.perf_counter() - t0) * 1000
            cursor.close()
            return rows, latency_ms, None
        except Exception as exc:
            return None, None, str(exc)

    def explain_plan(self, sql, statement_id):
        cursor = self.conn.cursor()
        try:
            sql_clean = sql.strip().rstrip(";")
            cursor.execute(
                f"EXPLAIN PLAN SET STATEMENT_ID = '{statement_id}' FOR {sql_clean}"
            )
            cursor.execute(
                "SELECT cost, cardinality, bytes FROM plan_table "
                "WHERE statement_id = :sid FETCH FIRST 1 ROWS ONLY",
                sid=statement_id,
            )
            row = cursor.fetchone()
            if not row:
                return {"cost": None, "cardinality": None, "bytes": None,
                        "error": "No plan row returned"}
            return {
                "cost":        int(row[0]) if row[0] is not None else None,
                "cardinality": int(row[1]) if row[1] is not None else None,
                "bytes":       int(row[2]) if row[2] is not None else None,
                "error":       None,
            }
        except Exception as exc:
            return {"cost": None, "cardinality": None, "bytes": None, "error": str(exc)}
        finally:
            try:
                cursor.execute(
                    "DELETE FROM plan_table WHERE statement_id = :sid",
                    sid=statement_id,
                )
            except Exception:
                pass
            cursor.close()

    def close(self):
        self.conn.close()


# ── MCP Client ────────────────────────────────────────────────────────────────

class MCPClient:
    def __init__(self, url):
        self.url = url.rstrip("/")

    def health(self):
        try:
            r = requests.get(f"{self.url}/health", timeout=5)
            return r.status_code == 200
        except Exception:
            return False

    def generate_sql(self, question, mode):
        try:
            r = requests.post(
                f"{self.url}/generate-sql",
                json={"question": question, "mode": mode},
                timeout=30,
            )
            if r.status_code == 200:
                return r.json().get("generated_sql"), None
            payload = r.json() if r.content else {}
            return None, payload.get("error", f"HTTP {r.status_code}")
        except Exception as exc:
            return None, str(exc)

    def get_health(self):
        """Fetch full health payload for LLM status check."""
        try:
            r = requests.get(f"{self.url}/health", timeout=5)
            if r.status_code == 200:
                return r.json(), None
            return None, f"HTTP {r.status_code}"
        except Exception as exc:
            return None, str(exc)


# ── Pre-run: cleanup, restart MCP, check LLM ──────────────────────────────────

def _move_previous_results_to_legacy():
    """Move previous mcp_evaluation_*.json and mcp_evaluation_*.png to legacy_results/."""
    LEGACY_DIR = RESULTS_DIR / "legacy_results"
    LEGACY_DIR.mkdir(exist_ok=True)
    moved = 0
    for p in list(RESULTS_DIR.glob("mcp_evaluation_*.json")) + list(RESULTS_DIR.glob("mcp_evaluation_*.png")):
        dest = LEGACY_DIR / p.name
        # Avoid overwrite: append _N if dest exists
        n = 0
        while dest.exists():
            n += 1
            dest = LEGACY_DIR / f"{p.stem}_v{n}{p.suffix}"
        shutil.move(str(p), str(dest))
        moved += 1
    return moved


def _restart_mcp_server(mcp_url: str):
    """Kill existing MCP server process and start a new one."""
    base = "http://localhost"
    try:
        port = int(mcp_url.split(":")[-1].rstrip("/").split("/")[0] or "3000")
    except (ValueError, IndexError):
        port = 3000

    # Kill existing node process running mcp-server-http
    try:
        if platform.system() == "Windows":
            subprocess.run(
                ["taskkill", "/F", "/IM", "node.exe", "/FI", "WINDOWTITLE eq *mcp*"],
                capture_output=True, timeout=5,
            )
        else:
            subprocess.run(
                ["pkill", "-f", "mcp-server-http.js"],
                capture_output=True, timeout=5,
            )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    time.sleep(2)

    if not MCP_SERVER_JS.exists():
        return False, f"MCP server script not found: {MCP_SERVER_JS}"

    try:
        proc = subprocess.Popen(
            ["node", str(MCP_SERVER_JS)],
            cwd=str(PROJECT_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except Exception as exc:
        return False, f"Failed to start MCP server: {exc}"

    # Wait for server to be reachable
    for _ in range(15):
        time.sleep(1)
        try:
            r = requests.get(f"{base}:{port}/health", timeout=2)
            if r.status_code == 200:
                return True, None
        except Exception:
            pass
    return False, "MCP server did not become healthy within 15 seconds"


def _check_mcp_and_llm(mcp_url: str, mcp_mode: str) -> str | None:
    """
    Check MCP health and LLM status. Returns None on success, error message on failure.
    """
    mcp = MCPClient(mcp_url)
    health, err = mcp.get_health()
    if err:
        return f"MCP server unreachable at {mcp_url}: {err}"
    if not health:
        return f"MCP server returned no health payload"

    llm_enabled = health.get("llm_enabled", False)
    llm_model = health.get("llm_model", "—")
    loaded_rules = health.get("loaded_rules", 0)

    c_, r_ = C.maybe(C.C + C.B), C.maybe(C.R)
    print(f"\n{c_}── MCP Server Status ─────────────────────────────────────────────────{r_}")
    print(f"  URL:           {mcp_url}")
    print(f"  Loaded rules:  {loaded_rules}")
    print(f"  LLM enabled:   {C.maybe(C.G if llm_enabled else C.Y)}{llm_enabled}{r_}")
    print(f"  LLM model:     {llm_model}")

    if mcp_mode in ("llm", "hybrid") and not llm_enabled:
        reasons = []
        if not health.get("llm_model"):
            reasons.append("LLM_API_KEY missing or invalid in .env")
        reasons.append("ENABLE_LLM_SQL_GEN must be 'true' in .env")
        reasons.append("Restart MCP server after changing .env")
        return "LLM is required but disabled. Possible causes: " + "; ".join(reasons)

    g_ = C.maybe(C.G)
    print(f"  Status:        {g_}✓ OK{r_}")
    print(f"{C.maybe(C.D)}{'─' * 70}{r_}")
    return None


# ── Test loading ──────────────────────────────────────────────────────────────

def expected_sql(test):
    for key in ("expected_sql", "sql", "baseline_sql"):
        value = test.get(key)
        if value and str(value).strip():
            return str(value).strip()
    return None


def load_tests(question_ids, complexities):
    with open(TEST_QUESTIONS_FILE, "r", encoding="utf-8") as f:
        payload = json.load(f)

    tests = payload.get("test_questions", payload)
    normalized = []
    for idx, test in enumerate(tests, start=1):
        row = dict(test)
        row["id"] = int(row.get("id", idx))
        normalized.append(row)

    if question_ids:
        normalized = [t for t in normalized if t["id"] in question_ids]

    if complexities:
        normalized = [
            t for t in normalized
            if str(t.get("complexity", "")).strip().lower() in complexities
        ]

    return normalized


def parse_ids(raw):
    if not raw.strip():
        return set()
    try:
        return {int(x.strip()) for x in raw.split(",") if x.strip()}
    except ValueError:
        raise ValueError("--question-ids must be comma-separated integers")


def parse_complexities(raw):
    if not raw.strip() or raw.strip().lower() == "all":
        return set()
    allowed = set(COMPLEXITY_TIERS)
    values = {x.strip().lower() for x in raw.split(",") if x.strip()}
    invalid = values - allowed
    if invalid:
        raise ValueError(
            f"--complexity invalid: {sorted(invalid)}. Use simple,medium,complex or all"
        )
    return values


def fmt_latency(value):
    return f"{value:.2f}ms" if isinstance(value, (int, float)) else "N/A"


# ── Baseline phase ────────────────────────────────────────────────────────────

def run_baseline_tests(db, tests, include_explain):
    results = []
    by_id = {}

    for test in tests:
        qid = test["id"]
        question = test.get("question", "")
        base_sql = expected_sql(test)

        if not base_sql:
            row = {
                "id": qid, "question": question, "complexity": test.get("complexity", ""),
                "sql": None, "success": False,
                "rows": None, "row_count": None, "latency_ms": None,
                "explain_plan": {"cost": None, "cardinality": None, "bytes": None,
                                 "error": "Missing expected SQL"},
                "error": "Missing expected SQL",
            }
            results.append(row)
            by_id[qid] = row
            r_, res = C.maybe(C.R_), C.maybe(C.R)
            print(f"  {r_}✗ Q{qid}{res} BASELINE_FAIL — no expected SQL in test")
            continue

        rows, latency_ms, error = db.execute(base_sql)
        explain = (
            db.explain_plan(base_sql, f"B{qid}_{int(time.time()*1000)%100000}")
            if include_explain and error is None
            else {"cost": None, "cardinality": None, "bytes": None, "error": error}
        )

        row = {
            "id": qid,
            "question": question,
            "complexity": test.get("complexity", ""),
            "sql": base_sql,
            "success": error is None,
            "rows": normalize_rows(rows) if rows is not None else None,
            "row_count": len(rows) if rows is not None else None,
            "latency_ms": latency_ms,
            "explain_plan": explain,
            "error": error,
        }
        results.append(row)
        by_id[qid] = row

        res = C.maybe(C.R)
        if error is None:
            g_ = C.maybe(C.G)
            rows_n = len(rows) if rows is not None else 0
            cost = explain.get("cost")
            card = explain.get("cardinality")
            bytes_ = explain.get("bytes")
            plan_str = f"cost={cost}" if cost is not None else ""
            if card is not None:
                plan_str += f" card={card}"
            if bytes_ is not None:
                plan_str += f" bytes={bytes_}"
            print(f"  {g_}✓ Q{qid}{res} baseline | executed=ok | rows={rows_n} | {fmt_latency(latency_ms)} | plan: {plan_str or 'N/A'}")
        else:
            r_ = C.maybe(C.R_)
            print(f"  {r_}✗ Q{qid}{res} baseline | executed=fail | {error[:70]}")

    return results, by_id


# ── MCP phase ─────────────────────────────────────────────────────────────────

def run_mcp_tests(db, mcp, tests, mcp_mode, baseline_by_id, include_explain):
    results = []

    for test in tests:
        qid = test["id"]
        question = test.get("question", "")

        gen_sql, gen_error = mcp.generate_sql(question, mcp_mode)
        if not gen_sql:
            row = {
                "id": qid, "question": question, "complexity": test.get("complexity", ""),
                "generated": False, "mcp_sql": None,
                "executed": False, "semantic_match": False,
                "exact_order_match": False, "extract_string_match": False,
                "rows": None, "row_count": None, "latency_ms": None,
                "explain_plan": {"cost": None, "cardinality": None, "bytes": None,
                                 "error": gen_error},
                "explain_delta": {"cost": None, "cardinality": None, "bytes": None},
                "latency_ratio": None,
                "error": gen_error,
            }
            results.append(row)
            r_, res = C.maybe(C.R_), C.maybe(C.R)
            print(f"  {r_}✗ Q{qid}{res} MCP | generated=fail | executed=skip | {str(gen_error)[:60]}")
            continue

        rows, latency_ms, error = db.execute(gen_sql)
        explain = (
            db.explain_plan(gen_sql, f"M{qid}_{int(time.time()*1000)%100000}")
            if include_explain and error is None
            else {"cost": None, "cardinality": None, "bytes": None, "error": error}
        )

        baseline = baseline_by_id.get(qid) if baseline_by_id else None
        is_match = False
        explain_delta = {"cost": None, "cardinality": None, "bytes": None}
        latency_ratio = None

        exact_order = False
        extract_str = False

        if baseline:
            b_rows = baseline.get("rows")
            is_match = (
                baseline.get("success")
                and error is None
                and semantic_match(b_rows, rows)
            )
            if error is None and rows is not None and b_rows is not None:
                exact_order = exact_order_match(b_rows, rows)
                extract_str = extract_string_match(b_rows, rows)
            bplan = baseline.get("explain_plan", {})
            for k in ("cost", "cardinality", "bytes"):
                if bplan.get(k) is not None and explain.get(k) is not None:
                    explain_delta[k] = explain.get(k) - bplan.get(k)

            b_lat = baseline.get("latency_ms")
            if b_lat and latency_ms:
                latency_ratio = latency_ms / b_lat

        row = {
            "id": qid,
            "question": question,
            "complexity": test.get("complexity", ""),
            "generated": True,
            "mcp_sql": gen_sql,
            "executed": error is None,
            "semantic_match": is_match,
            "exact_order_match": exact_order,
            "extract_string_match": extract_str,
            "rows": normalize_rows(rows) if rows is not None else None,
            "row_count": len(rows) if rows is not None else None,
            "latency_ms": latency_ms,
            "explain_plan": explain,
            "explain_delta": explain_delta,
            "latency_ratio": latency_ratio,
            "error": error,
        }
        results.append(row)

        g_, y_, r_ = C.maybe(C.G), C.maybe(C.Y), C.maybe(C.R_)
        res = C.maybe(C.R)
        exec_ok = error is None
        log_parts = [
            "executed=" + ("ok" if exec_ok else "fail"),
            f"semantic={'ok' if is_match else 'fail'}",
            f"exact_order={'ok' if exact_order else 'fail'}",
            f"extract_str={'ok' if extract_str else 'fail'}",
        ]
        if baseline:
            c = explain.get("cost")
            d = explain_delta.get("cost")
            if d is not None:
                log_parts.append(f"cost_delta={d:+d}")
            elif c is not None:
                log_parts.append(f"cost={c}")
        log_parts.append(fmt_latency(latency_ms))
        if latency_ratio is not None:
            log_parts.append(f"ratio={latency_ratio:.2f}x")
        log_line = " | ".join(log_parts)

        if is_match:
            print(f"  {g_}✓ Q{qid}{res} PASS | {log_line}")
        elif exec_ok:
            print(f"  {y_}◆ Q{qid}{res} mismatch | {log_line}")
        else:
            err_short = (error or "")[:60].replace("\n", " ")
            print(f"  {r_}✗ Q{qid}{res} exec FAIL | {log_line} | err={err_short}")

    return results


# ── Per-tier helpers ──────────────────────────────────────────────────────────

def _avg(values):
    return statistics.mean(values) if values else None


def _median(values):
    return statistics.median(values) if values else None


def _p95(values):
    if not values:
        return None
    s = sorted(values)
    idx = max(0, int(len(s) * 0.95) - 1)
    return s[idx]


def tier_latency_stats(results_list):
    lats = [r["latency_ms"] for r in results_list
            if isinstance(r.get("latency_ms"), (int, float))]
    return {
        "count": len(lats),
        "avg_ms": _avg(lats),
        "median_ms": _median(lats),
        "p95_ms": _p95(lats),
    }


def tier_accuracy(mcp_results_list, total_in_tier):
    matches = sum(1 for r in mcp_results_list if r.get("semantic_match"))
    return {
        "total": total_in_tier,
        "matches": matches,
        "accuracy_pct": (matches / total_in_tier * 100) if total_in_tier else 0.0,
    }


# ── Summary ───────────────────────────────────────────────────────────────────

def summarize_results(tests, baseline_results, mcp_results, run_mode):
    total = len(tests)
    summary = {"run_mode": run_mode, "total": total}

    # ── RQ1 + RQ4: Semantic correctness and comparison breakdown ───────────────
    if mcp_results:
        generated = sum(1 for r in mcp_results if r.get("generated"))
        executed  = sum(1 for r in mcp_results if r.get("executed"))
        matches   = sum(1 for r in mcp_results if r.get("semantic_match"))
        exact_order = sum(1 for r in mcp_results if r.get("exact_order_match"))
        extract_str = sum(1 for r in mcp_results if r.get("extract_string_match"))

        summary["rq1_semantic_correctness"] = {
            "total": total,
            "generated": generated,
            "executed": executed,
            "matches": matches,
            "accuracy_pct": (matches / total * 100) if total else 0.0,
            "exact_order_match": exact_order,
            "extract_string_match": extract_str,
        }

        # RQ4 — per-tier breakdown
        tier_rq4 = {}
        for tier in COMPLEXITY_TIERS:
            tier_tests = [t for t in tests
                          if str(t.get("complexity", "")).lower() == tier]
            tier_mcp   = [r for r in mcp_results
                          if str(r.get("complexity", "")).lower() == tier]
            tier_rq4[tier] = tier_accuracy(tier_mcp, len(tier_tests))

        # Degradation deltas
        tiers_present = [t for t in COMPLEXITY_TIERS if tier_rq4[t]["total"] > 0]
        degradation = {}
        for i in range(len(tiers_present) - 1):
            a, b = tiers_present[i], tiers_present[i + 1]
            degradation[f"{a}_to_{b}"] = (
                tier_rq4[b]["accuracy_pct"] - tier_rq4[a]["accuracy_pct"]
            )

        summary["rq4_robustness"] = {"by_tier": tier_rq4, "degradation": degradation}

    # ── RQ2: Execution efficiency ─────────────────────────────────────────────
    if baseline_results or mcp_results:
        rq2 = {}

        if baseline_results:
            base_overall = tier_latency_stats(baseline_results)
            base_by_tier = {
                tier: tier_latency_stats(
                    [r for r in baseline_results
                     if str(r.get("complexity", "")).lower() == tier]
                )
                for tier in COMPLEXITY_TIERS
            }
            rq2["baseline"] = {"overall": base_overall, "by_tier": base_by_tier}

        if mcp_results:
            mcp_overall = tier_latency_stats(
                [r for r in mcp_results if r.get("executed")]
            )
            mcp_by_tier = {
                tier: tier_latency_stats(
                    [r for r in mcp_results
                     if r.get("executed")
                     and str(r.get("complexity", "")).lower() == tier]
                )
                for tier in COMPLEXITY_TIERS
            }

            ratios = [r["latency_ratio"] for r in mcp_results
                      if isinstance(r.get("latency_ratio"), (int, float))]
            rq2["mcp"] = {
                "overall": mcp_overall,
                "by_tier": mcp_by_tier,
                "latency_ratio": {
                    "avg": _avg(ratios),
                    "median": _median(ratios),
                    "p95": _p95(ratios),
                    "count": len(ratios),
                },
            }

        summary["rq2_efficiency"] = rq2

    # ── RQ3: Optimization potential ───────────────────────────────────────────
    if mcp_results:
        cost_deltas   = [r["explain_delta"]["cost"]
                         for r in mcp_results
                         if r.get("explain_delta", {}).get("cost") is not None]
        card_deltas   = [r["explain_delta"]["cardinality"]
                         for r in mcp_results
                         if r.get("explain_delta", {}).get("cardinality") is not None]
        byte_deltas   = [r["explain_delta"]["bytes"]
                         for r in mcp_results
                         if r.get("explain_delta", {}).get("bytes") is not None]

        # Queries that are correct but cost more than baseline — prime candidates
        # for rule-based or learned optimisation
        correct_but_expensive = sum(
            1 for r in mcp_results
            if r.get("semantic_match")
            and r.get("explain_delta", {}).get("cost") is not None
            and r["explain_delta"]["cost"] > 0
        )

        summary["rq3_optimization"] = {
            "cost": {
                "comparable": len(cost_deltas),
                "mcp_lower":  sum(1 for x in cost_deltas if x < 0),
                "same":       sum(1 for x in cost_deltas if x == 0),
                "mcp_higher": sum(1 for x in cost_deltas if x > 0),
                "avg_delta":  _avg(cost_deltas),
                "median_delta": _median(cost_deltas),
            },
            "cardinality": {
                "comparable": len(card_deltas),
                "same":       sum(1 for x in card_deltas if x == 0),
                "different":  sum(1 for x in card_deltas if x != 0),
                "avg_delta":  _avg(card_deltas),
            },
            "bytes": {
                "comparable": len(byte_deltas),
                "mcp_lower":  sum(1 for x in byte_deltas if x < 0),
                "same":       sum(1 for x in byte_deltas if x == 0),
                "mcp_higher": sum(1 for x in byte_deltas if x > 0),
                "avg_delta":  _avg(byte_deltas),
            },
            "correct_but_expensive": correct_but_expensive,
        }

    # Baseline success (sanity metric)
    if baseline_results:
        baseline_ok = sum(1 for r in baseline_results if r.get("success"))
        summary["baseline_success"] = baseline_ok
        summary["baseline_success_rate"] = (baseline_ok / total * 100) if total else 0.0

    return summary


# ── Console output ────────────────────────────────────────────────────────────

def _pct(v):
    return f"{v:.2f}%" if isinstance(v, float) else "N/A"


def _ms(v):
    return f"{v:.2f}ms" if isinstance(v, (int, float)) else "N/A"


def print_summary(summary):
    c_, g_, y_, r_, m_, d_, res = (
        C.maybe(C.C), C.maybe(C.G), C.maybe(C.Y), C.maybe(C.R_),
        C.maybe(C.M), C.maybe(C.D), C.maybe(C.R),
    )
    sep = "=" * 70
    print(f"\n{c_}{C.B}{sep}{res}")
    print(f"  EVALUATION RESULTS")
    print(f"{c_}{sep}{res}\n")
    print(f"  Run mode  : {m_}{summary['run_mode']}{res}")
    print(f"  Total     : {summary['total']} questions")

    if "baseline_success" in summary:
        pct = summary['baseline_success_rate']
        col = g_ if pct == 100 else (y_ if pct >= 80 else r_)
        print(f"  Baseline  : {col}{summary['baseline_success']}/{summary['total']}{res} ({_pct(pct)})")

    rq1 = summary.get("rq1_semantic_correctness")
    if rq1:
        acc = rq1['accuracy_pct']
        col = g_ if acc >= 90 else (y_ if acc >= 70 else r_)
        print(f"\n  {c_}RQ1  Semantic Correctness{res}  (Baseline vs MCP comparison)")
        print(f"    Generated       : {rq1['generated']}/{rq1['total']}")
        print(f"    Executed        : {rq1['executed']}/{rq1['total']}")
        print(f"    Semantic match  : {col}{rq1['matches']}/{rq1['total']}{res}  ({_pct(acc)})")
        if rq1.get("exact_order_match") is not None:
            print(f"    Exact order     : {rq1['exact_order_match']}/{rq1['total']} (rows+values+order)")
        if rq1.get("extract_string_match") is not None:
            print(f"    Extract string  : {rq1['extract_string_match']}/{rq1['total']} (canonical JSON)")

    rq4 = summary.get("rq4_robustness")
    if rq4:
        print(f"\n  {c_}RQ4  Robustness Across Complexity{res}  (Accuracy by tier)")
        for tier, stats in rq4["by_tier"].items():
            acc = stats['accuracy_pct']
            col = g_ if acc == 100 else (y_ if acc >= 70 else r_)
            print(f"    {tier.capitalize():<8} : {col}{stats['matches']}/{stats['total']}{res}  ({_pct(acc)})")
        for label, delta in rq4.get("degradation", {}).items():
            arrow = "↓" if delta < 0 else ("↑" if delta > 0 else "→")
            lbl = label.replace("_to_", " → ")
            col = r_ if delta < 0 else (g_ if delta > 0 else d_)
            print(f"    {lbl:<28} {col}{arrow} {abs(delta):.2f}pp{res}")

    rq2 = summary.get("rq2_efficiency")
    if rq2:
        print(f"\n  {c_}RQ2  Execution Efficiency{res}  (Latency: baseline vs MCP)")
        if "baseline" in rq2:
            b = rq2["baseline"]["overall"]
            print(f"    Baseline : avg {_ms(b.get('avg_ms'))}  median {_ms(b.get('median_ms'))}  p95 {_ms(b.get('p95_ms'))}")
        if "mcp" in rq2:
            m = rq2["mcp"]["overall"]
            print(f"    MCP      : avg {_ms(m.get('avg_ms'))}  median {_ms(m.get('median_ms'))}  p95 {_ms(m.get('p95_ms'))}")
            lr = rq2["mcp"].get("latency_ratio", {})
            if lr.get("avg") is not None:
                x = lr['avg']
                col = y_ if x > 2 else (r_ if x > 5 else g_)
                print(f"    Overhead : {col}{lr['avg']:.2f}x{res} avg  {lr['median']:.2f}x median  {lr['p95']:.2f}x p95")
        if "baseline" in rq2 and "mcp" in rq2:
            print(f"    By tier  :")
            for tier in COMPLEXITY_TIERS:
                bt = rq2["baseline"]["by_tier"].get(tier, {})
                mt = rq2["mcp"]["by_tier"].get(tier, {})
                if bt.get("count", 0) > 0:
                    print(f"      {tier.capitalize():<8} : {_ms(bt.get('avg_ms'))} → {_ms(mt.get('avg_ms'))}")

    rq3 = summary.get("rq3_optimization")
    if rq3:
        c = rq3["cost"]
        print(f"\n  {c_}RQ3  Optimization Potential{res}  (EXPLAIN PLAN cost)")
        print(f"    Comparable : {c['comparable']}  |  MCP lower: {g_}{c['mcp_lower']}{res}  same: {c['same']}  higher: {r_}{c['mcp_higher']}{res}")
        if c.get("avg_delta") is not None:
            print(f"    Cost delta : avg {c['avg_delta']:+.1f}  median {c['median_delta']:+.1f}")
        print(f"    Correct but expensive (optimisation candidates) : {rq3['correct_but_expensive']}")

    print(f"\n{c_}{sep}{res}\n")


# ── Main runner ───────────────────────────────────────────────────────────────

def run(args):
    # 1. Move previous results to legacy_results/
    c_, g_, r_ = C.maybe(C.C), C.maybe(C.G), C.maybe(C.R_)
    res = C.maybe(C.R)

    n_moved = _move_previous_results_to_legacy()
    if n_moved:
        print(f"{c_}Moved {n_moved} previous result(s) to {RESULTS_DIR / 'legacy_results'}{res}")

    if args.run_mode in ("mcp", "compare"):
        print(f"\n{c_}Restarting MCP server...{res}")
        ok, err = _restart_mcp_server(args.mcp_url)
        if not ok:
            print(f"{r_}ERROR: {err}{res}")
            sys.exit(1)
        print(f"{g_}MCP server restarted.{res}")

        fail_reason = _check_mcp_and_llm(args.mcp_url, "llm")
        if fail_reason:
            print(f"\n{r_}ERROR: {fail_reason}{res}")
            sys.exit(1)

    qids = parse_ids(args.question_ids)
    complexities = parse_complexities(args.complexity)
    tests = load_tests(qids, complexities)

    if args.max_questions is not None:
        if args.max_questions <= 0:
            print(f"{r_}--max-questions must be > 0{res}")
            sys.exit(1)
        tests = tests[: args.max_questions]

    if not tests:
        print(f"{r_}No test questions selected.{res}")
        sys.exit(1)

    selected_counts = Counter(
        str(t.get("complexity", "unknown")).lower() for t in tests
    )
    print(f"\n{c_}── Test Selection ─────────────────────────────────────────────────────{res}")
    print(f"  IDs filter        : {args.question_ids or 'all'}")
    print(f"  Complexity filter : {args.complexity or 'all'}")
    print(f"  Max questions     : {args.max_questions if args.max_questions is not None else 'none'}")
    print(f"  Selected tests    : {g_}{len(tests)}{res}")
    print(f"  Mix               : {dict(selected_counts)}")

    db = Database(args.db_user, args.db_password, args.db_dsn)

    mcp = None
    if args.run_mode in ("mcp", "compare"):
        mcp = MCPClient(args.mcp_url)
        if not mcp.health():
            print(f"\n{r_}ERROR: MCP server is not healthy at {args.mcp_url}{res}")
            db.close()
            sys.exit(1)

    effective_explain = not args.no_explain  # EXPLAIN PLAN on by default

    m_ = C.maybe(C.M)
    print(f"\n{c_}Running {g_}{len(tests)}{res} test(s)  |  run_mode={m_}{args.run_mode}{res}  |  "
          f"mcp_mode=llm | explain={effective_explain}")

    baseline_results, baseline_by_id = [], {}
    mcp_results = []

    if args.run_mode in ("baseline", "compare"):
        print(f"\n{c_}── Baseline phase (local SQL) ─────────────────────────────────────────────{res}")
        baseline_results, baseline_by_id = run_baseline_tests(
            db, tests, include_explain=effective_explain
        )

    if args.run_mode in ("mcp", "compare"):
        print(f"\n{c_}── MCP phase (LLM-generated SQL) ──────────────────────────────────────────{res}")
        mcp_results = run_mcp_tests(
            db,
            mcp,
            tests,
            "llm",
            baseline_by_id=baseline_by_id if args.run_mode == "compare" else None,
            include_explain=effective_explain,
        )

    db.close()

    summary = summarize_results(tests, baseline_results, mcp_results, args.run_mode)
    print_summary(summary)

    result = {
        "timestamp": datetime.now().isoformat(),
        "run_mode": args.run_mode,
        "mcp_mode": "llm",
        "summary": summary,
        "baseline_results": baseline_results,
        "mcp_results": mcp_results,
    }

    out = RESULTS_DIR / f"mcp_evaluation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print(f"{g_}Results saved to:{res} {out}")

    if not args.no_visualize:
        print(f"\n{c_}── Generating visualizations ─────────────────────────────────────────────{res}")
        viz_script = SCRIPT_DIR / "visualize_results.py"
        try:
            subprocess.run(
                [sys.executable, str(viz_script), "--input", str(out)],
                check=True,
                cwd=str(SCRIPT_DIR),
            )
        except subprocess.CalledProcessError as e:
            y_ = C.maybe(C.Y)
            print(f"{y_}WARNING: Visualization failed (exit {e.returncode}). Results JSON saved.{res}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="MCP SQL Evaluation — RQ1 Correctness, RQ2 Efficiency, "
                    "RQ3 Optimization, RQ4 Robustness"
    )
    parser.add_argument(
        "--question-ids", default="",
        help="Comma-separated question IDs to run (default: all)",
    )
    parser.add_argument(
        "--complexity", default="all",
        help="Complexity filter: simple,medium,complex or all (default: all)",
    )
    # mcp_mode always "llm" — no lookup/hybrid
    parser.add_argument(
        "--run-mode", default="compare",
        choices=["baseline", "mcp", "compare"],
        help="baseline: baseline only | mcp: MCP only | compare: both (default: compare)",
    )
    parser.add_argument(
        "--no-explain", action="store_true",
        help="Skip EXPLAIN PLAN metrics (explain on by default)",
    )
    parser.add_argument(
        "--no-visualize", action="store_true",
        help="Skip generating visualization graphs and tables after evaluation",
    )
    parser.add_argument(
        "--max-questions", type=int, default=None,
        help="Cap the number of questions to run",
    )
    parser.add_argument(
        "--mcp-url", default=os.getenv("MCP_SERVER_URL", "http://localhost:3000"),
    )
    parser.add_argument("--db-user",     default=os.getenv("DB_USER",     "mcp_dev"))
    parser.add_argument("--db-password", default=os.getenv("DB_PASSWORD", "mcp_pass123"))
    parser.add_argument("--db-dsn",      default=os.getenv("DB_DSN",      "localhost:1521/FREE"))

    args = parser.parse_args()
    run(args)


if __name__ == "__main__":
    main()
