"""Build schema context strings for DRL middleware NL2SQL ablation (B1/B2/B3)."""
from __future__ import annotations

import importlib.util
import sys
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
VLDB_DIR = REPO_ROOT / "ESQ_Bench_VLDB"

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


@lru_cache(maxsize=1)
def _load_harness():
    name = "drl_telemetry_harness_ctx"
    spec = importlib.util.spec_from_file_location(name, VLDB_DIR / "drl_telemetry_harness.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@lru_cache(maxsize=1)
def _full_graph():
    return _load_harness().load_schema_graph(REPO_ROOT / "schemas" / "postgres")


def _tables_for_owner(sg, owner: str) -> dict[str, list[str]]:
    # Collision-free: see run_drl_baselines.tables_for_schema for why filtering the
    # pooled graph by node["source"] silently drops tables for schemas whose table
    # names collide with a later-loaded schema file.
    src = SCHEMA_TO_SQL.get(owner, "")
    return dict(sg.by_source.get(src, {}))


def pruned_schema_context(
    owner: str,
    question: str,
    tier_hints: dict[str, str],
    max_tables: int = 5,
) -> tuple[str, list[str], float]:
    """Return compact pruned schema string, selected tables, prune_ms."""
    drl = _load_harness()
    sg = _full_graph()
    src = SCHEMA_TO_SQL.get(owner, "")
    sub_tables = _tables_for_owner(sg, owner)
    sub_sg = drl.SchemaGraph(
        graph=sg.source_graphs.get(src, drl.nx.Graph()),
        tables=sub_tables,
        load_ms=sg.load_ms,
    )
    selected, prune_ms, _ = drl.prune_context_subgraph(
        sub_sg, question, tier_hints, max_tables=max_tables
    )
    lines = [f"{t}({', '.join(sub_tables.get(t, []))})" for t in selected]
    header = f"PostgreSQL schema {owner}. Use ONLY these tables and columns:\n"
    return header + "\n".join(lines), selected, prune_ms


def middleware_schema_context(
    baseline: str,
    question: str,
    schema_owner: str,
    tier_hints: dict[str, str],
) -> tuple[str, dict]:
    """B1=full tier hint, B2=pruned subgraph, B3=pruned (rules added in build_messages)."""
    bl = baseline.lower().replace("drl_", "")
    if bl == "b1":
        ctx = tier_hints.get(schema_owner, "")
        return ctx, {"baseline": "B1", "pruned_tables": [], "prune_ms": 0.0, "context_kind": "full_tier_hint"}

    ctx, selected, prune_ms = pruned_schema_context(schema_owner, question, tier_hints)
    return ctx, {
        "baseline": bl.upper(),
        "pruned_tables": selected,
        "prune_ms": prune_ms,
        "context_kind": "pruned_subgraph",
    }
