#!/usr/bin/env python3
"""Generate submission figures for drl_middleware_vldb.tex."""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

VLDB_DIR = Path(__file__).resolve().parent
ROOT = VLDB_DIR.parent
FIG = VLDB_DIR / "figures"
FIG.mkdir(exist_ok=True)
RESULTS = ROOT / "experiments" / "results"


def analyze_failures():
    """Aggregate the per-tier taxonomy from analyze_esq_failures.py into the
    paper's 5-bucket scheme. Source of truth: experiments/results/
    gpt4o_failure_taxonomy_fresh.json (fine-grained F0-F4 tags), not the
    (separately-maintained) verification_failure_stats.json summary file.
    """
    path = ROOT / "experiments" / "results" / "gpt4o_failure_taxonomy_fresh.json"
    reports = json.loads(path.read_text(encoding="utf-8"))
    buckets = Counter()
    total = 0
    ex_rows = sd_rows = 0
    for r in reports:
        total += r["total"]
        fm = r["failure_modes"]
        buckets["semantic_or_filter"] += fm.get("F3_wrong_results", 0) + fm.get("F3_wrong_shape", 0)
        buckets["exec_error"] += fm.get("F1_exec_error", 0)
        buckets["ordering_or_pagination"] += (
            fm.get("F2_limit_syntax", 0) + fm.get("F2_except_syntax", 0) + fm.get("F2_dialect_nonstandard", 0)
        )
        buckets["projection_mismatch"] += fm.get("F3_projection_mismatch", 0)
        buckets["invalid_column_name"] += fm.get("F1_syntactic_invalid", 0)
    ex_pass = total - sum(buckets.values())
    return {
        "n": total,
        "ex_pct": round(100 * ex_pass / total, 1),
        "failure_modes": dict(buckets),
    }


def fig_ex_by_tier():
    summary = json.loads((RESULTS / "verification_1000_summary.json").read_text())
    tiers = [1, 2, 3]

    def series(model: str):
        return [
            next(r["ex_pct"] for r in summary if r["model"] == model and r["tier"] == t and r["n"] > 100)
            for t in tiers
        ]

    gpt = series("gpt-4o")
    gem = series("gemini-2.5-flash")
    cla = series("claude-sonnet-4-5")
    fig, ax = plt.subplots(figsize=(3.4, 2.4))
    x = range(3)
    w = 0.25
    ax.bar([i - w for i in x], gpt, w, label="GPT-4o", color="#2196F3")
    ax.bar(list(x), gem, w, label="Gemini 2.5", color="#FF9800")
    ax.bar([i + w for i in x], cla, w, label="Claude", color="#4CAF50")
    ax.set_xticks(list(x), ["T1", "T2", "T3"])
    ax.set_ylabel("Execution match (%)")
    ax.set_ylim(0, 65)
    ax.legend(fontsize=6)
    ax.set_title("Verification suite (PostgreSQL)", fontsize=9)
    fig.tight_layout()
    fig.savefig(FIG / "fig_ex_by_tier.pdf")
    plt.close(fig)


def fig_context():
    m = json.loads((VLDB_DIR / "drl_baseline_metrics.json").read_text())
    labels = ["B0", "B1", "B2"]
    vals = [m["baselines"][b]["context_bytes_mean"] for b in labels]
    fig, ax = plt.subplots(figsize=(3.2, 2.3))
    ax.bar(["Full\nDDL", "Tier\nhint", "Pruned"], vals, color=["#9E9E9E", "#607D8B", "#4CAF50"])
    ax.set_ylabel("Mean context (bytes)")
    fig.tight_layout()
    fig.savefig(FIG / "fig_context_reduction.pdf")
    plt.close(fig)


def fig_failures(stats):
    labels = list(stats["failure_modes"].keys())
    vals = list(stats["failure_modes"].values())
    fig, ax = plt.subplots(figsize=(3.4, 2.5))
    ax.barh(labels, vals, color="#E53935")
    ax.set_xlabel("Count")
    fig.tight_layout()
    fig.savefig(FIG / "fig_failure_modes.pdf")
    plt.close(fig)


if __name__ == "__main__":
    stats = analyze_failures()
    fig_ex_by_tier()
    fig_context()
    fig_failures(stats)
    print("figures ok", stats)
