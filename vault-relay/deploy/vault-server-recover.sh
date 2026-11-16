#!/usr/bin/env bash
# Подъём после аварии VPS 185.180.199.237 (King Servers, тикет #320239).
#
# Зачем: сервер лежит целиком (ядро принимает TCP, процессы не отвечают).
# Скрипт сторожит момент, когда он оживёт, и сразу делает то, что нельзя
# откладывать: проверяет сервисы и адреса, поднимает упавшее, снимает копию
# состояния релея К НАМ (офсайт-бэкапа до сих пор не было) и уведомляет.
#
# Идемпотентность: пока сайт не отдаёт 200 — молча выходит. После успешного
# прохода ставит штамп на текущую дату и больше не повторяется в этот день
# (дальше работает обычный vault-uptime.timer).
#
# Коды выхода: 0 — либо ещё лежит, либо всё сделано; 1 — ожил, но проверки
# с замечаниями; 2 — ожил, но SSH не пускает (нужен человек).

set -uo pipefail

SITE="${VAULT_RECOVER_SITE:-https://vault-msg.ru/pd.html}"
LOG="$HOME/.hermes/logs/vault-recover.log"
STAMP="$HOME/.hermes/state/vault-recovered"
BACKUP_ROOT="$HOME/backups/vault-relay"
mkdir -p "$(dirname "$LOG")" "$(dirname "$STAMP")" "$BACKUP_ROOT"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
# Часовая проба SSH поднимает этот скрипт, когда сайт ещё лежит: проверять
# доступность сайта тогда бессмысленно, а войти и снять копию — уже можно.
FORCE=0
[ "${VAULT_RECOVER_FORCE:-0}" = "1" ] && FORCE=1

log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }
notify() {
  [ "$DRY" = "1" ] && { printf '[dry-run] уведомление: %s — %s\n' "$1" "$2"; return 0; }
  notify-send -u "${3:-normal}" "$1" "$2" 2>/dev/null || true
}

if [ "$FORCE" != "1" ]; then
  code=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "$SITE" 2>/dev/null || echo 000)
  if [ "$code" != "200" ]; then
    exit 0                    # ещё лежит — это штатное состояние, не шумим
  fi
fi

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$(date +%F)" ]; then
  exit 0                      # уже отработали сегодня
fi

if [ "$FORCE" = "1" ]; then
  log "принудительный подъём по пробе SSH — проверяю вход"
else
  log "сайт ответил 200 — начинаю подъём"
fi

# --- удалённая часть -------------------------------------------------------
# Пароль sudo передаём первой строкой в stdin, а не аргументом: в ps его не видно.
SUDO_PASSWORD=$(grep -E '^SUDO_PASSWORD=' "$HOME/.hermes/.env" 2>/dev/null | head -1 | cut -d= -f2-)

