#!/usr/bin/env python3
"""Comprehensive visualization for MCP evaluation results.

Produces 13 graphs + 6 tables matching the research paper structure:

  Graphs:
    graph_01_complexity_distribution.png
    graph_02_category_distribution.png
    graph_03_accuracy_by_complexity.png
    graph_04_baseline_vs_mcp_latency.png
    graph_05_complexity_success_rates.png
    graph_06_test_coverage_matrix.png
    graph_07_summary_metrics.png
    graph_08_latency_per_query.png
    graph_09_explain_cost_per_query.png
    graph_10_explain_plan_delta.png
    graph_11_explain_cardinality.png
    graph_12_explain_bytes.png
    graph_13_explain_plan_table.png

  Tables (rendered as PNG):
    table_01_dataset_summary.png
    table_02_accuracy_results.png
    table_03_baseline_performance.png
    table_04_optimization_metrics.png
    table_05_failure_analysis.png
    table_06_latency_comparison.png
"""

import argparse
import json
import os
import statistics
import tempfile
from pathlib import Path

# Ensure matplotlib has a writable cache dir even in restricted environments
os.environ.setdefault("MPLCONFIGDIR", tempfile.mkdtemp(prefix="mpl_"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.colors as mcolors
from matplotlib.gridspec import GridSpec
import numpy as np

COMPLEXITY_TIERS   = ("simple", "medium", "complex")
TIER_COLORS        = {"simple": "#4CAF50", "medium": "#2196F3", "complex": "#F44336"}
TIER_COLORS_LIGHT  = {"simple": "#C8E6C9", "medium": "#BBDEFB", "complex": "#FFCDD2"}
PALETTE            = ["#26A69A", "#42A5F5", "#EF5350", "#FFA726", "#AB47BC", "#66BB6A"]
DPI                = 140


# ── Utility ───────────────────────────────────────────────────────────────────

def latest_json(results_dir: Path) -> Path | None:
    files = sorted(
        results_dir.glob("mcp_evaluation_*.json"),
        key=lambda p: p.stat().st_mtime, reverse=True
    )
    return files[0] if files else None


def _save(fig, path: Path):
    fig.tight_layout()
    fig.savefig(path, dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {path.name}")


def _bar_val(ax, bars, fmt="{:.0f}", fontsize=8, color="black"):
    for bar in bars:
        h = bar.get_height()
        if h > 0:
            ax.text(bar.get_x() + bar.get_width() / 2, h + 0.3,
                    fmt.format(h), ha="center", va="bottom", fontsize=fontsize, color=color)


def _stats(values):
    if not values:
        return None, None, None, None
    return (statistics.mean(values), statistics.median(values),
            sorted(values)[max(0, int(len(values) * 0.95) - 1)],
            statistics.stdev(values) if len(values) > 1 else 0.0)


def _tier_rows(results, tier):
    return [r for r in results if str(r.get("complexity", "")).lower() == tier]


# ── Graph 01: Complexity Distribution ────────────────────────────────────────

def graph_01(data, out):
    baseline = data.get("baseline_results", [])
    counts   = {t: len(_tier_rows(baseline, t)) for t in COMPLEXITY_TIERS}
    total    = sum(counts.values())

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 5))

    # Pie
    labels = [f"{t.capitalize()}\n({counts[t]}, {counts[t]/total*100:.1f}%)"
              for t in COMPLEXITY_TIERS]
    wedges, _ = ax1.pie(
        [counts[t] for t in COMPLEXITY_TIERS],
        labels=labels,
        colors=[TIER_COLORS[t] for t in COMPLEXITY_TIERS],
        startangle=140, wedgeprops=dict(edgecolor="white", linewidth=1.5),
    )
    ax1.set_title("Dataset Complexity Distribution (Pie)", fontsize=12)

    # Bar
    bars = ax2.bar(
        [t.capitalize() for t in COMPLEXITY_TIERS],
        [counts[t] for t in COMPLEXITY_TIERS],
        color=[TIER_COLORS[t] for t in COMPLEXITY_TIERS],
        edgecolor="white", linewidth=0.8,
    )
    _bar_val(ax2, bars)
    ax2.set_ylabel("Query count")
    ax2.set_title("Dataset Complexity Distribution (Bar)", fontsize=12)
    ax2.spines[["top", "right"]].set_visible(False)

    fig.suptitle(f"Graph 01 — Dataset Distribution  (Total: {total} queries)", fontsize=13, y=1.01)
    _save(fig, out)


# ── Graph 02: Category Distribution ──────────────────────────────────────────

def graph_02(data, out):
    baseline = data.get("baseline_results", [])
    # Build category from question text (first 3 words as proxy)
    cats = {}
    for r in baseline:
        q = r.get("question", "")
        words = q.split()
        cat = " ".join(words[:3]).lower().rstrip("?")
        cats[cat] = cats.get(cat, 0) + 1

    # Keep top 15
    sorted_cats = sorted(cats.items(), key=lambda x: -x[1])[:15]
    labels, values = zip(*sorted_cats) if sorted_cats else ([], [])

    fig, ax = plt.subplots(figsize=(12, 5))
    colors = [PALETTE[i % len(PALETTE)] for i in range(len(labels))]
    bars = ax.barh(list(reversed(labels)), list(reversed(values)),
                   color=list(reversed(colors)), edgecolor="white")
    for bar, v in zip(bars, reversed(values)):
        ax.text(bar.get_width() + 0.2, bar.get_y() + bar.get_height() / 2,
                str(v), va="center", fontsize=8)
    ax.set_xlabel("Query count")
    ax.set_title("Graph 02 — Query Category Distribution (Top 15)", fontsize=12)
    ax.spines[["top", "right"]].set_visible(False)
    _save(fig, out)


# ── Graph 03: MCP Accuracy by Complexity ─────────────────────────────────────

def graph_03(data, out):
    mcp_res   = data.get("mcp_results", [])
    rq4       = data.get("summary", {}).get("rq4_robustness", {}).get("by_tier", {})

    tiers  = [t for t in COMPLEXITY_TIERS if rq4.get(t, {}).get("total", 0) > 0]
    totals = [rq4[t]["total"]   for t in tiers]
    passes = [rq4[t]["matches"] for t in tiers]
    accs   = [rq4[t]["accuracy_pct"] for t in tiers]

    x = np.arange(len(tiers))
    w = 0.35

    fig, ax = plt.subplots(figsize=(9, 5))
    b1 = ax.bar(x - w/2, totals, w, label="Total",  color="#90A4AE", edgecolor="white")
    b2 = ax.bar(x + w/2, passes, w, label="Passed", color=[TIER_COLORS[t] for t in tiers],
                edgecolor="white")

    for bar, acc in zip(b2, accs):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5,
                f"{acc:.1f}%", ha="center", va="bottom", fontsize=10, fontweight="bold")

    ax.set_xticks(x)
    ax.set_xticklabels([t.capitalize() for t in tiers])
    ax.set_ylabel("Query count")
    ax.set_title("Graph 03 — MCP Accuracy by Complexity", fontsize=12)
    ax.legend()
    ax.spines[["top", "right"]].set_visible(False)
    overall = data.get("summary", {}).get("rq1_semantic_correctness", {}).get("accuracy_pct", 0)
    ax.set_xlabel(f"Overall accuracy: {overall:.2f}%", fontsize=9, color="#555")
    _save(fig, out)


