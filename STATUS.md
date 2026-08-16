# 📋 Vault — Статус проекта (обновлено 16.08.2026)

## Направление продукта (переопределено 16.08.2026)
- **Ориентир функционала**: Delta Chat (релиз 2.48+, посты zero/V2/webxdc) —
  Vault должен предлагать как минимум тот же современный функционал;
  устаревшее не рассматриваем. Полный анализ: docs/ROADMAP-2026-08-16.md
- **Базовые возможности**: как Telegram — чаты, группы, медиа, каналы, звонки
- **Дизайн**: Telegram как образец
- **Ключевые направления**: каналы (монетизация), мини-приложения (webxdc-модель),
  локал-перст соцсеть (M5), zero-metadata (Header Protection RFC 9788)

## Название
- **Рабочее**: Vault
- **Домены**: vault-msg.ru, vault-msg.tech
- **Структура**: один проект = три приложения (решение 10.08):
  1. **Мессенджер** — репозиторий открытый (когда будет рабочий вариант)
  2. **Сайт** (лендинг, монетизация) — репозиторий закрытый
  3. **Соцсеть** (без сервера, данные на устройстве) — планирование архитектуры

## Архитектура (решение 10.08.2026): SERVERLESS
Клиент ходит в почту напрямую (IMAP/SMTP), шифрует сам (XChaCha20-Poly1305 + X25519),
сервер не нужен. Backend/Axum/PostgreSQL/Docker удалены 16.08.2026 (клиент-серверная
эпоха закрыта; код recoverable из git-истории). Почтовый сервер видит «мусор»,
клиент — чат. Zero-knowledge.

## Стек технологий
- **CLI (terminal)**: Rust (REPL `vault --cli`; ratatui опционально)
- **Desktop**: Tauri 2.0 (Rust + Vue 3 + Vite) — serverless, email через Tauri-команды
- **Android**: Tauri 2.0 (Rust + WebView), не тестирован на устройстве
- **БД в клиенте**: SQLite / JSON-файлы (контакты, ключи)

## Криптография ✅ (с тестами)
- X25519 (обмен ключами), XChaCha20-Poly1305 (шифр), Ed25519 (подписи), Argon2
- Stealth-метка: AAD="VAULT" (Associated Data) — метка vault-писем живёт ТОЛЬКО в
  MAC-аутентификации Poly1305, в потоке (ciphertext/base64) её НЕТ; получатель
  определяет своё по успешной расшифровке; письма без метки = обычная почта
- X3DH, Double Ratchet, PAKE, Kyber, Hybrid, Sealed — были в backend-модулях
  (удалены вместе с backend 16.08; при необходимости восстанавливаются из git-истории)
- Обмен ключами: /keygen, /invite (самодостаточная ссылка base64url JSON {id,sender,key}),
  /accept (добавляет контакт с ключом), /confirm, /keyshare, /add <email> [name] [pubkey], QR (desktop)

## Email-транспорт ✅ (проверен E2E на реальных Gmail)
- Rust e2e-тесты: `vault-client/tests/email_e2e.rs` (шифр→SMTP→IMAP→расшифр) и
  `key_exchange_e2e.rs` (двухсторонний обмен ключами по email) — PASS 10.08
- Запуск: `./scripts/run-email-e2e.sh` (пароли Gmail в gitignored scripts/.email_test_env)
- Критические фиксы (обязательны при любом новом email-коде):
  - fold строк ≤76 колонок при отправке (RFC 5322) — иначе Gmail спам-фильтр
  - decode_quoted_printable при чтении тела (провайдеры перекодируют base64)
  - fetch последние 50 UID (desc), decrypt терпит whitespace
  - тест ищет письма и в Junk (флаг \Junk, локализованное имя) — спам уводит b→a

## Тесты (10.08.2026)
- Client: 235 ✅; e2e email + key-exchange: PASS на реальных Gmail
- Desktop: vite build ✅ + Tauri cargo check/build ✅; Android: crypto 3/3 ✅

## Текущий статус этапа 1 (до демо 20.08)
### ✅ Готово
- A. Rust e2e email-транспорт (вместо Python-скрипта) — PASS
- B. Desktop serverless: Tauri email-команды + api.js на invoke — build OK
  (осталось: визуальный тест на реальных Gmail)
- C. Обмен ключами: код (самодостаточные инвайты, /accept, /add с ключом) + E2E PASS
- C2. Vault как шифровальщик/дешифровальщик для любого канала (CipherTool 🛡, 20d7f6e) — done 11.08
- CipherTool фиксы (1ecf504, 13.08): контакты (имена) в select, шифротекст сохраняется
  после расшифровки; подсказка формы входа (30f1937): Vault шифрует на устройстве,
  почта — транспорт, контакты — только по выбору (id/QR)
- Группы через email (13.08, коммиты e54d9b36c…14401f560): CLI-ядро (group_key +
  /groupsend + раздача ключа инвайтом + автоприём) + Desktop (Tauri-команды
  sendGroupMessage/getGroupMessages/getGroups, selectGroup по group_key) +
  e2e на реальных Gmail (group_e2e.rs, RFC2045 whitespace fix) — ВСЁ ГОТОВО
- Группы в Desktop — соц. функции (13.08, коммиты 43dbe55 → 1a269aa): роли
  Admin/Moderator/Member (персист в groups.json, select в UI); инвайт-флоу с
  согласием (VaultGroupInvite → попап ← → VaultGroupAccept → идемпотентный
  groups_add_member); имя/аватар отправителя в чатах (кэш vault-profiles);
  попап добавления участника из контактов Vault; поллинг писем 30с (тихий,
  попап инвайта приходит автоматически). Проверки: npm ✅, cargo ✅,
  src-tauri 13 ✅, vault-client 177 ✅
