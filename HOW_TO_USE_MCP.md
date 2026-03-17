# How to Use the SQLclMCP MCP Server

The SQLclMCP server is a **natural language to Oracle SQL** API. You send a question in plain English and get back Oracle SQL. It runs at:

**Base URL:** `https://sqlclmcp.onrender.com`

No API key required for public use (rate limits may apply on the free tier).

---

## 1. Check the server is up

```bash
curl https://sqlclmcp.onrender.com/health
```

You should see `"status":"ok"`, plus how many rules are loaded and whether LLM is enabled.

---

## 2. Generate SQL from a question

**Endpoint:** `POST /generate-sql`  
**Body:** JSON with `question` (required) and optional `mode`.

### Example (curl)

```bash
curl -X POST https://sqlclmcp.onrender.com/generate-sql \
  -H "Content-Type: application/json" \
  -d '{"question": "List top 10 customers by total order value", "mode": "llm"}'
```

### Example response

```json
{
  "question": "List top 10 customers by total order value",
  "generated_sql": "SELECT C_NAME, SUM(O_TOTALPRICE) AS total FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY GROUP BY C_NAME ORDER BY total DESC FETCH FIRST 10 ROWS ONLY",
  "source": "llm",
  "mode": "llm",
  "success": true
}
```

### Modes

| Mode     | What it does |
|----------|----------------|
| `llm`    | Always use the LLM to generate SQL (best for new questions). |
| `lookup` | Only use the built-in rule set (no LLM; fast, for known TPC-H-style questions). |
| `hybrid` | Try lookup first; if no match, use LLM (default). |

Omit `mode` to use `hybrid`.

---

## 3. Execute SQL (optional, when enabled on the server)

**Endpoint:** `POST /execute-sql`  
**Body:** `{"sql": "SELECT ..."}`

The server can run **SELECT** (and `WITH ... SELECT`) queries against an Oracle database if the deployer has turned execution on. Execution is **off** on the public Render deploy (no DB access there).

- If execution is **enabled** (e.g. server run locally with Oracle): the server runs the SQL and returns `{ "success": true, "columns": [...], "rows": [...], "rowCount": N }`.
- If execution is **disabled**: the server returns 503 with a message to copy the SQL and run it in your own client (e.g. SQL Developer).

The UI at [prishiv.netlify.app](https://prishiv.netlify.app) has an **Execute SQL** button: when execution is available you see results in a table; otherwise you get the “copy and run locally” hint.

---

## 4. Generate SQL for many questions at once

**Endpoint:** `POST /generate-batch`  
**Body:** JSON with `questions` (array of strings) and optional `mode`.

```bash
curl -X POST https://sqlclmcp.onrender.com/generate-batch \
  -H "Content-Type: application/json" \
  -d '{"questions": ["Top 5 orders by price", "Count customers in region EUROPE"], "mode": "llm"}'
```

Response includes a `results` array with one entry per question (each with `generated_sql`, `source`, `success`).

---

## 5. Use from your own code

### Python

```python
import requests

url = "https://sqlclmcp.onrender.com/generate-sql"
payload = {"question": "List top 5 orders by total price", "mode": "llm"}
r = requests.post(url, json=payload)
data = r.json()
if data.get("success"):
    print(data["generated_sql"])
else:
    print("Error:", data.get("error"))
```

### JavaScript (Node or browser)

```javascript
const res = await fetch("https://sqlclmcp.onrender.com/generate-sql", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    question: "List top 5 orders by total price",
    mode: "llm",
  }),
});
const data = await res.json();
if (data.success) console.log(data.generated_sql);
else console.error(data.error);
```

### cURL (one-liner)

```bash
curl -X POST https://sqlclmcp.onrender.com/generate-sql -H "Content-Type: application/json" -d '{"question":"Your question here"}'
```

---

## 6. Run the full evaluation pipeline against this server

If you have the SQLclMCP repo and an Oracle DB with TPC-H data, you can point the evaluation runner at the live server:

```bash
export MCP_SERVER_URL=https://sqlclmcp.onrender.com
cd experiments
python3 mcp_evaluation.py --run-mode compare --max-questions 10
```

This runs the baseline SQL locally, sends the same questions to the MCP server, and compares results and EXPLAIN PLAN.

---

## Summary

| What you want              | How to use it |
|----------------------------|---------------|
| Check server is running    | `GET /health` |
| One question → SQL         | `POST /generate-sql` with `{"question": "..."}` |
| Run generated SQL on server | `POST /execute-sql` with `{"sql": "SELECT ..."}` (only when server has execution enabled) |
| Many questions → SQL       | `POST /generate-batch` with `{"questions": ["...", "..."]}` |
| Use in your app            | Same URLs; call from Python, JS, or any HTTP client. |
| Evaluate with Oracle + TPC-H | Set `MCP_SERVER_URL` and run `mcp_evaluation.py`. |

**Note:** On the free tier the service may sleep after ~15 minutes of no traffic; the first request after that can take 30–60 seconds (cold start).
