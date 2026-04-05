# Node NL2SQL server; Oracle access uses node-oracledb (thin) + wallet from env.
FROM node:20-bookworm-slim

# unzip: required by scripts/docker-start.sh and wallet extraction in mcp-server-http.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x /app/scripts/docker-start.sh

ENV NODE_ENV=production

EXPOSE 3000
ENTRYPOINT ["/bin/sh", "/app/scripts/docker-start.sh"]