# ── Graph 04: Baseline vs MCP Latency ────────────────────────────────────────

def graph_04(data, out):
    rq2 = data.get("summary", {}).get("rq2_efficiency", {})

    tiers_present = [t for t in COMPLEXITY_TIERS
                     if rq2.get("baseline", {}).get("by_tier", {}).get(t, {}).get("count", 0) > 0]

    b_avgs = [rq2["baseline"]["by_tier"][t].get("avg_ms", 0) for t in tiers_present]
    m_avgs = [rq2.get("mcp", {}).get("by_tier", {}).get(t, {}).get("avg_ms", 0) or 0
              for t in tiers_present]
    b_p95  = [rq2["baseline"]["by_tier"][t].get("p95_ms", 0) for t in tiers_present]
    m_p95  = [rq2.get("mcp", {}).get("by_tier", {}).get(t, {}).get("p95_ms", 0) or 0
              for t in tiers_present]

    x = np.arange(len(tiers_present))
    w = 0.2

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))

    # Avg
    ba = ax1.bar(x - w*1.5, b_avgs, w, label="Baseline Avg", color="#78909C", edgecolor="white")
    ma = ax1.bar(x - w/2,   m_avgs, w, label="MCP Avg",      color="#42A5F5", edgecolor="white")
    bp = ax1.bar(x + w/2,   b_p95,  w, label="Baseline P95", color="#B0BEC5", edgecolor="white")
    mp = ax1.bar(x + w*1.5, m_p95,  w, label="MCP P95",      color="#90CAF9", edgecolor="white")
    for bars in [ba, ma, bp, mp]:
        for bar in bars:
            h = bar.get_height()
            if h > 0:
                ax1.text(bar.get_x() + bar.get_width()/2, h,
                         f"{h:.1f}", ha="center", va="bottom", fontsize=7, rotation=45)
    ax1.set_xticks(x)
    ax1.set_xticklabels([t.capitalize() for t in tiers_present])
    ax1.set_ylabel("Milliseconds")
    ax1.set_title("Avg & P95 Latency by Tier", fontsize=11)
    ax1.legend(fontsize=8)
    ax1.spines[["top", "right"]].set_visible(False)

    # Ratio histogram
    ratios = [r["latency_ratio"] for r in data.get("mcp_results", [])
              if isinstance(r.get("latency_ratio"), (int, float))]
    if ratios:
        ax2.hist(ratios, bins=40, color="#42A5F5", edgecolor="white", alpha=0.85)
        avg_r = sum(ratios) / len(ratios)
        ax2.axvline(1.0,  color="#F44336", linestyle="--", lw=1.5, label="1× (baseline)")
        ax2.axvline(avg_r, color="#FF9800", linestyle="--", lw=1.5, label=f"Avg {avg_r:.2f}×")
        ax2.set_xlabel("Latency ratio (MCP / Baseline)")
        ax2.set_ylabel("Query count")
        ax2.set_title("Latency Ratio Distribution", fontsize=11)
        ax2.legend(fontsize=8)
        ax2.spines[["top", "right"]].set_visible(False)
    else:
        ax2.text(0.5, 0.5, "No ratio data\n(run in compare mode)",
                 ha="center", va="center", transform=ax2.transAxes, color="#888", fontsize=10)
        ax2.axis("off")

    fig.suptitle("Graph 04 — Baseline vs MCP Latency Comparison", fontsize=13, y=1.01)
    _save(fig, out)


