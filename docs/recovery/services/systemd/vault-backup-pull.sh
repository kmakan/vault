#!/usr/bin/env bash
# Ежедневная выгрузка состояния релея к нам на ноутбук.
#
# Зачем: 15.11.2026 сервер лёг, и выяснилось, что копий нет вообще — ни базы,
# ни env, ни конфигов nginx. Скрипт тянет их каждый день, пока машина жива.
#
# Молчит, пока сервер недоступен: это штатное состояние аварии, а не событие.
# Уведомляет только при смене состояния (первая удачная копия, потом сбой).

set -u
LOG="$HOME/.hermes/logs/vault-backup-pull.log"
STATE="$HOME/.hermes/state/vault-backup-last"
ROOT="$HOME/backups/vault-relay"
KEEP_DAYS=14
SSH="ssh -o BatchMode=yes -o ConnectTimeout=12"

log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }
notify() { notify-send -u "${3:-normal}" "$1" "$2" 2>/dev/null || true; }

if ! $SSH server 'echo ok' >/dev/null 2>&1; then
  log "SSH не пустил — копию не снимаем"
  exit 0
fi

stamp=$(date +%F-%H%M)
dest="$ROOT/$stamp"
mkdir -p "$dest" || exit 1

# --- что именно забираем ----------------------------------------------------
# state.json — аккаунты, подписки, незавершённые оплаты, коды;
# accounting.json — реестр доходов и чеков; env — секреты (0600);
# nginx — вхосты; accounting-digest.py — скрипт сводки (в репозитории его нет).
$SSH server 'cd ~/vault-relay 2>/dev/null && tar -czf - \
    vault-relay-state.json vault-relay-accounting.json \
    env accounting.env accounting-digest.py 2>/dev/null' \
  > "$dest/relay-data.tgz" 2>>"$LOG"
rc_data=$?

$SSH server 'sudo -n cat /etc/nginx/sites-enabled/* 2>/dev/null || cat /etc/nginx/sites-enabled/* 2>/dev/null' \
  > "$dest/nginx-sites.conf" 2>>"$LOG"

$SSH server 'crontab -l 2>/dev/null' > "$dest/crontab.txt" 2>>"$LOG"

if [ "$rc_data" -ne 0 ] || [ ! -s "$dest/relay-data.tgz" ]; then
  log "выгрузка данных не удалась (rc=$rc_data) — каталог $dest оставлен для разбора"
  rm -rf "$dest"
  # сообщаем только если раньше копии снимались: значит, что-то сломалось
  if [ -f "$STATE" ]; then
    notify "Vault: копия релея не снялась" "SSH пускает, но данные не выгрузились — смотреть $LOG" critical
  fi
  exit 1
fi

( cd "$dest" && sha256sum relay-data.tgz nginx-sites.conf crontab.txt > SHA256SUMS 2>/dev/null || true )
size=$(du -sh "$dest" 2>/dev/null | cut -f1)
log "копия снята: $dest ($size)"

if [ ! -f "$STATE" ]; then
  notify "Vault: первая копия релея снята" "state, accounting, env и nginx — в $dest"
fi
date -Is > "$STATE"

# --- ротация ----------------------------------------------------------------
find "$ROOT" -maxdepth 1 -type d -name '20*' -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null
