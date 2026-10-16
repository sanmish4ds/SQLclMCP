"""Easy NL2SQL guardrails service (NVIDIA NeMo Guardrails + deterministic SQL firewall).

Endpoints (all JSON):
  GET  /health
  POST /v1/check/input   {"text": "..."}                                  -> verdict
  POST /v1/check/output  {"question": "...", "sql": "...", "text": "..."} -> verdict (+ possibly rewritten text)
  POST /v1/check/sql     {"sql": "..."}                                   -> deterministic SQL verdict (no LLM)

Verdict shape:
  {"allowed": bool, "status": "passed|modified|blocked", "rail": str|null,
   "code": str|null, "message": str|null, "text": str|null, "sql": {...}|null, "latency_ms": int}

Env:
  GUARDRAILS_LLM_CHECKS   true (default) | false — drop the LLM self-check rails (deterministic only)
  GUARDRAILS_MODEL        model for self-check rails (default LLM_MODEL or gpt-4o-mini)
  LLM_API_KEY / OPENAI_API_KEY, LLM_API_URL (OpenAI-compatible; /chat/completions suffix is stripped)
  GUARDRAILS_TOKEN        optional shared secret; when set, requests need header X-Guardrails-Token
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from easynlsql_guards.sql_policy import analyze_sql  # noqa: E402

log = logging.getLogger("easynlsql.guardrails")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
# NeMo logs full rail prompts (including user text) at INFO; keep that out of production logs.
logging.getLogger("nemoguardrails").setLevel(os.environ.get("NEMO_LOG_LEVEL", "WARNING"))

LLM_FLOWS = {"self check input", "self check output"}

# Colang flow name -> stable code returned to the Node server / UI.
RAIL_CODES = {
    "check sensitive input": "sensitive_like",
    "check prompt injection heuristics": "injection_like",
    "self check input": "off_policy_input",
    "check sql output safety": "unsafe_sql",
    "check sensitive output": "sensitive_output",
    "injection detection": "output_injection",
    "self check output": "off_policy_output",
}


def _truthy(v: Optional[str], default: bool = True) -> bool:
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _load_dotenv() -> None:
    """Load the repo's .env for local runs (does not override real env vars)."""
    for p in (HERE.parent / ".env", HERE / ".env"):
        if not p.is_file():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def build_rails(llm_checks: Optional[bool] = None):
    from nemoguardrails import LLMRails, RailsConfig

    _load_dotenv()
    if llm_checks is None:
        llm_checks = _truthy(os.environ.get("GUARDRAILS_LLM_CHECKS"), True)
    if not os.environ.get("OPENAI_API_KEY") and os.environ.get("LLM_API_KEY"):
        os.environ["OPENAI_API_KEY"] = os.environ["LLM_API_KEY"]
    if not os.environ.get("OPENAI_API_KEY"):
        # The OpenAI client refuses to construct without a key; deterministic mode never calls it.
        if llm_checks:
            log.warning("No LLM_API_KEY/OPENAI_API_KEY; disabling LLM self-check rails")
        llm_checks = False
        os.environ["OPENAI_API_KEY"] = "unused"

    config = RailsConfig.from_path(str(HERE / "config"))
    model = os.environ.get("GUARDRAILS_MODEL") or os.environ.get("LLM_MODEL") or "gpt-4o-mini"
    for m in config.models:
        if m.type == "main":
            m.model = model
            api_url = os.environ.get("LLM_API_URL", "").strip()
            if api_url:
                m.parameters["base_url"] = api_url.removesuffix("/chat/completions").rstrip("/")
    if not llm_checks:
        config.rails.input.flows = [f for f in config.rails.input.flows if f not in LLM_FLOWS]
        config.rails.output.flows = [f for f in config.rails.output.flows if f not in LLM_FLOWS]
    rails = LLMRails(config)
    rails.llm_checks_enabled = llm_checks
    return rails