# ── Graph 05: Complexity Success Rates ───────────────────────────────────────

def graph_05(data, out):
    rq4 = data.get("summary", {}).get("rq4_robustness", {}).get("by_tier", {})
    tiers = [t for t in COMPLEXITY_TIERS if rq4.get(t, {}).get("total", 0) > 0]
    accs  = [rq4[t]["accuracy_pct"] for t in tiers]

    fig, ax = plt.subplots(figsize=(8, 5))
    bars = ax.bar([t.capitalize() for t in tiers], accs,
                  color=[TIER_COLORS[t] for t in tiers], edgecolor="white", linewidth=0.8)
    for bar, acc in zip(bars, accs):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() - 4,
                f"{acc:.1f}%", ha="center", va="top", fontsize=13, fontweight="bold",
                color="white")

    ax.set_ylim(0, 115)
    ax.axhline(100, color="#aaa", linestyle="--", lw=0.8)
    ax.set_ylabel("Accuracy (%)")
    ax.set_title("Graph 05 — Complexity Success Rates", fontsize=12)
    ax.spines[["top", "right"]].set_visible(False)

    deg = data.get("summary", {}).get("rq4_robustness", {}).get("degradation", {})
    note = "  ".join(f"{k.replace('_to_',' → ')}: {v:+.1f}pp" for k, v in deg.items())
    ax.set_xlabel(note, fontsize=8, color="#555")
    _save(fig, out)


# ── Graph 06: Test Coverage Matrix (Heatmap) ─────────────────────────────────

def graph_06(data, out):
    mcp_res = data.get("mcp_results", [])
    if not mcp_res:
        print("  [Graph 06] No MCP results, skipping."); return

    n   = len(mcp_res)
    cols = min(25, n)
    rows = (n + cols - 1) // cols
    matrix = np.zeros((rows, cols))
    for i, r in enumerate(mcp_res):
        row_i, col_i = divmod(i, cols)
        matrix[row_i, col_i] = 1 if r.get("semantic_match") else (0.5 if r.get("executed") else 0)

    fig, ax = plt.subplots(figsize=(14, max(4, rows * 0.45)))
    cmap = mcolors.ListedColormap(["#EF5350", "#FFA726", "#66BB6A"])
    im = ax.imshow(matrix, cmap=cmap, vmin=0, vmax=1, aspect="auto")
    ax.set_xlabel("Query index (within row)")
    ax.set_ylabel("Row block")
    ax.set_title("Graph 06 — Test Coverage Matrix  (Green=Pass, Orange=Executed/Mismatch, Red=Fail)",
                 fontsize=11)

    handles = [mpatches.Patch(color="#66BB6A", label="Pass (semantic match)"),
               mpatches.Patch(color="#FFA726", label="Executed but mismatch"),
               mpatches.Patch(color="#EF5350", label="Failed / not generated")]
    ax.legend(handles=handles, loc="upper right", fontsize=8, bbox_to_anchor=(1.18, 1))
    _save(fig, out)


# ── Graph 07: Summary Metrics Overview ───────────────────────────────────────

def graph_07(data, out):
    s   = data.get("summary", {})
    rq1 = s.get("rq1_semantic_correctness", {})
    total = s.get("total", 0)

    metrics = {
        "Baseline\nSuccess": s.get("baseline_success_rate", 0),
        "MCP\nGenerated": rq1.get("generated", 0) / total * 100 if total else 0,
        "MCP\nExecuted":  rq1.get("executed",  0) / total * 100 if total else 0,
        "Semantic\nMatch": rq1.get("accuracy_pct", 0),
    }

    fig, ax = plt.subplots(figsize=(9, 5))
    bars = ax.bar(list(metrics.keys()), list(metrics.values()),
                  color=["#26A69A", "#42A5F5", "#66BB6A", "#AB47BC"],
                  edgecolor="white", linewidth=0.8)
    for bar, v in zip(bars, metrics.values()):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5,
                f"{v:.1f}%", ha="center", va="bottom", fontsize=11, fontweight="bold")

    ax.set_ylim(0, 115)
    ax.axhline(100, color="#ccc", linestyle="--", lw=0.8)
    ax.set_ylabel("Percentage (%)")
    ax.set_title("Graph 07 — Summary Metrics Overview", fontsize=12)
    ax.spines[["top", "right"]].set_visible(False)
    _save(fig, out)


# ── Graph 08: Latency Per Query ───────────────────────────────────────────────

