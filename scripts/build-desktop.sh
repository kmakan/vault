#!/usr/bin/env bash
# build-desktop.sh — Build Vault Desktop (Tauri 2.0)
# Usage: ./scripts/build-desktop.sh [--dev|--release]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$SCRIPT_DIR/../vault-desktop"

exec "$SCRIPT_DIR/../vault-desktop/scripts/build-desktop.sh" "$@"
