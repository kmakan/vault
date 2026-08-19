# Подписочный сниппет для vault-android (см. скилл tauri-android-build).

> ⚠️ `pnpm tauri android init` ПЕРЕЗАПИСЫВАЕТ `gen/android/app/build.gradle.kts`
> (gen/ в .gitignore — сниппет не коммитится автоматически). После
> re-init восстановить блок из этого файла в build.gradle.kts.

В `android { }` блок (после открывающей скобки):

```kotlin
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("VAULT_KEYSTORE") ?: "")
            storePassword = System.getenv("VAULT_KEYSTORE_PASS") ?: ""
            keyAlias = "vault"
            keyPassword = System.getenv("VAULT_KEYSTORE_PASS") ?: ""
        }
    }
```

В `buildTypes { getByName("release") { ... } }` добавить строку:

```kotlin
            signingConfig = signingConfigs.getByName("release")
```

> ⚠️ **НЕ запускать `npx tauri icon` в vault-android!** Он перезапишет
> `gen/android/app/src/main/res/mipmap-*/ic_launcher*.png` — а это
> УТВЕРЖДЁННАЯ пользователем лаунчер-иконка Android: историческая
> голубо-жёлтая (два полукруга с точками, 19.08: «она мне понравилась, она
> и будет теперь иконкой приложения»). Фиолетовый контурный V — только в
> окне приложения (src-tauri/icons), НЕ на рабочем столе. Если mipmap
> случайно перезаписаны — восстановить: `git checkout --
> src-tauri/gen/android/app/src/main/res/mipmap-*/ic_launcher*.png`
> (gen/android в git).

Сборка подписанного релиза:

> ⚠️ `signingConfigs.create("release")` в build.gradle.kts выполняется при
> конфигурации проекта ВСЕГДА (не только для release buildType) — без
> `VAULT_KEYSTORE` падает ЛЮБАЯ сборка, включая debug:
> `Cannot convert '' to File` (app/build.gradle.kts:19). Env обязателен
> перед каждым `tauri android build`, не только release.

```bash
export ANDROID_HOME=~/Android/Sdk
export ANDROID_NDK_HOME=~/Android/Sdk/ndk/27.0.12077973
# NDK 27 без префиксованных ar/ranlib — симлинки для vendored openssl (см. references/android-port-plan.md)
export PATH=/tmp/ndk-bin:$PATH:$ANDROID_HOME/platform-tools
export VAULT_KEYSTORE=~/.local/share/vault/vault-release.keystore
export VAULT_KEYSTORE_PASS=$(cat ~/.local/share/vault/keystore-pass.txt)
npx tauri android build
# → src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

Keystore: `~/.local/share/vault/vault-release.keystore` + `keystore-pass.txt`
(600, НЕ в git). Потеря keystore = невозможность обновлений (same-signature).