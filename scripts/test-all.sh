#!/usr/bin/env bash
# test-all.sh — полный прогон тестов Vault по всем крейтам.
#
# В репозитории НЕТ workspace: каждый крейт автономен (свой Cargo.lock и
# target/), поэтому `cargo test --workspace` здесь невозможен. Этот скрипт
# заменяет его: последовательно прогоняет все наборы тестов и печатает сводку.
#
# Usage:
#   ./scripts/test-all.sh              # все крейты
#   ./scripts/test-all.sh core client  # только выбранные
#
# Переменные:
#   VAULT_TEST_CARGO_ARGS="--offline -j2"   # доп. аргументы каждому cargo
#
# Наборы:
#   core    vault-core                     cargo test            (lib, 26)
#   client  vault-client                   cargo test            (lib+bin+tests/*)
#   desktop vault-desktop/src-tauri        cargo test --lib      (151)
#   android vault-android/src-tauri        cargo test --lib      (20)
#
# Не покрыто (нужны живой аккаунт/устройство, см. docs/testing/):
#   vault-client/tests/*_e2e.rs — помечены #[ignore]; запуск:
#     cargo test --test email_e2e -- --ignored
#   Android target (NDK): . scripts/android-env.sh && cargo check --target aarch64-linux-android
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vault-test-all.XXXXXX")"

WANT=("$@")
if [ ${#WANT[@]} -eq 0 ]; then
    WANT=(core client desktop android)
fi

fail=0
declare -a SUMMARY

run_suite() {
    local name="$1" dir="$2"
    shift 2
    local skip=1 w
    for w in "${WANT[@]}"; do
        [ "$w" = "$name" ] && skip=0
    done
    [ "$skip" = 1 ] && return 0

    local log="$LOG_DIR/$name.log"
    printf '\n\033[1m=== %s (%s)\033[0m\n' "$name" "$dir"
    # shellcheck disable=SC2086
    if ( cd "$ROOT/$dir" && cargo "$@" ${VAULT_TEST_CARGO_ARGS:-} ) >"$log" 2>&1; then
        local counts
        counts="$(grep -E '^test result:' "$log" | sed 's/^test result: //' | paste -sd' | ' -)"
        SUMMARY+=("ok    $name: $counts")
        printf '  ✅ %s\n' "$counts"
        grep -E '^warning: unused|^error' "$log" | head -5
    else
        fail=1
        SUMMARY+=("FAIL  $name: см. $log")
        printf '  ❌ упал — log: %s\n' "$log"
        grep -nE '^error(\[|:)|panicked at|^test .* FAILED|^failures:' "$log" | head -20
    fi
}

run_suite core    vault-core              test
run_suite client  vault-client            test
run_suite desktop vault-desktop/src-tauri test --lib
run_suite android vault-android/src-tauri test --lib

printf '\n\033[1m=== Итог\033[0m\n'
for line in "${SUMMARY[@]}"; do
    printf '  %s\n' "$line"
done
[ "$fail" = 0 ] && printf '  ✅ всё зелёное (логи: %s)\n' "$LOG_DIR" \
                || printf '  ❌ есть красное (логи: %s)\n' "$LOG_DIR"
exit "$fail"
