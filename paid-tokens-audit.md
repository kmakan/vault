# Аудит реализации платных relay-токенов (задача 0.6.2)

> Дата аудита: 26.09.2026. Код **не изменялся** — отчёт только читающий.
> Техспека: `docs/design/paid-tokens-spec.md` (далее — «спека»).
>
> Прочитано целиком: `relay-server/src/{tokens.rs, main.rs, store.rs, rate.rs, lib.rs,
> bin/gen_token.rs, Cargo.toml}`, `relay-server/tests/integration.sh`,
> `vault-desktop/src/{relay-client.js, features/relay.js, i18n.js}`,
> `vault-desktop/src/components/{SettingsPage.vue, ChatHeader.vue}`,
> `vault-desktop/src/locales/{ru,en,zh}.js`, `vault-desktop/scripts/{relay-smoke.mjs,
> channels-relay-e2e.mjs, check-template.cjs}`, `docs/design/relay-protocol.md`,
> `.github/workflows/ci.yml`, `git log`.
> Проверено: `cargo test` в `relay-server` → 10 passed (только `tokens.rs`), 0 тестов в `main.rs`.

---

## 0. TL;DR

**Реализации платных токенов нет вообще — 0 % от шагов 1–9 плана внедрения (спека §7).**
Ни в сервере, ни в клиенте, ни в i18n нет ни одного артефакта: нет `Plan`, `issue_v2`,
`V2_LEN`, покупок, платёжного трейта, персистентности, `KV_PRO`, функций
`fetchTokenInfo/purchaseCheckout/purchaseVerify/activateToken`, ключей `pro_*`.
Единственный след темы во всём репозитории — текст спеки (проверено ripgrep по 539 файлам).

| Шаг спеки §7 | Что заявлено | Факт | Комментарий |
|---|---|---|---|
| 1. `tokens.rs`: v2-формат | `Plan`, `V1_LEN/V2_LEN`, `issue_v2`, `parse` по длине | ❌ нет | `tokens.rs` — только v1 (45 Б), `Token` без `plan` (`tokens.rs:79-90`) |
| 2. Персистентность (критично) | `subscriptions`/`token_bindings`/`device_count` в БД | ❌ нет | Всё в `Mutex<HashMap>` в памяти (`main.rs:34-61`); в `Cargo.toml` нет ни sled, ни rusqlite |
| 3. Plan-aware лимиты | заменить expiry-хак на `t.plan`, лимиты/TTL/очередь по тарифу | ❌ нет | Premium-хак на месте: `expiry > now+365д` (`main.rs:505-512`); TTL жёстко 24 ч (`main.rs:246`), очередь — константа 200 (`main.rs:121`) |
| 4. Новые роуты | `/relay/purchase/{checkout,verify}`, `/relay/tokens/{activate,info}` | ❌ нет | В `Router` только pub/poll/ws/metrics/health/register (`main.rs:710-719`) |
| 5. `PaymentProvider` + стаб | трейт + `TestProvider` + 3 заглушки | ❌ нет | Ни трейта, ни `async-trait` в зависимостях, ни env `VAULT_RELAY_PAYMENTS/YOOKASSA/STRIPE/REVENUECAT` |
| 6. `gen_token.rs` | `--plan/--sub/--months` | ❌ нет | CLI = `read|write <days> [count]` (`bin/gen_token.rs:7-46`) |
| 7. Клиент `relay-client.js` | 4 функции + `KV_PRO` + 7-дневный грейс | ❌ нет | Модуль — 494 строки, ничего платного; `setMyToken`, о котором пишет спека §5.2, **не существует** |
| 8. UI + i18n | секция покупки в `SettingsPage.vue`, 9 ключей `pro_*` | ❌ нет | Ни секции, ни ключей; в 3 локалях по 552 ключа, паритет есть, `pro_*` отсутствуют |
| 9. Тесты | unit + интеграция + клиентский смоук | ❌ нет | Из 10 существующих тестов все — про v1/каналы; хендлеры `main.rs` не покрыты; `relay-server` вообще не в CI |

**Главный вывод:** до начала кодинга спеку нужно поправить — в ней **две ошибки
формата (одна арифметическая, одна с security-последствиями)** и **один
функциональный провал** (нет per-device nonce ⇒ все устройства одной подписки
получают побайтово одинаковый токен и общую очередь). Подробности — §2 и §3.

---

## 1. Фактическое состояние кода (инвентаризация)

### 1.1 Сервер: `relay-server/src/tokens.rs` (344 строки, 10 тестов)

| Элемент | Состояние | Ссылка |
|---|---|---|
| Формат v1 `key_id(8)‖scope(1)‖expiry(4)‖mac(32)` = 45 Б | есть | `tokens.rs:3`, `issue` `tokens.rs:108-117` |
| MAC покрывает только `key_id‖scope‖expiry` | есть | `tokens.rs:62-76` |
| `Scope` (Read/Write/ChannelRead/ChannelWrite) | есть | `tokens.rs:13-47` |
| `ServerKeys` — ротация через `key_id` | **декоративно**: `new()` кладёт ОДИН ключ, `mac()` итерирует по одному | `tokens.rs:51-77` |
| `parse()`: жёсткий `raw.len() != 45 → None` | есть | `tokens.rs:127-131` |
| `parse()`: канальные токены **не** проверяются MAC (только длина + sentinel `expiry == u32::MAX`) | есть | `tokens.rs:134-149` |
| `channel_tokens()` + golden vectors (кросс-импл контракт) | есть | `tokens.rs:173-194`, тест `tokens.rs:330-339` |
| `ct_eq` constant-time | есть | `tokens.rs:196-205` |
| `Plan`, `V1_LEN`, `V2_LEN`, `issue_v2`, `plan/sub/paid_until` в `Token` | **нет** | — |
| Экспорт `Plan`/`issue_v2` из `lib.rs` | **нет** (экспортируются `channel_tokens, issue, parse, Scope, ServerKeys, Token`) | `lib.rs:7` |

Следствие: **любой v2-токен сегодня отвергается** — длина не 45 → `None` → 401/400.

### 1.2 Сервер: `relay-server/src/main.rs` (772 строки, 0 тестов)

