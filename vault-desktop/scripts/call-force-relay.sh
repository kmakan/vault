#!/usr/bin/env bash
# Тест B: оставить пирам единственный путь — через TURN-релей.
#
# ЗАЧЕМ. Избранная ICE-пара видна в логе (`ice selected candidate pair …`), и
# на двух звонках подряд она была прямой: десктоп ↔ публичный адрес оператора
# телефона. Прямой путь — это успех соединения, но он НЕ доказывает, что резерв
# работает: если у провайдера NAT «endpoint-independent», медиа никогда не идёт
# через relay, и остатёк TURN-пути не проверен вообще. Чтобы проверить его,
# надо сделать прямой путь невозможным. Здесь блокируется ровно один адрес —
# публичный адрес пира, и ровно UDP; релей не блокируется, signaling (TCP) не
# трогается, правила counter-ные, счётчик показан в peek.
#
# Пароль sudo только по stdin (в argv не попадает), правила сами снимаются по
# долготе. Адрес пира берётся из строки избранной пары предыдущего звонка и
# проверяется на IPv4-литерал и на «это не релей».
#
#   printf '%s\0' "$PW" | ./call-force-relay.sh add <ip пира> [долгота_сек]
#   ./call-force-relay.sh peek
#   printf '%s\0' "$PW" | ./call-force-relay.sh del
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"

RELAY="${VAULT_RELAY_IP:-185.180.199.237}"
TABLE="inet vault_direct_block"

IFS= read -r -d '' PW || true
sudo_run() { printf '%s\n' "$PW" | sudo -S -p '' "$@"; }

case "${1:-peek}" in
  add)
    PEER="${2:?укажи публичный адрес пира из строки «selected candidate pair»}"
    TTL="${3:-900}"
    # Долгота проверяется до подстановки в командную строку фонового процесса:
    # само снятие — отдельным процессом, потому что вызывающая оболочка умирает
    # вместе с tool-вызовом и её sleep не дожил бы до срока.
    case "$TTL" in *[!0-9]*) echo "долгота должна быть числом секунд: $TTL" >&2; exit 2 ;; esac
    if ! printf '%s' "$PEER" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
      echo "адрес не похож на IPv4: $PEER" >&2; exit 2
    fi
    [ "$PEER" = "$RELAY" ] && { echo "нельзя блокировать сам релей" >&2; exit 2; }
    sudo_run nft add table "$TABLE"
    sudo_run nft add chain inet vault_direct_block "out { type filter hook output priority -150; policy accept; }"
    sudo_run nft add chain inet vault_direct_block "in { type filter hook input priority -150; policy accept; }"
    # add поверх живой таблицы удваивает правила, а задвоенный counter
    # вранья ради не нужен: чистим цепочки до вставки.
    sudo_run nft flush chain inet vault_direct_block out
    sudo_run nft flush chain inet vault_direct_block in
    sudo_run nft add rule inet vault_direct_block out "ip daddr $PEER meta l4proto udp counter drop"
    sudo_run nft add rule inet vault_direct_block in "ip saddr $PEER meta l4proto udp counter drop"
    echo "прямой UDP с $PEER заблокирован (долгота ${TTL}с); медиа может идти только через $RELAY"
    # Само снятие — отдельным процессом (вызывающая оболочка умирает вместе с
    # tool-вызовом). Пароль уходит фоновому процессу по stdin: в argv его быть
    # не может, потому что командную строку чужого процесса читает любой
    # пользователь через /proc.
    printf '%s\n' "$PW" | setsid bash -c 'IFS= read -r pw; sleep "$1"; printf "%s\n" "$pw" | sudo -S -p "" nft delete table inet vault_direct_block' _ "$TTL" >/dev/null 2>&1 &
    ;;
  peek)
    sudo_run nft list table inet vault_direct_block 2>/dev/null | command grep -E 'counter' || echo "правил нет"
    ;;
  del)
    sudo_run nft delete table inet vault_direct_block 2>/dev/null && echo "блокировка снята"
    ;;
  *)
    echo "использование: add <ip> [долгота] | peek | del" >&2; exit 2
    ;;
esac
