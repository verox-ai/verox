#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_NAME="verox"
DIST_DIR="$SCRIPT_DIR/dist"
DIST_ENTRY="$DIST_DIR/index.js"
SERVICE_NAME="verox"
SYSTEM_SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
USER_SERVICE_FILE="${HOME}/.config/systemd/user/${SERVICE_NAME}.service"

echo ""
echo "  Verox Updater"
echo "  ──────────────────────────────────────"

# ── Detect package manager ────────────────────────────────────────────────────

if command -v pnpm &>/dev/null; then
  PKG="pnpm"
elif command -v npm &>/dev/null; then
  PKG="npm"
else
  echo "  ✗ Neither pnpm nor npm found. Install Node.js first."
  exit 1
fi

# ── Detect installed service scope ───────────────────────────────────────────
# Check which service file exists so we use the right systemctl scope.

SERVICE_SCOPE=""
if [ -f "$SYSTEM_SERVICE_FILE" ]; then
  SERVICE_SCOPE="system"
elif [ -f "$USER_SERVICE_FILE" ]; then
  SERVICE_SCOPE="user"
fi

# ── 1. Stop service (if installed) ────────────────────────────────────────────

if [ -n "$SERVICE_SCOPE" ]; then
  echo "  → Stopping service ($SERVICE_SCOPE)..."
  if [ "$SERVICE_SCOPE" = "system" ]; then
    sudo systemctl stop "$SERVICE_NAME" || true
  else
    systemctl --user stop "$SERVICE_NAME" || true
  fi
else
  echo "  ℹ  No systemd service detected — skipping stop"
fi

# ── 2. Pull latest code ───────────────────────────────────────────────────────

echo "  → git pull..."
git pull

# ── 3. Install dependencies ───────────────────────────────────────────────────

echo "  → Installing dependencies ($PKG)..."
"$PKG" install --frozen-lockfile 2>/dev/null || "$PKG" install

# ── 4. Build ──────────────────────────────────────────────────────────────────
echo "  → cleaning old dist folder"
rm $DIST_DIR/*

echo "  → Building..."
"$PKG" run build:all
chmod +x "$DIST_ENTRY"

# ── 5. Create or refresh symlink ─────────────────────────────────────────────

echo "  → Setting up verox command..."

SYSTEM_BIN="/usr/local/bin/$BIN_NAME"
USER_BIN="${HOME}/.local/bin/$BIN_NAME"

# Check if a correct symlink already exists
LINKED=false
for p in "$SYSTEM_BIN" "$USER_BIN"; do
  if [ -L "$p" ] && [ "$(readlink "$p")" = "$DIST_ENTRY" ]; then
    echo "  ✓ Symlink OK: $p"
    LINKED=true
    break
  fi
done

if [ "$LINKED" = false ]; then
  # Remove any stale symlinks (use if to avoid set -e firing on missing files)
  if [ -L "$SYSTEM_BIN" ]; then
    rm -f "$SYSTEM_BIN" 2>/dev/null || sudo rm -f "$SYSTEM_BIN" || true
  fi
  if [ -L "$USER_BIN" ]; then
    rm -f "$USER_BIN" || true
  fi

  # Try /usr/local/bin without sudo, then with, then fall back to ~/.local/bin
  if ln -s "$DIST_ENTRY" "$SYSTEM_BIN" 2>/dev/null; then
    echo "  ✓ Symlink: $SYSTEM_BIN → $DIST_ENTRY"
  elif sudo ln -s "$DIST_ENTRY" "$SYSTEM_BIN" 2>/dev/null; then
    echo "  ✓ Symlink (sudo): $SYSTEM_BIN → $DIST_ENTRY"
  else
    mkdir -p "$(dirname "$USER_BIN")"
    if ln -s "$DIST_ENTRY" "$USER_BIN"; then
      echo "  ✓ Symlink: $USER_BIN → $DIST_ENTRY"
      if ! echo "$PATH" | grep -q "${HOME}/.local/bin"; then
        echo "  ⚠  Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
      fi
    else
      echo "  ✗ Could not create symlink — run install.sh with sudo"
    fi
  fi
fi

# ── 6. Restart service (if installed) ─────────────────────────────────────────

if [ -n "$SERVICE_SCOPE" ]; then
  echo "  → Starting service ($SERVICE_SCOPE)..."
  if [ "$SERVICE_SCOPE" = "system" ]; then
    sudo systemctl daemon-reload
    sudo systemctl start "$SERVICE_NAME"
  else
    systemctl --user daemon-reload
    systemctl --user start "$SERVICE_NAME"
  fi
  SCOPE_FLAG=""
  [ "$SERVICE_SCOPE" = "user" ] && SCOPE_FLAG=" --user"
  echo "  ✓ Service started."
  echo "  Logs: journalctl${SCOPE_FLAG} -u $SERVICE_NAME -f"
else
  echo "  ℹ  No systemd service — run 'verox start' to start manually"
fi

echo ""
echo "  Done."
echo ""
