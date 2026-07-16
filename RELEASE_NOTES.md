# Vault v0.1.0 — Release Notes

**Дата**: 20 августа 2026  
**Платформы**: Linux (DEB, RPM), Android (APK), CLI

## Что такое Vault

Vault — зашифрованный мессенджер, работающий через email. Без сервера. Ваши ключи — у вас.

## Ключевые возможности

### Шифрование
- **XChaCha20-Poly1305** — симметричное шифрование сообщений
- **Ed25519** — подписи и верификация
- **X3DH** — обмен ключами без предварительного контакта
- **Kyber (ML-KEM-1024)** — постквантовое шифрование
- **Double Ratchet** — сквозное шифрование с Forward Secrecy

### Мессенджер
- Групповые чаты (до 50 участников)
- Эмодзи-пикер (150+ эмодзи, включая кастомные)
- Реакции на сообщения
- Поиск по сообщениям
- Аудиосообщения
- Экспорт чатов (JSON/TXT)
- Аватары из хэша email
- Управление группами (promote/demote/block)

### Клиенты
- **CLI** — терминальный интерфейс с 15 командами
- **Desktop** — Tauri 2.0 (Vue.js), DEB/RPM
- **Android** — Tauri 2.0, APK

### Desktop UI
- 6 тем: Dark, Light, Dracula, Kanagawa, Nord, Solarized
- 7 шрифтов (включая Pro: Manrope, Plus Jakarta, Space Grotesk)
- Мультиязычность: EN, RU, CN
- Профессиональный интерфейс

## Установка

### Linux (DEB)
```bash
sudo dpkg -i vault_0.1.0_amd64.deb
```

### Linux (RPM)
```bash
sudo rpm -i vault_0.1.0_amd64.rpm
```

### CLI
```bash
cargo install --path mailcipher-client
```

### Android
Скачать APK и установить на устройство.

## Обмен ключами

- Копирование в буфер обмена
- Через Signal (с предупреждением о VPN)
- PGP через email
- SimpleX / Briar
- QR-код (планируется)

## Документация

- [INSTALL.md](INSTALL.md) — инструкции по установке
- [CONTRIBUTING.md](CONTRIBUTING.md) — гайд для контрибьюторов
- [docs/](docs/) — архитектура, API, деплой

## Статус

- 228/228 тестов ✅
- Desktop build ✅
- Android build ✅ (неподписан)
- Нет сервера — вся логика на клиенте
