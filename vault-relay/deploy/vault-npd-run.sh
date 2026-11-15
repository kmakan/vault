#!/usr/bin/env bash
# Vault: запуск сверки чеков НПД с отметкой успеха.
# Зачем обёртка: по отметке «последний успех» решается, нужен ли догон
# (vault-npd-retry), и по ней же видно, что сверка ожила после серии отказов.
set -uo pipefail

STATE_DIR="$HOME/.local/state/vault-relay"
STAMP="$STATE_DIR/npd-last-ok"
FAIL_STAMP="$HOME/.hermes/state/npd-alert.last"
mkdir -p "$STATE_DIR"

"$HOME/.local/bin/vault-npd-receipts" "$@"
rc=$?

if [ "$rc" -eq 0 ]; then
  date +%s > "$STAMP"
  # До этого было оповещение об отказе — сообщаем, что сверка ожила, и снимаем
  # дедуп-отметку: следующий отказ снова должен дать сигнал, а не молчать 6 ч.
  if [ -f "$FAIL_STAMP" ]; then
    rm -f "$FAIL_STAMP"
    echo "$(date -Is) сверка восстановлена: чеки НПД снова оформляются" \
      >> "$HOME/.hermes/logs/npd-alert.log"
    notify-send -u normal "Vault: чеки НПД снова оформляются" "сверка с ФНС прошла" 2>/dev/null || true
  fi
fi
exit "$rc"
