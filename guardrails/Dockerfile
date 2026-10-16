# Easy NL2SQL guardrails sidecar (NVIDIA NeMo Guardrails). Build context: repo root
#   docker build -f guardrails/Dockerfile -t easynlsql-guardrails .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# yara-python ships manylinux wheels; build-essential is only a fallback for platforms without one.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY guardrails/requirements.txt guardrails/requirements.txt
RUN pip install -r guardrails/requirements.txt && apt-get purge -y build-essential && apt-get autoremove -y

COPY guardrails/config guardrails/config
COPY guardrails/easynlsql_guards guardrails/easynlsql_guards
COPY guardrails/server.py guardrails/server.py
# Table allowlist for the SQL firewall (TPC-H practice schema).
COPY schema-reference.json schema-reference.json

RUN useradd --create-home --uid 10001 guard && chown -R guard /app
USER guard

EXPOSE 8088
CMD ["sh", "-c", "uvicorn --app-dir /app/guardrails server:app --host 0.0.0.0 --port ${PORT:-8088}"]
