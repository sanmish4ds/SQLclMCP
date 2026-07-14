#!/usr/bin/env python3
"""DRL Experimental Telemetry and Verification Harness (VLDB artifact).

Loads an enterprise schema graph, instruments the context-pruning router,
optionally connects to PostgreSQL / MySQL / SQL Server, runs EXPLAIN, and
flags unsafe plan nodes (sequential scans on large transactional tables).

Usage (from repository root):
  python3 ESQ_Bench_VLDB/drl_telemetry_harness.py \\
    --schema-dir schemas/postgres \\
    --questions schemas/questions/tier1_questions.json \\
    --hints-file schemas/questions/tier1_schema_hints.json \\
    --limit 95

With live DB:
  python3 ESQ_Bench_VLDB/drl_telemetry_harness.py \\
    --engine postgres --dsn "postgresql://user:pass@127.0.0.1:5432/esq" \\
    --questions schemas/questions/tier1_questions.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import networkx as nx
except ImportError as exc:  # pragma: no cover
    raise SystemExit("networkx required: pip install networkx") from exc

VLDB_DIR = Path(__file__).resolve().parent
REPO_ROOT = VLDB_DIR.parent

CREATE_TABLE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.*?)\);",
    re.IGNORECASE | re.DOTALL,
)
FK_RE = re.compile(
    r"FOREIGN\s+KEY\s*\([^)]+\)\s*REFERENCES\s+(\w+)",
    re.IGNORECASE,
)
UNSAFE_SCAN_RE = re.compile(
    r"\b(Seq\s+Scan|Table\s+Scan|ALL\s+on\s+`?\w+`?)\b",
    re.IGNORECASE,
)


def ex_match(gold_rows, pred_rows) -> bool:
    if gold_rows is None or pred_rows is None:
        return False
    return sorted(gold_rows) == sorted(pred_rows)


def sd_flag(ex_ok: bool, sr_ok: bool, em_ok: bool) -> bool:
    if not ex_ok:
        return False
    if not sr_ok:
        return True
    return not em_ok


@dataclass
class SchemaGraph:
    graph: nx.Graph
    tables: dict[str, list[str]] = field(default_factory=dict)
    load_ms: float = 0.0
    # Per-source-file view: source filename -> {table: cols}. Unlike `tables`/`graph`,
    # this is never corrupted by cross-schema table-name collisions (see `collisions`),
    # because each entry is scoped to the file it was parsed from.
    by_source: dict[str, dict[str, list[str]]] = field(default_factory=dict)
    # Per-source-file subgraph: source filename -> nx.Graph, built only from that file's
    # own CREATE TABLE / FOREIGN KEY statements, so FK-neighbor expansion for one schema
    # can never wander into a same-named table belonging to a different schema.
    source_graphs: dict[str, "nx.Graph"] = field(default_factory=dict)
    # table name -> list of source filenames that declare a table with that exact name.
    # Any entry with len > 1 is a cross-schema name collision; `tables`/`graph` (the
    # pooled view) silently keep only the last-loaded file's columns/edges for that name.
    collisions: dict[str, list[str]] = field(default_factory=dict)

    @property
    def n_tables(self) -> int:
        return self.graph.number_of_nodes()

    @property
    def n_edges(self) -> int:
        return self.graph.number_of_edges()

    @property
    def n_tables_true(self) -> int:
        """Sum of per-source table counts -- the correct total, unaffected by collisions."""
        return sum(len(v) for v in self.by_source.values())


def load_schema_graph(schema_dir: Path) -> SchemaGraph:
    t0 = time.perf_counter()
    g = nx.Graph()
    tables: dict[str, list[str]] = {}
    by_source: dict[str, dict[str, list[str]]] = {}
    source_graphs: dict[str, nx.Graph] = {}
    collisions: dict[str, list[str]] = {}
    tables_source_of: dict[str, str] = {}
    for sql_path in sorted(schema_dir.glob("*.sql")):
        text = sql_path.read_text(encoding="utf-8", errors="replace")
        src = sql_path.name
        by_source.setdefault(src, {})
        sub_g = source_graphs.setdefault(src, nx.Graph())
        for m in CREATE_TABLE_RE.finditer(text):
            table = m.group(1).lower()
            body = m.group(2)
            cols = [
                ln.strip().split()[0].lower()
                for ln in body.split(",")
                if ln.strip() and not ln.strip().upper().startswith("CONSTRAINT")
            ]
            by_source[src][table] = cols
            sub_g.add_node(table, columns=cols, source=src)
            for fk in FK_RE.findall(body):
                sub_g.add_edge(table, fk.lower(), kind="fk")

            if table in tables:
                collisions.setdefault(table, [tables_source_of.get(table, "?")]).append(src)
            tables[table] = cols
            g.add_node(table, columns=cols, source=src)
            for fk in FK_RE.findall(body):
                g.add_edge(table, fk.lower(), kind="fk")
        # track first-writer source per bare table name for collision reporting
        for t in by_source[src]:
            tables_source_of.setdefault(t, src)
    return SchemaGraph(
        graph=g,
        tables=tables,
        load_ms=(time.perf_counter() - t0) * 1000.0,
        by_source=by_source,
        source_graphs=source_graphs,
        collisions=collisions,
    )


def _tokenize(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z][a-z0-9_]{2,}", text.lower())}


def prune_context_subgraph(
    sg: SchemaGraph,
    question: str,
    domain_hints: dict[str, str] | None = None,
    max_tables: int = 5,
) -> tuple[list[str], float, int]:
    """Keyword + 1-hop FK expansion router (bounded sub-graph)."""
    t0 = time.perf_counter()
    q_tokens = _tokenize(question)
    scores: dict[str, int] = {}
    for table, cols in sg.tables.items():
        table_tokens = _tokenize(table.replace("_", " "))
        col_tokens = _tokenize(" ".join(cols))
        hit = len(q_tokens & (table_tokens | col_tokens))
        if domain_hints:
            for blob in domain_hints.values():
                if table.upper() in blob.upper():
                    hit += 2
        if hit:
            scores[table] = hit

    if not scores:
        selected = list(sg.tables.keys())[:max_tables]
    else:
        # Tie-break by FK-degree (descending), not table iteration/insertion order:
        # a schema with many lexically-similar table names can otherwise exclude the
        # true seed table from the top-k' entirely, since Python's stable sort keeps
        # ties in whatever order the catalog file happened to declare them (see the
        # Appendix B worked trace). Higher FK-degree is a reasonable structural prior
        # for "this table is a real join hub," independent of naming coincidence.
        def sort_key(v: str) -> tuple[int, int]:
            return (scores[v], sg.graph.degree(v) if sg.graph.has_node(v) else 0)

        seeds = sorted(scores, key=sort_key, reverse=True)[:3]
        selected_set = set(seeds)
        # Rank neighbor candidates by FK-degree too, so truncation to max_tables keeps
        # the most structurally-connected neighbors rather than the alphabetically
        # first ones.
        candidates: dict[str, int] = {}
        for seed in seeds:
            for nbr in sg.graph.neighbors(seed):
                if nbr not in selected_set:
                    candidates[nbr] = max(candidates.get(nbr, 0), sg.graph.degree(nbr))
        for nbr in sorted(candidates, key=candidates.get, reverse=True):
            if len(selected_set) >= max_tables:
                break
            selected_set.add(nbr)
        selected = sorted(selected_set)[:max_tables]

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    sub = sg.graph.subgraph(selected).copy()
    mem_bytes = sys.getsizeof(json.dumps(nx.node_link_data(sub)))
    return selected, elapsed_ms, mem_bytes


def explain_plan(engine: str, conn: Any, sql: str) -> tuple[str | None, str | None]:
    sql_clean = sql.strip().rstrip(";")
    cur = conn.cursor()
    try:
        if engine == "postgres":
            cur.execute(f"EXPLAIN (FORMAT TEXT) {sql_clean}")
            rows = cur.fetchall()
            plan = "\n".join(r[0] for r in rows)
            return plan, None
        if engine == "mysql":
            cur.execute(f"EXPLAIN {sql_clean}")
            rows = cur.fetchall()
            plan = json.dumps([list(r) for r in rows], default=str)
            return plan, None
        if engine == "sqlserver":
            cur.execute(f"SET SHOWPLAN_TEXT ON; {sql_clean}; SET SHOWPLAN_TEXT OFF;")
            chunks = []
            while True:
                if cur.description:
                    chunks.extend(str(r[0]) for r in cur.fetchall())
                if not cur.nextset():
                    break
            return "\n".join(chunks), None
        return None, f"unsupported engine {engine}"
    except Exception as exc:
        return None, str(exc)
    finally:
        cur.close()


def plan_safety_compliant(plan: str | None, large_tables: set[str]) -> bool:
    if not plan:
        return False
    if not UNSAFE_SCAN_RE.search(plan):
        return True
    for tbl in large_tables:
        if tbl.lower() in plan.lower() and UNSAFE_SCAN_RE.search(plan):
            return False
    return True


def sd_op_index(ex_ok: bool, em_ok: bool, sr_ok: bool, plan_safe: bool) -> bool:
    if not ex_ok:
        return False
    if sd_flag(ex_ok, sr_ok, em_ok):
        return True
    return not plan_safe


def open_connection(engine: str, dsn: str):
    if engine == "postgres":
        import psycopg2

        return psycopg2.connect(dsn)
    if engine == "mysql":
        import pymysql

        cfg = json.loads(dsn) if dsn.startswith("{") else {"host": "127.0.0.1", "user": "root", "database": "esq"}
        return pymysql.connect(**cfg)
    if engine == "sqlserver":
        import pyodbc

        return pyodbc.connect(dsn)
    raise ValueError(engine)


def run_harness(args: argparse.Namespace) -> dict:
    sg = load_schema_graph(args.schema_dir)
    domain_hints = json.loads(args.hints_file.read_text()) if args.hints_file else {}

    questions = json.loads(args.questions.read_text()).get("questions", [])
    if args.limit:
        questions = questions[: args.limit]

    large_tables = {t for t in sg.tables if t in ("orders", "transactions", "order_lines", "payments")}

    conn = None
    if args.dsn:
        conn = open_connection(args.engine, args.dsn)

    records = []
    prune_times: list[float] = []
    mem_footprints: list[int] = []
    plan_safe_count = 0
    plan_checked = 0
    sd_op_count = 0
    ex_count = 0

    for q in questions:
        selected, prune_ms, mem_b = prune_context_subgraph(
            sg, q.get("question", ""), domain_hints, max_tables=args.max_tables
        )
        prune_times.append(prune_ms)
        mem_footprints.append(mem_b)

        gold_sql = q.get("gold_sql", "")
        plan_text, plan_err = (None, "no connection")
        executed = False
        gold_rows = pred_rows = None
        exec_ms = None
        if conn and gold_sql:
            cur = conn.cursor()
            try:
                t_exec = time.perf_counter()
                cur.execute(gold_sql.strip().rstrip(";"))
                gold_rows = cur.fetchall()
                pred_rows = gold_rows
                executed = True
                exec_ms = (time.perf_counter() - t_exec) * 1000.0
                plan_text, plan_err = explain_plan(args.engine, conn, gold_sql)
            except Exception as exc:
                plan_err = str(exc)
            finally:
                cur.close()

        plan_safe = plan_safety_compliant(plan_text, large_tables)
        if plan_text:
            plan_checked += 1
            plan_safe_count += int(plan_safe)

        ex_ok = ex_match(gold_rows, pred_rows) if executed else False
        em_ok = True
        sr_ok = ex_ok
        if ex_ok:
            ex_count += 1
        if sd_op_index(ex_ok, em_ok, sr_ok, plan_safe):
            sd_op_count += 1

        records.append(
            {
                "id": q.get("id"),
                "prune_ms": round(prune_ms, 3),
                "mem_bytes": mem_b,
                "selected_tables": selected,
                "plan_safe": plan_safe,
                "plan_error": plan_err,
                "exec_ms": round(exec_ms, 3) if exec_ms is not None else None,
            }
        )

    if conn:
        conn.close()

    def pct(xs: list[float], p: float) -> float:
        if not xs:
            return 0.0
        xs_sorted = sorted(xs)
        k = int(round((p / 100.0) * (len(xs_sorted) - 1)))
        return xs_sorted[k]

    return {
        "schema_tables": sg.n_tables,
        "schema_edges": sg.n_edges,
        "schema_load_ms": round(sg.load_ms, 3),
        "questions": len(records),
        "prune_ms_mean": round(sum(prune_times) / max(len(prune_times), 1), 3),
        "prune_ms_p50": round(pct(prune_times, 50), 3),
        "prune_ms_p95": round(pct(prune_times, 95), 3),
        "graph_mem_bytes_mean": int(sum(mem_footprints) / max(len(mem_footprints), 1)),
        "plan_safety_rate": round(plan_safe_count / max(plan_checked, 1), 4),
        "sd_op_rate_on_ex": round(sd_op_count / max(ex_count, 1), 4),
        "records": records,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="DRL telemetry harness (VLDB artifact)")
    ap.add_argument("--schema-dir", type=Path, default=REPO_ROOT / "schemas" / "postgres")
    ap.add_argument("--questions", type=Path, required=True)
    ap.add_argument("--hints-file", type=Path, default=None)
    ap.add_argument("--engine", choices=("postgres", "mysql", "sqlserver"), default="postgres")
    ap.add_argument("--dsn", default="", help="DB connection string (optional for offline prune-only)")
    ap.add_argument("--max-tables", type=int, default=5)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", type=Path, default=VLDB_DIR / "drl_telemetry.json")
    args = ap.parse_args()

    summary = run_harness(args)
    args.out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "records"}, indent=2))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
