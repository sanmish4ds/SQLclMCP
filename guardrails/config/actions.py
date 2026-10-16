"""Custom NeMo Guardrails actions for Easy NL2SQL (auto-loaded from the config dir)."""

import os
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nemoguardrails.actions import action  # noqa: E402
from nemoguardrails.actions.rail_outcome import RailOutcome, TransformSpec  # noqa: E402

from easynlsql_guards.sql_policy import analyze_sql, redact_unsafe_sql_blocks  # noqa: E402
from easynlsql_guards.text_checks import find_injection, find_sensitive  # noqa: E402


@action(name="check_sensitive_text", is_system_action=True)
async def check_sensitive_text(text: Optional[str] = None, source: str = "input", context: Optional[dict] = None):
    hits = find_sensitive(text or "")
    if hits:
        return RailOutcome.block(reason=f"sensitive_{source}", metadata={"detections": hits})
    return RailOutcome.allow()


@action(name="check_prompt_injection", is_system_action=True)
async def check_prompt_injection(text: Optional[str] = None, context: Optional[dict] = None):
    hits = find_injection(text or "")
    if hits:
        return RailOutcome.block(reason="prompt_injection", metadata={"patterns": hits})
    return RailOutcome.allow()


@action(name="check_sql_output", is_system_action=True)
async def check_sql_output(context: Optional[dict] = None):
    """Block if the primary generated SQL is unsafe; redact unsafe ```sql fences in tutor prose."""
    context = context or {}
    generated_sql = context.get("generated_sql") or ""
    if generated_sql:
        v = analyze_sql(generated_sql)
        if not v.allowed:
            return RailOutcome.block(reason="unsafe_sql", metadata=v.to_dict())
    bot_message = context.get("bot_message") or ""
    redacted, findings = redact_unsafe_sql_blocks(bot_message)
    if findings:
        return RailOutcome(
            decision="transform",
            reason="unsafe_sql_block_redacted",
            metadata={"findings": findings},
            transforms=(TransformSpec(target="bot_message", text=redacted),),
        )
    return RailOutcome.allow()
