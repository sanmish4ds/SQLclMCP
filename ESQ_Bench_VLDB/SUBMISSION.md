# The VLDB Journal — Submission Package (DRL Middleware)

**Target venue:** [The VLDB Journal](https://www.vldb.org/vldb_journal/) (Springer)  
**Not** PVLDB / VLDB conference proceedings.

**Primary artifact:** `drl_middleware_vldb.tex` → `drl_middleware_vldb.pdf`  
**Template:** Springer `svjour3` (two-column), `\journalname{The VLDB Journal}`  
**Length cap:** ≤ 25 pages (journal rule). Current build aims for a full research article well under the cap.

## Build

```bash
cd ESQ_Bench_VLDB
python3 generate_paper_figures.py
pdflatex drl_middleware_vldb.tex
bibtex drl_middleware_vldb
pdflatex drl_middleware_vldb.tex
pdflatex drl_middleware_vldb.tex
```

## Publication-ready checklist

### Content (done)
- [x] Systems/middleware framing (not a leaderboard benchmark paper)
- [x] Formal schema-graph scaling problem + definitions
- [x] Architecture: prune router, RAST (specified), safeguards
- [x] Worked example (t2a-002 prune → sanitize)
- [x] 1,000-pair verification suite + harnesses
- [x] B0–B3 middleware metrics (PostgreSQL + MySQL)
- [x] NL2SQL results: GPT-4o / Gemini / Claude (Claude T2/T3 rescored)
- [x] Failure taxonomy + category EX table + SD_op
- [x] Ablations, discussion, threat model, limitations
- [x] Artifact paths documented
- [x] Journal name set to **The VLDB Journal**

### Author / submission actions
- [ ] Confirm employer disclaimer wording with co-authors
- [ ] Add funding grant numbers if any
- [ ] Confirm ORCID IDs (optional but recommended)
- [ ] Download / confirm latest VLDB Journal LaTeX template from the journal site if they require a journal-specific class beyond `svjour3`
- [ ] Submit PDF (initial) via Springer / journal portal; final must include all source files
- [ ] Ensure total ≤ 25 pages; no space-saving tricks; readable figures

### Optional follow-ups (not blocking)
- [ ] Live Claude re-generation (schema-prefix rescoring already recovers EX)
- [ ] SQL Server instance validation
- [ ] Model-output PSC under B3
- [ ] Full RAST parse-and-emit in HTTP path

## Key numbers

| Claim | Value |
|-------|-------|
| Context reduction B1→B2 | 71% |
| Prune p95 | 0.76 ms |
| Middleware p95 (excl. LLM) | 4.1 ms |
| GPT-4o / Gemini / Claude EX | 51.6% / 50.1% / 46.5% |
| SD_op on EX (GPT-4o) | 95.9% |
| MySQL gold executable | 875/946 |

## Reproduce experiments

See `README.md` in this folder.
