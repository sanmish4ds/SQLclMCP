"""Deterministic Oracle SQL firewall for Easy NL2SQL.

Two layers:
  1. Lexical scan (strings and comments stripped) — catches constructs sqlglot
     cannot parse, e.g. ``WITH FUNCTION`` inline PL/SQL, and statement chaining.
  2. AST scan via sqlglot (Oracle dialect) — statement type, locks, DB links,
     system catalogs, dangerous PL/SQL packages.

Unknown (non-TPC-H) tables are a *warning*, not a block, because ESQ/benchmark
callers send their own schema_context. System catalogs are always blocked.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Set

import sqlglot
from sqlglot import exp

_REPO_ROOT = Path(__file__).resolve().parents[2]

# Statements that must never appear anywhere in the tree.
_FORBIDDEN_NODES = tuple(
    getattr(exp, n)
    for n in (
        "Insert", "Update", "Delete", "Merge", "Create", "Drop", "Alter",
        "TruncateTable", "Grant", "Revoke", "Command", "Commit", "Rollback",
        "Transaction", "Use", "Set", "Copy", "LoadData",
    )
    if hasattr(exp, n)
)

# Lexical tokens that indicate procedural code, transactions or DDL/DML.
_LEXICAL_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|"
    r"commit|rollback|savepoint|begin|declare|execute|exec|call|pragma|"
    r"lock\s+table|rename|purge|flashback|audit|noaudit|analyze|shutdown)\b",
    re.IGNORECASE,
)
_WITH_PLSQL = re.compile(r"\bwith\s+(function|procedure)\b", re.IGNORECASE)
_FOR_UPDATE = re.compile(r"\bfor\s+update\b", re.IGNORECASE)

# Package / function prefixes that reach outside the query (network, files,
# sleep/DoS, dynamic SQL, privilege info).
_DANGEROUS_PREFIXES = (
    "DBMS_", "UTL_", "OWA_", "HTP", "HTF", "CTXSYS", "ORDSYS", "MDSYS",
    "XDB", "SYS_CONTEXT", "USERENV", "HTTPURITYPE", "DBURITYPE", "XDBURITYPE",
    "SYS.", "SYSTEM.", "APEX_", "WWV_", "JAVA",
)

# System catalog / dynamic performance views. USER_* views are allowed: they only
# describe the connected lab user's own objects (the SQL lab's DESC / SHOW TABLES use them).
_SYSTEM_TABLE = re.compile(
    r"^(DBA_|ALL_|CDB_|V\$|GV\$|X\$|V_\$|GV_\$|SYS\.|SYSTEM\.|AUDSYS\.)",
    re.IGNORECASE,
)
_SYSTEM_SCHEMAS = {"SYS", "SYSTEM", "AUDSYS", "CTXSYS", "MDSYS", "XDB", "OUTLN", "DBSNMP", "LBACSYS"}


def _load_default_allowlist() -> Set[str]:
    raw = os.environ.get("SQL_TABLE_ALLOWLIST", "").strip()
    if raw:
        return {t.strip().upper() for t in raw.split(",") if t.strip()}
    p = _REPO_ROOT / "schema-reference.json"
    try:
        data = json.loads(p.read_text())
        return {str(t["name"]).upper() for t in data.get("tables", []) if t.get("name")}
    except Exception:
        return {"REGION", "NATION", "CUSTOMER", "SUPPLIER", "PART", "ORDERS", "LINEITEM", "PARTSUPP"}


DEFAULT_ALLOWLIST: Set[str] = _load_default_allowlist() | {"DUAL"}


@dataclass
class SqlVerdict:
    allowed: bool
    sql: str
    violations: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    tables: List[str] = field(default_factory=list)
    parsed: bool = False

    def to_dict(self) -> dict:
        return {
            "allowed": self.allowed,
            "violations": self.violations,
            "warnings": self.warnings,
            "tables": self.tables,
            "parsed": self.parsed,
        }


def strip_strings_and_comments(sql: str) -> str:
    """Replace string literals, quoted identifiers and comments with spaces."""
    out = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if c == "-" and nxt == "-":
            j = sql.find("\n", i)
            i = n if j < 0 else j
            out.append(" ")
        elif c == "/" and nxt == "*":
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
            out.append(" ")
        elif c in ("q", "Q") and nxt == "'" and i + 2 < n:
            # Oracle alternative quoting: q'[ ... ]'
            open_ch = sql[i + 2]
            close_ch = {"[": "]", "{": "}", "(": ")", "<": ">"}.get(open_ch, open_ch)
            j = sql.find(close_ch + "'", i + 3)
            i = n if j < 0 else j + 2
            out.append(" '' ")
        elif c == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'" and j + 1 < n and sql[j + 1] == "'":
                    j += 2
                    continue
                if sql[j] == "'":
                    break
                j += 1
            i = j + 1
            out.append(" '' ")
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _lexical_violations(code: str) -> List[str]:
    v = []
    body = code.strip().rstrip(";").strip()
    if ";" in body:
        v.append("multiple_statements")
    if not re.match(r"^\(*\s*(select|with)\b", body, re.IGNORECASE):
        v.append("not_select")
    if _WITH_PLSQL.search(body):
        v.append("inline_plsql")
    m = _LEXICAL_FORBIDDEN.search(body)
    if m:
        v.append(f"forbidden_keyword:{m.group(1).lower().split()[0]}")
    if _FOR_UPDATE.search(body):
        v.append("row_lock")
    if "@" in body:
        v.append("db_link")
    upper = body.upper()
    for pre in _DANGEROUS_PREFIXES:
        if re.search(r"(?<![A-Z0-9_$#])" + re.escape(pre), upper):
            v.append(f"dangerous_package:{pre.rstrip('._').lower()}")
            break
    return v


def _table_name(t: exp.Table) -> str:
    parts = [p for p in (t.args.get("catalog"), t.args.get("db"), t.this) if p is not None]
    return ".".join(p.name if hasattr(p, "name") else str(p) for p in parts).upper()


def analyze_sql(sql: str, allowlist: Optional[Set[str]] = None) -> SqlVerdict:
    allowlist = DEFAULT_ALLOWLIST if allowlist is None else {a.upper() for a in allowlist} | {"DUAL"}
    raw = str(sql or "").strip()
    verdict = SqlVerdict(allowed=False, sql=raw)
    if not raw:
        verdict.violations.append("empty")
        return verdict
    if len(raw) > 20000:
        verdict.violations.append("too_long")
        return verdict

    code = strip_strings_and_comments(raw)
    verdict.violations.extend(_lexical_violations(code))

    try:
        stmts = [s for s in sqlglot.parse(raw.rstrip().rstrip(";"), read="oracle") if s is not None]
        verdict.parsed = True
    except Exception as e:  # sqlglot can't parse some valid Oracle (MODEL clause, WITH FUNCTION, ...)
        stmts = []
        verdict.warnings.append(f"unparsed:{type(e).__name__}")

    if verdict.parsed:
        if len(stmts) != 1:
            verdict.violations.append("multiple_statements")
        for st in stmts:
            if not isinstance(st, exp.Query):
                verdict.violations.append(f"not_select:{type(st).__name__.lower()}")
            for node in st.walk():
                if isinstance(node, _FORBIDDEN_NODES):
                    verdict.violations.append(f"forbidden_statement:{type(node).__name__.lower()}")
                if isinstance(node, exp.Lock):
                    verdict.violations.append("row_lock")
            cte_names = {c.alias_or_name.upper() for c in st.find_all(exp.CTE)}
            for t in st.find_all(exp.Table):
                name = _table_name(t)
                if not name:
                    continue
                if "@" in name:
                    verdict.violations.append("db_link")
                    name = name.split("@", 1)[0]
                schema = name.split(".")[0] if "." in name else ""
                bare = name.split(".")[-1]
                if _SYSTEM_TABLE.match(name) or _SYSTEM_TABLE.match(bare) or schema in _SYSTEM_SCHEMAS:
                    verdict.violations.append(f"system_catalog:{name.lower()}")
                elif bare not in cte_names and bare not in allowlist:
                    verdict.warnings.append(f"unknown_table:{name.lower()}")
                if bare not in cte_names and name not in verdict.tables:
                    verdict.tables.append(name)

    # De-duplicate, keep order.
    verdict.violations = list(dict.fromkeys(verdict.violations))
    verdict.warnings = list(dict.fromkeys(verdict.warnings))
    verdict.allowed = not verdict.violations
    return verdict


_FENCE = re.compile(r"```\s*(?:sql|oracle|plsql)?\s*\n(.*?)```", re.IGNORECASE | re.DOTALL)


def extract_sql_blocks(markdown: str) -> List[str]:
    return [m.group(1).strip() for m in _FENCE.finditer(str(markdown or "")) if m.group(1).strip()]


def redact_unsafe_sql_blocks(markdown: str, allowlist: Optional[Set[str]] = None):
    """Replace unsafe ```sql fences with a notice. Returns (text, [verdict dicts])."""
    findings = []

    def _sub(m: re.Match) -> str:
        body = m.group(1).strip()
        v = analyze_sql(body, allowlist)
        if v.allowed:
            return m.group(0)
        findings.append(v.to_dict())
        return (
            "```text\n-- [guardrails] SQL removed: only a single read-only SELECT on the "
            f"practice schema is shown ({', '.join(v.violations)}).\n```"
        )

    return _FENCE.sub(_sub, str(markdown or "")), findings
