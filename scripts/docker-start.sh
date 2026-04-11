#!/bin/sh
# Runtime entrypoint: wallet bootstrap + Node server (no SQLcl).
set -e

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
    echo "Wallet missing and ORACLE_WALLET_ZIP_B64 not set; Oracle TLS may fail until configured." >&2
  fi
fi

echo "Using wallet path: $WALLET_DIR"
if [ -n "${ORACLE_WALLET_ZIP_B64:-}" ]; then
  test -f "$WALLET_DIR/tnsnames.ora" && test -f "$WALLET_DIR/sqlnet.ora" && test -f "$WALLET_DIR/cwallet.sso" || {
    echo "Wallet incomplete after decode (need tnsnames.ora, sqlnet.ora, cwallet.sso)" >&2
    exit 1
  }
fi

cd /app || exit 1
# Use absolute path — minimal PATH in some runtimes causes exit 127 on bare "node"
NODE_BIN=/usr/local/bin/node
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "FATAL: node not found (tried /usr/local/bin/node and PATH)" >&2
  exit 127
fi
exec "$NODE_BIN" /app/sql-learn-server.js
