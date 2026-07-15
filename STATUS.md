# 📋 Whisper/Vault — Заметки проекта

## Название
- **Рабочее**: MailCipher (внутреннее)
- **Продвижение**: **Whisper** (основное)
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
- **Standlone Encryptor** — шифрование файлов/сообщений ✅

## Тесты
- **Backend**: 111/111 ✅
- **Клиент**: 58/58 ✅
- **Email**: 12/13 ⚠️
- **Desktop**: 4/4 crypto, 6/6 key_store ✅
- **Android**: 3/3 crypto ✅

## Текущий статус
- **Фаза**: Ядро криптографии завершено
- **Следующий шаг**: UI (Tauri 2.0) + интеграция email
- **Документация**: ✅ Обновлена
- **Kanban**: 21 задач осталось

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
- Тесты: `cargo test --bin mailcipher-backend`
