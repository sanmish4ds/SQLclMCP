#!/usr/bin/env python3
"""Export failure cases: baseline (gold) vs generated SQL in a readable table.

Usage:
  python export_failure_cases.py [--input results/sql_evaluation_*.json]

Output: failure_cases_<basename>.md in the same directory as the input JSON.
"""

import argparse
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
RESULTS_DIR = SCRIPT_DIR / "results"


def main():
    parser = argparse.ArgumentParser(
        description="Export failure cases: baseline vs generated SQL in a readable table"
    )
    parser.add_argument(
        "--input", "-i",
        default=None,
        help="Path to sql_evaluation_*.json (default: latest in experiments/results)",
    )
    args = parser.parse_args()

    if args.input:
        in_path = Path(args.input).resolve()
    else:
        files = sorted(
            list(RESULTS_DIR.glob("sql_evaluation_*.json"))
            + list(RESULTS_DIR.glob("mcp_evaluation_*.json")),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not files:
            print("No evaluation JSON found in experiments/results/")
            return 1
        in_path = files[0]

    if not in_path.exists():
        print(f"File not found: {in_path}")
        return 1

    with open(in_path, encoding="utf-8") as f:
        data = json.load(f)

    baseline_by_id = {r["id"]: r for r in data.get("baseline_results", [])}
    mcp_by_id = {r["id"]: r for r in data.get("mcp_results", [])}

    failures = []
    for qid, mcp in sorted(mcp_by_id.items(), key=lambda x: x[0]):
        if mcp.get("semantic_match"):
            continue
        base = baseline_by_id.get(qid)
        failures.append((qid, base, mcp))

    if not failures:
        out_path = in_path.parent / "failure_cases_none.md"
        with open(out_path, "w", encoding="utf-8") as f:
            f.write("# Failure Cases\n\nNo failures. All tests passed semantic match.\n")
        print(f"No failures. Wrote: {out_path}")
        return 0

    # Build markdown report
    lines = [
        "# Failure Cases: Baseline vs MCP Generated",
        "",
        f"Source: `{in_path.name}`",
        f"Total failures: {len(failures)}",
        "",
        "| ID | Question | Complexity | Failure reason | Baseline rows | MCP rows |",
        "|----|----------|------------|----------------|---------------|----------|",
    ]

    for qid, base, mcp in failures:
        q = (mcp.get("question") or "").replace("|", " ").replace("\n", " ")
        question = q[:60] + ("..." if len(q) > 60 else "")
        complexity = mcp.get("complexity", "?")
        if not mcp.get("generated"):
            reason = "No SQL generated"
        elif not mcp.get("executed"):
            err = (mcp.get("error") or "unknown").replace("\n", " ").replace("|", " ").strip()[:60]
            reason = f"Execution error: {err}"
        else:
            reason = "Semantic mismatch"
        base_rows = base.get("row_count") if base and base.get("success") else "-"
        mcp_rows = mcp.get("row_count") if mcp.get("rows") is not None else "-"
        lines.append(f"| {qid} | {question} | {complexity} | {reason} | {base_rows} | {mcp_rows} |")

    lines.extend([
        "",
        "---",
        "",
        "## Baseline SQL (Local)",
        "",
    ])

    for qid, base, mcp in failures:
        lines.append(f"### Q{qid}: {mcp.get('question', '')[:80]}")
        lines.append("")
        if base and base.get("sql"):
            lines.append("```sql")
            lines.append(base["sql"])
            lines.append("```")
        else:
            lines.append("*No baseline SQL*")
        lines.append("")
        if base and base.get("error"):
            lines.append(f"**Baseline error:** {base['error']}")
            lines.append("")

    lines.extend([
        "---",
        "",
        "## MCP Generated SQL",
        "",
    ])

    for qid, base, mcp in failures:
        lines.append(f"### Q{qid}: {mcp.get('question', '')[:80]}")
        lines.append("")
        if mcp.get("mcp_sql"):
            lines.append("```sql")
            lines.append(mcp["mcp_sql"])
            lines.append("```")
        else:
            lines.append("*No MCP SQL*")
        lines.append("")
        if mcp.get("error"):
            lines.append(f"**MCP error:** {mcp['error']}")
            lines.append("")

    stem = in_path.stem
    for prefix in ("sql_evaluation_", "mcp_evaluation_"):
        if stem.startswith(prefix):
            stem = stem[len(prefix):]
            break
    out_path = in_path.parent / f"failure_cases_{stem}.md"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Wrote: {out_path} ({len(failures)} failure(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
