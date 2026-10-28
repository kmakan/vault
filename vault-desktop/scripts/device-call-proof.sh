#!/usr/bin/env bash
# device-call-proof.sh — доказательство канала звука звонка (#71) БЕЗ
# переустановки и без второго входа: приложение уже запущено и залогинено.
#
# Зачем отдельный шаг. Доказательство «гудок идёт в канал рингтона, а не в MEDIA»
# снимает только динамик телефона, а в device-accept-apk.sh оно вшито в конец
# общего цикла (установка → запуск → рестарты). На боевом аккаунте X50 каждый
# запуск = новый вход IMAP, а Яндекс отвечает AUTHENTICATIONFAILED на всплеск
# повторов (правило #8 в AGENTS.md). Значит кольцевую пробу надо уметь снимать
# отдельно, не трогая приложение.
#
# Использование:
#   VAULT_SER="<host:port>" scripts/device-call-proof.sh      # ждёт звонок
#   VAULT_CALL_WAIT=120 ...                                   # сколько секунд ждать
#   VAULT_CALL_LOG=/tmp/ring.log ...                          # проверить уже снятый
#                                                             # захват, не звоня
set -u

cd "$(dirname "$0")/.."
export PATH="$HOME/Android/Sdk/platform-tools:$PATH"

SER="${VAULT_SER:-}"
if [ -z "$SER" ]; then
  SER=$(adb devices | awk 'NR>1 && $2=="device" && $1 !~ /emulator/ {print $1; exit}')
fi

WAIT="${VAULT_CALL_WAIT:-90}"
LOG="${VAULT_CALL_LOG:-}"

# ── уровни громкости: без них «не слышно» неотличимо от «не играет» ──────────
if [ -z "$LOG" ]; then
  if [ -z "$SER" ]; then
    echo "Устройство не найдено. Подключи телефон или укажи VAULT_SER=host:port"; adb devices; exit 1
  fi
  echo "Устройство: $SER"
  adb -s "$SER" shell dumpsys audio > /tmp/volumes.$$.txt 2>/dev/null
  python3 - <<'PY' "$$/tmp/volumes.$$.txt"
import sys
path = sys.argv[1]
cur, vol = None, {}
for line in open(path, errors='replace'):
    t = line.strip()
    if t.startswith('- STREAM_'):
        cur = t[2:]
    elif cur and 'streamVolume' in t:
        vol[cur] = int(t.split(':')[1].strip())
        cur = None
ring, music = vol.get('STREAM_RING'), vol.get('STREAM_MUSIC')
print(f'громкость: RING={ring} MUSIC={music}')
if ring in (None, 0):
    print('✗ рингер не озвучен — доказательство снять нельзя, подними громкость звонка')
    sys.exit(1)
if (music or 0) > 0:
    print('~ MEDIA > 0: если гудок слышно, это ещё НЕ отличие рингтона от MEDIA.')
    print('  Для чистой пробы убавь медиа в 0 аппаратными клавишами.')
PY
  RC=$?
  rm -f /tmp/volumes.$$.txt
  [ $RC -eq 0 ] || exit $RC

  # ── захват: буфер чистим, иначе в счёт попадут строки прошлых probing ───────
  adb -s "$SER" logcat -c 2>/dev/null
  LOG="/tmp/ring-proof.$(date +%s).log"
  echo "=== захват лога: $LOG"
  echo "=== 7. канал звука: позвони сейчас (набор, принятие или входящий)"
  echo "    жду ${WAIT}с"
  ( adb -s "$SER" logcat -v time 2>/dev/null \
      | grep --line-buffered -E 'call sound:|play_call_sound|playCallSound|NoSuchMethod|Java exception' \
      > "$LOG" 2>&1 ) &
  CAP=$!
  sleep "$WAIT"
  kill "$CAP" 2>/dev/null
  pkill -f "adb -s $SER logcat" 2>/dev/null
fi

# ── вердикт по захвату ───────────────────────────────────────────────────────
python3 - "$LOG" <<'PY'
import re, sys
path = sys.argv[1]
try:
    src = open(path, errors='replace').read()
except OSError as e:
    print(f'✗ захват не читается: {e}')
    sys.exit(1)
sounds = re.findall(r'call sound: [^\n]*', src)
ring = [s for s in sounds if 'ringtoneChannel=true' in s]
failed = re.findall(r'(play_call_sound failed[^\n]*|NoSuchMethod[^\n]*|Java exception was thrown[^\n]*)', src)
print('--- что наиграл мост:')
for s in sounds[:12]:
    print('   ', s[:120])
if failed:
    # Порядок важен: при отказе провода строк «call sound» нет вовсе, и если
    # первым проверять пустоту, диагноз съедет на «не позвонили» — а это ровно
    # та маскировка, из-за которой 28.10 искали причину руками.
    print('✗ провод JNI даёт исключение (так гудок молчал на 0.1.284):')
    for f in failed[:4]:
        print('   ', f[:150])
    sys.exit(1)
if not sounds:
    print('✗ ни одной строки «call sound:» — звонка не было или до моста не дошло')
    sys.exit(1)
if not ring:
    print('✗ звук был, но ни разу не в канале рингтона (ringtoneChannel=true)')
    sys.exit(1)
print(f'✓ канал рингтона подтверждён на устройстве: строк {len(ring)} из {len(sounds)}')
print('  файл захвата:', path)
PY
