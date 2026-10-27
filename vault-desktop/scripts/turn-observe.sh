#!/usr/bin/env bash
# Наблюдение за UDP-трафиком с TURN-релеем без блокировок: чистые counter-правила.
#
# ЗАЧЕМ. «Звонок вне одной сети прошёл» само по себе не говорит, КАК оно
# прошло: srflx-пара (прямиком через CGNAT) и relay-пара (через TURN) для
# пользователя выглядят одинаково.
#
# МЕРИТЬ ЭТИМ — фон, а не медиа. Измерено 27.10 на 0.1.282: за 33-секундный
# звонок, избранная пара которого была прямой (`ice selected candidate pair
# 192.168.1.4:50521 <-> 91.78.11.152:6714`), сюда навалилось 244 пакета /
# 37 KB и обратно 69 — это проверки ICE (18 локальных × 10 удалённых пар плюс
# TURN Allocate/Refresh), а не медиа: принято за тот же звонок было ~320
# медиа-пакетов, из них с адреса релея только 69. Поэтому nonzero НИЧЕГО не
# доказывает, а вот положительный контроль (тест B, `call-force-relay.sh`) по
# этим же счётчикам читается: медиа через relay — это ровные ~50 пакетов/с в
# обе стороны, а не пачка на установлении. Окончательную меру даёт лог стека:
# RUST_LOG=info,rtc::peer_connection::handler::ice=debug печатает избранную
# пару адресами.
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
    # Повторный add поверх живой таблицы удваивает правила — а два counter-правила
    # на один поток считают вдвое. Чистим цепочки до вставки.
    sudo_run nft flush chain inet vault_turn_observe out
    sudo_run nft flush chain inet vault_turn_observe in
    sudo_run nft add rule inet vault_turn_observe out 'ip daddr '"$RELAY"' meta l4proto udp counter'
    sudo_run nft add rule inet vault_turn_observe in 'ip saddr '"$RELAY"' meta l4proto udp counter'
    echo "наблюдение за $RELAY включено (долгота ${TTL}с)"
    # Само-снятие: счётчики без срока — мусор в правилах фильтрации хоста.
    # Пароль — фоновому процессу строго по stdin: присваивание вида `env VAR=…`
    # видно в /proc/<pid>/cmdline чужим пользователям.
    printf '%s\n' "$PW" | setsid bash -c \
      'IFS= read -r pw; sleep "$1"; printf "%s\n" "$pw" | sudo -S -p "" nft delete table inet vault_turn_observe' _ "$TTL" \
      >/dev/null 2>&1 &
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