| Элемент | Состояние | Ссылка |
|---|---|---|
| `AppState` (всё в памяти: `registrations`, `daily_pub`, `token_bindings`, `last_seen`) | есть | `main.rs:27-62` |
| Лимит конвертов/сут на издателя, 100 по умолчанию, `retry-after`, JSON-тело 429 | есть | `main.rs:216-241`, `main.rs:687-690` |
| Идентичность издателя: `tok` → `Authorization` → IP, ключи `t:<hash>` / `ip:<ip>` | есть | `main.rs:490-517` |
| Premium-признак = **хак** `expiry > now+365д` (не считая каналы) | есть | `main.rs:505-512` |
| Анти-шаринг `check_token_binding` (`hash → fp`, первый fp владеет, 403) | есть | `main.rs:473-485`, вызовы `main.rs:203`, `main.rs:315`, `main.rs:659` |
| **Дыра:** если `fp` не пришёл — привязка не проверяется, `return true` | есть | `main.rs:474-476` |
| TTL конверта жёстко `min(now+24*3600)` | есть | `main.rs:246` |
| `MAX_QUEUE = 200` — константа, не по тарифу | есть | `main.rs:121` (передаётся в `store.push/push_front` в 4 местах) |
| `POST /relay/register` (free 30 дн / promo 3650 дн, 3/сут на IP) | есть | `main.rs:621-667` |
| Rate-limit pub 10 rps / poll 5 rps по токену (token-bucket) | есть | `rate.rs:29-61` |
| Оконных лимитов в `rate.rs` нет (только «ведро» с refill) | — | `rate.rs` |
| CORS: только tauri-origin'ы, `x-vault-fp` в allow_headers | есть | `main.rs:733-748` |
| `/metrics` — текст собирается руками, 9 счётчиков | есть | `main.rs:579-594` |
| `hex_or_generate`: при невалидном `VAULT_RELAY_KEY` — **эфемерный** ключ в памяти | есть | `main.rs:750-765` |
| Платежных роутов, трейта, подписок, `sub`, `paid_until`, `revoked_subs`, `grace_until` | **нет** | — |
| Новых счётчиков метрик (purchase_ok и т. п.) | **нет** | `main.rs:64-76` |

### 1.3 Сервер: `store.rs`, `rate.rs`, `gen_token.rs`, `lib.rs`

* `store.rs` — чистый in-memory `Mutex<HashMap<String, VecDeque<Envelope>>>`, дедуп по `env.id`, FIFO-вытеснение, `peek` с курсором для каналов (`store.rs:38-101`). Комментарий `store.rs:2-3` прямо признаёт: персист = «M2.3, если решим». **Для платных токенов это уже не опция** (спека §7 шаг 2).
* `rate.rs` — только два `OnceLock`-лимитера с дробным refill; ни оконных лимитов («5 чекаутов/час на fp»), ни персиста, ни скользящего окна (`rate.rs:20-47`).
* `gen_token.rs` — 53 строки, без `--plan/--sub/--months`; `now + days*86400` в `u32` (переполнение при очень больших `days`) (`gen_token.rs:38-45`).
* `lib.rs` — в библиотеку вынесены только `rate`, `store`, `tokens`. **Хендлеры axum остались в бинарнике**, поэтому интеграционные тесты `relay-server/tests/*.rs` не могут собрать `Router` — только `#\[cfg(test)]`-модули внутри `main.rs` (сейчас их 0) либо вынос роутера в `lib.rs`.

### 1.4 Клиент: `vault-desktop/src/relay-client.js` (494 строки)

Что есть (и это важно для планирования — часть фундамента уже готова):

| Функция/механизм | Ссылка |
|---|---|
| `DEFAULT_RELAY_URL = 'https://vault-msg.ru/relay'` (совпадает с префиксом роутов спеки §3) | `:17` |
| KV-ключи: `relay-read-token`, `relay-peer-tokens`, `relay-enabled`, `relay-list`, `relay-active`, `relay-limit-day` | `:21-26` |
| Список релеев с авто-фолбэком `pickLiveRelay`, `relayHealthUrl` | `:186-208` |
| `myFingerprint` (ленивый кэш, `crypto.default.fingerprint()`) — переиспользуемый fp для оплаты | `:137-149` |
| Авто-выдача токена: `reRegisterOurRelay` + `ensureOurRelayToken` | `:311-332`, `:390-397` |
| Publish с `fp`, `tok`, `wake`, обработка 429/403 | `:236-306` |
| Poll всех релеев, `X-Vault-Fp`, обработка 204/**402**/403 | `:338-383` |
| Каналы: `relayChannelPublish` / `relayChannelPoll` | `:419-493` |
| Суточный лимит: тихий фолбэк «до конца UTC-дня только почта» | `:247-251`, `:279-285` |

Чего нет: `fetchTokenInfo`, `purchaseCheckout`, `purchaseVerify`, `activateToken`, `KV_PRO`,
`deviceId`, `timeOrigin`, `pro_*` — ноль совпадений по всему `src/`.
Спека §5.2 говорит «через существующий `setMyToken`» — **такой функции нет**; реальные пути
записи токена — `saveRelays` (`:87-90`) и `addRelay` (`:92-101`, **слияние по url**).

### 1.5 Клиент: `features/relay.js` (362 строки)

Точки, куда логично встроить оплату/показ Pro-статуса (уже существуют, менять надо точечно):
`startRelayTicker` — health-чек раз в 60 с (`:118-155`, идеальное место для `fetchTokenInfo` раз в N тиков),
`syncEcoWithRelay` (`:306-324`), `onRelayEnabled` (`:360-362` — единственный хук из UI),
`relayConsume` (`:22-69`). Баннеры/тосты лимита живут в `App.vue:4716-4730` (паттерн
`relay-limit-banner` в kv «раз в сутки» — готовая заготовка для баннера «Pro закончился»).

### 1.6 UI и i18n

* `SettingsPage.vue:243-304` — единственный блок релея (тумблер, кнопка подключения,
  промо-ключ, ntfy-ссылка, `<details>` с релеями/peer-токенами). Место для секции покупки
  свободно — спека §5.1 требует «перед блоком релея» (строка 244).
* `SettingsPage.vue:574-608` — `relayAutoRegister` дублирует логику регистрации **сырым
  `fetch`** на захардкоженный `https://vault-msg.ru` (`:576`) и печатает русские строки через
  `alert()` мимо i18n. Платный флоу не должен повторять эту ошибку.
* `ChatHeader.vue:56-57` — единственный бейдж (`relay-delivery-badge`, проп `relayEmailDelivery`).
  Бейджа Pro нет; готовый паттерн для добавления.
* i18n: `ru.js`/`en.js`/`zh.js` — по **552** ключа, ключи `relay_*` в `:65-95`, `pro_*` — 0.
  `i18n.js` фолбэчит на `en`, потом на сам ключ (тихий баг вместо ошибки — важно для теста паритета).

### 1.7 Тесты и CI

* `relay-server`: `cargo test` → 10 тестов, все в `tokens.rs`; `main.rs` — 0; `gen_token` — 0.
  Единственный интеграционный тест — `tests/integration.sh`, бьёт по **прод** `https://vault-msg.ru/relay`.
