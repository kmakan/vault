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
| JS (парсер конверта) | `src/message-format.js` `parseEnvelope` | `id`, `text`, `name`, `avatar`, `type`, `ts`, `key`, `pq`, `ttl`, `bio`, `tok`, `gavatar`, `poll` — извлечение полей, не решение о типе |
| JS (маршрутизатор) | `src/features/incoming.js` `routeLetter` | **тип не решает**: зовёт `vault_classify_incoming` (Rust) и исполняет эффекты (обработчик звонка, presence, профиль, тосты/бейджи) |
| Rust core (решение о типе) | `vault-client/src/vault/incoming.rs` `classify` | `kind` (`message`/`profile`/`presence`/`call`/`channel`/`group-service`), `env_id`, `chat_key`, `title` |
| Rust persist | `vault-desktop/src-tauri/src/vault_bridge.rs` `vault_store_incoming_message` | `id`, `text`, `name`, `avatar`, `ts`, `reactions`, `edited`, `replies`, `in_reply_to`, `ttl` → `MessageStore` |

Порядок проверок классификатора повторяет прод-роутер (а не «здравый смысл»),
потому что цель переноса — не изменить поведение: call (`type=call_*` + `call_id`)
→ presence (`presence === 1`) → vault-конверт (`vault=1` + `text` строкой, внутри
`type=profile` → профиль) → канал (`channel === 1`) → `hav === 1`. Каждое правило
закреплено кейсом фикстуры, включая ловушки: `call_id` без `type=call_*` — это
сообщение; `text:123` — не конверт; poll — сообщение, а не сигнал управления.

## 3. Чем проверяется

Фикстура одна на оба языка: `vault-client/tests/fixtures/m0-wire-contract.json`
(20 кейсов).

| Гейт | Команда | Проверок (19.10, W1) |
|---|---|---|
| Rust `incoming::classify` | `cd vault-client && cargo test --test m0_wire_contract` | 46 |
| JS `parseEnvelope` | `cd vault-desktop && npm run smoke:m0-wire` | 48 |
| JS маршрутизатор (эффекты) | `cd vault-desktop && npm run smoke:incoming` | 16 |

JS-гейты **входят в `npm run build`**: `smoke:m0-wire` и `smoke:incoming` стоят
до `vite build`. Rust-часть гоняет CI-задача `check-client` (`cargo test`).

Одни и те же байты обязаны одинаково читаться обеими сторонами: расхождение
ломает любой из гейтов. Числа разные, потому что каждая сторона объявляет в
фикстуре только свои ожидания (`rust_classify` / `js_parse_envelope`).

Правило **«сколько объявлено — столько проверено»**: число проверок считается по
всей фикстуре *до* выполнения и сверяется с выполненным, поэтому пропущенный
кейс или непокрытое поле → красный.

## 4. Что этим гейтом НЕ покрыто

- **Групповой meta-конверт** (`meta:1` + name/avatar) — его применяет
  `features/group-meta.js` (мета-скан), а не роутер; в фикстуре записан как «не
  решение роутера».
- Групповой **message**-конверт отличается от 1:1 не байтами, а ключом
  расшифровки: `chat_key = group:<id>` строит JS-адаптер после успешной
  расшифровки групповым ключом (в фикстуре — кейс с пояснением).
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
- `vault_bridge::vault_classify_incoming` — **больше не мёртвая команда**: с W1
  её вызывает `features/incoming.js` (решение о типе письма в Rust). Заодно убран
  `MessageStore::new()` внутри команды: он читал `~/.vault/messages.json` на
  каждое входящее письмо, хотя классификатору состояние не нужно.

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
      `npm run smoke:m0-wire` (JS-часть входит в `npm run build`; заменяет
      `m0-e2e-parity.mjs`, который не запускался ничем)
- [x] Пункт «JS `parseEnvelope` → `from_email_body`-style» закрыт как
      неактуальный: JS не парсит тело письма с X-заголовками вовсе — тело
      расшифровывается, а payload разбирает `parseEnvelope`; core-конверт живёт
      только в Rust
- [x] Свести ветки profile/presence/call/poll/channel: общая фикстура покрывает
      20 кейсов, решение о типе письма перенесено в Rust, JS — адаптер и эффекты
      (W1, `t_2243231f`). JS-гейт маршрутизатора: `npm run smoke:incoming`.
- [x] `vault_classify_incoming`: больше не мёртвая — её зовёт `incoming.js`
- [ ] Маппинг payload → `MessageStore` (`vault_bridge.rs`) покрыть тестом