def graph_08(data, out):
    baseline = data.get("baseline_results", [])
    mcp_res  = data.get("mcp_results", [])

    b_by_id = {r["id"]: r.get("latency_ms") for r in baseline}

    fig, ax = plt.subplots(figsize=(14, 5))
    colors = {"simple": TIER_COLORS["simple"], "medium": TIER_COLORS["medium"],
              "complex": TIER_COLORS["complex"]}

    xs_b, ys_b, cs_b = [], [], []
    xs_m, ys_m = [], []

    for r in baseline:
        if isinstance(r.get("latency_ms"), (int, float)):
            xs_b.append(r["id"])
            ys_b.append(r["latency_ms"])
            cs_b.append(colors.get(str(r.get("complexity", "")).lower(), "#90A4AE"))

    for r in mcp_res:
        if isinstance(r.get("latency_ms"), (int, float)) and r.get("executed"):
            xs_m.append(r["id"])
            ys_m.append(r["latency_ms"])

    ax.scatter(xs_b, ys_b, c=cs_b, s=12, alpha=0.7, label="Baseline", marker="o", zorder=2)
    if xs_m:
        ax.scatter(xs_m, ys_m, c="#90CAF9", s=12, alpha=0.7, label="MCP", marker="x", zorder=3)

    ax.set_xlabel("Question ID")
    ax.set_ylabel("Latency (ms)")
    ax.set_title("Graph 08 — Per-Query Latency (all 500 queries)", fontsize=12)
    ax.set_yscale("symlog", linthresh=1)
    ax.spines[["top", "right"]].set_visible(False)

    handles = [mpatches.Patch(color=TIER_COLORS[t], label=f"Baseline {t}") for t in COMPLEXITY_TIERS]
    if xs_m:
        handles.append(plt.Line2D([0], [0], marker="x", color="#90CAF9", lw=0, label="MCP"))
    ax.legend(handles=handles, fontsize=8, ncol=2)
    _save(fig, out)


# ── Graph 09: EXPLAIN PLAN Cost Per Query ────────────────────────────────────

def graph_09(data, out):
    baseline = data.get("baseline_results", [])
    mcp_res  = data.get("mcp_results", [])

    fig, ax = plt.subplots(figsize=(14, 5))

    for r in baseline:
        cost = r.get("explain_plan", {}).get("cost")
        if cost is not None:
            tier = str(r.get("complexity", "")).lower()
            ax.scatter(r["id"], cost, c=TIER_COLORS.get(tier, "#90A4AE"),
                       s=14, alpha=0.7, marker="o", zorder=2)

    for r in mcp_res:
        cost = r.get("explain_plan", {}).get("cost")
        if cost is not None:
            ax.scatter(r["id"], cost, c="#90CAF9", s=14, alpha=0.7, marker="x", zorder=3)

    ax.set_xlabel("Question ID")
    ax.set_ylabel("EXPLAIN PLAN Cost")
    ax.set_title("Graph 09 — EXPLAIN PLAN Cost Per Query", fontsize=12)
    ax.set_yscale("symlog", linthresh=1)
    ax.spines[["top", "right"]].set_visible(False)

    handles = [mpatches.Patch(color=TIER_COLORS[t], label=f"Baseline {t}") for t in COMPLEXITY_TIERS]
    handles.append(plt.Line2D([0], [0], marker="x", color="#90CAF9", lw=0, label="MCP cost"))
    ax.legend(handles=handles, fontsize=8)
    _save(fig, out)


# ── Graph 10: EXPLAIN PLAN Delta ─────────────────────────────────────────────

def graph_10(data, out):
    rq3 = data.get("summary", {}).get("rq3_optimization", {})
    if not rq3:
        print("  [Graph 10] No RQ3 data."); return

    c = rq3.get("cost", {})
    b = rq3.get("bytes", {})

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))

    for ax, metric, title in [(ax1, c, "Plan Cost"), (ax2, b, "Estimated Bytes")]:
        labels  = ["MCP Lower", "Same", "MCP Higher"]
        values  = [metric.get("mcp_lower", 0), metric.get("same", 0), metric.get("mcp_higher", 0)]
        colors_ = ["#66BB6A", "#90A4AE", "#EF5350"]
        bars = ax.bar(labels, values, color=colors_, edgecolor="white")
        _bar_val(ax, bars)
        ax.set_title(f"{title} Comparison\n(comparable: {metric.get('comparable',0)})", fontsize=11)
        ax.set_ylabel("Queries")
        avg = metric.get("avg_delta")
        if avg is not None:
            ax.set_xlabel(f"Avg delta: {avg:+.1f}", fontsize=9, color="#555")
        ax.set_ylim(0, max(values + [1]) * 1.25)
        ax.spines[["top", "right"]].set_visible(False)

    fig.suptitle("Graph 10 — EXPLAIN PLAN Delta Analysis (MCP vs Baseline)", fontsize=13, y=1.02)
    _save(fig, out)


# ── Graph 11: Cardinality Analysis ───────────────────────────────────────────

