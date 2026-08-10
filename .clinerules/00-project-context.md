# Vault (~/whisper) — контекст для Cline

Полный контекст — в AGENTS.md (роли, канбан, структура). Здесь — для CLI-агента.

## Стек

- Backend: Rust + Axum + SQLx (папка `vault-backend/` или корень — проверь `Cargo.toml`)
- Клиент: terminal/ratatui
- Шифрование: E2E (см. ENCRYPTION.md, ARCHITECTURE.md)
- Директории: `docs/` — документация; `graphify-out/` — вывод graphify

## Команды

- Проверка: `cargo check` / `cargo test` (после любых изменений)
- Запуск: см. `deploy*.sh` / docker-compose.yml (внимательно — в репо много версий)
- .env: `~/whisper/.env` (DATABASE_URL, JWT_SECRET, HOST, PORT, ALLOWED_ORIGINS)

## Секреты

- Переменные из карты ~/.cline/rules/01-secrets-map.md (vault.env): DATABASE_URL,
  JWT_SECRET, HOST, PORT, ALLOWED_ORIGINS. Доступ только через `$ИМЯ`, не печатать.

## Архитектурные ограничения

- Архитектура: serverless, транспорт = email; Postgres/Docker НЕ нужны
  (см. доки ~/Notes/Projects/mailcipher/, файлы .md имеют BOM — читай xxd при сомнении).
- Секреты НИКОГДА не хардкодить — только .env.