#!/usr/bin/env python3
"""Copy latest evaluation PNGs to research/figures/ and research/tables/.

Maps experiment output filenames to the names expected by the LaTeX paper.
Run after mcp_evaluation.py (with visualize) to sync the paper with latest results.

Usage:
  python copy_results_to_research.py [--input path/to/mcp_evaluation_*.json]
"""

import argparse
import shutil
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
RESULTS_DIR = SCRIPT_DIR / "results"
RESEARCH_FIGURES = PROJECT_ROOT / "research" / "figures"
RESEARCH_TABLES = PROJECT_ROOT / "research" / "tables"

# (experiment suffix, research filename)
GRAPHS = [
    ("graph_01_complexity_distribution", "graph_1_complexity_distribution.png"),
    ("graph_02_category_distribution", "graph_2_category_distribution.png"),
    ("graph_03_accuracy_by_complexity", "graph_3_mcp_accuracy_by_complexity.png"),
    ("graph_04_baseline_vs_mcp_latency", "graph_4_baseline_vs_mcp.png"),
    ("graph_05_complexity_success_rates", "graph_5_complexity_success_rates.png"),
    ("graph_06_test_coverage_matrix", "graph_6_test_coverage_matrix.png"),
    ("graph_07_summary_metrics", "graph_7_summary_metrics.png"),
    ("graph_08_latency_per_query", "graph_8_latency_per_query.png"),
    ("graph_09_explain_cost_per_query", "graph_9_explain_cost.png"),
    ("graph_09_explain_cost_per_query", "graph_9_explain_plan_per_query.png"),
    ("graph_10_explain_plan_delta", "graph_10_explain_plan_delta.png"),
    ("graph_11_explain_cardinality", "graph_11_explain_cardinality.png"),
    ("graph_12_explain_bytes", "graph_12_explain_bytes.png"),
    ("graph_13_explain_plan_table", "graph_13_explain_plan_table.png"),
]

TABLE_MAP = {
    "table_01_dataset_summary": "table_01_dataset_summary.png",
    "table_02_accuracy_results": "table_02_accuracy_results.png",
    "table_03_baseline_performance": "table_03_baseline_performance.png",
    "table_04_optimization_metrics": "table_04_optimization_metrics.png",
    "table_05_failure_analysis": "table_05_failure_analysis.png",
    "table_06_latency_comparison": "table_06_latency_comparison.png",
}


def main():
    parser = argparse.ArgumentParser(description="Copy evaluation PNGs to research/")
    parser.add_argument("--input", "-i", default=None, help="Path to mcp_evaluation_*.json")
    args = parser.parse_args()

    if args.input:
        in_path = Path(args.input).resolve()
    else:
        files = sorted(RESULTS_DIR.glob("mcp_evaluation_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not files:
            print("No mcp_evaluation_*.json found in experiments/results/")
            return 1
        in_path = files[0]

    base = in_path.stem + "_"  # mcp_evaluation_20260314_170413_

    RESEARCH_FIGURES.mkdir(parents=True, exist_ok=True)
    RESEARCH_TABLES.mkdir(parents=True, exist_ok=True)

    n_figs, n_tabs = 0, 0

    for exp_name, research_name in GRAPHS:
        src = RESULTS_DIR / f"{base}{exp_name}.png"
        if src.exists():
            shutil.copy2(src, RESEARCH_FIGURES / research_name)
            print(f"  {exp_name} -> figures/{research_name}")
            n_figs += 1

    for exp_name, research_name in TABLE_MAP.items():
        src = RESULTS_DIR / f"{base}{exp_name}.png"
        if src.exists():
            dst = RESEARCH_TABLES / research_name
            shutil.copy2(src, dst)
            print(f"  Copied {exp_name} -> tables/{research_name}")
            n_tabs += 1

    print(f"\nCopied {n_figs} figures, {n_tabs} tables to research/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
