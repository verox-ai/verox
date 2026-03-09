#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_NAME="verox"
DIST_ENTRY="$SCRIPT_DIR/dist/index.js"
SYSTEM_BIN="/usr/local/bin/$BIN_NAME"
USER_BIN="$HOME/.local/bin/$BIN_NAME"

echo ""
echo "  Verox Installer"
echo "  ──────────────────────────────────────"

# ── 1. Install dependencies ───────────────────────────────────────────────────

if command -v pnpm &>/dev/null; then
  PKG="pnpm"
elif command -v npm &>/dev/null; then
  PKG="npm"
else
  echo "  ✗ Neither pnpm nor npm found. Install Node.js first."
  exit 1
fi

echo "  → Installing dependencies with $PKG..."
"$PKG" install --frozen-lockfile 2>/dev/null || "$PKG" install

# ── 2. Build ──────────────────────────────────────────────────────────────────

echo "  → Building..."
"$PKG" run build:all

# ── 3. Make entry executable ──────────────────────────────────────────────────

chmod +x "$DIST_ENTRY"

# ── 4. Create symlink ─────────────────────────────────────────────────────────

# Remove any existing symlink first, then try system-wide, fall back to user bin
if [ -L "$SYSTEM_BIN" ]; then
  rm -f "$SYSTEM_BIN" 2>/dev/null || sudo rm -f "$SYSTEM_BIN" || true
fi
if [ -L "$USER_BIN" ]; then
  rm -f "$USER_BIN" || true
fi

if ln -s "$DIST_ENTRY" "$SYSTEM_BIN" 2>/dev/null; then
  echo "  ✓ Installed: $SYSTEM_BIN → $DIST_ENTRY"
elif sudo ln -s "$DIST_ENTRY" "$SYSTEM_BIN" 2>/dev/null; then
  echo "  ✓ Installed (sudo): $SYSTEM_BIN → $DIST_ENTRY"
else
  echo "  ℹ  Cannot write to /usr/local/bin — installing to ~/.local/bin instead"
  mkdir -p "$(dirname "$USER_BIN")"
  ln -s "$DIST_ENTRY" "$USER_BIN"
  echo "  ✓ Installed: $USER_BIN → $DIST_ENTRY"
  if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
    echo ""
    echo "  ⚠  Add the following to your shell profile (~/.bashrc or ~/.zshrc):"
    echo '     export PATH="$HOME/.local/bin:$PATH"'
  fi
fi

echo ""
echo "  Done. Run: $BIN_NAME start"
echo ""
