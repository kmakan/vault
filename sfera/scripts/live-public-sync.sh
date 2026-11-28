#!/usr/bin/env bash
# Изолированная приёмка синхронизации публичного канала через production FFI.
# Не читает аккаунты Vault и не подключается к боевым сервисам.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${TMPDIR:-/home/maksim/.hermes/cache/scratch}/sfera-public-sync-accept"
CLIENT="$SCRATCH/client"
SERVER="$SCRATCH/server"
CHANNEL="accept-public"
mkdir -p "$CLIENT" "$SERVER"

export SFERA_SYNC_ROOT="$CLIENT"
export SFERA_PUBLIC_ROOT="$CLIENT/public/channels"
export SFERA_SYNC_CHANNEL="$CHANNEL"
export SFERA_SYNC_URL="http://127.0.0.1:8095"
export SFERA_SYNC_TOKEN="isolated-test-token"

cd "$ROOT"
cargo build -q -p social-public --bin social-public-serve
cargo build -q -p social-ffi --bin public-sync
SFERA_PUBLIC_ROOT="$SERVER" SFERA_PUBLIC_BIND=127.0.0.1:8095 \
  SFERA_PUBLIC_UPLOAD_TOKEN="$SFERA_SYNC_TOKEN" \
  target/debug/social-public-serve >"$SCRATCH/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8095/health >/dev/null; then break; fi
  sleep 0.2
done
curl -fsS http://127.0.0.1:8095/health >/dev/null

SFERA_PUBLIC_ROOT="$CLIENT/public/channels" SFERA_SYNC_PHASE=prepare cargo run -q -p social-ffi --bin public-sync
SFERA_PUBLIC_ROOT="$CLIENT/public/channels" SFERA_SYNC_PHASE=sync cargo run -q -p social-ffi --bin public-sync
curl -fsS "http://127.0.0.1:8095/sfera/public/channels/$CHANNEL" >"$SCRATCH/feed.json"
python3 - "$SCRATCH/feed.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    feed = json.load(f)
assert feed["channel"]["id"] == "accept-public"
assert len(feed["posts"]) >= 1
assert any("Публичная приёмка" in post["post"]["body"] for post in feed["posts"])
print("READ_BACK_OK posts=", len(feed["posts"]))
PY
