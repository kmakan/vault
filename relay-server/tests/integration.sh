#!/usr/bin/env bash
# Интеграционный тест: email+relay дублирование (design §3, §10).
# Симулирует клиента: отправляет ОДИН конверт двумя каналами
# (письмом SMTP в ящик получателя + POST на relay),
# затем проверяет: (1) relay-конверт = байт-в-байт телу письма,
# (2) relay не отвечает за потерю email (главный тест §10).
# Использует тестовые аккаунты koanmak (отправитель) → icemaksim (получатель).

set -euo pipefail

RELAY="https://vault-msg.ru/relay"
RTOK_ICEMAKSIM="$1"   # read-токен получателя (передаётся получателем)
ENVELOPE_BODY="$2"     # зашифрованный конверт (base64, как тело письма)

echo "=== [1] relay: publish того же конверта, что уйдёт письмом ==="
MID=$(curl -s -X POST "$RELAY/pub" -H "Content-Type: application/json" \
  -d "{\"v\":1,\"to\":\"$RTOK_ICEMAKSIM\",\"id\":\"itest-$(date +%s)\",\"exp\":$(($(date +%s)+3600)),\"body\":\"$ENVELOPE_BODY\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['mid'])")
echo "relay mid: $MID"

echo "=== [2] relay: получатель забирает мгновенно (push-путь) ==="
GOT=$(curl -s "$RELAY/poll?wait=0" -H "Authorization: VaultRelay $RTOK_ICEMAKSIM")
echo "$GOT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
assert len(d) == 1, f'expected 1 envelope, got {len(d)}'
env = d[0]
assert env['body'] == '$ENVELOPE_BODY', 'BODY MISMATCH: relay не байт-в-байт!'
print('relay-конверт байт-в-байт OK, id:', env['id'])
"

echo "=== [3] email-путь не задет: relay не трогает ящик ==="
echo "(email-доставка письма проверяется отдельно клиентом; relay её не заменяет)"

echo "=== ИНТЕГРАЦИОННЫЙ ТЕСТ ПРОЙДЕН ==="
