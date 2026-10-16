"""Cheap deterministic text checks that run before any LLM-based rail."""

from __future__ import annotations

import re
from typing import List

_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b")
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_PHONE = re.compile(r"(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)")
_SECRETS = [
    ("openai_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("connect_string_password", re.compile(r"\b\w+/[^\s/@]{3,}@[\w.-]+", re.IGNORECASE)),
    (
        "password_value",
        re.compile(r"\b(password|passwd|pwd|secret|api[_ -]?key|token)\s*(?:is|=|:)\s*\S{4,}", re.IGNORECASE),
    ),
]

# Example/test domains are fine in SQL exercises (e.g. LIKE '%@example.com').
_SAFE_EMAIL_DOMAINS = ("example.com", "example.org", "example.net", "test.com", "domain.com")


def _luhn_ok(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def find_sensitive(text: str) -> List[str]:
    s = str(text or "")
    hits: List[str] = []
    for m in _EMAIL.finditer(s):
        if not m.group(0).lower().endswith(_SAFE_EMAIL_DOMAINS):
            hits.append("email")
            break
    if _SSN.search(s):
        hits.append("ssn")
    for m in _CARD.finditer(s):
        digits = re.sub(r"\D", "", m.group(0))
        if 13 <= len(digits) <= 19 and _luhn_ok(digits):
            hits.append("credit_card")
            break
    if _PHONE.search(s):
        hits.append("phone")
    for name, rx in _SECRETS:
        if rx.search(s):
            hits.append(name)
    return list(dict.fromkeys(hits))


_INJECTION_PATTERNS = [
    r"\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|earlier|all|your|system)\b.{0,30}\b(instructions?|rules?|prompts?|guidelines?|directions?|constraints?)\b",
    r"\b(reveal|show|print|repeat|output|leak|tell me|what (is|are))\b.{0,30}\b(your|the)\b.{0,20}\b(system|hidden|initial|original|developer)\s+(prompt|instructions?|message)",
    r"\bsystem prompt\b",
    r"\bdeveloper (mode|message)\b",
    r"\bjailbreak\b",
    r"\bDAN\b|\bdo anything now\b",
    r"\byou are (now|no longer)\b.{0,60}\b(unrestricted|unfiltered|evil|without (any )?(rules|restrictions|limits))",
    r"\bpretend (to be|you are)\b.{0,60}\b(no|without) (rules|restrictions|filters|guardrails)",
    r"\b(act|behave) as\b.{0,40}\b(unrestricted|unfiltered|root|admin|dba|sysdba)\b",
    r"<\|?(im_start|im_end|system|endoftext)\|?>",
    r"^\s*(###|\[)\s*(system|assistant|instruction)s?\s*[:\]]",
    r"\bnew (instructions|rules)\s*:",
]
_INJECTION_RX = [re.compile(p, re.IGNORECASE | re.MULTILINE) for p in _INJECTION_PATTERNS]


def find_injection(text: str) -> List[str]:
    s = str(text or "")
    return [p.pattern[:40] for p in _INJECTION_RX if p.search(s)]
