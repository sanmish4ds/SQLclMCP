#!/usr/bin/env python3
"""Run DRL middleware baselines B0–B3 on the 1,000-pair verification suite.

B0  Full-catalog context (all tables in schema DDL)
B1  Schema-linked tier hint (full tier hint text)
B2  Dynamic context pruning only (Algorithm 1)
B3  Pruning + transactional safeguards (COALESCE scan + EXPLAIN PSC)

Output: ESQ_Bench_VLDB/drl_baseline_metrics.json

Usage:
  python3 ESQ_Bench_VLDB/run_drl_baselines.py
  python3 ESQ_Bench_VLDB/run_drl_baselines.py --engine postgres --limit 100
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

VLDB_DIR = Path(__file__).resolve().parent
REPO_ROOT = VLDB_DIR.parent
sys.path.insert(0, str(REPO_ROOT / "schemas" / "seed"))

from dbio import open_db  # noqa: E402

# Load harness module from same directory
_spec = importlib.util.spec_from_file_location("drl_harness", VLDB_DIR / "drl_telemetry_harness.py")
_drl = importlib.util.module_from_spec(_spec)
sys.modules["drl_harness"] = _drl
_spec.loader.exec_module(_drl)

SCHEMA_TO_SQL = {
    "SALES_ORDER": "01_t1a_sales_order.sql",
    "UNIVERSITY": "02_t1b_university.sql",
    "PORTFOLIO_MGMT": "03_t2a_portfolio_mgmt.sql",
    "HEALTHCARE": "04_t2b_healthcare.sql",
    "CORE_BANKING": "05_t3a_core_banking.sql",
    "INSURANCE": "06_t3b_insurance.sql",
}
SCHEMA_TIER = {
    "SALES_ORDER": 1,
    "UNIVERSITY": 1,
    "PORTFOLIO_MGMT": 2,
    "HEALTHCARE": 2,
    "CORE_BANKING": 3,
    "INSURANCE": 3,
}
HOT_TABLES = frozenset({"orders", "transactions", "order_lines", "payments"})
AGG_RE = re.compile(r"\b(SUM|AVG|MIN|MAX)\s*\(\s*(?!COALESCE)([a-z_][a-z0-9_]*)", re.I)


def load_hints(tier: int) -> dict[str, str]:
    path = REPO_ROOT / "schemas" / "questions" / f"tier{tier}_schema_hints.json"
    return json.loads(path.read_text(encoding="utf-8"))


def tables_for_schema(sg: _drl.SchemaGraph, owner: str) -> dict[str, list[str]]:
    # Uses the collision-free per-source view (SchemaGraph.by_source) rather than
    # filtering the pooled graph by node["source"]: 48 table names collide across
    # the six schema files (e.g. "claims" in both Healthcare and Insurance), and the
    # pooled graph's `source` attribute reflects only whichever file loaded last for
    # that name, silently dropping legitimate tables from earlier-loaded schemas.
    src = SCHEMA_TO_SQL.get(owner, "")
    return dict(sg.by_source.get(src, {}))


def full_catalog_context_bytes(sg: _drl.SchemaGraph, owner: str) -> int:
    subset = tables_for_schema(sg, owner)
    lines = []
    for t, cols in sorted(subset.items()):
        lines.append(f"{t}({', '.join(cols)})")
    return sys.getsizeof("\n".join(lines))


def pruned_hint_bytes(sg: _drl.SchemaGraph, owner: str, question: str, hints: dict) -> tuple[int, float, int]:
    src = SCHEMA_TO_SQL.get(owner, "")
    sub_tables = tables_for_schema(sg, owner)
    sub_sg = _drl.SchemaGraph(
        graph=sg.source_graphs.get(src, _drl.nx.Graph()),
        tables=sub_tables,
        load_ms=sg.load_ms,
    )
    selected, prune_ms, mem_b = _drl.prune_context_subgraph(sub_sg, question, hints, max_tables=5)
    lines = [f"{t}({', '.join(sub_tables.get(t, []))})" for t in selected]
    return sys.getsizeof("\n".join(lines)), prune_ms, mem_b


def apply_null_safeguards(sql: str) -> str:
    """Insert COALESCE on bare aggregate columns (B3 safeguard S3)."""

    def repl(m):
        fn, col = m.group(1), m.group(2)
        return f"{fn}(COALESCE({col}, 0)"

    return AGG_RE.sub(repl, sql)


def explain_postgres(schema: str, sql: str) -> tuple[str | None, str | None]:
    try:
        db = open_db("postgres", schema)
        cur = db.con.cursor()
        cur.execute(f"EXPLAIN (FORMAT TEXT) {sql.strip().rstrip(';')}")
        plan = "\n".join(r[0] for r in cur.fetchall())
        db.close()
        return plan, None
    except Exception as exc:
        return None, str(exc)


def explain_mysql(schema: str, sql: str) -> tuple[str | None, str | None]:
    try:
        db = open_db("mysql", schema)
        cur = db.con.cursor()
        cur.execute(f"EXPLAIN {sql.strip().rstrip(';')}")
        rows = cur.fetchall()
        plan = json.dumps([list(r) for r in rows], default=str)
        db.close()
        return plan, None
    except Exception as exc:
        return None, str(exc)


def explain_plan(engine: str, schema: str, sql: str) -> tuple[str | None, str | None]:
    if engine == "postgres":
        return explain_postgres(schema, sql)
    if engine == "mysql":
        return explain_mysql(schema, sql)
    return None, "unsupported engine"


def percentile(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    xs = sorted(xs)
    k = int(round((p / 100.0) * (len(xs) - 1)))
    return xs[k]


def run_baselines(args: argparse.Namespace) -> dict:
    suite_path = REPO_ROOT / "schemas" / "questions" / "verification_suite_1000.json"
    questions = json.loads(suite_path.read_text(encoding="utf-8"))["questions"]
    if args.limit:
        questions = questions[: args.limit]

    sg = _drl.load_schema_graph(REPO_ROOT / "schemas" / "postgres")
    hints_by_tier = {t: load_hints(t) for t in (1, 2, 3)}

    metrics: dict[str, dict] = {
        b: {
            "context_bytes": [],
            "prune_ms": [],
            "graph_mem_bytes": [],
            "plan_checked": 0,
            "plan_safe": 0,
            "middleware_ms": [],
        }
        for b in ("B0", "B1", "B2", "B3")
    }

    for q in questions:
        owner = q["schema"]
        tier = SCHEMA_TIER[owner]
        hints = hints_by_tier[tier]
        sql = (q.get("pg_gold_sql") or q.get("gold_sql") or "").strip().rstrip(";")
        if args.engine == "mysql":
            if q.get("mysql_skip"):
                sql = ""
            else:
                sql = (q.get("mysql_gold_sql") or q.get("gold_sql") or "").strip().rstrip(";")

        # B0: full catalog
        b0_ctx = full_catalog_context_bytes(sg, owner)
        metrics["B0"]["context_bytes"].append(b0_ctx)
        metrics["B0"]["prune_ms"].append(0.0)
        metrics["B0"]["graph_mem_bytes"].append(b0_ctx)
        t0 = time.perf_counter()
        if args.engine in ("postgres", "mysql") and sql:
            plan, _ = explain_plan(args.engine, owner, sql)
            metrics["B0"]["plan_checked"] += int(plan is not None)
            metrics["B0"]["plan_safe"] += int(_drl.plan_safety_compliant(plan, HOT_TABLES))
        metrics["B0"]["middleware_ms"].append((time.perf_counter() - t0) * 1000.0)

        # B1: full tier hint
        b1_ctx = sys.getsizeof(hints.get(owner, ""))
        metrics["B1"]["context_bytes"].append(b1_ctx)
        metrics["B1"]["prune_ms"].append(0.0)
        metrics["B1"]["graph_mem_bytes"].append(b1_ctx)
        t0 = time.perf_counter()
        if args.engine in ("postgres", "mysql") and sql:
            plan, _ = explain_plan(args.engine, owner, sql)
            metrics["B1"]["plan_checked"] += int(plan is not None)
            metrics["B1"]["plan_safe"] += int(_drl.plan_safety_compliant(plan, HOT_TABLES))
        metrics["B1"]["middleware_ms"].append((time.perf_counter() - t0) * 1000.0)

        # B2: pruning only
        b2_ctx, prune_ms, mem_b = pruned_hint_bytes(sg, owner, q.get("question", ""), hints)
        metrics["B2"]["context_bytes"].append(b2_ctx)
        metrics["B2"]["prune_ms"].append(prune_ms)
        metrics["B2"]["graph_mem_bytes"].append(mem_b)
        t0 = time.perf_counter()
        if args.engine in ("postgres", "mysql") and sql:
            plan, _ = explain_plan(args.engine, owner, sql)
            metrics["B2"]["plan_checked"] += int(plan is not None)
            metrics["B2"]["plan_safe"] += int(_drl.plan_safety_compliant(plan, HOT_TABLES))
        metrics["B2"]["middleware_ms"].append((time.perf_counter() - t0) * 1000.0 + prune_ms)

        # B3: prune + safeguards
        safe_sql = apply_null_safeguards(sql)
        metrics["B3"]["context_bytes"].append(b2_ctx)
        metrics["B3"]["prune_ms"].append(prune_ms)
        metrics["B3"]["graph_mem_bytes"].append(mem_b)
        t0 = time.perf_counter()
        if args.engine in ("postgres", "mysql") and safe_sql:
            plan, _ = explain_plan(args.engine, owner, safe_sql)
            metrics["B3"]["plan_checked"] += int(plan is not None)
            metrics["B3"]["plan_safe"] += int(_drl.plan_safety_compliant(plan, HOT_TABLES))
        metrics["B3"]["middleware_ms"].append((time.perf_counter() - t0) * 1000.0 + prune_ms)

    summary = {
        "suite": "verification_1000",
        "questions": len(questions),
        "engine": args.engine,
        "schema_tables": sg.n_tables,
        "schema_tables_true": sg.n_tables_true,
        "schema_table_collisions": len(sg.collisions),
        "baselines": {},
    }

    for b, m in metrics.items():
        ctx = m["context_bytes"]
        prune = m["prune_ms"]
        mem = m["graph_mem_bytes"]
        mw = m["middleware_ms"]
        checked = m["plan_checked"]
        safe = m["plan_safe"]
        summary["baselines"][b] = {
            "context_bytes_mean": int(statistics.mean(ctx)) if ctx else 0,
            "context_bytes_p50": int(percentile([float(x) for x in ctx], 50)),
            "context_reduction_vs_B0_pct": round(100.0 * (1.0 - statistics.mean(ctx) / max(statistics.mean(metrics["B0"]["context_bytes"]), 1)), 2) if b != "B0" and ctx else 0.0,
            "prune_ms_mean": round(statistics.mean(prune), 3),
            "prune_ms_p50": round(percentile(prune, 50), 3),
            "prune_ms_p95": round(percentile(prune, 95), 3),
            "graph_mem_bytes_mean": int(statistics.mean(mem)) if mem else 0,
            "graph_mem_bytes_p50": int(percentile([float(x) for x in mem], 50)),
            "middleware_ms_mean": round(statistics.mean(mw), 3),
            "middleware_ms_p50": round(percentile(mw, 50), 3),
            "middleware_ms_p95": round(percentile(mw, 95), 3),
            "plan_safety_compliance": round(safe / max(checked, 1), 4),
            "plan_checked": checked,
        }

    # Delta CSD proxy: context reduction B1 -> B2
    b1_mean = summary["baselines"]["B1"]["context_bytes_mean"]
    b2_mean = summary["baselines"]["B2"]["context_bytes_mean"]
    summary["context_scaling_delta_bytes"] = {
        "B1_mean": b1_mean,
        "B2_mean": b2_mean,
        "reduction_pct": round(100.0 * (1.0 - b2_mean / max(b1_mean, 1)), 2),
    }
    return summary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=("postgres", "mysql", "offline"), default="postgres")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", type=Path, default=VLDB_DIR / "drl_baseline_metrics.json")
    args = ap.parse_args()

    summary = run_baselines(args)
    args.out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