* `vault-desktop/scripts/`: 8 смоук-скриптов, из них релевантны `relay-smoke.mjs`
  (мок-харьнесс для `features/relay.js` с управляемыми таймерами) и `channels-relay-e2e.mjs`
  (**живой relay, автостарт на случайном порту с `VAULT_RELAY_KEY=aa×32`** — идеальная база
  для e2e покупки). `package.json` — **нет** скрипта `test`.
* `.github/workflows/ci.yml` — `vault-client` и `vault-desktop` (build). **`relay-server` в CI не
  собирается и не тестируется**; смоук-скрипты не запускаются. Т.е. тесты платных токенов
  в CI не попадут, пока это не добавлено.

---

## 2. Расхождения «спека ↔ код» (что в спеке написано неверно о текущем коде)

| # | Утверждение спеки | Факт в коде | severity |
|---|---|---|---|
| S1 | §2.2 `V2_LEN = 57; // 8+1+1+1+8+4+32` | **Арифметика спеки неверна: 8+1+1+1+8+4+32 = 55, не 57.** base64url: 45 Б → 60 симв., 55 Б → **74** симв. (57 Б → 76). Реализация по спеке даст несовместимый формат и сломает любые будущие golden-vectors | **P0** |
| S2 | §2.1 «`ver` = 2. Любая другая длина/значение → **v1-семантика** (`Free`)» | v1-ветка `parse` — единственная, и в ней канальные токены **не проверяются MAC** (`tokens.rs:134-149`). Если «другая длина» уходит в v1-ветку, то токен длиной 55 Б со scope `'c'/'C'` и sentinel-байтами `raw[9..13] = FF FF FF FF` будет принят как канальный **без проверки подписи** → подделка адреса канальной очереди и права publish в чужой канал | **P0** |
| S3 | §2.1 «Один `sub` = одна оплата = до N токенов (устройств)» | В layout v2 **нет поля device/nonce**. `issue_v2(keys, Read, Pro, sub, paid_until)` детерминирован ⇒ все устройства одной подписки получают **побайтово одинаковый токен**, у них общий `hash` (адрес очереди) и общая привязка в `token_bindings` (1:1, `main.rs:48`). Следствия: (а) устройство B читает конверты устройства A; (б) `device_limit` не считается (уникальных токенов один на `sub`); (в) «перенос устройства» не имеет смысла | **P0** |
| S4 | §5.2 «кладёт токен в `relay-list` через существующий `setMyToken`» | Функции `setMyToken` в `relay-client.js` нет. Запись: `saveRelays`/`addRelay`; `addRelay` **сливает по url** (`relay-client.js:97-98`) | P1 |
| S5 | §1 таблица: «Постов/сут в канал — 100 (текущий лимит по hash write-токена)» | Счётчик **один общий**: `publisher_key` для канала даёт `t:<hash(write-токен)>`, для личных конвертов — `t:<hash(read-токен)>`, но обе пишут в `daily_pub` (`main.rs:216-241`). То есть 100/сут — это «всё вместе», а не «100 плюс 100». Тарифная сетка в спеке подаёт их как независимые строки | P1 |
| S6 | §2.3 «промо-выдачу обычным `plan=Free` с длинным `paid_until`» и тут же «`relay_register` выдаёт `plan=Trial`» | Внутреннее противоречие спеки. Плюс **регресс**: сегодня промо-токен (3650 дней) попадает в `premium` по expiry-хаку (`main.rs:511-512`) и не имеет суточного лимита; после перехода на `t.plan >= Pro` тестеры/владелец **потеряют безлимит** | P1 |
| S7 | §2.1/§3.4: «`paid_until < now` → 402 в `relay_pub`/`relay_poll`» | `is_expired()` вызывается ещё в трёх местах, которые спека не упоминает: авторизация write-токена в `relay_pub` (`main.rs:163-164`), `relay_ws` (`main.rs:367-368`) и `require_read` → `relay_poll`/`relay_ws`. Забудете `relay_ws` — просроченный Pro продолжит получать конверты по WS | P1 |
| S8 | §7 шаг 2: хранилище `sled`/`RocksDB`/`sqlite` | Ни одной из зависимостей нет (`Cargo.toml`). Для одного VPS практичнее `rusqlite` (bundled) с одним файлом `relay.db`; выбор нужно зафиксировать, иначе шаг 2 раздувается | P2 |
| S9 | §5.4: новые ключи в `ru.js` **(и `en.js`)** | Локалей три: `ru/en/zh` (по 552 ключа, паритет сейчас соблюдён). Пропуск `zh.js` = тихая поломка локали при фолбэке на `en` | P2 |
| S10 | §3.4 пример: `pro` с `daily_used: 412` | Текущий `daily_pub` инкрементируется **только** для `!premium` (`main.rs:218-239`). Pro-издатель в счётчике не попадает → `daily_used` для Pro всегда 0. Нужен «считаем всегда, сравниваем с лимитом тарифа» | P1 |
| S11 | §6 «Не логировать: значения токенов, fp, `payment_url`» | Сейчас это соблюдается (`main.rs:665` пишет только `unlimited=…, days=…`). Но в `relay_pub`/`relayPoll` есть `console.log('[relay] publish skip: no-peer-token for', chatId, 'keys:', …)` (`relay-client.js:256`) и `[relay] published to <chatId>` (`:297`) — это email-адреса в лог клиента; для платного флоу важно не расширить этот уровень логирования (не писать `sub`, `checkout_id`, `payment_url`) | P2 |
| S12 | §4.1 «реестр провайдеров собирается в `main()` по env» | В `main()` сейчас только 6 env-переменных (`main.rs:672-690`); ни `Lang`, ни `Region` типов в коде нет — их надо вводить (или упростить: `lang: &str`) | P2 |

---

## 3. Дефекты и пробелы в самой спеке (надо закрыть ДО кодинга)

### 3.1 P0 — формат v2 не определяет устройство

Нужен **per-device nonce** (8 или 16 байт) в layout и в MAC. Варианты:

```
v2a (63 Б): key_id(8)‖scope(1)‖ver(1)‖plan(1)‖sub(8)‖dev_nonce(8)‖paid_until(4)‖mac(32)  → 84 симв. base64url
v2b (71 Б): key_id(8)‖scope(1)‖ver(1)‖plan(1)‖flags(1)‖sub(8)‖dev_nonce(16)‖paid_until(4)‖mac(32) → 96 симв.
```
`dev_nonce` входит в MAC ⇒ каждый выданный токен уникален ⇒ свои `hash`/очередь и своя
привязка на устройство, а `sub` агрегирует их для лимита устройств и для отзыва
(`revoked_subs`). Альтернатива «без nonce, но хранить реестр устройств на сервере» хуже:
MAC-токен остаётся статичным, а очередь общая.

Следствие для тестов: `issue_v2` дважды с одним `sub` обязан дать **разные** строки
(это и есть «тест-форсунка» на S3).