report=$(
  {
    printf 'SUDO_PASSWORD=%q\n' "$SUDO_PASSWORD"
    cat <<'REMOTE'
set -uo pipefail
say() { printf '%s\n' "$*"; }
say "== время/аптайм"; uptime
say "== память"; free -h
say "== диск"; df -h / /home 2>/dev/null | sort -u
say "== inodes"; df -i / | tail -1

say "== сервисы"
for u in nginx vault-relay; do
  printf '%s: %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"
done

# Поднимаем то, что не поднялось само (после жёсткого ребута бывает).
for u in nginx vault-relay; do
  if [ "$(systemctl is-active "$u" 2>/dev/null)" != "active" ]; then
    say "== $u не активен — перезапускаю"
    printf '%s\n' "$SUDO_PASSWORD" | sudo -S systemctl restart "$u" 2>&1 | tail -3
    sleep 3
    say "$u после рестарта: $(systemctl is-active "$u" 2>/dev/null)"
  fi
done

say "== nginx -t"; printf '%s\n' "$SUDO_PASSWORD" | sudo -S nginx -t 2>&1 | tail -3
say "== health релея"; curl -s -m 5 http://127.0.0.1:8091/health || echo "health не ответил"
say "== порты"; ss -lntp 2>/dev/null | grep -E ':(80|443|8091)\b' || echo "портов нет"

say "== IPv4"
ip -4 -o addr show scope global | awk '{print $2, $4}'
say "== IPv6"
ip -6 -o addr show scope global | awk '{print $2, $4}'

say "== ошибки с загрузки"
journalctl -p err -b --no-pager 2>/dev/null | tail -20 || true

say "== состояние релея"
ls -la "$HOME/vault-relay"/vault-relay-state.json* 2>/dev/null | tail -5
ls -la "$HOME"/vault-relay/*.db "$HOME"/vault-relay/*.sqlite* 2>/dev/null | tail -5
# Отчёт — не проверка: его код возврата ничего не значит. При `set -o pipefail`
# последний ls по несуществующему glob'у даёт 2, и это выглядело как «SSH не
# пустил», хотя отчёт снят целиком (подъём 16.11 зацикливался на этом).
exit 0
REMOTE
  } | ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 server 'bash -s' 2>&1
)
ssh_rc=$?

printf '%s\n' "$report" >> "$LOG"

if [ "$ssh_rc" -ne 0 ]; then
  log "SSH не пустил (rc=$ssh_rc) — внутрь не попали"
  if [ "$FORCE" = "1" ]; then
    exit 2                    # часовую пробу это не удивляет: она сама логирует
  fi
  # не долбим уведомлением каждые 3 минуты: не чаще раза в полчаса
  last="$HOME/.hermes/state/vault-recover-ssh-warn"
  now=$(date +%s)
  if [ ! -f "$last" ] || [ $(( now - $(cat "$last" 2>/dev/null || echo 0) )) -gt 1800 ]; then
    echo "$now" > "$last"
    notify "Vault: сервер ожил, но SSH не пускает" "сайт отвечает 200, внутрь не зашли — нужен человек" critical
  fi
  exit 2
fi

# --- офсайт-копия ----------------------------------------------------------
if [ "$DRY" = "1" ]; then
  printf '%s\n' "$report"
  log "dry-run: проверки прошли, копия и штамп не трогались"
  exit 0
fi

dest="$BACKUP_ROOT/$(date +%F-%H%M)"
mkdir -p "$dest"
chmod 700 "$dest"
rsync -az --ignore-missing-args -e 'ssh -o BatchMode=yes -o ConnectTimeout=15' \
  server:'vault-relay/vault-relay-state.json*' \
  server:'vault-relay/*.db' \
  server:'vault-relay/*.sqlite*' \
  server:'vault-relay/env' \
  "$dest"/ 2>>"$LOG"
rsync_rc=$?
if [ "$rsync_rc" -eq 0 ] || [ "$rsync_rc" -eq 24 ]; then
  ( cd "$dest" && sha256sum * > SHA256SUMS 2>/dev/null || true )
  log "копия состояния снята: $dest ($(du -sh "$dest" 2>/dev/null | cut -f1))"
else
  log "rsync состояния вернул $rsync_rc — копия неполная"
fi

# --- вердикт ---------------------------------------------------------------
bad=$(printf '%s\n' "$report" | grep -cE '^(nginx|vault-relay): (inactive|failed)$' || true)
health=$(printf '%s\n' "$report" | grep -A1 '== health релея' | tail -1 | cut -c1-80)

echo "$(date +%F)" > "$STAMP"
# Сторож одноразовый: снимаем себя с расписания, иначе на следующий день
# повторил бы «сервер ожил» на живом сервере. Ставит его обратно сторож
# доступности, когда сайты уходят в DOWN.
systemctl --user disable --now vault-server-recover.timer 2>/dev/null || true
log "подъём завершён: проблемных сервисов $bad, health: $health, копия $dest"

if [ "$bad" -gt 0 ]; then
  notify "Vault: сервер ожил с замечаниями" "не поднялись сервисы ($bad). Отчёт: $LOG" critical
  exit 1
fi
notify "Vault: сервер ожил" "сайты и релей отвечают, копия состояния снята" normal
exit 0
