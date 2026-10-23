#!/usr/bin/env sh
# Android toolchain env для Vault — **source**, а не запускать:
#
#   . scripts/android-env.sh
#   cd vault-android/src-tauri && cargo check --target aarch64-linux-android
#   cd vault-android && npx tauri android build
#
# Зачем: `cc-rs` ищет в PATH префиксованный компилятор
# (`aarch64-linux-android-clang`), а NDK 27 его не предоставляет — в
# `toolchains/llvm/prebuilt/<host>/bin` лежат только версионированные
# `aarch64-linux-android24-clang` (+ `llvm-ar`/`llvm-ranlib` без префикса).
# Поэтому C-зависимости (`libsqlite3-sys` bundled, `openssl-src`, `ring`,
# `oboe-sys`) падали с:
#   error occurred in cc-rs: failed to find tool "aarch64-linux-android-clang"
#   ring: sizeof(size_t)!=sizeof(uintptr_t)   (пустой __ANDROID_API__)
#
# Раньше это лечилось exec-обёртками в /tmp/ndk-bin (и симлинками llvm-ar),
# но /tmp не переживает перезагрузку сессии — сборка отваливалась снова
# (docs/testing/recovery-resilience.md, «ENV-дрейф линкера»).
# Здесь то же самое делается БЕЗ внешних обёрток: cc-rs уважает
# `CC_<target>` / `CXX_<target>` / `AR_<target>` / `RANLIB_<target>`,
# а `ring`/`oboe` читают их же через cc. Ничего вне NDK не создаётся.
#
# Переопределяемо: ANDROID_HOME, ANDROID_NDK_HOME, VAULT_ANDROID_API.

_vault_android_home="${ANDROID_HOME:-$HOME/Android/Sdk}"

if [ -n "${ANDROID_NDK_HOME:-}" ]; then
    _vault_ndk_home="$ANDROID_NDK_HOME"
else
    # command ls: в интерактивном zsh `ls` — алиас (eza/lsd), и его вывод
    # с колонками прав ломает путь (известный ENV-дрейф, см. шапку).
    _vault_ndk_home="$(command ls -d "$_vault_android_home"/ndk/* 2>/dev/null | sort -V | tail -n 1)"
fi

_vault_ndk_bin="$_vault_ndk_home/toolchains/llvm/prebuilt/linux-x86_64/bin"
_vault_api="${VAULT_ANDROID_API:-24}"

# NDK не найден → не оставляем за собой полусобранное окружение.
if [ ! -x "$_vault_ndk_bin/aarch64-linux-android${_vault_api}-clang" ]; then
    printf 'android-env: NDK toolchain не найден: %s\n' "$_vault_ndk_bin" >&2
    printf 'android-env: задайте ANDROID_NDK_HOME=~/Android/Sdk/ndk/<версия>\n' >&2
    if [ -n "${ZSH_VERSION:-}${BASH_VERSION:-}" ]; then
        return 1
    fi
    exit 1
fi

export ANDROID_HOME="$_vault_android_home"
export ANDROID_NDK_HOME="$_vault_ndk_home"
# platform-tools: adb/logcat для проверок на устройстве.
case ":$PATH:" in
    *":$_vault_android_home/platform-tools:"*) ;;
    *) PATH="$_vault_android_home/platform-tools:$PATH" ;;
esac
export PATH

# target rustc (: rust clang-префикс NDK). Имена NDK не совпадают с rust target:
# у armv7 префикс `armv7a-`, у остальных совпадает.
for _vault_pair in \
    "aarch64-linux-android:aarch64-linux-android" \
    "armv7-linux-androideabi:armv7a-linux-androideabi" \
    "i686-linux-android:i686-linux-android" \
    "x86_64-linux-android:x86_64-linux-android"
do
    _vault_target="${_vault_pair%%:*}"
    _vault_prefix="${_vault_pair#*:}"
    _vault_var="$(printf '%s' "$_vault_target" | tr '-' '_')"
    eval "CC_$_vault_var='$_vault_ndk_bin/${_vault_prefix}${_vault_api}-clang'"
    eval "CXX_$_vault_var='$_vault_ndk_bin/${_vault_prefix}${_vault_api}-clang++'"
    eval "AR_$_vault_var='$_vault_ndk_bin/llvm-ar'"
    eval "RANLIB_$_vault_var='$_vault_ndk_bin/llvm-ranlib'"
    export "CC_$_vault_var" "CXX_$_vault_var" "AR_$_vault_var" "RANLIB_$_vault_var"
done

# Подпись: android-signing.md — VAULT_KEYSTORE(_PASS) нужны для ЛЮБОЙ сборки
# APK (`npx tauri android build`), а не только release. Пароль здесь НЕ
# читаем: секреты не должны попадать в env окружения без явного решения.
if [ -z "${VAULT_KEYSTORE:-}" ]; then
    printf 'android-env: OK (%s, API %s). Для сборки APK задайте VAULT_KEYSTORE + VAULT_KEYSTORE_PASS (scripts/android-signing.md)\n' \
        "$(basename "$_vault_ndk_home")" "$_vault_api" >&2
fi

unset _vault_android_home _vault_ndk_home _vault_ndk_bin _vault_api \
    _vault_pair _vault_target _vault_prefix _vault_var