### 3.2 P0 — «любая другая длина → v1-семантика» заменяется на явный отказ

Корректная диспетчеризация:

```
len == 45 → v1 (personal: MAC; channel: только если scope ∈ {c,C} И expiry == u32::MAX)
len == V2_LEN → v2 (ver == 2 И scope ∈ {r,w}; channel-scope в v2 ЗАПРЕЩЁН)
иначе → None
```
Обязательный регрес-тест: 55-байтовый токен со scope `'C'` и sentinel-байтами →
`parse` = `None` (иначе — MAC-bypass канальных токенов, `tokens.rs:134-149`).

### 3.3 P1 — `fp` сейчас необязателен ⇒ лимиты обходятся «просто не отправляя fp»

`check_token_binding` при отсутствии `fp`/`X-Vault-Fp` возвращает `true`
(`main.rs:474-476`), а `publisher_key` падает на ключ `ip:<ip>` (`main.rs:516`).
Значит владелец Pro-токена может: не слать `fp` (тогда привязка к устройству не проверяется
и лимит устройств не применяется) и/или получить лимит по IP. Для платных токенов правило
должно быть явным: **для v2-токенов `fp` обязателен** (иначе 400/403 и `daily_pub` по `t:<hash>`),
легаси-семантика без fp сохраняется только для v1. Это надо записать в спеку §3.3/§6.

### 3.4 P1 — в `ServerKeys` нет настоящей ротации, а для платы это деньги

`ServerKeys::new` принимает один ключ (`tokens.rs:56-60`); смена `VAULT_RELAY_KEY`
мгновенно убивает **все** Pro/выданные токены (у клиента это тихо превратится в Free —
см. §5.2 отчёта). Нужно: `VAULT_RELAY_KEY` + `VAULT_RELAY_KEY_PREV` (список), причём
`key_id` в v2 должен совпадать с `key_id` выпускающего ключа. Плюс: `hex_or_generate`
при невалидном env печатает предупреждение и продолжает с **эфемерным** ключом
(`main.rs:763`) — при включённых платежах это должен быть `panic!`/exit.

### 3.5 P1 — персистентность (шаг 2) — жёсткий блокер, а не «M2.3»

`token_bindings` в памяти (`main.rs:48`) + `daily_pub` в памяти + `subscriptions` (будут)
означают: рестарт/деплой релея = покупатель Pro мгновенно становится Free, причём
**незаметно** (см. клиентский авто-даунгрейд, §5.2). Дополнительно: in-memory `last_seen`
и `Store` — ок, для очередей потеря непрочитанного допустима, для подписок — нет.

### 3.6 P1 — что делать с уже выданными промо-токенами (миграция)

Нужна явная политика (спека молчит, а §2.3 фактически ломает безлимит тестеров, см. S6):
1) `Plan::Internal`/`Unlimited` для промо (сохраняет нынешнее поведение безлимита), или
2) промо → `plan=Trial` + `paid_until = expiry` + флаг `unlimited` в профиле, или
3) пометить промо-выдачу как `sub=0` + `unlimited=true` в персисте при первом контакте.
Рекомендация — (1): одна новая планка `Plan::Internal = 4`, `unlimited: bool` в `Plan`-логике
лимитов, промо-выдача = `issue_v2(..., Internal, sub=0, paid_until=now+3650д)`.
Побочный бонус: `sub=0` явно отделяет «не платили» от «платили» (важно для `409 already_active`).

### 3.7 P2 — мелочи спеки

* `paid_until` для v1 = `expiry` (спека §2.2) — ок, но тогда клиент, распарсив токен
  без сервера, не отличит Free-30дневный от Pro; вывод плана только через `/tokens/info` (спека права).
* `Plan::from_byte` для неизвестного байта → `Free` (fail-open по тарифу) — **ловушка
  реализации**: MAC должен считаться по **сырым байтам** полей, а `Plan` — маппиться
  уже в структуре. Иначе токен, выпущенный с байтом `plan=9`, не пройдёт собственную
  проверку MAC (пересчёт по `Free` даст другой тег). Нужен тест: `issue` с сырым
  байтом plan=9 → `parse` = Some с `plan=Free`.
* `relay-protocol.md` §4/§7/§10 (in-memory + «sqlite-WAL») и `store.rs:2-3` описывают
  MVP-состояние — после шага 2 эти документы надо обновить, иначе спека и код будут
  противоречить друг другу (тот же долг, что у §7 шага 5).
* §5.3 «анти-подмена часов через `performance.timeOrigin` + monotonic»: клиентский
  `KV_PRO` лежит в локальной БД, которую пользователь редактирует, а `Date.now()` в
  клиенте уже используется везде. Это **не граница безопасности** (сервер — единственный
  авторитет), только UX. Рекомендация: не закладывать `timeOrigin`-схему, ограничиться
  «сервер авторитетен + 7-дневный грейс как подсказка UI»; иначе это лишняя сложность
  с нулевой защитой.

---

## 4. Чего не хватает по разделам спеки (пошаговая карта «чего нет»)

### §2. Формат токена v2 (tokens.rs)
Нет: `V1_LEN`/`V2_LEN` (корректно **55**), `#[repr(u8)] enum Plan`, `Plan::from_byte`/`as_byte`/
`is_premium`/`daily_limit`/`max_devices`/`queue_mult`/`ttl_secs` (тарифные константы удобно
держать на `Plan`, а не размазывать по `main.rs`), поля `plan/sub/dev/paid_until` в `Token`,
`issue_v2`, ветка v2 в `parse`, `is_paid_out()` (или переработка `is_expired`), отказ
канальных scope в v2, golden-vectors v2 (кросс-импл контракт, как у каналов
`tokens.rs:330-339`), экспорт новых символов в `lib.rs:7`.

### §3. Серверные эндпоинты (main.rs)
Нет: **ни одного** из четырёх. Плюс инфраструктура, без которой они не собираются:

