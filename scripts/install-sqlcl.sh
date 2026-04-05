#!/bin/sh
# Download SQLcl into <repo>/.sqlcl-bundle/ (same layout as the Docker image).
# Requires: curl or wget, unzip, a JRE (SQLcl is Java).
set -e
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DEST="$ROOT/.sqlcl-bundle"
SQL_BIN="$DEST/sqlcl/bin/sql"
ZIP_URL="https://download.oracle.com/otn_software/java/sqldeveloper/sqlcl-latest.zip"

if [ -x "$SQL_BIN" ]; then
  echo "SQLcl already present: $SQL_BIN"
  echo "export SQLCL_BIN=\"$SQL_BIN\""
  exit 0
fi

if ! command -v java >/dev/null 2>&1 || ! java -version >/dev/null 2>&1; then
  echo "Java 11+ is required for SQLcl (install Temurin 17, Oracle JDK, etc.). macOS /usr/bin/java is only a stub until a JDK is installed." >&2
  exit 1
fi

mkdir -p "$DEST"
cd "$DEST"
rm -f sqlcl-latest.zip
if command -v curl >/dev/null 2>&1; then
  echo "Downloading SQLcl..."
  curl -fsSL -o sqlcl-latest.zip "$ZIP_URL"
elif command -v wget >/dev/null 2>&1; then
  echo "Downloading SQLcl..."
  wget -q -O sqlcl-latest.zip "$ZIP_URL"
else
  echo "Need curl or wget to download SQLcl." >&2
  exit 1
fi

unzip -oq sqlcl-latest.zip
rm -f sqlcl-latest.zip
chmod +x "$SQL_BIN"

echo "Installed SQLcl at $SQL_BIN"
echo "Add to your shell profile or run before npm start:"
echo "export SQLCL_BIN=\"$SQL_BIN\""
