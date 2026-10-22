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

# 1) Поднять окно на текущий воркспейс и сфокусировать его.
hyprctl dispatch focuswindow title:"Vault" 2>/dev/null || \
  hyprctl dispatch focuswindow class:"vault-desktop" 2>/dev/null || true
sleep 1

# 2) Нажать Enter (дефолтная кнопка модалки входящего звонка).
if command -v wtype >/dev/null 2>&1; then
  wtype -k Return
  echo "Enter отправлен (wtype)"
else
  echo "wtype не найден — нужен ручной Enter"
  exit 1
fi
sleep 1
