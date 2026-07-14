#!/bin/zsh
cd /Users/sanjaymishra/SQLclMCP
source .venv/bin/activate
exec python experiments/run_sql_evaluation.py --run-mode compare --questions-file experiments/new-practice-questions.json --no-schema-hint --no-visualize
