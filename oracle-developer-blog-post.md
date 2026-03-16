# Evaluating LLM-Generated SQL on Oracle: An MCP-Based Framework

**By Sanjay Mishra**  
*Oracle Developer Blog — Technical Article*

---

## Introduction

Large language models (LLMs) can turn natural language questions into SQL—but how do you know the generated query is *correct* and *efficient* on your database? In this post I share **SQLclMCP**, an open-source evaluation framework that runs LLM-generated SQL and human-written baseline SQL on **Oracle Database**, compares results rigorously, and measures execution and optimization behavior using **EXPLAIN PLAN**. The project uses the **Model Context Protocol (MCP)** to integrate an LLM and evaluates against a 500-question TPC-H test set. Here’s what we built and what we learned.

---

## The Problem

Natural language to SQL (NL2SQL) is useful for analysts and applications, but production use requires:

1. **Correctness** — The generated query must return the same logical result as the intended query.
2. **Efficiency** — Execution time and plan quality matter.
3. **Oracle compatibility** — Syntax and semantics must be valid for Oracle (e.g. no `LIMIT`, use `FETCH FIRST N ROWS ONLY`; no `EXTRACT(QUARTER FROM ...)`).

Without an automated way to compare LLM output to a gold standard on a real Oracle instance, it’s hard to improve prompts or trust deployment.

---

## Approach: MCP + Baseline Comparison

We use a simple pipeline:

1. **Baseline phase** — For each test question we have a gold-standard Oracle SQL. We execute it on Oracle, capture result rows, latency, and EXPLAIN PLAN (cost, cardinality, bytes).
2. **MCP phase** — We send the same natural language question to an MCP server that calls an LLM (OpenAI-compatible API) to generate SQL. We execute that SQL on the same Oracle database and capture rows, latency, and EXPLAIN PLAN.
3. **Comparison** — We compare result sets (semantic match, exact order match, and a canonical string representation), and we compare plan metrics.

The MCP server is a small Node.js HTTP service that accepts a question and returns generated SQL. The evaluation engine is Python: it uses **oracledb** to run both baseline and generated SQL and to collect EXPLAIN PLAN data.

---

## Tech Stack

- **Oracle Database** — TPC-H schema (we use Oracle 26ai Free via Docker; any Oracle instance with TPC-H works).
- **MCP server** — Node.js, Express-style HTTP; calls LLM with a schema hint and Oracle-specific rules.
- **Evaluation engine** — Python 3.10+, **oracledb**, **requests**, **matplotlib**.
- **Config** — `.env` for `LLM_API_KEY`, `ENABLE_LLM_SQL_GEN`, and Oracle connection (user, password, DSN).

---

## Quick Start

**1. Start Oracle** (e.g. Docker):

```bash
docker-compose up -d
```

**2. Configure `.env`:**

```
ENABLE_LLM_SQL_GEN=true
LLM_API_KEY=<your_openai_api_key>
LLM_MODEL=gpt-4o-mini
DB_USER=mcp_dev
DB_PASSWORD=mcp_pass123
DB_DSN=localhost:1521/FREE
```

**3. Start the MCP server:**

```bash
node mcp-server-http.js
```

**4. Run the evaluation:**

```bash
cd experiments
python3 mcp_evaluation.py --run-mode compare
```

The script runs baseline and MCP phases, compares results, and by default generates 13 graphs and 6 tables (e.g. accuracy by complexity, latency comparison, EXPLAIN cost deltas). Results are written to `experiments/results/` as JSON and PNGs.

---

## What We Measure

- **Semantic correctness** — Do baseline and MCP return the same set of rows (order-independent)?
- **Exact order match** — Same rows, same values, same order?
- **Canonical string match** — Same result set when serialized to a canonical form?
- **Execution success** — Did the generated SQL run without error?
- **Latency** — Execution time for baseline vs MCP (and ratio).
- **EXPLAIN PLAN** — Cost, cardinality, and bytes for both queries; we compute deltas to spot optimization gaps.

All of this is logged per query and summarized in the console and in the output JSON.

---

## Lessons Learned on Oracle

These came from real failures in our evaluation and were fixed by tightening the schema hint and rules sent to the LLM.

### 1. EXTRACT does not support QUARTER

The LLM often produced `EXTRACT(QUARTER FROM order_date)`. Oracle’s `EXTRACT` supports only `YEAR`, `MONTH`, `DAY`, `HOUR`, `MINUTE`, `SECOND`—not `QUARTER`. That leads to **ORA-00907: missing right parenthesis**.

**Fix:** In the prompt we specify: use `CEIL(EXTRACT(MONTH FROM col)/3)` or `TO_CHAR(col,'Q')` for quarter, and prefer date ranges like `col >= DATE '2023-01-01' AND col < DATE '2024-01-01'` for year filters.

### 2. Column names are table-specific

In a CTE on `LINEITEM L`, the LLM sometimes selected `L.P_PARTKEY`. The `LINEITEM` table has `L_PARTKEY`, not `P_PARTKEY` (that’s on `PART`). Oracle returns **ORA-00904: "L"."P_PARTKEY": invalid identifier**.

**Fix:** We explicitly tell the model: “LINEITEM has L_PARTKEY (use L.L_PARTKEY, never L.P_PARTKEY). PART has P_PARTKEY.”

### 3. FETCH FIRST N ROWS ONLY

We require the model to use Oracle’s `FETCH FIRST N ROWS ONLY` instead of `LIMIT N`. The schema hint and examples in the prompt enforce this.

These Oracle-specific rules in the MCP prompt significantly reduced execution errors and improved semantic match rates in our runs.

---

## Failure Analysis and Export

When queries fail or results differ, we need to inspect baseline vs generated SQL. The repo includes a script that reads the evaluation JSON and produces a markdown report:

```bash
python3 experiments/export_failure_cases.py --input experiments/results/mcp_evaluation_<timestamp>.json
```

That report lists each failure with baseline SQL, MCP-generated SQL, and error or mismatch reason—useful for debugging and for improving the schema hint and prompts.

---

## Reproducibility and Research

The test set is **500 TPC-H questions** in three complexity tiers (simple, medium, complex). Each test has a natural language question and expected Oracle SQL. The evaluation output (JSON + graphs + tables) is structured so it can drive a research paper or internal reports. We also sync the latest result PNGs into a `research/` folder for inclusion in LaTeX.

---

## Summary

- **SQLclMCP** evaluates LLM-generated SQL on Oracle by comparing it to human-written baseline SQL.
- It uses **MCP** for the LLM interface and **oracledb** for execution and EXPLAIN PLAN.
- Correctness is checked with **semantic**, **exact-order**, and **canonical-string** comparison; execution and plan metrics are collected by default.
- **Oracle-specific prompt rules** (no EXTRACT(QUARTER), correct column names per table, FETCH FIRST N ROWS ONLY) are critical for reducing errors.
- The project is open source: you can run it on your own Oracle + TPC-H setup, extend the test set, and adapt the MCP server and prompts for your schema.

If you’re building or evaluating NL2SQL on Oracle, we hope this framework and the lessons above help you ship with more confidence.

---

## Links

- **Repository:** [SQLclMCP](https://github.com/your-org/SQLclMCP) *(replace with your repo URL)*
- **Oracle Database 26ai Free:** [Oracle Container Registry](https://container-registry.oracle.com/)
- **oracledb driver:** [python-oracledb](https://oracle.github.io/python-oracledb/)

---

*Disclaimer: Views expressed are the author’s. Not an official Oracle publication.*
