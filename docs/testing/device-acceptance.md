# Приёмка на устройстве (Android, X50)

Смоуки проверяют **модули**, гейты — **статику**. Ни то, ни другое не видит
разрыв между модулем и компонентом. Живое устройство видит.

20.10.2026 — на X50 так нашлось: **«Новая папка» создавалась БЕЗ ИМЕНИ**.
Сборка была зелёная, 79 смоуков зелёные, все гейты зелёные. Модуль читал
имя у владельца форм (`uiStore`), а шаблон писал в поле данных компонента —
состояние фичи было **раздвоено** (см. ADR-004 J.7 + ADR-005 W2 п.14).

## Что собирается на телефон

APK собирается из `~/whisper/vault-desktop/src` — **тот же код**, что и
десктоп. Каталог `vault-android/` — заброшенная копия 0.1.148, в APK не
поставляется. Значит: правки десктопа затрагивают и телефон.

## Сборка и установка

```bash
# 1. версия выше стоящей на телефоне (иначе install -r молча оставит старую)
#    versionCode = major*1e6 + minor*1e3 + patch  (0.1.230 -> 1230)
grep -n '"version"' vault-desktop/src-tauri/tauri.conf.json

# 2. окружение и сборка (процедура: ~/.hermes/skills/devops/vault-android-apk/)
export JAVA_HOME=/usr/lib/jvm/default
export ANDROID_HOME=$HOME/Android/Sdk
export ANDROID_NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973
BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CC_aarch64_linux_android="$BIN/aarch64-linux-android34-clang"
export CXX_aarch64_linux_android="$BIN/aarch64-linux-android34-clang++"
export AR_aarch64_linux_android="$BIN/llvm-ar"
export RANLIB_aarch64_linux_android="$BIN/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$BIN/aarch64-linux-android34-clang"
export VAULT_KEYSTORE="$HOME/.local/share/vault/vault-release.keystore"
export VAULT_KEYSTORE_PASS="$(cat "$HOME/.local/share/vault/keystore-pass.txt")"
cd vault-desktop && npx tauri android build --apk --target aarch64 --features barcode-scanner

# 3. артефакт: ABI и подпись — ДО установки
APK=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
$ANDROID_HOME/build-tools/*/aapt dump badging "$APK" | grep -E "versionCode|native-code"
$ANDROID_HOME/build-tools/*/apksigner verify --print-certs "$APK" | grep -i md5

# 4. установка (данные сохраняются только при совпадении сертификата!)
adb -s "$SER" install -r "$APK"
adb -s "$SER" shell dumpsys package com.vault.vault | grep -E "versionCode|firstInstallTime"
```

Грабли: `install -r` с versionCode **ниже** стоящего — молчаливый тест старого
кода; x86_64-APK на ARM-телефоне ставится, но падает на `UnsatisfiedLinkError`.

## Живая приёмка UI

```bash
export PATH="$HOME/Android/Sdk/platform-tools:$PATH"
SER=$(adb devices | awk '/device$/{print $1; exit}')   # телефон по mDNS
adb -s "$SER" shell am start -n com.vault.vault/.MainActivity
PID=$(adb -s "$SER" shell pidof com.vault.vault | tr -d '\r')
adb -s "$SER" forward tcp:9224 localabstract:webview_devtools_remote_$PID

cd vault-desktop && node scripts/device-accept.mjs
```

`device-accept.mjs` (Node, без Python) проверяет на живой странице: вход,
владельцы на месте, модалка настроек открывается/закрывается, чат открывается,
ввод включает отправку, **полный путь «Новая папка»** (диалог → имя → папка
появилась в списке) и убирает за собой тестовую папку.

Приложение должно быть **на переднем плане**: WebView не обрабатывает
сообщения, пока не в фокусе (иначе CDP молчит — это не «инструмент сломался»).

## Вход на устройстве — не трогать (правило от 27.10, после потери недель)

Тест-устройство держит **живой аккаунт**, и вход на нём дороже любой пробы.
Яндекс отзывает app-пароли и отвечает `AUTHENTICATIONFAILED` на всплеск
повторов входа, а сборка, которая сейчас стоит на телефоне (до 0.1.283
включительно), при неудачном авто-входе стирает сохранённый пароль
(прежняя ветка `login failed` → `delete_credentials` в `src/api.js`). Начиная с
этой правки отказ входа не удаляет креды ни в какой ветке — вердикт даёт
ядро (`vault::login_failure`, ADR-005 партия 5j, задача #75). Запрет это не
снимает: на стоящей сборке опасна каждая попытка, а Яндексу всё равно, что
решает клиент. Поэтому запрет, он без исключений:

- не выходить из аккаунта: не нажимать «Выйти», не запускать panic/duress, не
  делать `pm clear`, не стирать cred-файл руками;
- не вводить пароль в форму входа, если авто-вход упал: на сборке 0.1.283 и
  прежних **одна** неудачная попытка уже стирает креды. Правильная реакция —
  остановиться и доложить владельцу, а не «попробую другой пароль»;
- не гонять приёмку волной повторов входа: каждый рестарт и каждый `install -r`
  — это новый IMAP-логин, а Яндекс на всплеск отвечает `AUTHENTICATIONFAILED`
  даже валидным паролем (27.10 так и потеряли вход: три рестарта плюс
  переустановка артефакта Play поверх того же аккаунта);
- перед шагом, который может стоить сессии (вторая сборка поверх боевого
  аккаунта, рестарт десктопа с живой сессией, pro-проба), — свериться, что вход
  не под угрозой, и идти по наименее разрушительному пути: эмулятор или второе
  устройство, а не боевой аккаунт.

Потеря доступа к аккаунту — инцидент, а не деталь приёмки: сразу в журнал и
владельцу.

## Чего приёмка НЕ заменяет

- Разрушительные сценарии («сбой посреди импорта не меняет диск») на живом
  телефоне с боевыми данными **не выполняются** — их покрывает fault-injection
  на том же коде.
- Приёмка проверяет **поведение**, а не «счастливый случай»: смоуки остаются
  основным инструментом на каждый коммит.
