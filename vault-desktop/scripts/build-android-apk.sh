#!/usr/bin/env bash
# Сборка release-APK для Android (arm64) из vault-desktop.
#
# ЕДИНСТВЕННЫЙ источник истины: APK собирается ТОЛЬКО из `vault-desktop/src`
# (заброшенная копия `vault-android/` удалена 21.10.2026 — 26 ГБ мусора и
# источник путаницы: две директории выглядели как две сборки Android).
#
# Процедура: ~/.hermes/skills/devops/vault-android-apk/SKILL.md
#   подпись → install -r → logcat → рестарты ×3 → CDP-пробы.
# Подробный порядок релиза целиком — docs/RELEASE-RUNBOOK.md.
#
# ВАЖНО ПЕРЕД СБОРКОЙ: поднять `version` в `src-tauri/tauri.conf.json` выше
# стоящей на телефоне (versionCode = major*1e6 + minor*1e3 + patch). Иначе
# `install -r` молча оставит старую версию — и приёмка проверит старый код.
#
# РЕЖИМ (первый аргумент): `apk` (по умолчанию) — RuStore, прямой download и
# device-приёмка; `aab` — Google Play, который принимает только бандлы.
# Один и тот же ключ подписи в обоих режимах: смена keystore ломает апдейты
# у существующих установок.
#
# ПОКУПКИ В СБОРКЕ (VAULT_NO_PURCHASES): Play не выплачивает разработчику с
# расчётным счётом в РФ и не позволяет покупать цифровые товары мимо своего
# биллинга, поэтому в бандл покупки не входят — скрипт включает флаг сборки
# VITE_NO_PURCHASES=1 сам (кнопки покупки и поля промо-ключа не будет).
# Для apk флаг по умолчанию выключен; включить — `VAULT_NO_PURCHASES=1
# scripts/build-android-apk.sh apk`. Какому каналу что подаётся — решать не
# скрипту: он ПЕЧАТАЕТ значение флага, чтобы артефакт нельзя было перепутать.
set -euo pipefail
MODE="${1:-apk}"

export JAVA_HOME=/usr/lib/jvm/default
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
export NDK_HOME="$ANDROID_NDK_HOME"
BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CC_aarch64_linux_android="$BIN/aarch64-linux-android34-clang"
export CXX_aarch64_linux_android="$BIN/aarch64-linux-android34-clang++"
export AR_aarch64_linux_android="$BIN/llvm-ar"
export RANLIB_aarch64_linux_android="$BIN/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$BIN/aarch64-linux-android34-clang"
export PATH="$BIN:$ANDROID_HOME/platform-tools:$PATH"
export VAULT_KEYSTORE="$HOME/.local/share/vault/vault-release.keystore"
export VAULT_KEYSTORE_PASS="$(tr -d '\n' < "$HOME/.local/share/vault/keystore-pass.txt")"

cd "$(dirname "$0")/.."
AAPT="$HOME/Android/Sdk/build-tools/$(ls "$HOME/Android/Sdk/build-tools" | sort -V | tail -1)/aapt"

# Флаг покупок: apk — как сказал оператор (по умолчанию покупки есть), aab —
# всегда без покупок. Экспортируется до сборки фронта: vite подшивает
# import.meta.env.VITE_NO_PURCHASES именно из окружения процесса.
if [ "$MODE" = aab ]; then
  export VAULT_NO_PURCHASES=1
fi
export VITE_NO_PURCHASES="$([ "${VAULT_NO_PURCHASES:-0}" = 1 ] && echo 1 || echo 0)"
echo "покупки в сборке: $([ "$VITE_NO_PURCHASES" = 1 ] && echo "НЕТ (play-канал)" || echo "есть") (режим $MODE, VITE_NO_PURCHASES=$VITE_NO_PURCHASES)"

case "$MODE" in
  apk)
    npx tauri android build --apk --target aarch64 --features barcode-scanner
    OUT="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
    ;;
  aab)
    npx tauri android build --aab --target aarch64 --features barcode-scanner
    OUT="src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab"
    ;;
  *)
    echo "использование: $(basename "$0") [apk|aab]" >&2
    exit 2
    ;;
esac

echo
echo "$MODE: $OUT"
ls -la "$OUT"
sha256sum "$OUT"
TREE_VER=$(node -e 'process.stdout.write(require("./src-tauri/tauri.conf.json").version)')
if [ "$MODE" = apk ]; then
  "$AAPT" dump badging "$OUT" | grep -E "^package:|native-code"
  ART_VER=$("$AAPT" dump badging "$OUT" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p" | head -1)
else
  # В бандле версия лежит в ассете tauri.conf.json — тем же файлом, что задаёт
  # и versionCode. Play Console сам не скажет, из какого дерева собран файл.
  ART_VER=$(unzip -p "$OUT" base/assets/tauri.conf.json | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "бандл проверяет Play Console при загрузке; локально — SHA256 выше и версия внутри"
fi
echo "версия: дерево=$TREE_VER, артефакт=$ART_VER"
if [ "$ART_VER" != "$TREE_VER" ]; then
  echo "✗ артефакт не из этого дерева ($MODE): собрать заново, в релиз его не класть" >&2
  exit 1
fi

# Провод JNI по DEX готового артефакта. Хостовые проверки (cargo check, компиляция
# Kotlin, гейты ассетов и мутации) его не видят: Rust зовёт статик-методы на
# наружном классе, а R8 в release вырезает мост @JvmStatic, если для метода нет
# keep-правила. 28.10 так и вышли на приёмку 0.1.284: playCallSound/stopCallSound
# дожили только на $Companion, гудок молчал с NoSuchMethodError. Мера дешёвая,
# зато ставится здесь — до телефона.
echo "=== JNI-провода по DEX ==="
node scripts/dex-jni-check.mjs "$OUT" || { echo "✗ часть JNI-вызовов из Rust не видна в артефакте как static — не принимать" >&2; exit 1; }
