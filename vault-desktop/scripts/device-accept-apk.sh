#!/usr/bin/env bash
# Приёмка release-APK на устройстве: подпись → install -r → запуск →
# крэш-маркеры → рестарты ×3.
#
# Порядок релиза целиком — docs/RELEASE-RUNBOOK.md.
#
# Устройство: адрес меняется (беспроводная отладка). Если IP:порт не
# подключается, телефон виден по mDNS-имени в `adb devices`
# (`adb-<серийный>._adb-tls-connect._tcp`) — он работает без порта.
#   adb devices | grep adb-tls
#
# Использование:
#   VAULT_SER="192.168.1.2:37053" ./scripts/device-accept-apk.sh
#   # или без переменной — возьмёт первый не-эмулятор из adb devices
set -u

cd "$(dirname "$0")/.."
export PATH="$HOME/Android/Sdk/platform-tools:$PATH"

SER="${VAULT_SER:-}"
if [ -z "$SER" ]; then
  SER=$(adb devices | awk 'NR>1 && $2=="device" && $1 !~ /emulator/ {print $1; exit}')
fi
if [ -z "$SER" ]; then
  echo "Устройство не найдено. Подключи телефон (USB или беспроводная отладка)"
  echo "или укажи VAULT_SER=host:port. Список:"; adb devices; exit 1
fi
echo "Устройство: $SER"

APK="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
BUILD_TOOLS="$HOME/Android/Sdk/build-tools/$(ls "$HOME/Android/Sdk/build-tools" | sort -V | tail -1)"
AAPT="$BUILD_TOOLS/aapt"
APKSIGNER="$BUILD_TOOLS/apksigner"
export VAULT_KEYSTORE="$HOME/.local/share/vault/vault-release.keystore"
export VAULT_KEYSTORE_PASS="$(tr -d '\n' < "$HOME/.local/share/vault/keystore-pass.txt")"

echo "=== 1. артефакт ==="
ls -la "$APK" || { echo "НЕТ APK — собери: scripts/build-android-apk.sh"; exit 1; }
"$AAPT" dump badging "$APK" | grep -E "^package:|versionCode|native-code" | head -5

echo "=== 2. подпись: APK vs keystore (md5) ==="
APK_MD5=$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null | grep -i "md5" | head -1)
KEY_MD5=$(keytool -exportcert -keystore "$VAULT_KEYSTORE" -alias vault -storepass "$VAULT_KEYSTORE_PASS" 2>/dev/null | openssl dgst -md5 | awk '{print $2}')
echo "APK:  $APK_MD5"
echo "KEY:  $KEY_MD5"
[ -n "$KEY_MD5" ] && [ "${APK_MD5##* }" = "$KEY_MD5" ] && echo "подпись совпадает" || echo "!! ПОДПИСЬ НЕ СОВПАДАЕТ"

echo "=== 3. install -r ==="
adb -s "$SER" install -r "$APK" 2>&1 | tail -3
adb -s "$SER" shell dumpsys package com.vault.vault | grep -E "versionName|versionCode|lastUpdateTime" | head -3

echo "=== 4. запуск + крэш-маркеры ==="
adb -s "$SER" logcat -c
adb -s "$SER" shell am start -n com.vault.vault/.MainActivity 2>&1 | head -2
sleep 30
adb -s "$SER" shell dumpsys activity activities 2>/dev/null | grep -m1 "mResumedActivity"
echo "--- крэш-маркеры:"
adb -s "$SER" logcat -d 2>/dev/null | grep -iE "FATAL EXCEPTION|ANR in com.vault|has died|UnsatisfiedLinkError" | head -10
echo "(пусто = крэшей нет)"

echo "=== 5. цикл рестартов ×3 ==="
for i in 1 2 3; do
  adb -s "$SER" shell am force-stop com.vault.vault
  sleep 2
  adb -s "$SER" logcat -c
  adb -s "$SER" shell am start -n com.vault.vault/.MainActivity >/dev/null 2>&1
  sleep 12
  # «на переднем плане» мерим по ЛЮБОЙ форме строки резюмированной активности:
  # на Android 15 это `topResumedActivity=` / `ResumedActivity:`, а не только
  # `mResumedActivity`. Старый греп давал foreground=0 на здоровом приложении —
  # ложный сигнал, из-за которого провальная приёмка выглядит «так и надо».
  RES=$(adb -s "$SER" shell dumpsys activity activities 2>/dev/null | grep -m1 "ResumedActivity" | grep -c "com.vault.vault")
  CRASH=$(adb -s "$SER" logcat -d 2>/dev/null | grep -icE "FATAL EXCEPTION|has died")
  echo "  restart $i: foreground=$RES crash-маркеров=$CRASH"
done

echo "=== 6. CDP-приёмка (19 проверок) ==="
# ВЫХОД ЭТОГО ШАГА = ВЫХОД ПРИЁМКИ. Раньше здесь стояло
#   node scripts/device-accept.mjs 2>&1 | tail -4
и код возврата node съедался пайпом: скрипт завершался с 0 даже когда
# пробы красные (23.10 на 0.1.259 приёмка «прошла» с необработанным
# исключением в странице). То же касательно «приложение не запущено»: CDP —
# обязательная часть приёмки, пропускать её молча нельзя.
PID=$(adb -s "$SER" shell pidof com.vault.vault | tr -d '\r')
CDP_LOG=/tmp/device-accept-cdp.$$.log
if [ -z "$PID" ]; then
  echo "✗ приложение не запущено — CDP-пробы не сняты, приёмка НЕ принята"
  exit 1
fi
adb -s "$SER" forward tcp:9224 "localabstract:webview_devtools_remote_$PID" >/dev/null
node scripts/device-accept.mjs > "$CDP_LOG" 2>&1
CDP_RC=$?
tail -12 "$CDP_LOG"
if [ "$CDP_RC" -ne 0 ]; then
  echo "✗ CDP-приёмка провалена (код $CDP_RC) — версию не публиковать"
  exit "$CDP_RC"
fi
echo "✓ CDP-приёмка принята"
