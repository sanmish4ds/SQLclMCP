# How SQLcl MCP Works: A Complete Guide

> This document explains the architecture, components, and data flow of how GitHub Copilot connects to an Oracle Autonomous Database using SQLcl's built-in MCP server.

---

## Table of Contents

1. [What is MCP?](#1-what-is-mcp)
2. [What is SQLcl?](#2-what-is-sqlcl)
3. [The Big Picture: How Everything Connects](#3-the-big-picture)
4. [SQLcl's Built-in MCP Server](#4-sqlcls-built-in-mcp-server)
5. [How a Natural Language Query Flows End-to-End](#5-end-to-end-flow)
6. [The TPC-H Dataset](#6-the-tpc-h-dataset)
7. [What You Can Do](#7-what-you-can-do)
8. [Security Boundaries](#8-security-boundaries)
9. [Setting Everything Up](#9-setting-everything-up)
10. [Why `run-sql-async` Instead of `run-sql`](#10-why-run-sql-async-instead-of-run-sql)

---

## 1. What is MCP?

**MCP (Model Context Protocol)** is an open standard created by Anthropic that defines how AI models communicate with external tools and data sources.

Think of it like a **universal plug** — any AI assistant (GitHub Copilot, Claude, GPT) can use any tool that speaks MCP without needing custom integrations for each combination.

```
AI Assistant ──(MCP)──► Tool Server ──► External System (DB, API, File, etc.)
```

MCP messages are JSON-RPC — the AI sends a structured request like:

```json
{
  "tool": "run-sql",
  "params": { "sql": "SELECT COUNT(*) FROM ORDERS" }
}
```

And receives back a structured result. The AI never needs to know how the database works — it just calls tools.

---

## 2. What is SQLcl?

**SQLcl** is Oracle's modern command-line interface for Oracle Database. It replaces the older SQL*Plus tool and adds:

- No Oracle Client installation required (pure Java + JDBC)
- Built-in Liquibase for schema versioning
- Tab completion, command history, output formatting
- **Built-in MCP server** (since SQLcl 24.3)
- Runs on macOS, Linux, Windows

```bash
# Start SQLcl interactively
sql admin/<password>@prishivdb1_high

# Start SQLcl as an MCP server (used by Copilot)
sql mcp
```

---

## 3. The Big Picture

Here is the full architecture of how everything connects:

```
┌──────────────────────────────────────────────────────┐
│                  Developer's Machine                 │
│                                                      │
│  ┌───────────────────────────────────────────────┐  │
│  │         VS Code + GitHub Copilot Chat         │  │
│  └────────────────────┬──────────────────────────┘  │
│                       │ MCP Protocol                 │
│                       │ (JSON-RPC over stdio)        │
│                       ▼                              │
│  ┌───────────────────────────────────────────────┐  │
│  │           SQLcl MCP Server                    │  │
│  │           (built into SQLcl binary)           │  │
│  │                                               │  │
│  │   Tools: connect, run-sql, run-sqlcl,         │  │
│  │          schema-information, list-connections  │  │
│  │                                               │  │
│  │   Connection store: SQL Developer registry    │  │
│  │   Execution engine: Java JDBC thin driver     │  │
│  └────────────────────┬──────────────────────────┘  │
│                       │ JDBC / TLS (TCP 1522)        │
└───────────────────────┼──────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────┐
│          Oracle Autonomous Database 23ai             │
│          prishivdb1 (OCI - us-ashburn-1)             │
│                                                      │
│  CUSTOMER  ORDERS  LINEITEM  PART                    │
│  PARTSUPP  SUPPLIER  NATION  REGION                  │
└──────────────────────────────────────────────────────┘
```

---

## 4. SQLcl's Built-in MCP Server

### How Oracle Built It

Oracle embedded an MCP listener directly into SQLcl's Java process. When you run `sql mcp`, SQLcl starts its normal engine AND opens an MCP endpoint on **stdio** — standard input/output.

VS Code's MCP client starts SQLcl as a background subprocess and talks to it via that stdio pipe. No separate server process, no port management — it just works wherever SQLcl is installed.

### MCP Tools Exposed by SQLcl

| Tool | What it does |
|---|---|
| `connect` | Connects to a saved database connection by name |
| `disconnect` | Closes the current DB connection |
| `list-connections` | Lists all saved connections from SQL Developer's store |
| `run-sql` | Executes a SQL statement and returns results as JSON |
| `run-sqlcl` | Runs SQLcl-specific commands (DDL generation, Liquibase, etc.) |
| `schema-information` | Returns table names, columns, and metadata |

### The Connection Store

SQLcl and SQL Developer share a **connection registry** stored locally on your machine:
```
~/.sqldeveloper/system*/o.jdeveloper.db.connection*/connections.xml
```

When you save a connection in SQL Developer as `prishivdb1`, the MCP server looks it up by name — no credentials needed in chat. This is why you save the connection once and Copilot can reuse it any time.

### VS Code Configuration

In your VS Code `settings.json`:
```json
{
  "mcp": {
    "servers": {
      "sqlcl": {
        "type": "stdio",
        "command": "sql",
        "args": ["mcp"]
      }
    }
  }
}
```

---

## 5. End-to-End Flow

Here is exactly what happens when you ask Copilot a database question:

```
You type: "Find top 10 customers by total order value"
         │
         ▼
GitHub Copilot (GPT-4o) understands the intent
→ decides to use the run-sql MCP tool
         │
         ▼
Copilot generates the SQL:
  SELECT c.C_NAME, SUM(o.O_TOTALPRICE) AS TOTAL
  FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
  GROUP BY c.C_NAME
  ORDER BY TOTAL DESC
  FETCH FIRST 10 ROWS ONLY
         │
         ▼
MCP sends the request to SQLcl via stdio:
  { "tool": "run-sql", "params": { "connection": "prishivdb1", "sql": "..." } }
         │
         ▼
SQLcl looks up the "prishivdb1" saved connection
→ opens a JDBC connection using the wallet (TLS, port 1522)
→ executes the SQL against Oracle ADB
         │
         ▼
Oracle processes the query and returns rows
         │
         ▼
SQLcl returns results as JSON back to Copilot via stdio
         │
         ▼
Copilot formats and displays the results in chat
```

**The key insight:** Copilot handles the language understanding and SQL writing. SQLcl handles the database connection and execution. Neither needs to know what the other does internally — MCP is the contract between them.

---

## 6. The TPC-H Dataset

The database is loaded with the **TPC-H benchmark dataset** — a standard dataset used in database performance research.

### Tables

| Table | Description | Key Columns |
|---|---|---|
| `REGION` | 5 geographic regions | R_REGIONKEY, R_NAME |
| `NATION` | 25 countries | N_NATIONKEY, N_NAME, N_REGIONKEY |
| `CUSTOMER` | 150,000 customers | C_CUSTKEY, C_NAME, C_ACCTBAL, C_MKTSEGMENT |
| `ORDERS` | ~750,000 orders | O_ORDERKEY, O_CUSTKEY, O_TOTALPRICE, O_ORDERDATE |
| `LINEITEM` | ~3M line items | L_ORDERKEY, L_PARTKEY, L_QUANTITY, L_EXTENDEDPRICE |
| `SUPPLIER` | 10,000 suppliers | S_SUPPKEY, S_NAME, S_NATIONKEY |
| `PART` | 200,000 parts | P_PARTKEY, P_NAME, P_BRAND, P_RETAILPRICE |
| `PARTSUPP` | Part-supplier links | PS_PARTKEY, PS_SUPPKEY, PS_SUPPLYCOST |

### Entity Relationships

```
REGION ──< NATION ──< CUSTOMER ──< ORDERS ──< LINEITEM >── PART
                  ──< SUPPLIER ──< PARTSUPP >────────────── PART
```

---

## 7. What You Can Do

Once connected via SQLcl MCP in Copilot Chat, just ask in plain English:

**Explore the schema**
- *"Show me all tables"*
- *"Describe the ORDERS table"*
- *"What columns does LINEITEM have?"*

**Query data**
- *"How many customers are in each nation?"*
- *"Find the top 10 suppliers by total supply cost"*
- *"What is the average order value per market segment?"*

**Analyse and aggregate**
- *"Show me monthly order totals for the last year"*
- *"Which parts have the most line items?"*
- *"Count orders by status"*

**Manage schema (DDL)**
- *"Generate the CREATE TABLE script for CUSTOMER"*
- *"Create a new table called PROMOTIONS with id, name, discount, start_date"*

**Anything else SQL can do** — joins, subqueries, window functions, CTEs — Copilot writes it, SQLcl runs it.

---

## 8. Security Boundaries

| Concern | How it's handled |
|---|---|
| **Database credentials** | Stored in SQL Developer connection store, never in chat |
| **Wallet / TLS** | Oracle wallet provides mutual TLS — all traffic is encrypted over port 1522 |
| **IP whitelisting** | Oracle ADB ACL restricts which IPs can connect (ORA-12506 if not whitelisted) |
| **Query safety** | Copilot will ask for confirmation before running destructive DDL/DML |

---

## 9. Setting Everything Up

### Prerequisites
- Oracle Cloud Free account ([oracle.com/cloud/free](https://oracle.com/cloud/free))
- Oracle Autonomous Database (Always Free tier, 23ai)
- SQLcl installed (`brew install sqlcl`)
- SQL Developer installed (for saving the named connection)

### Step-by-step

```bash
# 1. Fix the wallet sqlnet.ora (one-time fix for OCI wallet placeholder)
sed -i '' 's|DIRECTORY="?/network/admin"|DIRECTORY="/path/to/your/wallet"|' \
  /path/to/your/wallet/sqlnet.ora

# 2. Test connectivity
TNS_ADMIN=/path/to/your/wallet sql admin/<password>@prishivdb1_high

# 3. Whitelist your IP in OCI ACL if you get ORA-12506
curl -s https://checkip.amazonaws.com   # find your IP
# OCI Console → ADB → Network → ACL → add your IP/32
```

```
# 4. Save the connection in SQL Developer
Open SQL Developer → New Connection → Cloud Wallet
→ name it "prishivdb1" → test → save
```

```json
// 5. Add SQLcl MCP to VS Code settings.json
{
  "mcp": {
    "servers": {
      "sqlcl": {
        "type": "stdio",
        "command": "sql",
        "args": ["mcp"]
      }
    }
  }
}
```

```
# 6. Use it in Copilot Chat
"Connect to prishivdb1 and show me all tables"
```

---

## Summary

```
You (plain English)
       │
       ▼
GitHub Copilot — understands intent, writes SQL
       │  MCP (JSON-RPC over stdio)
       ▼
SQLcl MCP Server — receives tool calls, manages connection
       │  JDBC / TLS (port 1522)
       ▼
Oracle Autonomous Database 23ai — executes SQL, returns results
       │
       ▼
Results displayed in Copilot Chat
```

**SQLcl** is the execution engine — it holds the connection to Oracle and runs every query.  
**MCP** is the contract — it lets Copilot call SQLcl like any other tool without knowing anything about JDBC, wallets, or TNS.  
**You** just ask questions in plain English.

---

## 10. Why `run-sql-async` Instead of `run-sql`

### The Problem with `run-sql` on Large Tables

The `run-sql` tool works by executing a SQL statement and **streaming the entire result set back as a single MCP response**. For small queries this is fine — but on the TPC-H dataset with tables like `ORDERS` (~750,000 rows) or `LINEITEM` (~3M rows), this creates a serious issue:

- The MCP response payload can exceed **tens of megabytes** of raw data
- GitHub Copilot's context window has a hard limit on how much it can receive in one tool call response
- When the response is too large, Copilot **writes it to a temporary file** instead of reading it inline — meaning the result is never actually visible or usable in chat

In practice, when you call `run-sql` on a query that touches a large table, you see this:

```
Large tool result (16KB) written to file. Use the read_file tool to access the content at: ...
```

And the file contents turn out to be **raw row data from a completely different prior query** — the MCP server has been buffering and replaying stale cached output. The actual query result you wanted is lost.

### How `run-sql-async` Fixes This

`run-sql-async` breaks execution into three separate steps:

| Step | Command | What it does |
|---|---|---|
| 1 | `submit` | Sends the SQL to the database; returns immediately with a task `id` |
| 2 | `status` | Polls by task `id` — returns `"Finished"` when done |
| 3 | `results` | Fetches only the final result, cleanly separated from the stream |

Because the query runs in the background and only the **final result** is fetched when you call `results`, the MCP response stays small and never triggers the file-overflow behaviour.

### The Pattern to Use

```
1. run-sql-async  command=submit  task="SELECT ..."   → returns id: 0
2. run-sql-async  command=status  task=0              → returns "Finished"
3. run-sql-async  command=results task=0              → returns the actual rows
```

### When to Use Which Tool

| Situation | Use |
|---|---|
| Simple metadata queries (`SELECT table_name FROM user_tables`) | Either — but `run-sql-async` is safer |
| Any query touching `ORDERS`, `LINEITEM`, `CUSTOMER`, or `PARTSUPP` | Always `run-sql-async` |
| Aggregations (`COUNT`, `SUM`, `GROUP BY`) that return few rows | `run-sql-async` recommended |
| Schema introspection (`DESCRIBE`, `schema-information`) | `schema-information` tool directly |

### Root Cause Summary

The issue is not a bug in SQLcl — it is a **mismatch between MCP's synchronous single-response model and large JDBC result sets**. `run-sql` was designed for small, bounded queries. `run-sql-async` was designed for exactly this scenario: queries where execution time and result size are unpredictable.