def _verdict(result, original: str, started: float, sql_report: Optional[dict] = None) -> dict:
    status = getattr(result.status, "value", str(result.status)).lower()
    blocked = status == "blocked"
    rail = result.rail
    return {
        "allowed": not blocked,
        "status": status,
        "rail": rail,
        "code": RAIL_CODES.get(rail, rail) if blocked else None,
        "message": result.content if blocked else None,
        "text": None if blocked else (result.content if status == "modified" else original),
        "sql": sql_report,
        "latency_ms": int((time.perf_counter() - started) * 1000),
    }


class InputReq(BaseModel):
    text: str = Field(..., max_length=20000)


class OutputReq(BaseModel):
    question: str = Field("", max_length=20000)
    sql: str = Field("", max_length=20000)
    text: str = Field("", max_length=60000)


class SqlReq(BaseModel):
    sql: str = Field(..., max_length=20000)


def create_app(rails=None) -> FastAPI:
    app = FastAPI(title="Easy NL2SQL Guardrails", version="1.0.0")
    state = {"rails": rails}

    def get_rails():
        if state["rails"] is None:
            state["rails"] = build_rails()
        return state["rails"]

    def auth(token: Optional[str]) -> None:
        expected = os.environ.get("GUARDRAILS_TOKEN", "")
        if expected and token != expected:
            raise HTTPException(status_code=401, detail="bad guardrails token")

    async def run(messages, rail_type, original, started, sql_report=None):
        from nemoguardrails.rails.llm.options import RailType

        try:
            result = await get_rails().check_async(messages, rail_types=[RailType(rail_type)])
        except Exception as e:  # fail closed: a crashed rail must not let content through
            log.exception("rail execution failed")
            return {
                "allowed": False, "status": "error", "rail": None, "code": "guardrails_error",
                "message": f"Guardrails check failed: {type(e).__name__}", "text": None,
                "sql": sql_report, "latency_ms": int((time.perf_counter() - started) * 1000),
            }
        return _verdict(result, original, started, sql_report)

    @app.get("/health")
    async def health():
        r = get_rails()
        return {
            "ok": True,
            "engine": "nemoguardrails",
            "llm_checks": bool(getattr(r, "llm_checks_enabled", False)),
            "input_rails": list(r.config.rails.input.flows),
            "output_rails": list(r.config.rails.output.flows),
        }

    @app.post("/v1/check/input")
    async def check_input(req: InputReq, x_guardrails_token: Optional[str] = Header(None)):
        auth(x_guardrails_token)
        started = time.perf_counter()
        return await run([{"role": "user", "content": req.text}], "input", req.text, started)

    @app.post("/v1/check/output")
    async def check_output(req: OutputReq, x_guardrails_token: Optional[str] = Header(None)):
        auth(x_guardrails_token)
        started = time.perf_counter()
        sql_report = analyze_sql(req.sql).to_dict() if req.sql.strip() else None
        # Output rails need non-empty bot text; fall back to the SQL itself.
        text = req.text if req.text.strip() else (f"```sql\n{req.sql}\n```" if req.sql.strip() else "")
        if not text:
            return {"allowed": True, "status": "passed", "rail": None, "code": None, "message": None,
                    "text": "", "sql": None, "latency_ms": 0}
        messages = [
            {"role": "context", "content": {"generated_sql": req.sql}},
            {"role": "user", "content": req.question or ""},
            {"role": "assistant", "content": text},
        ]
        out = await run(messages, "output", text, started, sql_report)
        if not req.text.strip() and out["allowed"]:
            out["text"] = ""
        return out

    @app.post("/v1/check/sql")
    async def check_sql(req: SqlReq, x_guardrails_token: Optional[str] = Header(None)):
        auth(x_guardrails_token)
        started = time.perf_counter()
        v = analyze_sql(req.sql)
        return {
            "allowed": v.allowed, "status": "passed" if v.allowed else "blocked",
            "rail": "sql firewall", "code": None if v.allowed else "unsafe_sql",
            "message": None if v.allowed else "Only a single read-only SELECT (or WITH … SELECT) is allowed.",
            "text": None, "sql": v.to_dict(), "latency_ms": int((time.perf_counter() - started) * 1000),
        }

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8088")))
