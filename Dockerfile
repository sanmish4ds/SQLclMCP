# Docker deploy avoids Render's native build (python-env.sh / render-build-tool issues).
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    wget \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"

WORKDIR /opt/sqlcl-bundle
RUN wget -q https://download.oracle.com/otn_software/java/sqldeveloper/sqlcl-latest.zip \
    && unzip -qq sqlcl-latest.zip \
    && rm sqlcl-latest.zip \
    && chmod +x /opt/sqlcl-bundle/sqlcl/bin/sql

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x /app/scripts/docker-start.sh

ENV SQLCL_BIN=/opt/sqlcl-bundle/sqlcl/bin/sql
ENV NODE_ENV=production

EXPOSE 3000
ENTRYPOINT ["/bin/sh", "/app/scripts/docker-start.sh"]
