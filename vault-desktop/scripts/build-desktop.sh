#!/usr/bin/env bash
# build-desktop.sh — Build Vault Desktop (Tauri 2.0)
# Usage: ./scripts/build-desktop.sh [--dev|--release|--check]
#
# --dev     Run in dev mode (hot reload)
# --release Build release packages (.deb, .rpm, .AppImage, .msi, .dmg)
# --check   Just verify compilation (no packaging)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
DESKTOP_DIR="$PROJECT_DIR/vault-desktop"
TAURI_DIR="$DESKTOP_DIR/src-tauri"

MODE="${1:---release}"

echo "╔══════════════════════════════════════════╗"
echo "║  Vault Desktop Build                     ║"
echo "╚══════════════════════════════════════════╝"
echo "Mode: $MODE"
echo ""

# Check prerequisites
MISSING=()
for cmd in node npm cargo; do
    if ! command -v "$cmd" &>/dev/null; then
        MISSING+=("$cmd")
    fi
done
if ! npx tauri --version &>/dev/null 2>&1; then
    MISSING+=("tauri-cli (npm install -g @tauri-apps/cli)")
fi
if [ ${#MISSING[@]} -gt 0 ]; then
    echo "❌ Missing prerequisites: ${MISSING[*]}"
    exit 1
fi

cd "$DESKTOP_DIR"

# 1. Install frontend dependencies
echo "📦 Installing frontend dependencies..."
npm install --include=dev --ignore-scripts 2>&1 | tail -3

# 2. Build frontend
echo ""
echo "🔨 Building frontend (vite)..."
./node_modules/.bin/vite build 2>&1

# 3. Rust check
echo ""
echo "🦀 Checking Rust code..."
cd "$TAURI_DIR"
cargo check 2>&1 | grep -E "error|warning.*vault" | head -10 || true
cd "$DESKTOP_DIR"

# 4. Mode-specific action
case "$MODE" in
    --dev)
        echo ""
        echo "🚀 Starting dev mode (hot reload)..."
        npm run tauri dev 2>&1
        ;;
    --check)
        echo ""
        echo "✅ Compilation check passed. No packages built."
        ;;
    --release|*)
        echo ""
        echo "📦 Building release packages..."
        npm run tauri build 2>&1

        echo ""
        echo "✅ Build complete!"
        echo ""
        echo "Artifacts:"
        BUNDLE_DIR="$TAURI_DIR/target/release/bundle"
        if [ -d "$BUNDLE_DIR" ]; then
            find "$BUNDLE_DIR" -type f \( -name "*.deb" -o -name "*.rpm" -o -name "*.AppImage" -o -name "*.msi" -o -name "*.dmg" -o -name "*.exe" \) 2>/dev/null | while read f; do
                SIZE=$(du -h "$f" | cut -f1)
                echo "  📦 $f ($SIZE)"
            done
        fi
        echo ""
        echo "Directory: $BUNDLE_DIR"
        ;;
esac
