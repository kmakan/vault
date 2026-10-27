#!/usr/bin/env bash
# Наблюдение за UDP-трафиком с TURN-релеем без блокировок: чистые counter-правила.
#
# ЗАЧЕМ. «Звонок вне одной сети прошёл» само по себе не говорит, КАК оно
# прошло: srflx-пара (прямиком через CGNAT) и relay-пара (через TURN) для
# пользователя выглядят одинаково. Приёмка TURN требует измеримого свидетеля,
# и счётчик пакетов на адресе релея — самый прямой: если за разговор через
# relay bytes>0, медиа шла через TURN; если 0 — через прямой путь.
#
# Использование (пароль sudo передаётся по stdin, в argv не попадает):
#   printf '%s\0' "$PW" | ./turn-observe.sh add [долгота_сек]
#   ./turn-observe.sh peek      # показать счётчики (во время и после звонка)
#   printf '%s\0' "$PW" | ./turn-observe.sh del
#   printf '%s\0' "$PW" | ./turn-observe.sh status
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"

RELAY="${VAULT_RELAY_IP:-185.180.199.237}"
TABLE="inet vault_turn_observe"

IFS= read -r -d '' PW || true
sudo_run() { printf '%s\n' "$PW" | sudo -S -p '' "$@"; }

case "${1:-status}" in
  add)
    TTL="${2:-600}"
    sudo_run nft add table "$TABLE"
    sudo_run nft add chain inet vault_turn_observe 'out { type filter hook output priority 0; policy accept; }'
    sudo_run nft add chain inet vault_turn_observe 'in { type filter hook input priority 0; policy accept; }'
    sudo_run nft add rule inet vault_turn_observe out 'ip daddr '"$RELAY"' meta l4proto udp counter'
    sudo_run nft add rule inet vault_turn_observe in 'ip saddr '"$RELAY"' meta l4proto udp counter'
    echo "наблюдение за $RELAY включено (долгота ${TTL}с)"
    # Само-снятие: счётчики без срока — мусор в правилах фильтрации хоста.
    setsid env SUDO_PW="$PW" TTL="$TTL" bash -c \
      'sleep "$TTL"; printf "%s\n" "$SUDO_PW" | sudo -S -p "" nft delete table inet vault_turn_observe' \
      >/dev/null 2>&1 < /dev/null &
    ;;
  peek)
    sudo_run nft list table inet vault_turn_observe 2>/dev/null | command grep -a counter
    ;;
  del)
    sudo_run nft delete table "$TABLE" 2>/dev/null && echo "наблюдение снято" \
      || echo "таблицы нет — уже снято"
    ;;
  status)
    if command nft list table "$TABLE" >/dev/null 2>&1; then
      echo "включено"; command nft list table "$TABLE" | command grep -a counter
    else
      echo "выключено"
    fi
    ;;
  *)
    echo "неизвестная команда: $1"; exit 1
    ;;
esac