| Нужно | Зачем / где появится |
|---|---|
| `struct Checkout { fp, plan, months, id, provider, created, expires, status }` + `HashMap<co_id, Checkout>` **в персисте** | идемпотентность §3.1 |
| `subscriptions: {sub → {plan, paid_until, revoked, issued_at}}` **в персисте** | выдача v2, `402`/`revoked` |
| `device_bindings: {token_hash → {fp, sub, dev, activated_at}}` + `devices: {sub → set<token_hash>}` **в персисте** | §3.3, замена `token_bindings` (`main.rs:48`) |
| `revoked_subs: HashSet<sub>` (персист) | §6 «отмена оплаты → Refunded» |
| Оконный лимитер «5 чекаутов/час на fp» | §3.1 429; в `rate.rs` такого нет — добавить `allow_window(key, limit, window)` + тест |
| `pub_key → (день, счётчик)` **считать всегда**, гейт — по лимиту плана | §7 шаг 3 + S10 |
| `publisher_key` → возвращать `Plan` (а не `bool premium`) | §7 шаг 3, снимает хак `main.rs:511-512` |
| TTL/очередь по плану **получателя** | `main.rs:246` (`exp.min(now+24h)`) и `main.rs:121` (`MAX_QUEUE`) — 4 места вызова `push/push_front` |
| Плановый 402 в `relay_ws` и в проверке write-токена | S7 (`main.rs:163-164`, `:367-368`) |
| Обязательный `fp` для v2 | §3.3 находятся выше |
| `grace_until` (серверная граница офлайн-грейса) | §5.3 — кто и когда продлевает? Нужен явный источник (напр. `paid_until + 7д`, обновляемый при каждом успешном `/tokens/info`) |
| Новые счётчики `Metrics` + строки в `/metrics` | `main.rs:64-76`, `:579-594` — без PII, только числа |
| Регистрация роутов в `Router::new()` | `main.rs:710-719` |
| Ответ 402 «checkout disabled» при `VAULT_RELAY_PAYMENTS=0` | §3.1/§7 шаг 4 |

### §4. Платёжный шлюз
Нет: трейта `PaymentProvider` (+`async-trait` в `Cargo.toml`), типов `Checkout`/`PayStatus`/
`PayError`/`Region`/`Lang`, `TestProvider` (мгновенный `Paid`), заглушек ЮKassa/Stripe/RevenueCat
(`unavailable`), реестра по env, HTTP-клиента к провайдерам (в коде есть только самописный
ntfy-клиент на `std::net::TcpStream`, `main.rs:541-569` — для HTTPS-провайдеров нужен
нормальный клиент; `reqwest`/`ureq` в зависимостях нет), флагов `VAULT_RELAY_PAYMENTS`,
`VAULT_RELAY_YOOKASSA_SHOPID/_SECRET_KEY`, `VAULT_RELAY_STRIPE_KEY`, `VAULT_RELAY_REVENUECAT_KEY`.
Сборочный флаг «Stripe/ЮKassa отключены в Android» (`#ifdef`-идея спеки §4.2) в веб-фронте
невыполним — надо решать через `import.meta.env`/`VITE_*`-подобный конфиг или по `platform`
из Tauri.

### §5. Клиентский экран покупки
Нет: четырёх функций из §5.2, `KV_PRO`, логики грейса, `proState` в `App.vue`,
секции в `SettingsPage.vue`, бейджа в `ChatHeader.vue`, 9 ключей `pro_*` в трёх локалях.
Дополнительно (вне спеки, но блокирует «3 устройства»): клиентская модель
`relay-list = [{url, myToken, label}]` хранит **один** токен на URL релея, а
`addRelay` сливает записи по `url` (`relay-client.js:97-98`) ⇒ тариф «3/10 устройств»
не представим. Нужна смена формы: `{url, label, tokens: [{token, deviceId, plan, paid_until}]}`
(peer-токены ключуются по url — `KV_PEERS` — и не пострадают), с опросом/публикацией по
всем своим токенам. Спека этого шага не содержит — добавить в §7.

---

## 5. Опасные места в текущем коде (сломают платные токены, даже если формат будет верным)

1. **Клиент тихо понижает Pro до Free.** `relayPoll` при **402** вызывает
   `reRegisterOurRelay` (`relay-client.js:353-359`), а `reRegisterOurRelay`
   (`:311-332`) безусловно **перезаписывает** `myToken` свежим бесплатным v1-токеном
   (30 дней). Итог: истёкший/недоступный Pro → тихий Free без единого слова пользователю;
   после рестарта релея (потеря in-memory привязок) → 403 → **то же самое** (`:286-295`).
   Для платного флоу это надо переделать: различать «v1-легаси» (авто-регистрация ок) и
   «v2 Pro» (402 → баннер «Pro закончился» + кнопка продлить; 403 → НЕ перерегистрировать,
   а показать «войдите на этом устройстве»).
2. **`relayPublish` шлёт 24-часовой `exp`** (`relay-client.js:257`) — для Business 72 ч
   сервер обязан быть единственным авторитетом TTL (он и есть: `main.rs:246`). Просто
   зафиксировать в тесте: клиентский `exp` не может продлить TTL получателя.
3. **Одно поле `fp` на все релеи**, `X-Vault-Fp` шлётся только в poll (`relay-client.js:350`),
   в pub — в теле (`:273`). Для v2 это норм, но при multi-token схеме из §4 нужен
   `fp` + `token` в паре, иначе привязка «какой токен на каком устройстве» не восстановится.
4. **Нет телеметрии платежей**: `/metrics` не покажет ни продаж, ни 402-прогонов
   (`main.rs:579-594`) — без них отладка флоу TestProvider будет слепой.
5. **`Store` и `last_seen` в памяти** — для платного TTL 72 ч потеря конвертов при деплое
   становится заметной (окно доставки больше, чем раньше): стоит рассмотреть персист очередей
   в том же `relay.db`, что и подписки (шаг 2), хотя спека это оставляет «на M2.3».
6. **CORS/locales**: новые POST-эндпоинты бьются через Tauri `plugin-http` (CORS не мешает),
   но `check-template.cjs` (сборка) потребует, чтобы все `@click`/`v-if` имена из шаблона
   секции покупки были в `data()`/`methods()` `SettingsPage.vue` — иначе сборка упадёт (E1).
7. **Нет `npm test`**: 8 смоук-скриптов запускаются руками; новый платный смоук без
   скрипта в `package.json` и без CI не будет выполняться никогда.

---

## 6. Безопасность: статус по таблице спеки §6

