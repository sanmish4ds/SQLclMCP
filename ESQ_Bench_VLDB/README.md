# DRL Middleware — The VLDB Journal Package

**Venue:** The VLDB Journal (Springer), not PVLDB.

## Build paper

```bash
cd ESQ_Bench_VLDB
python3 generate_paper_figures.py
pdflatex drl_middleware_vldb.tex
bibtex drl_middleware_vldb
pdflatex drl_middleware_vldb.tex
pdflatex drl_middleware_vldb.tex
```

Output: `drl_middleware_vldb.pdf` (journal two-column; length must stay ≤ 25 pages)

## Reproduce experiments

```bash
# 1. Build 1,000-pair suite
python3 schemas/questions/build_verification_suite_1000.py --engine postgres

# 2. Middleware baselines B0–B3
python3 ESQ_Bench_VLDB/run_drl_baselines.py --engine postgres
python3 ESQ_Bench_VLDB/run_drl_baselines.py --engine mysql \
  --out ESQ_Bench_VLDB/drl_baseline_metrics_mysql.json

# 3. NL2SQL evaluation (9 runs, ~2–3 hours)
experiments/run_verification_1000_postgres.sh

# 4. Summarize
python3 experiments/summarize_verification_1000.py
```

## Key measured results (July 2026)

| Claim | Value |
|-------|-------|
| Context reduction B1→B2 | 71% |
| Prune p95 | 0.76 ms |
| Middleware p95 (excl. LLM) | 4.1 ms |
| GPT-4o EX (1,000 pairs) | 51.6% |
| Gemini EX | 50.1% |
| Claude EX (rescored T2/T3) | 46.5% |
| SD_op on EX (GPT-4o) | 95.9% |

## Files

| File | Role |
|------|------|
| `drl_middleware_vldb.tex` | Submission paper |
| `figures/*.pdf` | Generated figures |
| `drl_baseline_metrics.json` | Middleware table data |
| `verification_failure_stats.json` | Failure taxonomy |
| `drl_telemetry_harness.py` | Pruning + EXPLAIN harness |
