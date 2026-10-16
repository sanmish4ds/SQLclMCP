# Easy NL2SQL guardrails (NVIDIA NeMo Guardrails)

A Python sidecar that runs [NeMo Guardrails](https://github.com/NVIDIA/NeMo-Guardrails) input/output rails for the Node API (`sql-learn-server.js`) behind https://easynlsql.netlify.app.

```
browser → Netlify (proxy) → Node API ──► POST /v1/check/input   ─┐
                                 │        (before the LLM call)   │  guardrails/server.py
                                 └──────► POST /v1/check/output  ─┘  NeMo LLMRails.check_async
                                          (after the LLM call)
```

## Rails

| Stage | Rail | Kind | Blocks / does |
|---|---|---|---|
| input | `check sensitive input` | regex (custom action) | emails, SSN, Luhn-valid cards, phones, API keys, JWTs, `user/pass@db`, `password is …` |
| input | `check prompt injection heuristics` | regex (custom action) | "ignore previous instructions", system-prompt extraction, role-play jailbreaks, chat-template tokens |
| input | `self check input` | LLM (NeMo built-in) | off-topic requests, jailbreaks, system catalogs, credential and privilege requests. Conceptual DML/DDL questions are allowed |
| output | `check sql output safety` | sqlglot AST plus lexical (custom action) | **blocks** unsafe generated SQL; **redacts** unsafe ```` ```sql ```` fences in tutor prose |
| output | `check sensitive output` | regex | secrets or PII in the answer |
| output | `injection detection` | YARA (NeMo built-in) | markdown XSS and template injection in tutor markdown (rendered via `innerHTML`) |
| output | `self check output` | LLM (NeMo built-in) | prompt leaks, harmful or off-topic answers |

The deterministic rails run first and short-circuit, so an LLM self-check is only paid for inputs that pass them.

**SQL firewall** ([easynlsql_guards/sql_policy.py](easynlsql_guards/sql_policy.py)) allows only a single read-only `SELECT` / `WITH … SELECT`. It rejects:

- DML and DDL
- PL/SQL, including `WITH FUNCTION`
- `FOR UPDATE`
- DB links (`@`)
- `DBMS_*`, `UTL_*`, `SYS_CONTEXT`, `HTTPURITYPE` and similar packages
- the system catalogs `DBA_*`, `ALL_*`, `V$*` and `SYS.*`

`USER_*` views stay allowed because the SQL lab uses them. Tables outside TPC-H produce a *warning*, not a block, because ESQ/benchmark callers send their own schema.

The Node server also carries a dependency-free JS port of the lexical layer ([../guardrails-client.js](../guardrails-client.js)). That port always runs on `/execute-sql`, `/api/invoke` and generated SQL, even without the sidecar.

## Run locally

```bash
uv venv --python 3.12 guardrails/.venv
uv pip install --python guardrails/.venv/bin/python -r guardrails/requirements-dev.txt
npm run guardrails                                         # :8088, reads LLM_API_KEY from ../.env
GUARDRAILS_URL=http://127.0.0.1:8088 npm start             # Node API with rails on
```

## Test

```bash
guardrails/.venv/bin/python -m pytest guardrails/tests     # offline: firewall, text checks, NeMo rails
GUARDRAILS_LIVE_LLM=1 guardrails/.venv/bin/python -m pytest guardrails/tests -k live   # LLM self-checks
npm run test:guardrails                                    # Node firewall and client
```

## Configuration

| Env | Where | Default | |
|---|---|---|---|
| `GUARDRAILS_URL` | Node | unset (off) | sidecar base URL |
| `GUARDRAILS_TOKEN` | both | unset | shared secret (`X-Guardrails-Token`); **set it in production**, since the sidecar is a public web service on Render |
| `GUARDRAILS_FAIL_MODE` | Node | `open` | `closed` returns 503 when the sidecar is unreachable |
| `GUARDRAILS_TIMEOUT_MS` | Node | `8000` | |
| `GUARDRAILS_LLM_CHECKS` | sidecar | `true` | `false` keeps only the deterministic rails (no extra LLM cost) |
| `GUARDRAILS_MODEL` | sidecar | `LLM_MODEL` or `gpt-4o-mini` | self-check model (OpenAI-compatible; honours `LLM_API_URL`) |
| `LAB_ALLOW_DML` | Node | `false` | lets `/api/invoke` `run-sql` execute DDL/DML with autoCommit |

Cost and latency: with LLM checks on, each `/generate-sql` makes two extra small calls (about 0.5–1.5 s each with gpt-4o-mini). Blocked inputs never reach the generation LLM. The service uses about 100 MB RSS.