| Угроза | Защита по спеке | Статус в коде | Что нужно |
|---|---|---|---|
| Подделка тарифа байт-патчем | MAC покрывает `plan+sub+paid_until` | невозможно сегодня (v2 нет) | `issue_v2` + v2-ветка `parse` + тесты на патч каждого поля |
| Канальный MAC-bypass при наивном диспетчере | — (спека предлагает опасное правило, S2) | каналы MAC не проверяют уже сейчас | строгий dispatch по длине + регрес-тест (S2) |
| Устройства-подделки / лимит устройств | привязка по `sub`, до N | 1:1 `token_bindings` в памяти, fp опционален | per-device nonce (S3) + персист `device_bindings` + **обязательный fp для v2** (S3/§3.3) |
| Повторная оплата (replay) | идемпотентный `checkout_id`, verify идемпотентен по `sub` | нет эндпоинтов | персист `checkouts`, ключ идемпотентности `(fp, plan, активный)`; verify при `already_paid` обязан вернуть **тот же** `sub` |
| Отмена/возврат | `PayStatus::Refunded` → `revoked_subs` | нет | персист + проверка в `pub/poll/ws` |
| Обход суточного лимита «не слать fp» | — (спека не закрывает) | **дыра** (`main.rs:474-476`, `:516`) | обязательный fp для v2; иначе платный лимит обходится флагом |
| Потеря подписки при рестарте релея | персист (§7 шаг 2) | **всё в памяти** | шаг 2 — блокер релиза |
| Ротация ключа убивает все Pro | — (спека молчит) | `ServerKeys` = 1 ключ | `KEY_PREV`, список ключей |
| Неверный/отсутствующий `VAULT_RELAY_KEY` | — | эфемерный ключ + warning | при `PAYMENTS=1` → fail-fast |
| Утечка в логи | не логировать токены/fp/`payment_url` | соблюдается на сервере | сохранить в новых хендлерах; в `/metrics` — только числа |
| Перебор чекаутов | 5/час на fp | лимитера нет | `rate.rs::allow_window` + тест |
| Фишинг `payment_url` | не указано | — | подпись/домен провайдера на стороне клиента (UI: показывать домен, не «жмите сюда») |
| Корреляция оплаты и переписки | `sub` opaque, не email | — | не логировать связку `fp↔sub↔token_hash` в одном месте; `sub` не должен попадать в URL/логи |

---

## 7. Какие тесты нужны

Текущая база: `cargo test` = 10 тестов (`tokens.rs`), хендлеры `main.rs` = 0,
интеграция = shell-скрипт по прод-URL, клиент = 8 смоуков без раннера, `relay-server` не в CI.

### 7.1 Rust unit — `tokens.rs` (дёшево, ловят криптографию формата)
1. `v2_len_is_55` — **`V2_LEN == 55`** и base64url-строка = 74 символа (защита от S1).
2. `v2_roundtrip` — `issue_v2` → `parse`: `plan/sub/paid_until/dev` совпадают, `scope` ок.
3. `v1_still_parses_as_free` — v1 → `plan=Free`, `paid_until == expiry` (спека §2.2).
4. `v2_rejects_wrong_len` — 54/56 Б → `None`.
5. `tamper_plan_byte` — патч байта `plan` (2→3) → `None` (MAC покрывает профиль).
6. `tamper_paid_until` — сдвиг `paid_until` на +1 год → `None`.
7. `tamper_sub` / `tamper_dev_nonce` — → `None`.
8. `two_devices_differ` — два `issue_v2` с одним `sub` → **разные строки и разные `hash`** (S3).
9. `unknown_plan_byte_maps_to_free` — выпуск с сырым plan=9 → `parse` = Some(`plan=Free`) (ловушка §3.7).
10. `v2_rejects_channel_scope` — v2 со scope `'c'/'C'` → `None`.
11. `forged_long_channel_token_rejected` — 55 Б, scope `'C'`, `raw[9..13]=FFFFFFFF` → `None` (**MAC-bypass, S2**).
12. `channel_tokens_unchanged` — существующие golden-vectors (`tokens.rs:330-339`) продолжают проходить; `channel_tokens()` не затронут.
13. `expired_v2_is_not_hmac_expired` — `is_expired()` false при валидной подписи, `is_paid_out()` true при `paid_until < now` (важно: v2-`expiry` — sentinel, `main.rs:163-164` не должен 402-ить валидный токен).
14. `mac_covers_raw_bytes` — токен, выпущенный с plan-байтом 9, проверяется по сырым байтам (не по `Free`).

### 7.2 Rust unit — тарифная логика и лимиты (вынести в `plan.rs`/таблицу `Plan`)
15. `plan_table_matches_spec` — лимиты 100/1000/10000, устройства 1/3/10, TTL 24/24/72, очередь ×1/×2/×5 **соответствуют таблице §1** (защита от «разъехались» константы и спеки).
16. `is_premium` — `Free/Trial` не premium, `Pro/Business/Internal` premium (тест на S6).
17. `publisher_key_no_premium_hack` — v1-токен с `expiry = now+400д` **не** premium (хак снят), v2 Pro — premium (это тест на `main.rs:505-512`).

### 7.3 Тесты хендлеров — внутри `main.rs` (`#\[cfg(test)]`, axum `Router` + `tower::ServiceExt::oneshot`)
Требует: вынести сборку `Router`/логику в функцию (`fn app(state) -> Router`), `tower` в `dev-dependencies`.
18. `checkout_disabled_returns_402` — без `VAULT_RELAY_PAYMENTS` все `/purchase/*` = 402 «checkout disabled».
19. `checkout_idempotent_same_fp_plan` — два одинаковых `checkout` → один `checkout_id` (replay-защита).
20. `checkout_new_for_other_months_or_plan` — другой `months`/`plan` → новый `checkout_id`.
21. `checkout_validation` — `plan="gold"` / `months=7` → 422.
22. `checkout_rate_limit_5_per_hour` — 6-й за час → 429 (тест лимитера из `rate.rs`).
23. `verify_pending_then_paid` — `TestProvider`: сначала 402 `not_paid_yet`, затем 200 с `token v2`, `plan`, `paid_until`, `sub`.
24. `verify_fp_mismatch` → 409; `verify_checkout_expired` → 410.
25. `verify_idempotent_returns_same_sub` — повторный verify = тот же `sub` и тот же v2-токен (новая подписка не создаётся).
26. `checkout_already_active` — у fp уже Pro → 409 + `paid_until`.
27. `activate_binds_and_counts_devices` — 1-й, 2-й, 3-й fp → 200 с `devices: 1,2,3`; 4-й → 409 `device_limit`; чужой fp для уже занятого токена → 409 `bound_to_another`; `paid_until < now` → 402 `plan_expired`.
28. `v1_token_keeps_legacy_one_device` — v1-семантика не ломается.
29. `tokens_info_shape` — 200 с `plan/paid_until/daily_used/daily_limit/devices/max_devices/grace_until`; 402 при истёкшей подписке.
30. `pub_over_free_limit_429_with_plan` — 101-й конверт Free → 429 с `limit: 100`; Pro — 101-й проходит, 1001-й → 429 с `limit: 1000`; `daily_used` растёт и у Pro (S10).
31. `pub_ttl_and_queue_by_plan` — Free: `exp` клиентом +72 ч обрезается до 24 ч; Business: 72 ч проходит; очередь 200/400/1000.
32. `pub_and_poll_and_ws_402_when_paid_until_passed` — во всех трёх точках (S7), включая write-токен в `Authorization`.
33. `fp_required_for_v2` — v2-токен без `fp` → 403/400; v1 без `fp` → как раньше (нет регрессии).
34. `revoked_sub_rejected` — после `Revunded` → 402 на pub/poll/ws.
35. `metrics_contain_no_identifiers` — тело `/metrics` не содержит ни токена, ни `sub`, ни fp.

