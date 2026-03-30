#!/bin/sh
set -e

DATA_DIR="${VEROX_HOME:-/data}"
KEY_FILE="$DATA_DIR/.vault_key"

# Ensure data dir exists (volume might not create subdirs)
mkdir -p "$DATA_DIR"

# Resolve vault password: env var > key file > auto-generate
if [ -n "$VEROX_VAULT_PASSWORD" ]; then
  echo "[verox] Using vault password from environment variable."
else
  if [ -f "$KEY_FILE" ]; then
    VEROX_VAULT_PASSWORD=$(cat "$KEY_FILE")
    export VEROX_VAULT_PASSWORD
    echo "[verox] Loaded vault password from $KEY_FILE"
  else
    # First launch — generate and persist a new key
    VEROX_VAULT_PASSWORD=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
    export VEROX_VAULT_PASSWORD
    echo "$VEROX_VAULT_PASSWORD" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "[verox] ============================================================"
    echo "[verox] First launch: generated vault encryption key."
    echo "[verox] Key stored in: $KEY_FILE (inside your data volume)"
    echo "[verox] Back this file up — losing it means losing access to all"
    echo "[verox] stored credentials (API keys, tokens, etc.)."
    echo "[verox] ============================================================"
  fi
fi

echo "[verox] ============================================================"
echo "[verox] Web UI: http://${VEROX_HOST:-<your-server-ip>}:3000"
echo "[verox] Use the onboarding wizard to set your password and API key."
echo "[verox] Tip: set VEROX_HOST in docker-compose.yml to see the exact URL."
echo "[verox] ============================================================"

exec node dist/index.js start
