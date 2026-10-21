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
set -euo pipefail

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
npx tauri android build --apk --target aarch64 --features barcode-scanner

APK="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
echo
echo "APK: $APK"
ls -la "$APK"
"$HOME/Android/Sdk/build-tools/$(ls "$HOME/Android/Sdk/build-tools" | sort -V | tail -1)/aapt" \
  dump badging "$APK" | grep -E "^package:|native-code"