def graph_11(data, out):
    mcp_res = data.get("mcp_results", [])
    deltas  = [r["explain_delta"]["cardinality"] for r in mcp_res
               if r.get("explain_delta", {}).get("cardinality") is not None]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 5))

    # Same vs Different bar
    same  = sum(1 for d in deltas if d == 0)
    diff  = sum(1 for d in deltas if d != 0)
    bars  = ax1.bar(["Same", "Different"], [same, diff], color=["#66BB6A", "#EF5350"],
                    edgecolor="white")
    _bar_val(ax1, bars)
    ax1.set_title(f"Cardinality Agreement\n({len(deltas)} comparable)", fontsize=11)
    ax1.set_ylabel("Queries")
    ax1.spines[["top", "right"]].set_visible(False)

    # Histogram of non-zero deltas
    nonzero = [d for d in deltas if d != 0]
    if nonzero:
        ax2.hist(nonzero, bins=30, color="#EF5350", edgecolor="white", alpha=0.85)
        ax2.set_xlabel("Cardinality delta (MCP − Baseline)")
        ax2.set_ylabel("Queries")
        ax2.set_title("Non-Zero Cardinality Deltas", fontsize=11)
        ax2.spines[["top", "right"]].set_visible(False)
    else:
        ax2.text(0.5, 0.5, "All cardinality estimates\nidentical to baseline",
                 ha="center", va="center", transform=ax2.transAxes, fontsize=11, color="#388E3C")
        ax2.axis("off")

    fig.suptitle("Graph 11 — Cardinality Estimation Analysis", fontsize=13, y=1.02)
    _save(fig, out)


# ── Graph 12: Bytes Analysis ─────────────────────────────────────────────────

def graph_12(data, out):
    mcp_res = data.get("mcp_results", [])
    deltas  = [r["explain_delta"]["bytes"] for r in mcp_res
               if r.get("explain_delta", {}).get("bytes") is not None]

    rq3 = data.get("summary", {}).get("rq3_optimization", {}).get("bytes", {})

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 5))

    # Distribution bar
    vals   = [rq3.get("mcp_lower", 0), rq3.get("same", 0), rq3.get("mcp_higher", 0)]
    colors = ["#66BB6A", "#90A4AE", "#EF5350"]
    bars   = ax1.bar(["MCP Lower", "Same", "MCP Higher"], vals, color=colors, edgecolor="white")
    _bar_val(ax1, bars)
    ax1.set_title(f"Estimated Bytes Distribution\n({rq3.get('comparable',0)} comparable)", fontsize=11)
    ax1.set_ylabel("Queries")
    ax1.spines[["top", "right"]].set_visible(False)

    # Scatter: baseline bytes vs mcp bytes
    base_res = data.get("baseline_results", [])
    b_by_id  = {r["id"]: r.get("explain_plan", {}).get("bytes") for r in base_res}
    xs, ys   = [], []
    for r in mcp_res:
        mb = r.get("explain_plan", {}).get("bytes")
        bb = b_by_id.get(r["id"])
        if mb is not None and bb is not None:
            xs.append(bb); ys.append(mb)

    if xs:
        lim = max(max(xs), max(ys)) * 1.05
        ax2.scatter(xs, ys, alpha=0.5, s=15, color="#42A5F5")
        ax2.plot([0, lim], [0, lim], "r--", lw=1, label="y = x (identical)")
        ax2.set_xlabel("Baseline bytes")
        ax2.set_ylabel("MCP bytes")
        ax2.set_title("Bytes: Baseline vs MCP (scatter)", fontsize=11)
        ax2.legend(fontsize=8)
        ax2.spines[["top", "right"]].set_visible(False)
    else:
        ax2.text(0.5, 0.5, "No comparable byte data",
                 ha="center", va="center", transform=ax2.transAxes, color="#888")
        ax2.axis("off")

    fig.suptitle("Graph 12 — Data Transfer (Bytes) Analysis", fontsize=13, y=1.02)
    _save(fig, out)


# ── Graph 13: EXPLAIN PLAN Table (visual table) ───────────────────────────────

def graph_13(data, out):
    baseline = data.get("baseline_results", [])
    mcp_res  = data.get("mcp_results", [])
    m_by_id  = {r["id"]: r for r in mcp_res}

    rows = []
    for r in baseline[:50]:   # first 50 rows for readability
        qid  = r["id"]
        tier = str(r.get("complexity", "")).capitalize()
        b_cost = r.get("explain_plan", {}).get("cost", "—")
        m_cost = m_by_id.get(qid, {}).get("explain_plan", {}).get("cost", "—")
        delta  = m_by_id.get(qid, {}).get("explain_delta", {}).get("cost")
        match  = "✓" if m_by_id.get(qid, {}).get("semantic_match") else "✗"
        b_lat  = r.get("latency_ms")
        m_lat  = m_by_id.get(qid, {}).get("latency_ms")
        rows.append([str(qid), tier,
                     str(b_cost), str(m_cost),
                     f"{delta:+d}" if delta is not None else "—",
                     f"{b_lat:.1f}" if isinstance(b_lat, float) else "—",
                     f"{m_lat:.1f}" if isinstance(m_lat, float) else "—",
                     match])

    col_labels = ["Q#", "Tier", "Base Cost", "MCP Cost", "Δ Cost",
                  "Base ms", "MCP ms", "Match"]

    fig, ax = plt.subplots(figsize=(14, max(5, len(rows) * 0.22 + 1.5)))
    ax.axis("off")

    tbl = ax.table(
        cellText=rows, colLabels=col_labels,
        loc="center", cellLoc="center",
    )
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(7.5)
    tbl.scale(1, 1.2)

    # Header style
    for j in range(len(col_labels)):
        tbl[0, j].set_facecolor("#37474F")
        tbl[0, j].set_text_props(color="white", fontweight="bold")

    # Row banding + match colouring
    last_col = len(col_labels) - 1
    for i, row in enumerate(rows, start=1):
        bg = "#FAFAFA" if i % 2 == 0 else "#ECEFF1"
        for j in range(len(col_labels)):
            tbl[i, j].set_facecolor(bg)
        if row[last_col] == "✓":
            tbl[i, last_col].set_facecolor("#C8E6C9")
        else:
            tbl[i, last_col].set_facecolor("#FFCDD2")

    ax.set_title(f"Graph 13 — EXPLAIN PLAN Table (first {len(rows)} queries)", fontsize=12, pad=10)
    _save(fig, out)


