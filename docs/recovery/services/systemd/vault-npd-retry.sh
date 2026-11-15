#!/usr/bin/env bash
# Vault: быстрый догон сверки чеков НПД, когда туннель Amnezia опущен.
# Зачем: если сверка упала из-за поднятого VPN (ФНС/kill switch режут трафик),
# ждать ближайшего :17 не нужно — при опущенном туннеле догоняем в пределах
# 10 минут. Пока туннель поднят — молчим: там сверку делает часовой таймер,
# а повторять заведомо падающий запрос каждые 10 минут бессмысленно.
set -uo pipefail

# Туннель поднят (маршруты-перехват 0.0.0.0/1 и 128.0.0.0/1 через amn0) —
# не дёргаем ФНС зря.
if ip route show 2>/dev/null | grep -q 'dev amn0'; then
  exit 0
fi

STAMP="$HOME/.local/state/vault-relay/npd-last-ok"
last=$(cat "$STAMP" 2>/dev/null || echo 0)
now=$(date +%s)
# Свежий успех (меньше 30 минут назад) — догонять нечего.
if [ $((now - last)) -lt 1800 ]; then
  exit 0
fi

exec "$HOME/.local/bin/vault-npd-run"
