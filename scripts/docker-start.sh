#!/bin/sh
# Runtime entrypoint for Docker on Render (wallet bootstrap + Node server).
set -e
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$JAVA_HOME/bin:$PATH"
export SQLCL_BIN="${SQLCL_BIN:-/opt/sqlcl-bundle/sqlcl/bin/sql}"
export TNS_ADMIN="${TNS_ADMIN:-/app/wallet}"
export ORACLE_WALLET_PATH="${ORACLE_WALLET_PATH:-$TNS_ADMIN}"

mkdir -p "$TNS_ADMIN"

if [ ! -f "$TNS_ADMIN/tnsnames.ora" ] || [ ! -f "$TNS_ADMIN/sqlnet.ora" ] || [ ! -f "$TNS_ADMIN/cwallet.sso" ]; then
  if [ -n "${ORACLE_WALLET_ZIP_B64:-}" ]; then
    echo "Wallet missing; decoding ORACLE_WALLET_ZIP_B64 into $TNS_ADMIN"
    rm -rf "$TNS_ADMIN"
    mkdir -p "$TNS_ADMIN"
    echo "$ORACLE_WALLET_ZIP_B64" | base64 -d > /tmp/oracle_wallet.zip
    unzip -o -q /tmp/oracle_wallet.zip -d "$TNS_ADMIN"
    rm -f /tmp/oracle_wallet.zip
  else
    echo "Wallet missing and ORACLE_WALLET_ZIP_B64 not set; startup will fail." >&2
  fi
fi

echo "Using wallet path: $TNS_ADMIN"
test -f "$TNS_ADMIN/tnsnames.ora"
test -f "$TNS_ADMIN/sqlnet.ora"
test -f "$TNS_ADMIN/cwallet.sso"

cd /app
exec npm start