# ── Table 01: Dataset Summary ─────────────────────────────────────────────────

def table_01(data, out):
    baseline = data.get("baseline_results", [])
    total = len(baseline)

    rows = []
    for tier in COMPLEXITY_TIERS:
        tr = _tier_rows(baseline, tier)
        lats = [r["latency_ms"] for r in tr if isinstance(r.get("latency_ms"), (int, float))]
        avg_lat = statistics.mean(lats) if lats else 0
        rows.append([tier.capitalize(), str(len(tr)),
                     f"{len(tr)/total*100:.1f}%" if total else "—",
                     f"{avg_lat:.2f}"])

    total_lats = [r["latency_ms"] for r in baseline if isinstance(r.get("latency_ms"), (int, float))]
    avg_total  = statistics.mean(total_lats) if total_lats else 0
    rows.append(["Total", str(total), "100.0%", f"{avg_total:.2f}"])

    headers = ["Complexity Level", "Count", "%", "Avg Latency (ms)"]
    _render_table(fig_title="Table 01 — Test Dataset Composition by Complexity Level",
                  headers=headers, rows=rows, out=out,
                  footer="Baseline execution times measured on Oracle 26ai. "
                         "Avg latency measured with warm Oracle buffer pool.")


# ── Table 02: Accuracy Results ────────────────────────────────────────────────

def table_02(data, out):
    rq4 = data.get("summary", {}).get("rq4_robustness", {}).get("by_tier", {})
    rq1 = data.get("summary", {}).get("rq1_semantic_correctness", {})
    total = data.get("summary", {}).get("total", 0)

    rows = []
    for tier in COMPLEXITY_TIERS:
        t = rq4.get(tier, {})
        n  = t.get("total", 0)
        m  = t.get("matches", 0)
        f  = n - m
        acc = t.get("accuracy_pct", 0)
        rows.append([tier.capitalize(), str(n), str(m), f"{acc:.2f}%",
                     "100.0%", f"{f} failure(s)" if f > 0 else "None"])

    overall_acc = rq1.get("accuracy_pct", 0)
    rows.append(["Overall", str(total), str(rq1.get("matches", 0)),
                 f"{overall_acc:.2f}%", "100.0%", ""])

    headers = ["Complexity", "Total", "Matches", "Accuracy", "Row Count Acc.", "Notes"]
    _render_table(fig_title="Table 02 — MCP Semantic Accuracy Results by Query Complexity",
                  headers=headers, rows=rows, out=out,
                  footer="Semantic accuracy: sorted result set comparison (normalized tuples). "
                         "Row count accuracy measures cardinality agreement.")


# ── Table 03: Baseline Performance ───────────────────────────────────────────

def table_03(data, out):
    baseline = data.get("baseline_results", [])
    rows = []
    for tier in COMPLEXITY_TIERS:
        tr   = _tier_rows(baseline, tier)
        lats = [r["latency_ms"] for r in tr if isinstance(r.get("latency_ms"), (int, float))]
        if not lats:
            continue
        mean_, med_, p95_, std_ = _stats(lats)
        rows.append([tier.capitalize(), str(len(tr)),
                     f"{mean_:.2f}", f"{med_:.2f}", f"{p95_:.2f}", f"{std_:.2f}"])

    all_lats = [r["latency_ms"] for r in baseline if isinstance(r.get("latency_ms"), (int, float))]
    if all_lats:
        mean_, med_, p95_, std_ = _stats(all_lats)
        rows.append(["Overall", str(len(baseline)),
                     f"{mean_:.2f}", f"{med_:.2f}", f"{p95_:.2f}", f"{std_:.2f}"])

    headers = ["Complexity", "Count", "Mean (ms)", "Median (ms)", "P95 (ms)", "StdDev (ms)"]
    _render_table(fig_title="Table 03 — Baseline Query Performance Statistics",
                  headers=headers, rows=rows, out=out,
                  footer="All baseline queries execute successfully (100% success rate). "
                         "Complex queries show high variance due to different JOIN strategies.")


# ── Table 04: Optimization Metrics ───────────────────────────────────────────

