# Сборка Vault для Android

**Единственный источник сборки — `vault-desktop`.** Телефонный APK собирается из
`vault-desktop/src` (фронт) и `vault-desktop/src-tauri` (мост + Kotlin-слой
`src-tauri/gen/android/**`). Каталог `vault-android/` был заброшенной копией и
удалён 21.10.2026; собирать из него запрещено. «Десктопных» правок не бывает:
тот же код едет на телефон, поэтому после любых изменений UI — приёмка на
устройстве (`docs/testing/device-acceptance.md`).

## Автоматизированная сборка (то, чем пользуются)

```bash
cd ~/whisper
vault-desktop/scripts/build-android-apk.sh          # APK  — RuStore, прямой download, приёмка
vault-desktop/scripts/build-android-apk.sh aab      # AAB  — Google Play принимает только бандлы
```

Скрипт делает всё, что нужно повторять руками: поднимает `JAVA_HOME`,
`ANDROID_HOME`, NDK-линкеры для `aarch64-linux-android` (CC/CXX/AR/RANLIB),
берёт ключ подписи из файлов вне репозитория
(`~/.local/share/vault/vault-release.keystore` + `keystore-pass.txt`), вызывает
`npx tauri android build --target aarch64 --features barcode-scanner`, печатает
путь артефакта, его размер, SHA256 и (для APK) `aapt dump badging`.

Артефакты:

| Режим | Путь | Куда подаётся |
|---|---|---|
| `apk` | `vault-desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` | RuStore, `vault-msg.ru/releases/`, device-приёмка |
| `aab` | `vault-desktop/src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab` | Google Play Console |

Долго: ~9 минут (первый прогон после правки Rust — дольше).

**Перед сборкой** поднять `version` в `vault-desktop/src-tauri/tauri.conf.json`
выше стоящей на телефоне: `versionCode = major*1e6 + minor*1e3 + patch`
(0.1.271 → 1271). Иначе `adb install -r` молча оставит старую версию, и приёмка
проверит старый код. `versionName`/`versionCode` в `build.gradle.kts` берутся из
генерируемого `tauri.properties`, руками их не писать.

**Ключ подписи не менять никогда.** Все релизы подписаны одним ключом; смена
keystore ломает апдейты у существующих установок. Секрета ключа в чате, в
репозитории и в анкетах сторов нет.

## Фактические параметры сборки

`vault-desktop/src-tauri/gen/android/app/build.gradle.kts`:
`compileSdk 36`, `targetSdk 36`, `minSdk 24`, `applicationId com.vault.vault`,
`abiFilters` только `arm64-v8a` (предсобранный Opus), release:
`isMinifyEnabled = true` + `proguard-rules.pro` (keep-правила JNI — без них R8
срезает методы и приложение падает с `NoSuchMethodError` на старте).
`targetSdk 36` уже удовлетворяет требованию Google Play (API 36 обязателен для новых
приложений и обновлений с 31.08.2026) — проверять живой curl'ом перед подачей.

Разрешения и их назначение — `AndroidManifest.xml` в том же дереве; геолокация
нужна `src/geo.js` (сообщение «я здесь» и координаты в SOS), это ответ на
вопрос модерации «зачем приложению доступ к местоположению».

## Ручной прогон (если скрипт недоступен)

```bash
cd ~/whisper/vault-desktop
source .                        # если нужен локальный env
npx tauri android build --apk --target aarch64 --features barcode-scanner
```

`--features barcode-scanner` включает сканер штрихкода (MLKit); без этого флага
сборка легче, но без сканера. F-Droid такой сборки не примет: MLKit и сервисы
Google — несвободные компоненты, нужна отдельная сборка без них.

## Приёмка собранного артефакта

```bash
VAULT_SER=<host:port> vault-desktop/scripts/device-accept-apk.sh
```

Подпись → `install -r` → крэш-маркеры в logcat → рестарты ×3 → CDP-пробы.
Публиковать (сайты, сторы, теги) только принятую версию и только по команде
владельца. Порядок релиза целиком — `docs/RELEASE-RUNBOOK.md`, статус
готовности к магазинам — `~/Notes/Projects/mailcipher/STORE-READINESS-2026-10-11.md`.
