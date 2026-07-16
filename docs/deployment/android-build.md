# Сборка Vault для Android

## Предварительные требования

### 1. Java JDK 17
```bash
# Arch Linux
sudo pacman -S jdk17-openjdk

# Ubuntu/Debian
sudo apt install openjdk-17-jdk
```

### 2. Android SDK
```bash
# Скачать command-line tools
mkdir -p ~/Android/Sdk/cmdline-tools
cd ~/Android/Sdk/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip commandlinetools-linux-11076708_latest.zip
mv cmdline-tools latest

# Добавить в PATH
export ANDROID_HOME=~/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin
export PATH=$PATH:$ANDROID_HOME/platform-tools

# Установить компоненты
sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"
```

### 3. Tauri Android Plugin
```bash
cd ~/vault/mailcipher-desktop
npm install @tauri-apps/cli
npx tauri android init
```

## Сборка

### Debug APK
```bash
cd ~/vault/mailcipher-desktop
npx tauri android build
```

### Release APK (подписанный)
```bash
# Создать keystore (один раз)
keytool -genkey -v -keystore ~/vault-release.keystore \
  -alias vault -keyalg RSA -keysize 2048 -validity 10000

# Собрать release
npx tauri android build --release
```

APK будет в: `src-tauri/target/release/bundle/apk/`

## Установка на устройство

```bash
adb install src-tauri/target/release/bundle/apk/Vault.apk
```

## Текущий статус

- ✅ Desktop (Linux): Собран `Vault_0.1.0_amd64.deb` (3.9 MB)
- ⏳ Android: Требуется установка Java + Android SDK

## Структура проекта

```
mailcipher-desktop/
├── src/                  # Vue frontend
├── src-tauri/           # Tauri backend (Rust)
│   ├── icons/           # Иконки приложения
│   └── tauri.conf.json  # Конфигурация
├── dist/                # Собранный frontend
└── package.json
```