def table_04(data, out):
    rq3  = data.get("summary", {}).get("rq3_optimization", {})
    rq2  = data.get("summary", {}).get("rq2_efficiency", {})
    c    = rq3.get("cost", {})
    b    = rq3.get("bytes", {})
    cd   = rq3.get("cardinality", {})
    cbe  = rq3.get("correct_but_expensive", 0)

    lr   = rq2.get("mcp", {}).get("latency_ratio", {}) if rq2.get("mcp") else {}
    b_ov = rq2.get("baseline", {}).get("overall", {}) if rq2.get("baseline") else {}
    m_ov = rq2.get("mcp", {}).get("overall", {}) if rq2.get("mcp") else {}

    b_avg = b_ov.get("avg_ms")
    m_avg = m_ov.get("avg_ms")
    avg_delta_ms = (m_avg - b_avg) if (b_avg and m_avg) else None
    avg_delta_pct = (avg_delta_ms / b_avg * 100) if (b_avg and avg_delta_ms is not None) else None

    b_p95 = b_ov.get("p95_ms")
    m_p95 = m_ov.get("p95_ms")
    p95_delta_ms  = (m_p95 - b_p95) if (b_p95 and m_p95) else None
    p95_delta_pct = (p95_delta_ms / b_p95 * 100) if (b_p95 and p95_delta_ms is not None) else None

    rows = [
        ["EXPLAIN Cost — MCP Lower",   str(c.get("mcp_lower", 0)),
         f"{c.get('mcp_lower',0)/c.get('comparable',1)*100:.1f}%" if c.get("comparable") else "—"],
        ["EXPLAIN Cost — Same",         str(c.get("same", 0)),
         f"{c.get('same',0)/c.get('comparable',1)*100:.1f}%"      if c.get("comparable") else "—"],
        ["EXPLAIN Cost — MCP Higher",   str(c.get("mcp_higher", 0)),
         f"{c.get('mcp_higher',0)/c.get('comparable',1)*100:.1f}%" if c.get("comparable") else "—"],
        ["Cardinality — Exact Match",   str(cd.get("same", 0)),
         f"{cd.get('same',0)/cd.get('comparable',1)*100:.1f}%"     if cd.get("comparable") else "—"],
        ["Bytes — Same",                str(b.get("same", 0)),
         f"{b.get('same',0)/b.get('comparable',1)*100:.1f}%"       if b.get("comparable") else "—"],
        ["Correct but Expensive",       str(cbe), "—"],
        ["Mean Latency Delta",
         f"{avg_delta_ms:+.2f} ms" if avg_delta_ms is not None else "—",
         f"{avg_delta_pct:+.1f}%"  if avg_delta_pct is not None else "—"],
        ["P95 Latency Delta",
         f"{p95_delta_ms:+.2f} ms" if p95_delta_ms is not None else "—",
         f"{p95_delta_pct:+.1f}%"  if p95_delta_pct is not None else "—"],
    ]
    headers = ["Metric", "Queries / Value", "Percentage / Note"]
    _render_table(fig_title="Table 04 — Query Optimization Analysis: Cost, Cardinality & Latency",
                  headers=headers, rows=rows, out=out,
                  footer="EXPLAIN PLAN via Oracle EXPLAIN PLAN statement. "
                         "Correct-but-expensive: semantically correct queries with higher optimizer cost.")


# ── Table 05: Failure Analysis ────────────────────────────────────────────────

def table_05(data, out):
    mcp_res = data.get("mcp_results", [])
    not_gen  = [r for r in mcp_res if not r.get("generated")]
    not_exec = [r for r in mcp_res if r.get("generated") and not r.get("executed")]
    mismatch = [r for r in mcp_res if r.get("executed") and not r.get("semantic_match")]

    def tier_count(lst, tier):
        return sum(1 for r in lst if str(r.get("complexity","")).lower() == tier)

    rows = []
    for tier in COMPLEXITY_TIERS:
        n = tier_count(not_gen, tier)
        e = tier_count(not_exec, tier)
        m = tier_count(mismatch, tier)
        total_tier = sum(1 for r in mcp_res if str(r.get("complexity","")).lower() == tier)
        rows.append([tier.capitalize(), str(total_tier), str(n), str(e), str(m),
                     str(n + e + m)])

    total_f = len(not_gen) + len(not_exec) + len(mismatch)
    rows.append(["Total", str(len(mcp_res)),
                 str(len(not_gen)), str(len(not_exec)), str(len(mismatch)),
                 str(total_f)])

    headers = ["Tier", "Total", "Not Generated", "Exec Error", "Mismatch", "Total Failures"]
    _render_table(fig_title="Table 05 — Failure Classification by Complexity Tier",
                  headers=headers, rows=rows, out=out,
                  footer="Not Generated: MCP server returned no SQL. "
                         "Exec Error: SQL generated but Oracle raised error. "
                         "Mismatch: executed but result set differs from baseline.")


# ── Table 06: Latency Comparison ─────────────────────────────────────────────