### 7.4 Персистентность (интеграция, отдельный бинарник/тест)
36. `subscriptions_survive_restart` — выпустили Pro, перезапустили сервер с тем же `relay.db` → `/tokens/info` с тем же токеном = 200 и тот же `plan`.
37. `device_bindings_survive_restart` — второй девайс с тем же `sub` по-прежнему укладывается в лимит (иначе после рестарта все устройства «слетают» в 1).
38. `checkout_idempotent_survives_restart` — повторный `checkout` с тем же fp/plan после рестарта возвращает тот же id.
39. `corrupt_db_fails_loudly` — битый файл → не тихий старт с пустыми подписками.

### 7.5 Клиентские смоуки (рядом с `relay-smoke.mjs`; новый `paid-tokens-smoke.mjs`)
Харнесс уже есть: мок `api/relay-client` + управляемые таймеры (`relay-smoke.mjs:47-56`).
40. `kv_pro_written_after_verify` — после `purchaseVerify` → `activateToken` → токен попадает в `relays[0].tokens[]` (новая форма), состояние в `relay-pro-state`.
41. `no_downgrade_on_402` — poll вернул 402 для v2-токена → `reRegisterOurRelay` **не вызывается**, показывается баннер продления (защита §5.1 отчёта).
42. `no_token_overwrite_on_403` — 403 на v2 Pro → токен не перезаписывается free-токеном.
43. `grace_7_days_offline` — `/health` падает → через 7 дней `paid_until` клиент перестаёт показывать Pro; серверный `grace_until` из `/tokens/info` сужает окно.
44. `info_polled_on_login_and_ticker` — `fetchTokenInfo` дёргается на логине/включении релея и раз в N тиков, не чаще.
45. `info_402_shows_expired_state` — состояние `expired`, CTA «Продлить», `relayDeliveryMode` = 'relay' (почта не ломается).
46. `checkout_error_paths` — 402/409/422/429 → понятные локализованные тексты, без alert().
47. `state_machine_ui` — `free → trial → active → expired` даёт 4 разных заголовка из §5.1 (по фикстуре состояния).
48. `i18n_keys_parity` — `pro_*` есть во всех трёх локалях (сейчас паритет 552/552/552 — тест не даст регрессии).

### 7.6 E2E против живого relay (шаблон `channels-relay-e2e.mjs` — автостарт на случайном порту)
49. `full_purchase_flow` — `checkout → verify → activate → pub` и **`pub` сверх Free-лимита (100) проходит на Pro** — это явный acceptance-критерий из спеки §7 шага 9.
50. `v1_client_unaffected` — старый v1-клиент (без `fp`, без pro-вызовов) работает как раньше; v1-токены не получают 402.
51. `cross_implementation_v2_golden` — если появится JS/CLI-парсер v2 — байт-в-байт совпадение (по аналогии с `channel_tokens_golden_vectors`).

### 7.7 CI
52. Добавить джоб `relay-server: cargo test` (+ `cargo check --release`).
53. Добавить джоб или npm-скрипт `test`, запускающий `*smoke.mjs` (сейчас CI запускает только `npm run build`).

---

## 8. Переупорядоченный план работ (предлагаемая редакция §7 спеки)

| Шаг | Содержание | DoD (проверяемо) |
|---|---|---|
| **0. Спека** | Исправить S1 (`V2_LEN=55`), S2 (отказ вместо v1-семантики), S3 (per-device nonce — выбрать layout), S6 (политика промо-миграции), S10 (счётчик всегда), добавить в спеку шаг «клиентская модель many-tokens-per-relay» и правило «fp обязателен для v2» | Коммит правок спеки; ни одного «TBD» в §2/§3 |
| **1. `tokens.rs` v2** | `Plan`, `V1_LEN/V2_LEN`, `issue_v2`, dispatch по длине, `is_paid_out`, golden-vectors v2 | `cargo test` зелёный, 14 тестов §7.1, существующие 10 не сломаны |
| **2. Персист (блокер)** | `rusqlite`: `subscriptions`, `checkouts`, `device_bindings`, `revoked_subs`; миграция `check_token_binding` в БД; `free_daily_limit`-счётчики оставить в памяти (допустимо, но зафиксировать в докстринге) | §7.4 (4 теста) зелёные; `cargo check` зелёный после шага |
| **3. Plan-aware лимиты** | `publisher_key → Plan`, счётчик всегда, TTL/очередь по плану получателя, 402 в трёх точках, снять expiry-хак | §7.2 + §7.3 (30-33) зелёные |
| **4. Роуты** | `/relay/purchase/{checkout,verify}`, `/relay/tokens/{activate,info}`, `VAULT_RELAY_PAYMENTS=0` → 402, лимитер 5/час | §7.3 (18-29) зелёные; curl-ручка в README релея |
| **5. `PaymentProvider`** | трейт + `TestProvider` + 3 заглушки `unavailable`; реестр по env | §7.3 (23-25) зелёные на TestProvider; `TestProvider` даёт Pro без оплаты |
| **6. `gen_token`** | `--plan pro --sub N --months M` (+ `--internal` для тестеров), фикс переполнения `days*86400` | ручной прогон выпускает v2, который `parse` принимает |
| **7. Клиент-протокол** | many-tokens-per-relay, 4 функции, `KV_PRO`, грейс, **запрет авто-даунгрейда**, `proState` в `App.vue` | §7.5 (40-47) зелёные |
| **8. UI + i18n** | секция покупки (4 состояния), бейдж в `ChatHeader.vue`, 9 ключей `pro_*` в **трёх** локалях, кнопка «отвязать устройство» (спека §9) | `npm run build` (check-template E1) зелёный; §7.5 (48) зелёный |
| **9. E2E + CI** | `paid-tokens-e2e.mjs` по образцу `channels-relay-e2e.mjs`; джоб `relay-server: cargo test`; npm `test` | §7.5/§7.6 зелёные локально и в CI |
| **10. Операционка** | `VAULT_RELAY_KEY` в env прод-юнита (fail-fast при пустом), `KEY_PREV`, `relay.db` в бэкап, обновление `relay-protocol.md` §4/§7/§10 и `store.rs:2-3` | деплой-процедура в `relay-server/README.md` |

Оценка: шаги 1-6 — сервер (P0), шаг 2 самый объёмный; шаги 7-8 — клиент; шаг 9-10 —
«не забыть». Без шага 2 релиза быть не должно.

---

## 9. Change-list (что и где менять) — быстрый указатель

* `relay-server/src/tokens.rs` — `Token` (`:79-90`) +3 поля; `ServerKeys::mac` (`:62-76`)
  → вариант `mac_v2`; новые `V1_LEN/V2_LEN/Plan` рядом со `Scope` (`:13-47`); `parse`
  (`:127-164`) → dispatch по длине; `is_expired` (`:93-99`) → `is_paid_out`; тесты (`:221-343`).