- Жизненный цикл групп (31c9379): выход/удаление группы пишут в хранилище
  (groups_leave/groups_delete, тест delete_group — src-tauri 14 ✅); принявший
  инвайт добавляется в members (Member); группы фильтруются по участию, из
  контактов исключён сам аккаунт + подмешаны участники групп; fetchPendingInvites
  пропускает инвайт только при уже-участии (иначе попап терялся)
- Serverless-онбординг (c371af3): форма входа БЕЗ регистрации (Vault = почта,
  ключи генерируются при первом входе); вкладка «Почта» убрана из сайдбара
  (Vault — мессенджер, почта остаётся транспортом); приглашение контакта 1-на-1
  по id участника/QR как в Session (VaultContactInvite → попап «Принять/Отклонить»
  → VaultContactAccept → peer-key handshake, контакт появляется у обоих);
  в QRCodePanel поле «Пригласить участника по id» + «Ваш id участника»
- Ключи в инвайтах НЕ передаются открытым текстом (a5c54d8…): group_key группы
  шифруется на публичном ключе получателя (ECDH X25519 + XChaCha20,
  crypto.encryptGroupKeyForUser) — в почтовом клиенте письмо нечитаемо;
  принимающий расшифровывает своим приватным ключом (crypto.decryptGroupKey,
  sender_public_key в инвайте). Публичные ключи (как Session ID) — открыты
  по дизайну: на них шифруют, их не шифруют. Без ключа собеседника инвайт в
  группу блокируется с подсказкой (сначала 🔗 обмен ключами)
- Git: чистый, remote gitverse.ru/maksim/vault-msg (приватный, 13.08)

### 🚧 Веха M0 — демо v0.1.0 (дедлайн 20.08.2026)
Ядро 1-на-1 готово ~90% (аватары/реакции/копирование/stealth-тема — 15.08).
Осталось:
- Визуальный тест Desktop на реальных Gmail (ТЕСТ-01..09, с Максимом)
- Локальная история + инкрементальный фетч (чаты в памяти, не перезагрузка)
- Полировка UI + CLI, сборки .deb/.AppImage, debug APK

### 📋 Веха M1 — паритет ядра обмена (дедлайн 15.09.2026)
Группы E2E (sender keys), локальная история, редактирование/удаление/сохранение
сообщений, файловые вложения + download-on-demand, фоновый аудио-плеер,
CLI-совместимость (конверт/react/stealth), полный Header Protection (zero-metadata).

### 📋 Веха M2 — каналы + монетизация (дедлайн 15.10.2026)
Каналы (broadcast, шифрованные), описания групп/каналов, платные подписки,
QR-онбординг (SecureJoin v3). Монетизация: платные каналы — главная ставка.

### 📋 Веха M3 — звонки + мини-приложения (дедлайн 30.11.2026)
Аудио/видео звонки (P2P WebRTC, сигнализация через сообщения, работа в фоне),
мини-приложения (webxdc-модель: HTML5 в ZIP, network-sandboxed, P2P API),
маркетплейс мини-приложений (revenue-share).

### 📋 Веха M4 — Android + магазины + сайт (дедлайн 31.01.2027)
Android-клиент (Tauri 2), Google Play, сайт vault-msg.ru/.tech (лендинг RU/EN),
push-уведомления, Pro-версия + оплата (⚠️ карты РФ не подходят для зарубежных
платежей — крипто/локальные платежи).

### 📋 Веха M5 — соцсеть local-first (дедлайн 31.03.2027)
Пользователь открывает просмотр контактам из Vault в клиенте на своём устройстве
(Android, возможно ПК). Как приложение соцсети, но вся информация хранится на
устройстве (local-first, без центрального сервера). Строительные блоки:
каналы (M2) + мини-приложения (M3).

### 📋 Веха M6 — устойчивость + крипто-апгрейд (параллельно 2027)
Multi-relay / multi-path delivery, post-quantum (Kyber/hybrid), Forward Secrecy
(Double Ratchet), аудит безопасности, Premium-релеи/хостинг, Enterprise/self-hosted.

## Канбан
- Доска: `vault` — ЕДИНСТВЕННАЯ рабочая (13.08: доска mailcipher заархивирована)
- Вехи (16.08): t_f6c0da12 (M0), t_m1_core (M1), t_m2_channels (M2),
  t_m3_calls (M3), t_m4_mobile (M4), t_m5_social (M5), t_m6_resilience (M6);
  27 задач привязаны к вехам комментариями
- Команда: `hermes kanban --board vault list`

## Директории проекта
```
~/whisper/
├── vault-desktop/          # Tauri 2.0 (Rust + Vue 3) — serverless
├── vault-client/           # Rust CLI (REPL) + тесты e2e
├── vault-android/          # Tauri 2.0 Android
├── docs/                   # ROADMAP-2026-08-16.md (актуален), PLAN-2026-08-10.md, ROADMAP/TIMELINE (устарели)
├── scripts/                # run-email-e2e.sh, .email_test_env (gitignored)
└── .github/workflows/      # CI/CD
```

## Ссылки
- Kanban: `hermes kanban --board vault list`
- Дорожная карта: `docs/ROADMAP-2026-08-16.md` (вехи M0–M6, монетизация)
- План: `docs/PLAN-2026-08-10.md`; заметки: `~/Notes/Projects/mailcipher/`
- e2e: `cd vault-client && ../scripts/run-email-e2e.sh`