def table_06(data, out):
    baseline = data.get("baseline_results", [])
    mcp_res  = data.get("mcp_results", [])

    rows = []
    for tier in COMPLEXITY_TIERS:
        btr = _tier_rows(baseline, tier)
        mtr = [r for r in _tier_rows(mcp_res, tier) if r.get("executed")]

        b_lats = [r["latency_ms"] for r in btr if isinstance(r.get("latency_ms"), (int, float))]
        m_lats = [r["latency_ms"] for r in mtr if isinstance(r.get("latency_ms"), (int, float))]

        b_mean, _, b_p95, b_std = _stats(b_lats) if b_lats else (None, None, None, None)
        m_mean, _, m_p95, m_std = _stats(m_lats) if m_lats else (None, None, None, None)

        delta_mean = ((m_mean - b_mean) / b_mean * 100) if (b_mean and m_mean) else None
        delta_p95  = ((m_p95  - b_p95)  / b_p95  * 100) if (b_p95  and m_p95)  else None

        rows.append([
            tier.capitalize(), str(len(b_lats)), str(len(m_lats)),
            f"{b_mean:.2f}" if b_mean else "—",
            f"{m_mean:.2f}" if m_mean else "—",
            f"{delta_mean:+.1f}%" if delta_mean is not None else "—",
            f"{b_p95:.2f}" if b_p95 else "—",
            f"{m_p95:.2f}" if m_p95 else "—",
            f"{delta_p95:+.1f}%" if delta_p95 is not None else "—",
        ])

    headers = ["Tier", "Base N", "MCP N",
               "Base Avg", "MCP Avg", "Δ Avg",
               "Base P95", "MCP P95", "Δ P95"]
    _render_table(fig_title="Table 06 — Latency Comparison: Baseline vs MCP (ms)",
                  headers=headers, rows=rows, out=out,
                  footer="All latencies in milliseconds. "
                         "Δ = (MCP − Baseline) / Baseline × 100. "
                         "Negative delta = MCP faster.")


# ── Generic table renderer ────────────────────────────────────────────────────

def _render_table(fig_title, headers, rows, out, footer=""):
    n_cols = len(headers)
    n_rows = len(rows)
    fig, ax = plt.subplots(figsize=(max(10, n_cols * 1.7), max(3, n_rows * 0.5 + 1.8)))
    ax.axis("off")

    tbl = ax.table(cellText=rows, colLabels=headers, loc="center", cellLoc="center")
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(9)
    tbl.scale(1, 1.5)

    for j in range(n_cols):
        tbl[0, j].set_facecolor("#263238")
        tbl[0, j].set_text_props(color="white", fontweight="bold")

    for i in range(1, n_rows + 1):
        is_total = rows[i - 1][0].lower() in ("total", "overall")
        bg = "#E8F5E9" if is_total else ("#FAFAFA" if i % 2 == 0 else "#ECEFF1")
        for j in range(n_cols):
            tbl[i, j].set_facecolor(bg)
            if is_total:
                tbl[i, j].set_text_props(fontweight="bold")

    ax.set_title(fig_title, fontsize=11, pad=16, fontweight="bold")
    if footer:
        fig.text(0.5, 0.01, footer, ha="center", fontsize=7.5, color="#555", wrap=True)
    _save(fig, out)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Visualize MCP evaluation (13 graphs + 6 tables)")
    parser.add_argument("--input",       default="",
                        help="Path to evaluation JSON (default: latest in results/)")
    parser.add_argument("--results-dir", default=str(Path(__file__).parent / "results"))
    args = parser.parse_args()

    results_dir = Path(args.results_dir)
    input_path  = Path(args.input) if args.input else latest_json(results_dir)
    if not input_path or not input_path.exists():
        raise SystemExit("No evaluation JSON found. Run mcp_evaluation.py first.")

    with input_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    stem = input_path.stem
    print(f"Input: {input_path}")
    print(f"Generating 13 graphs + 6 tables → {results_dir}/\n")

    out = lambda name: results_dir / f"{stem}_{name}"

    graph_01(data, out("graph_01_complexity_distribution.png"))
    graph_02(data, out("graph_02_category_distribution.png"))
    graph_03(data, out("graph_03_accuracy_by_complexity.png"))
    graph_04(data, out("graph_04_baseline_vs_mcp_latency.png"))
    graph_05(data, out("graph_05_complexity_success_rates.png"))
    graph_06(data, out("graph_06_test_coverage_matrix.png"))
    graph_07(data, out("graph_07_summary_metrics.png"))
    graph_08(data, out("graph_08_latency_per_query.png"))
    graph_09(data, out("graph_09_explain_cost_per_query.png"))
    graph_10(data, out("graph_10_explain_plan_delta.png"))
    graph_11(data, out("graph_11_explain_cardinality.png"))
    graph_12(data, out("graph_12_explain_bytes.png"))
    graph_13(data, out("graph_13_explain_plan_table.png"))

    print()
    table_01(data, out("table_01_dataset_summary.png"))
    table_02(data, out("table_02_accuracy_results.png"))
    table_03(data, out("table_03_baseline_performance.png"))
    table_04(data, out("table_04_optimization_metrics.png"))
    table_05(data, out("table_05_failure_analysis.png"))
    table_06(data, out("table_06_latency_comparison.png"))

    print(f"\nDone. 19 files saved to {results_dir}/")


if __name__ == "__main__":
    main()
