# M0 C1 — Wire Format Parity (payload-конверт ↔ `parseEnvelope` / `classify`)

Ревизия **19.10.2026**: документ описывает фактический формат обмена и то, чем он
проверяется. Прежняя версия объявляла каноническим вариант с `X-Vault-*`
заголовками — это legacy-ветка, в проде не используется (см. §5).

## 1. Транспорт — stealth

Письмо: **пустая тема**, тело — сам wrapped JSON. `X-Vault-*` заголовков нет,
письмо ищется по содержимому (парс конверта).

- `vault-desktop/src-tauri/src/lib.rs` (`recovery_build_escrow_email`): «Тело
  письма — сам wrapped JSON. Пустая тема, без X-Vault-* заголовков: письмо
  ищется по содержимому (парс конверта), стелс соблюдён».
- `vault-desktop/src/features/channels.js`, `features/groups.js` («тема писем
  пустая → subject-фильтрации нет»).

## 2. Контракт payload

Producer (JS, `vault-desktop/src/App.vue` `buildEnvelope`):

```json
{"vault":1,"id":"…","text":"…","name":"…","avatar":"…","key":"…","ts":0,
 "pq":"…", "gavatar":"…", "tok":"…"}
```

| Сторона | Код | Что читает |
|---|---|---|
| JS (парсер конверта) | `src/message-format.js` `parseEnvelope` | `id`, `text`, `name`, `avatar`, `type`, `ts`, `key`, `pq`, `ttl`, `bio`, `tok`, `gavatar`, `poll` |
| JS (классификация, прод) | `src/features/incoming.js` `classify` | `kind`, `chatKey`, `title`, `envId` (своя ветка, не Rust) |
| Rust core | `vault-client/src/vault/incoming.rs` `classify` | `kind`, `env_id` (`obj.id`), `chat_key` (`from`), `title` (`name`) |
| Rust persist | `vault-desktop/src-tauri/src/vault_bridge.rs` `vault_store_incoming_message` | `id`, `text`, `name`, `avatar`, `ts`, `reactions`, `edited`, `replies`, `in_reply_to`, `ttl` → `MessageStore` |

## 3. Чем проверяется

Фикстура одна на оба языка: `vault-client/tests/fixtures/m0-wire-contract.json`.

| Гейт | Команда | Проверок (19.10) |
|---|---|---|
| Rust | `cd vault-client && cargo test --test m0_wire_contract` | 14 |
| JS | `cd vault-desktop && npm run smoke:m0-wire` | 15 |

Одни и те же байты обязаны одинаково читаться обеими сторонами: расхождение
ломает любой из двух гейтов. Числа разные, потому что каждая сторона объявляет в
фикстуре только свои ожидания (`rust_classify` / `js_parse_envelope`).

Правило **«сколько объявлено — столько проверено»**: число проверок считается по
всей фикстуре *до* выполнения и сверяется с выполненным, поэтому пропущенный
кейс или непокрытое поле → красный. Самопроверки 19.10: расхождение JS-поля → JS
красный (exit 1); расхождение Rust-поля → Rust красный; пропуск кейса → оба
красных («14/15, провалов 1» и «выполнено 13 из объявленных 14»).

## 4. Что этим гейтом НЕ покрыто

- **profile / presence / call_\* / poll / channel-конверты**: у JS своя ветка в
  `features/incoming.js`, у Rust — `incoming::classify`; расхождение между ними
  здесь не ловится (отдельный пункт в §7).
- Вложения (encrypted envelope → `vault_client::vault::download_file`), чеки
  (receipts), групповые ключи, escrow, relay-дубликаты.
- Маппинг payload → `MessageStore` (`vault_bridge.rs`) — только живьём.

## 5. Мёртвый/legacy код — не «чинить» под него приложение

- `vault-client/src/vault/protocol.rs` — вариант с X-заголовками
  (`X-Vault-Encrypted/Type/ID/From/Reply-To` + `envelope_json` + payload):
  вызовов нет ни у одной стороны. `from_email_body` **был сломан**: брал блок
  заголовков как payload и пытался разобрать «envelope_json\npayload» одним
  JSON → всегда `None`. Починено 19.10 (`split_once`), добавлены roundtrip-тесты
  (message / reply / мусор без конверта).
- `vault-client/src/vault/filter.rs` — `wrap_body`, `is_vault_message`,
  `has_vault_subject`, `is_vault_any` без вызовов; CLI использует только
  `is_vault_receipt` / `clean_subject` (`cli/repl.rs`). Префикс темы `[VAULT]` в
  стелс-транспорте не используется.
- `vault_bridge::vault_classify_incoming` — Tauri-команда зарегистрирована
  (`lib.rs`), но из JS не вызывается ни разу: JS классифицирует сам.

## 6. Маппинг полей (актуальный)

| Слой | Поле | Примечание |
|---|---|---|
| тело письма | wrapped JSON `{vault:1,…}` | пустая тема, X-заголовков нет |
| envelope id | `id` | Rust `classify.env_id` = `obj.id` |
| threading | `in_reply_to` | в payload |
| время | `ts` (unix ms) | Rust-мост читает `p.ts`, RFC3339 не используется |
| ключи | `key`, `pq` | продолжение обмена в конверте (M2.4 `tok`) |
| legacy alias | `message_id` | встречается в Rust-fallback `env_id` (vault_bridge) |

## 7. История и action items

Что было не так (найдено 19.10): `m0-e2e-parity.mjs` печатал «16/23 passed» и
выходил с кодом 0 — 23 было жёстко зашито из плана, 7 проверок никогда не были
написаны; Rust-сторона в нём **симулировалась на JS** и с `\r\n`, тогда как
реальный Rust пишет `\n`; скрипт не запускался ничем (имя без `smoke` и без
записи в `package.json`).

- [x] Doc parity (этот файл, ревизия 19.10)
- [x] X-header roundtrip в Rust: `to_email_body` / `from_email_body` + тесты
- [x] Общий контракт-гейт на фикстуре: `cargo test --test m0_wire_contract` и
      `npm run smoke:m0-wire` (заменяет `m0-e2e-parity.mjs`)
- [x] Пункт «JS `parseEnvelope` → `from_email_body`-style» закрыт как
      неактуальный: JS не парсит тело письма с X-заголовками вовсе — тело
      расшифровывается, а payload разбирает `parseEnvelope`; core-конверт живёт
      только в Rust
- [ ] Свести ветки profile/presence/call/poll/channel: JS
      `features/incoming.js` `classify` ↔ Rust `incoming::classify` под общий
      гейт (сейчас расхождение ловится только чтением/живьём)
- [ ] `vault_classify_incoming`: удалить или начать использовать (мёртвая
      Tauri-команда)
- [ ] Маппинг payload → `MessageStore` (`vault_bridge.rs`) покрыть тестом