* `relay-server/src/lib.rs:7` — экспорты `Plan`, `issue_v2`, константы, `plan`-таблицу.
* `relay-server/src/main.rs` — `AppState` (`:27-62`): заменить `token_bindings` на
  персист-структуры + `plans`; `relay_pub` (`:126-284`): план издателя/получателя, TTL,
  очередь, обязательный fp; `relay_poll` (`:300-356`) и `relay_ws` (`:359-382`): 402 по
  плану; `check_token_binding` (`:473-485`) → в БД + мульти-устройство по `sub`;
  `publisher_key` (`:490-517`) → возвращает `Plan`; `daily_pub` (`:216-241`) → считать
  всегда; `relay_register` (`:621-667`) → `issue_v2(..., Trial/Internal, ...)`;
  `Metrics` (`:64-76`) + `/metrics` (`:579-594`) → новые счётчики; `main()` (`:672-721`) →
  env провайдеров, регистрация роутов, fail-fast на ключе; `cors_layer` (`:733-748`) — без
  изменений.
* `relay-server/src/store.rs:38-60` — `max_queue` уже параметр, нужен только вызов с
  планом; опционально персист (шаг 10).
* `relay-server/src/rate.rs` — добавить оконный лимитер для чекаутов (+тест).
* `relay-server/src/bin/gen_token.rs:7-46` — флаги плана; `:42` — арифметика на `u64`.
* `relay-server/Cargo.toml` — `rusqlite` (bundled), `async-trait`, HTTP-клиент
  провайдера, `tower` в `dev-dependencies`.
* `relay-server/tests/` — новый `paid_tokens.rs` (нужен доступ к роутеру ⇒ либо
  `#\[cfg(test)]` в `main.rs`, либо вынос `fn app()` в `lib.rs`); `integration.sh` не трогать
  (бьёт по прод).
* `vault-desktop/src/relay-client.js` — новая форма `relays[].tokens[]` (`:87-101`),
  4 функции + `KV_PRO` (новое), запрет авто-даунгрейда в `:286-295` и `:353-359`,
  `myFingerprint` (`:137-149`) переиспользуется.
* `vault-desktop/src/features/relay.js` — `fetchTokenInfo` в `startRelayTicker` (`:118-155`),
  `onRelayEnabled` (`:360-362`) — точка входа после покупки.
* `vault-desktop/src/App.vue` — `proState` в `data` (рядом с `:1139-1148`),
  баннер «Pro закончился» по образцу `:4716-4730`, проброс `relayDeliveryMode`.
* `vault-desktop/src/components/SettingsPage.vue` — секция перед `:243`,
  новые поля в `data()` (`:415-428`), методы; **не** дублировать `fetch` как в `:574-608`.
* `vault-desktop/src/components/ChatHeader.vue` — проп `proPlan` + бейдж по образцу `:56-57`.
* `vault-desktop/src/locales/{ru,en,zh}.js` — 9 ключей `pro_*` в каждый (рядом с `:65-95`).
* `vault-desktop/package.json` — скрипт `test`.
* `.github/workflows/ci.yml` — джоб `relay-server` + запуск смоуков.
* `docs/design/relay-protocol.md` §4/§5.4/§7/§10 и `docs/design/paid-tokens-spec.md` —
  синхронизировать с шагами 1-3 (лимиты по плану, персист, v2).

---

## 10. Открытые вопросы (нужно решение владельца, а не разработчика)

1. **Layout v2 с device-nonce**: 63 Б (8-байтный nonce) или 71 Б (16-байтный)? Влияет на
   совместимость с будущими клиентами — менять потом нельзя.
2. **Промо-миграция** (S6): тестеры/владелец сохраняют безлимит (`Plan::Internal`) или
   переводятся на `Trial`? Влияет на `gen_token --plan` и на `unlimited` в UI.
3. **Обязательность `fp` для v2** (S7/§3.3): «нет fp → 403» — безопасно, но может отрезать
   старые/сторонние клиенты, если они получат v2-токен. Подтвердить, что v2 выдаётся только
   своему клиенту.
4. **Схема many-tokens-per-relay в клиенте**: менять форму `relay-list` (совместимость со
   старыми kv нужна миграцией) или держать N «релеев» с одинаковым URL (конфликтует с
   `addRelay`-слиянием по url)? Рекомендую первое + миграцию.
5. **Провайдер по умолчанию для РФ/не-РФ** и валюты: 149 ₽ / $2.99 (спека §4.3) — цены
   окончательные? Нужны ли периодические платежи (autorenew) в объёме 0.6.2 (спека говорит
   `months` фиксировано — то есть нет).
6. **Возвраты**: ручной (promo) возврат без провайдера — как отзывать `sub`? Нужен ли
   admin-инструмент (`gen_token --revoke-sub N`)? Спека не описывает.
7. **Персист подписок в одном файле с очередями?** Если да — `store.rs` тоже становится
   персистным (упрощает, но расширяет объём шага 2).
8. **Публичность `/relay/tokens/info`**: он и так требует `Authorization` — ок; но что
   отдавать при v1-токене (нет `plan`)? Предлагаю `plan:"free"`, остальные поля нули.

---

## 11. Итог

* **Реализовано: 0 из 9 шагов.** Из смежной инфраструктуры, которую спека считала
  «готовым фундаментом», действительно на месте: fp-привязка (но 1:1 и в памяти),
  суточный лимит издателя с 429/`retry-after`, окно покупки не существует, health/фолбэк
  релеев, тихий фолбэк «почта вместо релея», клиентский `fp`-кэш, golden-vectors для
  канальных токенов, e2e-харнесс с автостартом релея.
* **Блокеры до релиза:** шаг 2 (персист), S3 (device-nonce), S2 (диспетчер длины),
  запрет клиентского авто-даунгрейда, обязательный `fp` для v2, `KEY_PREV`/fail-fast ключа.
* **Ошибки в самой спеке, которые надо исправить первым делом:** `V2_LEN` 57 → **55**;
  «другая длина → v1-семантика» → **отказ**; отсутствие per-device nonce; противоречие
  про `plan=Free`/`plan=Trial` для промо; `daily_used` для Pro при текущем счётчике;
  «существующий `setMyToken`», которого нет; «ru+en» вместо трёх локалей; общий (а не
  раздельный) лимит для каналов.
* **Тестов нужно ~53** (перечень в §7); сейчас покрытие платных токенов — ноль, а
  `relay-server` не participates в CI, поэтому тесты надо не только написать, но и
  подключить.

*Отчёт подготовлен в режиме read-only: изменён только этот файл
`paid-tokens-audit.md` в корне репозитория `/home/maksim/whisper/`.*
