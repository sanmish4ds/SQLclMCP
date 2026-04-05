#!/bin/sh
# Runtime entrypoint for Docker on Render (wallet bootstrap + Node server).
set -e
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$JAVA_HOME/bin:$PATH"
# Render dashboard often sets SQLCL_BIN=/opt/render/project/... (native build tree).
# That path does not exist in this image; ${SQLCL_BIN:-default} would keep the bad value.
SQLCL_DOCKER=/opt/sqlcl-bundle/sqlcl/bin/sql
if [ -n "$SQLCL_BIN" ]; then
  case "$SQLCL_BIN" in */opt/render/*) SQLCL_BIN= ;; esac
fi
if [ -z "$SQLCL_BIN" ] || [ ! -x "$SQLCL_BIN" ]; then
  export SQLCL_BIN="$SQLCL_DOCKER"
fi

# Always use an app-local wallet dir. If TNS_ADMIN is mis-set to /tmp (or /) in the
# dashboard, `rm -rf "$TNS_ADMIN"` becomes dangerous and fails on Linux (/tmp busy).
WALLET_DIR=/app/wallet
export TNS_ADMIN="$WALLET_DIR"
export ORACLE_WALLET_PATH="${ORACLE_WALLET_PATH:-$WALLET_DIR}"

mkdir -p "$WALLET_DIR"

if [ ! -f "$WALLET_DIR/tnsnames.ora" ] || [ ! -f "$WALLET_DIR/sqlnet.ora" ] || [ ! -f "$WALLET_DIR/cwallet.sso" ]; then
  if [ -n "${ORACLE_WALLET_ZIP_B64:-}" ]; then
    echo "Wallet missing; decoding ORACLE_WALLET_ZIP_B64 into $WALLET_DIR"
    find "$WALLET_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    tmpzip="/tmp/oracle_wallet.$$"
    echo "$ORACLE_WALLET_ZIP_B64" | base64 -d > "$tmpzip"
    unzip -o -q "$tmpzip" -d "$WALLET_DIR"
    rm -f "$tmpzip"

    # Zip often wraps files in Wallet_<name>/; flatten so *.ora are under WALLET_DIR.
    if [ ! -f "$WALLET_DIR/tnsnames.ora" ]; then
      inner=""
      for candidate in "$WALLET_DIR"/*; do
        [ -d "$candidate" ] || continue
        [ -f "$candidate/tnsnames.ora" ] || continue
        inner=$candidate
        break
      done
      if [ -n "$inner" ]; then
        for f in "$inner"/*; do
          [ -e "$f" ] || continue
          mv "$f" "$WALLET_DIR/"
        done
        rmdir "$inner" 2>/dev/null || rm -rf "$inner"
      fi
    fi
  else
    echo "Wallet missing and ORACLE_WALLET_ZIP_B64 not set; startup will fail." >&2
  fi
fi

echo "Using wallet path: $WALLET_DIR"
test -f "$WALLET_DIR/tnsnames.ora"
test -f "$WALLET_DIR/sqlnet.ora"
test -f "$WALLET_DIR/cwallet.sso"

cd /app
# Run node directly as PID 1 (not npm). Render sends SIGTERM on redeploy; npm often logs
# "signal SIGTERM" even when the instance is healthy — direct exec improves signal handling.
exec node mcp-server-http.js
