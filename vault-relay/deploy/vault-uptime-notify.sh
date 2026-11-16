#!/usr/bin/env bash
# Слежение за доступностью сайтов: сообщает о ПЕРЕХОДЕ состояния.
# Зачем: сервер может лежать часами, а узнавать об этом «когда зайдёшь» —
# поздно. Скрипт держит прошлое состояние и пишет в лог только изменения,
# чтобы не спамить каждые 5 минут.
# Телефон недоступен, пока лежит сервер (ntfy живёт на нём), поэтому основной
# канал — уведомление на рабочем столе; лог остаётся для истории.
set -u

# --dry-run: только лог, без уведомлений на рабочем столе (проверка логики).
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

STATE="$HOME/.hermes/state/uptime-last"
LOG="$HOME/.hermes/logs/uptime.log"
mkdir -p "$(dirname "$STATE")" "$(dirname "$LOG")"

out=$("$HOME/.hermes/scripts/uptime-monitor.sh" 2>/dev/null)
now=$(printf '%s\n' "$out" | grep -E '^[a-z][a-z0-9-]* (OK|DOWN)$' | sort | tr '\n' ';')
prev=$(cat "$STATE" 2>/dev/null || true)
printf '%s\n' "$now" > "$STATE"

[ -z "$prev" ] && exit 0
[ "$prev" = "$now" ] && exit 0

# Что изменилось: сравнение по имени сайта.
changed=""
up=0; down=0
# Разбираем пары «имя состояние» из текущего и прошлого снимков.
names=$(printf '%s\n' "${now};${prev}" | tr ';' '\n' | awk '{print $1}' | sort -u)
for n in $names; do
  cur=$(printf '%s\n' "$now" | tr ';' '\n' | awk -v n="$n" '$1==n{print $2}')
  old=$(printf '%s\n' "$prev" | tr ';' '\n' | awk -v n="$n" '$1==n{print $2}')
  [ "$cur" = "$old" ] && continue
  changed="$changed $n:$old→$cur"
  [ "$cur" = "OK" ] && up=$((up+1))
  [ "$cur" = "DOWN" ] && down=$((down+1))
done
[ -z "$changed" ] && exit 0

echo "$(date -Is) изменилось:$changed" >> "$LOG"

# Авария VPS: ставим на расписание сторож подъёма. Он одноразовый — после
# отработанного подъёма снимает себя сам, поэтому вхолостую не висит.
if [ "$DRY" = 0 ] && printf '%s\n' "$changed" | grep -qE ' (vault-ru|vault-en):OK→DOWN'; then
  systemctl --user enable --now vault-server-recover.timer 2>/dev/null || true
  echo "$(date -Is) сторож подъёма поставлен на расписание" >> "$LOG"
fi

if [ "$DRY" = 0 ]; then
  if [ "$down" -eq 0 ] && [ "$up" -gt 0 ]; then
    notify-send -u normal "Vault: сайты снова отвечают" "изменилось:$changed" 2>/dev/null || true
  elif [ "$up" -eq 0 ] && [ "$down" -gt 0 ]; then
    notify-send -u critical "Vault: сайты недоступны" "изменилось:$changed" 2>/dev/null || true
  else
    notify-send -u normal "Vault: состояние сайтов изменилось" "изменилось:$changed" 2>/dev/null || true
  fi
fi
exit 0
