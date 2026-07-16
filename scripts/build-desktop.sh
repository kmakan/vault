#!/usr/bin/env bash
# build-desktop.sh — Build Vault Desktop (Tauri 2.0)
# Usage: ./scripts/build-desktop.sh [--dev|--release]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$SCRIPT_DIR/../mailcipher-desktop"

exec "$SCRIPT_DIR/../mailcipher-desktop/scripts/build-desktop.sh" "$@"
