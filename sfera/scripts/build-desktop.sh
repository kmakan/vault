#!/usr/bin/env bash
# build-desktop.sh — сборка Sfera Desktop (Tauri 2).
# Логика и контракты проверяются до сборки; артефакты Tauri кладёт сам.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm ci --no-audit --no-fund
npm run test:contract
npm run build
npm run tauri build

echo
echo "Готово. Артефакты:"
echo "  $ROOT/src-tauri/target/release/bundle"
