# Java 21 JRE (required by SQLcl) on Ubuntu Jammy
FROM eclipse-temurin:21-jre-jammy

# Install Node.js 20, curl, unzip
RUN apt-get update -qq && \
    apt-get install -y -qq curl unzip && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y -qq nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Download SQLcl
RUN curl -sL https://download.oracle.com/otn_software/java/sqldeveloper/sqlcl-latest.zip -o sqlcl.zip && \
    unzip -q sqlcl.zip -d . && \
    chmod +x sqlcl/bin/sql && \
    rm sqlcl.zip

# Copy application source
COPY . .

ENV SQLCL_BIN=/app/sqlcl/bin/sql
ENV PORT=3000

EXPOSE 3000

CMD ["node", "mcp-server-http.js"]
