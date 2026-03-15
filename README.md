# MCP SQL Generation Evaluation Suite

Evaluation framework for benchmarking LLM-based SQL generation against human-written Oracle SQL baselines. Answers four core research questions on a 500-query TPC-H dataset.

## Research Questions

| # | Question |
|---|----------|
| **RQ1** | **Semantic Correctness** — Does the generated query return the same results as the intended query? |
| **RQ2** | **Execution Efficiency** — What is the performance overhead compared to human-written baselines? |
| **RQ3** | **Optimization Potential** — Can generated queries be improved through rule-based or learned optimization? |
| **RQ4** | **Robustness Across Complexity** — How does accuracy degrade with increasing query complexity? |

## Quick Start

```bash
# 1. Start MCP server
node mcp-server-http.js

# 2. Run full comparison (baseline + LLM, all 500 questions)
cd experiments
python3 mcp_evaluation.py --run-mode compare

# 3. Visualize results
python3 visualize_results.py
```

Results are saved to `experiments/results/`.

## Project Structure

```
SQLclMCP/
├── mcp-server-http.js          # MCP HTTP server (Node.js)
├── experiments/
│   ├── mcp_evaluation.py       # Evaluation engine (all 4 RQs)
│   ├── visualize_results.py    # Chart generator (PNG)
│   ├── test_questions.json     # 500 TPC-H test questions + expected SQL
│   └── results/                # JSON reports + PNG charts
├── docker-compose.yml          # Oracle 26ai Free container
└── .env                        # Environment config
```

## Requirements

- Python 3.10+ with `oracledb`, `requests`, `matplotlib`
- Node.js 14+
- Oracle 26ai Free (via Docker or existing instance)

```bash
pip install oracledb requests matplotlib
```

## Setup

### 1. Start Oracle Database

```bash
docker-compose up -d
```

Wait ~60 seconds for Oracle to initialise, then verify:

```bash
docker ps | grep oracle
```

### 2. Configure Environment

Copy and edit `.env`:

```
ENABLE_LLM_SQL_GEN=true
LLM_API_KEY=<your_openai_api_key>
LLM_MODEL=gpt-4o-mini
```

### 3. Start MCP Server

```bash
node mcp-server-http.js
```

### 4. Run Evaluation

```bash
cd experiments

# Full comparison (baseline + LLM) — answers all 4 RQs
python3 mcp_evaluation.py --run-mode compare

# Baseline only (RQ2 latency reference)
python3 mcp_evaluation.py --run-mode baseline --explain

# LLM only (no baseline comparison)
python3 mcp_evaluation.py --run-mode mcp

# Filter by complexity
python3 mcp_evaluation.py --run-mode compare --complexity simple
python3 mcp_evaluation.py --run-mode compare --complexity medium
python3 mcp_evaluation.py --run-mode compare --complexity complex

```

### 5. Visualize

```bash
python3 experiments/visualize_results.py
```

Generates three PNG charts in `experiments/results/`:
- `_viz_summary.png` — Semantic correctness (RQ1 + RQ4)
- `_viz_latency.png` — Execution efficiency (RQ2)
- `_viz_explain.png` — Optimization potential (RQ3)

## CLI Reference

| Argument | Default | Options | Description |
|----------|---------|---------|-------------|
| `--run-mode` | `compare` | `baseline`, `mcp`, `compare` | What phases to run |
| `--complexity` | `all` | `simple`, `medium`, `complex`, `all` | Filter by complexity tier |
| `--question-ids` | *(all)* | e.g. `1,2,5` | Run specific questions only |
| `--max-questions` | *(none)* | integer | Cap number of questions |
| `--no-explain` | — | flag | Skip EXPLAIN PLAN (on by default) |
| `--no-visualize` | — | flag | Skip visualization (on by default) |
| `--mcp-url` | `http://localhost:3000` | URL | MCP server address |
| `--db-user` | `mcp_dev` | string | Oracle username |
| `--db-password` | `mcp_pass123` | string | Oracle password |
| `--db-dsn` | `localhost:1521/FREE` | string | Oracle DSN |

## MCP Server API

### Health Check
```bash
curl http://localhost:3000/health
```

### Generate SQL (single)
```bash
curl -X POST http://localhost:3000/generate-sql \
  -H "Content-Type: application/json" \
  -d '{"question": "How many regions are there?", "mode": "llm"}'
```

Modes: `lookup` | `llm` | `hybrid`

### Generate SQL (batch)
```bash
curl -X POST http://localhost:3000/generate-batch \
  -H "Content-Type: application/json" \
  -d '{"questions": ["How many regions?", "Top 5 suppliers"], "mode": "hybrid"}'
```

### Reload Rules
```bash
curl -X POST http://localhost:3000/reload-rules
```

## Test Dataset

500 TPC-H questions across three complexity tiers:

| Tier | Count | Description |
|------|-------|-------------|
| Simple | 100 | Single-table counts and basic filters |
| Medium | 100 | Multi-table joins, aggregations, grouping |
| Complex | 300 | Subqueries, CTEs, window functions, business analytics |

## Evaluation Metrics

| Metric | RQ | Description |
|--------|----|-------------|
| Semantic accuracy | RQ1 | % of queries returning identical result sets (order-independent) |
| Accuracy by tier | RQ4 | Separate pass rates for simple / medium / complex |
| Avg latency (ms) | RQ2 | Mean execution time per tier, baseline vs MCP |
| Latency overhead | RQ2 | MCP latency / baseline latency ratio |
| EXPLAIN cost delta | RQ3 | MCP cost − baseline cost per query |
| Cost lower/same/higher | RQ3 | Distribution of optimization opportunities |

## Results Files

```
experiments/results/
├── mcp_evaluation_TIMESTAMP.json   # Full results (all metrics)
├── *_viz_summary.png               # Correctness bar chart
├── *_viz_latency.png               # Latency comparison chart
└── *_viz_explain.png               # EXPLAIN PLAN comparison chart
```

## Troubleshooting

### MCP Server Not Starting
```bash
pkill node
node mcp-server-http.js
```

### Database Connection Error
```bash
docker ps | grep oracle          # verify container is running
sqlplus mcp_dev/mcp_pass123@localhost:1521/FREE
```

### Python Dependencies Missing
```bash
pip install oracledb requests matplotlib
```
