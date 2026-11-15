#!/usr/bin/env bash
# Часовая проба: пускает ли нас сервер по SSH.
#
# Зачем отдельно от сторожа сайта: сайт может лежать и при живом SSH (nginx не
# поднялся), а нам важно войти как можно раньше — снять копию состояния релея
# и поднять сервисы. Проба стучится РАЗ В ЧАС, чтобы не плодить IMAP-подобных
# всплесков и не засорять журнал.
#
# Если SSH ответил — сразу запускает подъём в принудительном режиме
# (проверки, рестарты, офсайт-копия) и уведомляет. Если нет — одна строка в лог.
#
# Коды выхода: 0 — штатно (доступен или нет, решает подъём); 1 — ошибка лога.

set -uo pipefail

LOG="$HOME/.hermes/logs/vault-ssh-probe.log"
mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }
notify() { notify-send -u "${3:-normal}" "$1" "$2" 2>/dev/null || true; }

out=$(ssh -o BatchMode=yes -o ConnectTimeout=8 \
          -o ServerAliveInterval=5 -o ServerAliveCountMax=2 \
          server 'echo SSH_OK; uptime; systemctl is-active nginx vault-relay 2>/dev/null' 2>&1)
rc=$?

if [ "$rc" -ne 0 ] || ! printf '%s' "$out" | grep -q '^SSH_OK'; then
  # Одна строка: причина последней строкой (таймаут баннера, отказ и т.п.).
  log "SSH недоступен (rc=$rc): $(printf '%s' "$out" | tail -1)"
  exit 0
fi

one_line=$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)
log "SSH ОЖИЛ: $one_line"
notify "Vault: сервер пускает по SSH" "запускаю проверки и копию состояния" normal

VAULT_RECOVER_FORCE=1 "$HOME/.hermes/scripts/vault-server-recover.sh"
exit 0
