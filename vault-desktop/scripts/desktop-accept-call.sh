#!/usr/bin/env bash
# Ответ на входящий звонок на ДЕСКТОПЕ без мыши: фокус окна + Enter.
#
# Зачем: десктоп — WebKitGTK, у него нет CDP (это Chrome-протокол), а
# управлять мышью в Wayland нечем. Клавиатура есть всегда: окно фокусируем
# через hyprctl, а кнопка «Принять» — дефолтная, её активирует Enter.
#
# Использование: ./scripts/desktop-accept-call.sh
set -uo pipefail

export DISPLAY="${DISPLAY:-:1}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"

echo "=== окна Vault:"
hyprctl clients 2>/dev/null | grep -iE "class: .*(vault|Vault)|title: .*Vault" | head -3 || true

# 1) Сфокусировать окно Vault.
# Hyprland 0.56 разбирает аргумент `hyprctl dispatch` как lua-выражение
# (оборачивает в `return hl.dispatch(<арг>)`), поэтому прежняя форма
# `dispatch focuswindow title:"Vault` больше не работала — и молча: ошибка
# уходила в /dev/null, Enter попадал в чужое окно, а приёмка выглядела так,
# будто десктоп «не отвечает на звонок». Окно ищем по pid процесса стенда.
PID=$(pgrep -f 'vault-desktop$' | head -1)
if [ -z "$PID" ]; then
  echo "процесс vault-desktop не найден — стенд не запущен"
  exit 1
fi
hyprctl eval "local w for i,x in ipairs(hl.get_windows{}) do if tonumber(x.pid)==$PID then w=x end end if not w then error('no window') end hl.dsp.focus({window=w})" 2>&1 | head -1
sleep 1

# Проверка, а не надежда: если фокус не взялся, Enter уйдёт не туда.
ACTIVE=$(hyprctl activewindow 2>/dev/null | sed -n 's/^\s*title:\s*//p' | head -1)
case "$ACTIVE" in
  *Vault*) echo "фокус на окне Vault («$ACTIVE»)" ;;
  *) echo "ФОКУС НЕ НА VAULT — на активном окне «$ACTIVE»: Enter уйдёт не туда."
     echo "Переключитесь на воркспейс стенда (или закройте активное окно) и повторите;"
     echo "либо примите звонок вручную кнопкой «Принять»."
     exit 1 ;;
esac

# 2) Нажать Enter (дефолтная кнопка модалки входящего звонка).
if command -v wtype >/dev/null 2>&1; then
  wtype -k Return
  echo "Enter отправлен (wtype)"
else
  echo "wtype не найден — нужен ручной Enter"
  exit 1
fi
sleep 1
