# 📋 Vault — Статус проекта

## Название
- **Рабочее**: Vault
- **Продвижение**: **Vault**
- **Домены**: vault-msg.ru, vault-msg.tech

## Стек технологий
- **Backend**: Rust (Axum) + SQLx + PostgreSQL 17
- **Desktop**: Tauri 2.0 (Rust + Vue 3)
- **Terminal**: Rust (ratatui)
- **Android**: Tauri 2.0 (Rust + WebView)
- **БД**: PostgreSQL 17 (Docker) / SQLite (клиент)

## Криптография ✅
- **X25519** — обмен ключами ✅
- **XChaCha20-Poly1305** — симметричное шифрование ✅
- **Ed25519** — цифровые подписи ✅
- **Argon2** — хеширование паролей ✅
- **Group E2E** — групповое шифрование (общий ключ) ✅

## Тесты
- **Backend**: компилируется ✅ (0 warnings)
- **Client**: компилируется ✅ (0 warnings)
- **Desktop**: vite build ✅ + Tauri cargo check ✅
- **Android**: crypto 3/3 ✅

## Текущий статус (2026-07-22)

### ✅ Завершено
- Backend API (Axum + PostgreSQL) — порт 9443
- JWT авторизация (register/login)
- E2E шифрование (X25519 + XChaCha20)
- Группы (создание, участники, ключи, сообщения)
- Desktop UI (Vue 3 + Tauri 2.0)
  - Sidebar: аватар-круг, контакты, группы
  - Настройки в модальном окне
  - Emoji picker, голосовые сообщения
  - QR-код для обмена ключами
  - Превью вложений (изображения, документы)
  - Порядок сообщений (timestamp sync)
- Terminal клиент (ratatui)
- Android проект (Tauri 2.0 + WebView)
- CI/CD (GitHub Actions: ci.yml, release-desktop.yml, release-cli.yml)
- Docker Compose (PostgreSQL + Backend + Nginx)
- MIT Лицензия

### 🔧 Исправлено (22 июля 2026)
- Порядок сообщений — сортировка после дешифровки, перезагрузка с сервера
- Превью вложений — base64 хранится на сервере, парсится при загрузке
- Очистка warnings — 0 предупреждений в backend + client
- Коммиты — 57 файлов разбиты на 5 логических коммитов

### ⏸️ Требует тестирования
- Визуальное тестирование Desktop (запуск с реальными email)
- Тестирование шифрования сообщений
- Тестирование групп с реальными email
- Сборка Desktop пакетов (.deb/.rpm/.AppImage)

### 📋 До релиза
- DNS настройка vault-msg.ru + vault-msg.tech
- Landing page (RU + EN)
- Pro version page + оплата
- Google Play Store setup (Android)

### 📋 После релиза
- Voice Calls (13 задач в канбане)
- Phone Number (3 задачи)
- Push уведомления

## Git коммиты (последние)
```
eca9b7f  chore: add MIT LICENSE file
fe23062  chore(desktop): improve build script, add release profile
f62404c  fix(desktop): attachment preview — store base64 on server
b3467fc  fix(desktop): message ordering — sort after decrypt, reload after send
9afc2fc  docs: update ROADMAP with current phase status
ea55029  feat(client+desktop): add local SQLite storage module
427099e  feat(android): crypto improvements, lib commands, build config
72f32c9  feat(desktop): API improvements, group E2E crypto, locales
5eabb2c  feat(backend): port 9443, group_keys module, E2E message handler
```

## Канбан
- Доска: `vault` (32 ready + 4 done)
- Последние completed: t_6855a381, t_878f4cb2, t_e5e7870e, t_c88288dd, t_99b3da89

## Директории проекта
```
~/whisper/
├── vault-backend/          # Rust Axum + SQLx + PostgreSQL
├── vault-desktop/          # Tauri 2.0 (Rust + Vue 3)
├── vault-client/           # Rust CLI (ratatui)
├── vault-android/          # Tauri 2.0 Android
├── vault-web/              # Web UI (Vue 3 + TypeScript)
├── docs/                   # Документация
├── scripts/                # Скрипты сборки и деплоя
├── .github/workflows/      # CI/CD (GitHub Actions)
├── docker-compose.yml      # Docker (PG + Backend + Nginx)
└── nginx.conf              # Nginx конфигурация
```

## Монетизация
- Клиент ВСЕГДА БЕСПЛАТНЫЙ
- Группы 10+ участников: ₽99/мес
- Pro (расширенные функции): ₽99/мес
- Emoji-паки: ₽49-149
- Без рекламы: ₽99/мес

## Ссылки
- Kanban: `hermes kanban --board vault list`
- Тесты backend: `cd vault-backend && cargo test`
- Сборка Desktop: `cd vault-desktop && ./scripts/build-desktop.sh --release`
