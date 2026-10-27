#!/usr/bin/env bash
# Проба TURN из внешней сети: временные креды берём у релея, затем делаем
# Allocate на coturn (UDP и TCP). Симптом битого TURN на клиенте молчаливый
# («звонка нет вне одной Wi-Fi»), поэтому смотрим ответ coturn шаг за шагом.
#
# Использование:
#   VAULT_RELAY_TOKEN=<read/write-токен аккаунта> ./scripts/turn-probe.sh [https://host/relay]
# Токен берётся из окружения и в argv не попадает; credential в вывод не
# печатается (scripts/turn-probe.py).
#
# Что означает ответ релея: 503 — TURN не настроен (VAULT_TURN_SECRET не задан),
# 401 — токен не разобран, 402 — подписка истекла, 403 — канальный токен,
# 429 — суточный бюджет релея исчерпан (он общий с конвертами, лимит решает
# сервер по тарифу).
set -uo pipefail

BASE="${1:-${VAULT_RELAY_URL:-https://vault-msg.ru/relay}}"
BASE="${BASE%/}"
if [ -z "${VAULT_RELAY_TOKEN:-}" ]; then
  echo "нужен VAULT_RELAY_TOKEN (токен аккаунта из приложения)"; exit 1
fi

JSON=$(curl -fsS --max-time 15 --header @<(printf 'Authorization: VaultRelay %s\n' "$VAULT_RELAY_TOKEN") \
  "$BASE/turn") || { echo "✗ релей не выдал креды ($BASE/turn)"; exit 1; }

read -r TU TURN_HOST TURN_PORT < <(printf '%s' "$JSON" | python3 -c '
import json, sys
from urllib.parse import urlsplit
d = json.load(sys.stdin)
# turn:HOST:PORT[?transport=tcp] — scheme без «//», поэтому разбираем сами.
rest = urlsplit(d["uris"][0]).path or d["uris"][0].split(":", 1)[1]
host, _, port = rest.partition(":")
print(d["username"], host, (port.split("?", 1)[0] or "3478"))
')
export TU
export TURN_HOST
export TURN_PORT
export TP=$(printf '%s' "$JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["credential"])')
printf 'uris: %s\n' "$(printf '%s' "$JSON" | python3 -c 'import json,sys; print(", ".join(json.load(sys.stdin)["uris"]))')"
unset JSON

python3 "$(dirname "$0")/turn-probe.py"
RC=$?
unset TU TP
exit $RC
