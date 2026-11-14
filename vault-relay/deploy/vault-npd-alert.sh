#!/usr/bin/env bash
# Vault: оповещение, если сверка/выдача чеков НПД упала (lknpd недоступен и т.п.).
# Вешается на OnFailure= юнита vault-npd-receipts.service.
# Дедуп: не чаще одного раза в 6 часов, чтобы не спамить, если VPN поднят надолго.
# --dry-run: только лог/локальное уведомление, без push на телефон.
set -uo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

STATE_DIR="$HOME/.hermes/state"
mkdir -p "$STATE_DIR" "$HOME/.hermes/logs"
STAMP="$STATE_DIR/npd-alert.last"
LOG="$HOME/.hermes/logs/npd-alert.log"

now=$(date +%s)
last=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ $((now - last)) -lt 21600 ]; then
  exit 0
fi

reason=$(journalctl --user -u vault-npd-receipts.service -n 20 --no-pager 2>/dev/null \
  | grep -E 'vault-npd-receipts\[[0-9]+\]:' \
  | grep -viE 'сверка:|Starting|Finished' | tail -1 \
  | sed -E 's/.*vault-npd-receipts\[[0-9]+\]: //')
[ -z "$reason" ] && reason="сверка чеков не прошла (journalctl --user -u vault-npd-receipts)"

line="$(date -Is) чеки НПД НЕ оформляются: $reason"
echo "$line" >> "$LOG"
echo "$now" > "$STAMP"

notify-send -u critical "Vault: чеки НПД не оформляются" "$reason" 2>/dev/null || true

if [ "$DRY" = 0 ]; then
  # push на телефон через ntfy на сервере (тот же топик, что у денежного дайджеста)
  ssh -o BatchMode=yes -o ConnectTimeout=10 server '
    set -uo pipefail; cd /home/maksim/vault-relay
    [ -f accounting.env ] && . ./accounting.env 2>/dev/null
    URL="${VAULT_ACCOUNTING_NTFY_URL:-}"; [ -z "$URL" ] && exit 0
    printf "%s" "$1" | curl -s -m 20 -X POST -H "Title: Vault: чеки НПД НЕ оформляются" --data-binary @- "$URL" >/dev/null
  ' _ "$line" 2>/dev/null || true
fi
exit 0
