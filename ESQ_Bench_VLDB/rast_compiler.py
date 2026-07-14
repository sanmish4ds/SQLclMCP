#!/usr/bin/env python3
"""RAST (Relational AST) typing checks and dialect emitter -- reference implementation.

Sec. rast of the paper specifies an abstract IR (tau ::= Scan | Filter | Join |
Project | Agg | Sort) with two well-formedness rules (T1: every referenced column
exists in its RAST child's schema; T2: every non-aggregated Project column under
an Agg node appears in the grouping key) and a per-construct dialect emission table
(Table tab:emitter). Previously this was "specified but not integrated into the
production HTTP path" (Sec. limits).

This module closes that gap as an offline validator + emitter, reusing sqlglot's
SQL parser/AST as the concrete syntax layer underneath DRL's own RAST typing rules
and dialect-mapping policy, rather than a hand-written grammar for the abstract IR
described in Sec. rast -- the typing rules and emission policy (which NULLS LAST /
FETCH FIRST / STRING_AGG rewrites to apply, and in which direction) are DRL's own,
not sqlglot's defaults, and Sec. rast-typing's T1/T2 rules are enforced explicitly
below rather than left to whatever validation sqlglot happens to perform internally.

It is NOT wired into a live HTTP serving path (that integration remains future
work, per Sec. limits); it is wired into the evaluation harness so T1/T2 violation
rates on actual model-generated SQL can be measured and reported.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp


@dataclass
class TypingResult:
    t1_ok: bool = True
    t1_errors: list[str] = field(default_factory=list)
    t2_ok: bool = True
    t2_errors: list[str] = field(default_factory=list)
    parse_error: str | None = None

    @property
    def ok(self) -> bool:
        return self.parse_error is None and self.t1_ok and self.t2_ok


def _table_aliases(select: exp.Select) -> dict[str, str]:
    """alias/name -> real table name, lowercased."""
    out: dict[str, str] = {}
    for t in select.find_all(exp.Table):
        real = t.name.lower()
        alias = (t.alias or t.name).lower()
        out[alias] = real
    return out


def check_typing(sql: str, schema_tables: dict[str, list[str]], dialect: str = "postgres") -> TypingResult:
    """T1: every column reference resolves to a declared table.column in
    schema_tables. T2: every non-aggregated, non-constant SELECT expression in a
    GROUP BY query appears in the GROUP BY key (by rendered SQL text)."""
    result = TypingResult()
    try:
        tree = sqlglot.parse_one(sql, read=dialect)
    except Exception as exc:
        result.parse_error = str(exc)
        return result

    schema_lower = {t.lower(): {c.lower() for c in cols} for t, cols in schema_tables.items()}
    all_columns = {c for cols in schema_lower.values() for c in cols}

    for select in tree.find_all(exp.Select):
        aliases = _table_aliases(select)
        tables_in_scope = set(aliases.values()) or set(schema_lower.keys())

        for col in select.find_all(exp.Column):
            # Skip columns inside subqueries with their own FROM (handled by their
            # own find_all(exp.Select) pass); a simple heuristic: only check columns
            # whose nearest enclosing Select is this one.
            enclosing = col.find_ancestor(exp.Select)
            if enclosing is not select:
                continue
            colname = col.name.lower()
            qualifier = col.table.lower() if col.table else None
            if qualifier:
                real_table = aliases.get(qualifier, qualifier)
                if real_table in schema_lower and colname not in schema_lower[real_table] and colname != "*":
                    result.t1_ok = False
                    result.t1_errors.append(f"{qualifier}.{col.name} not in schema for table {real_table}")
            else:
                if colname == "*":
                    continue
                candidates = [t for t in tables_in_scope if t in schema_lower and colname in schema_lower[t]]
                if not candidates and colname not in all_columns:
                    result.t1_ok = False
                    result.t1_errors.append(f"unqualified column {col.name} not found in any in-scope table")

        # T2: GROUP BY completeness.
        group = select.args.get("group")
        if group:
            group_keys = {g.sql(dialect=dialect).strip().lower() for g in group.expressions}
            for proj in select.expressions:
                target = proj.this if isinstance(proj, exp.Alias) else proj
                if target.find(exp.AggFunc):
                    continue
                if isinstance(target, exp.Literal):
                    continue
                rendered = target.sql(dialect=dialect).strip().lower()
                if rendered not in group_keys:
                    result.t2_ok = False
                    result.t2_errors.append(f"non-aggregated projection '{rendered}' missing from GROUP BY")

    return result


# --- Dialect emission (Table tab:emitter), layered on top of sqlglot.transpile ---

_NULLS_LAST_MYSQL_RE = re.compile(r"ORDER BY\s+(.+?)\s+DESC(?!\s*,)", re.IGNORECASE)


def emit_dialect(sql: str, source_dialect: str, target_dialect: str) -> str:
    """Emit `sql` (written in `source_dialect`) for `target_dialect`, applying
    DRL's own Table tab:emitter rules on top of sqlglot's generic transpilation
    where sqlglot's defaults diverge from the paper's specified behavior.

    Concretely: sqlglot's MySQL (<8.0.14) writer silently *drops* NULLS LAST rather
    than rewriting it to the `ORDER BY (x IS NULL), x` form Table tab:emitter
    specifies -- a real, previously-untested gap between "what a generic SQL
    transpiler does" and "what DRL's emitter spec requires" that this function
    corrects for MySQL specifically.
    """
    target_map = {"mysql": "mysql", "postgres": "postgres", "postgresql": "postgres",
                  "sqlserver": "tsql", "tsql": "tsql"}
    write_dialect = target_map.get(target_dialect.lower(), target_dialect.lower())
    read_dialect = target_map.get(source_dialect.lower(), source_dialect.lower())

    has_nulls_last = bool(re.search(r"NULLS\s+LAST", sql, re.IGNORECASE))
    emitted = sqlglot.transpile(sql, read=read_dialect, write=write_dialect)[0]

    if write_dialect == "mysql" and has_nulls_last and "NULLS LAST" not in emitted.upper():
        # sqlglot dropped the NULLS LAST semantics; apply DRL's documented rewrite.
        m = _NULLS_LAST_MYSQL_RE.search(emitted)
        if m:
            col = m.group(1).strip()
            emitted = _NULLS_LAST_MYSQL_RE.sub(f"ORDER BY ({col} IS NULL), {col} DESC", emitted, count=1)

    return emitted
