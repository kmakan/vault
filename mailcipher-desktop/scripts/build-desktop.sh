#!/usr/bin/env bash
# build-desktop.sh — Build Whisper Desktop (Tauri 2.0)
# Usage: ./scripts/build-desktop.sh [--dev|--release]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
DESKTOP_DIR="$PROJECT_DIR/mailcipher-desktop"

MODE="${1:---release}"

echo "╔══════════════════════════════════════════╗"
echo "║  Whisper Desktop Build                  ║"
echo "╚══════════════════════════════════════════╝"

# Check prerequisites
for cmd in node npm cargo; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "❌ Missing: $cmd"
        exit 1
    fi
done

cd "$DESKTOP_DIR"

# 1. Install frontend dependencies
echo ""
echo "📦 Installing frontend dependencies..."
npm install --include=dev --ignore-scripts 2>&1 | tail -3

# 2. Build frontend
echo ""
echo "🔨 Building frontend..."
./node_modules/.bin/vite build 2>&1

# 3. Rust check
echo ""
echo "🦀 Checking Rust code..."
cd src-tauri
cargo check 2>&1
cd ..

# 4. Run tests
echo ""
echo "🧪 Running Rust tests..."
cd src-tauri
cargo test 2>&1
cd ..

# 5. Build
echo ""
if [ "$MODE" = "--dev" ]; then
    echo "🚀 Starting dev mode..."
    npm run tauri dev 2>&1
else
    echo "📦 Building release..."
    npm run tauri build 2>&1
    echo ""
    echo "✅ Build complete! Artifacts in src-tauri/target/release/bundle/"
fi
