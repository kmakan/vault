# 📋 Vault/Vault — Заметки проекта

## Название
- **Рабочее**: MailCipher (внутреннее)
- **Продвижение**: **Vault** (основное)
- **Запасное**: Vault

## Стек технологий
- **Backend**: Rust (Axum) + SQLx + PostgreSQL
- **Desktop**: Tauri 2.0 (Rust + Svelte)
- **Terminal**: Rust (ratatui)
- **Android**: Kotlin + Jetpack Compose
- **БД**: PostgreSQL (прод) / SQLite (dev)

## Криптография ✅
- **X3DH** (Signal Protocol) — обмен ключами ✅
- **Double Ratchet** — обновление ключей ✅
- **PAKE** — аутентификация по паролю ✅
- **XChaCha20-Poly1305** — симметричное шифрование ✅
- **Ed25519** — цифровые подписи ✅
- **Kyber-1024** — пост-квантовая защита ✅
- **Standalone Encryptor** — шифрование файлов/сообщений ✅

## Тесты
- **Backend**: 111/111 ✅
- **Клиент**: 62/62 ✅ (обновлено после исправления ошибок компиляции)
- **Email**: 12/13 ⚠️
- **Desktop**: 4/4 crypto, 6/6 key_store ✅
- **Android**: 3/3 crypto ✅

## Текущий статус
- **Фаза**: Ядро криптографии завершено
- **Следующий шаг**: UI (Tauri 2.0) + интеграция email
- **Документация**: ✅ Обновлена 2026-07-15
- **Kanban**: 20 задач осталось

## Git коммиты (последние)
```
fe5a9caee fix: исправить ошибки компиляции клиента
8e5049c40 chore: добавить оставшиеся конфигурационные файлы
aefc2af67 chore: добавить оставшиеся файлы проекта
e773a7a3c docs: обновить STATUS.md с текущим статусом проекта
9eaa6f1c2 chore: удалить target/ из git, обновить .gitignore
a28840c09 feat: добавить standalone Encryptor/Decryptor и обновить документацию
```

## Исправленные ошибки (2026-07-15)
- Устранён конфликт commands.rs vs commands/mod.rs (E0761)
- Добавлен mime_guess в Cargo.toml (E0433)
- Добавлен type alias Decryptor = Encryptor (E0432)
- Исправлен Ok(self.encrypt_inner()) → self.encrypt_inner() (E0308)
- Исправлен context() на map_err() для chacha20poly1305::Error (E0599)
- Исправлен temporary value dropped в test_tampered_payload_rejects (E0716)

## Монетизация
- Клиент ВСЕГДА БЕСПЛАТНЫЙ
- Группы 10+ участников: ₽99/мес
- Pro (расширенные функции): ₽99/мес
- Emoji-паки: ₽49-149
- Без рекламы: ₽99/мес

## Хранение данных
- **Локальное** — на устройстве пользователя
- **Транспорт** — email (IMAP/SMTP)
- **Лимит** — зависит от провайдера (Gmail 25MB, Outlook 20MB)

## Ссылки
- Kanban: `hermes kanban --board mailcipher list`
- Тесты backend: `cd mailcipher-backend && cargo test`
- Тесты клиент: `cd mailcipher-client && cargo test`
