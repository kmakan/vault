# Платные relay-токены (этап 0.6.2) — техническая спецификация

> Статус: черновик-спецификация. **Рабочий код не изменён** — документ описывает,
> что и где нужно дописать.
>
> Связанные документы: `docs/design/relay-protocol.md` (§4 токены, §5.4 лимиты),
> `docs/ROADMAP-2026-08-16.md` §4 (монетизация, модель 3 «Premium-релеи»),
> `docs/promotion/monetization-plan.md` (§3 отклонён, §1/§2 актуальны).

---

## 0. Реальное состояние релея (с чем работаем)

Изучено по коду, а не по старым заметкам:

| Что | Где | Как устроено |
|---|---|---|
| Токен v1 | `relay-server/src/tokens.rs:3` | `base64url(key_id(8) ‖ scope(1) ‖ expiry(4) ‖ mac(32))` — **45 байт, бинарный**. Никакого JSON-payload: `ttl`/`msgs`/`plan` в токене **нет** |
| Scope | `tokens.rs:14-47` | `Read='r'`, `Write='w'`, `ChannelRead='c'`, `ChannelWrite='C'` |
| Выдача | `tokens.rs:108` `issue(keys, scope, expiry)` | key_id = первые 8 байт server_key; `ServerKeys` (`tokens.rs:51`) — ротация через key_id |
| CLI | `relay-server/src/bin/gen_token.rs` | `vault-relay-gen <key_hex(64)> read\|write <days> [count]` |
| Self-register | `main.rs:621` `relay_register` | `POST /relay/register {fp, promo?}` → `{token, topic, exp, unlimited}`. Free = 30 дней, promo = 3650 дней. Rate-limit **3/день/IP** (`main.rs:636-649`) |
| Суточный лимит | `main.rs:216-241`, `publisher_key` `main.rs:479` | `VAULT_RELAY_FREE_DAILY_LIMIT` (по умолч. **100**). Premium-признак сейчас — **хак**: `expiry > now + 365д` (`main.rs:505-507`) |
| Анти-шаринг | `check_token_binding` `main.rs:469` | `token_bindings: HashMap<token_hash, fp>` — первый fp владеет, чужой → 403 |
| Хранилище | `relay-server/src/store.rs` | **In-memory** `HashMap` (sled/БД **нет**). `Envelope{id, body, exp, ts, from, tok}` |
| Очереди релея | `main.rs:41-61` | `daily_pub`, `token_bindings`, `last_seen`, `registrations` — **все in-memory** |
| Wake-up | `main.rs:267-282` | ntfy-мост, шлём только если получатель молчал ≥ 90 c (`last_seen`) |
| Клиент | `vault-desktop/src/relay-client.js` | `DEFAULT_RELAY_URL='https://vault-msg.ru/relay'`; KV `relay-list` `[{url, myToken, label}]`, `relay-peer-tokens`; `myFingerprint()` → `crypto.default.fingerprint()` |
| UI | `vault-desktop/src/components/SettingsPage.vue:244+` | toggle `relayEnabled`, `relayAutoRegister`, промо-инпут `relayPromoKey`, расширенный блок `<details>` |
| i18n | `vault-desktop/src/locales/ru.js:65-83` | `relay_*` — 19 ключей |

### Два критических пробела, которые платные токены требуют закрыть

1. **`token_bindings` в оперативной памяти.** Перезапуск релея (deploy, падение) **развязывает все токены** — анти-шаринг обнуляется. Для бесплатных токенов это допустимо (перевыдача), для **платных — нет**: купленный Pro не должен отвязываться от аккаунта из-за рестарта сервера. → раздел 7, шаг 2 (персистентность).
2. **Replay-защиты нет.** Дедуп конвертов — клиентский (по `env.id`, `relay-protocol.md` §5.3). Платёжные эндпоинты требуют серверной идемпотентности по `checkout_id` → раздел 3.

---

## 1. Тарифная сетка

Лимит считается на **издателя** (так же, как сейчас в `publisher_key`): идентичность —
`tok` из тела → `Authorization` → IP. Почта **никогда** не ограничивается: 429 означает
только отключение «ускорения», письмо уходит как обычно (`main.rs:214-215` — сохранить).

| | **Free** | **Pro** | **Business** |
|---|---|---|---|
| Цена | 0 ₽ | 149 ₽/мес (1490 ₽/год) | 499 ₽/мес (4990 ₽/год) |
| Конвертов/сут на издателя | 100 (текущий `VAULT_RELAY_FREE_DAILY_LIMIT`) | 1 000 | 10 000 |
| Постов/сут в канал | 100 (текущий лимит по hash write-токена) | 1 000 | 10 000 |
| Устройств на подписку | 1 (текущая привязка fp) | 3 | 10 |
| TTL конверта на релее | 24 ч (текущий `main.rs:246`) | 24 ч | 72 ч |
| Длина очереди на токен | `MAX_QUEUE` (текущее) | ×2 | ×5 |
| Trial для нового аккаунта | 30 дней (текущее `relay_register`) | — | — |
| Приоритетный wake-up (ntfy) | да (текущее) | да | да |
| Метрики использования (`/tokens/info`) | — | да | да |
| Поддержка | community | email | email + SLA-эскалация |

**Что НЕ меняется на Pro/Business:** E2E-шифрование и пост-квантовые ключи остаются
бесплатными навсегда (принцип `ROADMAP §4`: зарабатываем на ценности, никогда на данных).
Косметические пейволлы (`monetization-plan.md` §3) отклонены — не повторять.

**trial/active/expired** — состояния клиента, выводятся из `plan`+`paid_until` токена
(раздел 2) и локальной KV-копии (раздел 5).

---

## 2. Формат токена v2

### 2.1 Layout

v1 остаётся нетронутым (обратная совместимость). v2 отличается **длиной** — `parse()`
различает версии по размеру декодированных байтов:

```
v1 (45 Б): key_id(8) ‖ scope(1) ‖ expiry(4) ‖ mac_v1(32)          → Free
v2 (57 Б): key_id(8) ‖ scope(1) ‖ ver(1)=2 ‖ plan(1) ‖ sub(8) ‖ paid_until(4) ‖ mac_v2(32)
```

- `ver` = 2. Любая другая длина/значение → v1-семантика (`Free`).
- `plan`: `0=free`, `1=trial`, `2=pro`, `3=business`. Неизвестное значение → `Free` (fail-open по тарифу, fail-closed по HMAC).
- `sub` (u64 BE) — идентификатор подписки, назначается сервером при покупке. Один `sub` = одна оплата = до N токенов (устройств).
- `paid_until` (u32 BE, unix) — конец оплаченного периода. При `paid_until < now` токен **не инвалидируется на HMAC-уровне** — сервер возвращает 402 в `relay_pub`/`relay_poll` так же, как сейчас для истекшей `expiry` (`relay-protocol.md` §4).
- `mac_v2` = `HMAC-SHA256(server_key, key_id ‖ scope ‖ ver ‖ plan ‖ sub ‖ paid_until)` — в MAC **входит весь профиль**, поэтому подмена `plan`/`paid_until` байт-патчем ломает подпись.

### 2.2 Изменения в `tokens.rs`

```rust
pub const V1_LEN: usize = 45;   // 8+1+4+32
pub const V2_LEN: usize = 57;   // 8+1+1+1+8+4+32

#[repr(u8)]
pub enum Plan { Free = 0, Trial = 1, Pro = 2, Business = 3 }

impl Plan { fn from_byte(b: u8) -> Self { match b { 2=>Pro, 3=>Business, 1=>Trial, _=>Free } } }

pub struct Token {
    pub scope: Scope,
    pub expiry: u32,      // v1: подписка; v2: не используется (sentinel)
    pub hash: String,
    pub key_id: u64,
    // НОВОЕ:
    pub plan: Plan,       // v1 → Free
    pub sub: u64,         // v1 → 0
    pub paid_until: u32,  // v1 → expiry
}

pub fn issue_v2(keys: &ServerKeys, scope: Scope, plan: Plan, sub: u64, paid_until: u32) -> String
// parse() → по raw.len() выбирает v1/v2 ветку; v1 заполняет plan=Free, paid_until=expiry
```

Канальные токены (`channel_tokens`, `tokens.rs:173`) — **не трогать**: они выводятся из
`broadcast_key` канала и платными не являются. `is_channel()` остаётся стражем:
`publisher_key` уже исключает канальные токены из premium-логики (`main.rs:505-507`).

### 2.3 Замена expiry-хака

`publisher_key` (`main.rs:479-511`) сейчас считает premium по `expiry > now+365д`.
Заменить на `t.plan >= Pro` — это убирает хак и делает промо-выдачу обычным `plan=Free`
с длинным `paid_until` (промо-ключ тестера остаётся: `relay_register` выдаёт `plan=Trial`,
не занимающий платный лимит).

---

## 3. Серверные эндпоинты

Все новые роуты — в `main.rs:710-719` рядом с существующими, под префиксом
`/relay/...` (клиентский `baseUrl` уже заканчивается на `/relay`,
см. `relay-client.js:17`).

### 3.1 `POST /relay/purchase/checkout` — создать платёжную сессию

```
Body: { "plan": "pro"|"business", "months": 1|12, "fp": "<account fingerprint>", "lang": "ru"|"en" }
→ 200 { "checkout_id": "co_...", "provider": "yookassa"|"googleplay"|"stripe",
        "payment_url": "https://...", "expires_in": 1800 }
→ 402  { "error": "checkout disabled" }                -- VAULT_RELAY_PAYMENTS не задан
→ 409  { "error": "already_active", "paid_until": N }  -- у этого fp уже Pro
→ 422  { "error": "bad plan/months" }
→ 429  { "error": "rate limited" }                     -- ≤ 5 чекаутов/час на fp (новый лимитер)
```

Идемпотентность: один `fp` + `plan` + незавершённый чекаут → возврат существующего
`checkout_id` (а не нового). Это и есть replay-защита платежа.

### 3.2 `POST /relay/purchase/verify` — подтвердить оплату и выпустить токен

```
Body: { "checkout_id": "co_...", "fp": "<тот же>" }
→ 200 { "token": "<v2>", "topic": "<hash>", "plan": "pro", "paid_until": N, "sub": S }
→ 402  { "error": "not_paid_yet" }     -- провайдер говорит «ожидает оплаты»
→ 409  { "error": "fp_mismatch" }      -- fp отличается от чекаута
→ 410  { "error": "checkout_expired" } -- > expires_in
```

Сервер сам опрашивает провайдера (`PaymentProvider::verify`), не доверяя клиенту.
При успехе: `sub` = новый id, `paid_until = now + months*86400*30`,
`issue_v2(keys, Read, plan, sub, paid_until)`.

### 3.3 `POST /relay/tokens/activate` — привязать токен к устройству

```
Body: { "token": "<v2>", "fp": "<fingerprint>" }
→ 200 { "bound": true, "devices": 2, "max_devices": 3 }
→ 409  { "error": "bound_to_another" }   -- токен уже за другим fp
→ 409  { "error": "device_limit" }       -- devices >= max_devices тарифа
→ 402  { "error": "plan_expired" }       -- paid_until < now
```

Обобщает `check_token_binding` (`main.rs:469`): лимит устройств считается по `sub`
(все токены с этим `sub`), а не по одному токену. v1-токены остаются на старой
семантике (1 устройство, как сейчас).

### 3.4 `GET /relay/tokens/info` — остаток лимитов

```
Authorization: VaultRelay <token>
→ 200 { "plan": "pro", "paid_until": N, "daily_used": 412, "daily_limit": 1000,
        "devices": 2, "max_devices": 3, "grace_until": N }
→ 402  { "error": "subscription expired", "paid_until": N }
```

Нужен для экрана покупки и для клиента, чтобы показывать «осталось 588 конвертов
сегодня». `daily_used` берётся из `daily_pub` по `t:<hash>`.

---

## 4. Платёжный шлюз

### 4.1 Трейт

```rust
#[async_trait::async_trait]
trait PaymentProvider: Send + Sync {
    fn id(&self) -> &'static str;                 // "yookassa" | "googleplay" | "stripe"
    fn region(&self) -> Region;                   // Ru | Global
    async fn create_checkout(&self, plan: Plan, months: u8, lang: Lang)
        -> Result<Checkout, PayError>;            // { id, payment_url, provider_payload }
    async fn verify(&self, checkout_id: &str)
        -> Result<PayStatus, PayError>;           // Pending | Paid { paid_until } | Refunded
}
```

Реестр провайдеров собирается в `main()` по env:

| env | провайдер | регион | когда |
|---|---|---|---|
| `VAULT_RELAY_YOOKASSA_SHOPID` + `_SECRET_KEY` | ЮKassa (HTTP API, `POST /payments`) | РФ | после ИП |
| `VAULT_RELAY_REVENUECAT_KEY` | RevenueCat → Google Play Billing | Global | публикация в Play |
| `VAULT_RELAY_STRIPE_KEY` | Stripe Checkout | Global | не-РФ карты, вне Play |
| `VAULT_RELAY_PAYMENTS=0` | все `/purchase/*` → 402 | — | текущее состояние, по умолчанию |

### 4.2 Жёсткое ограничение Android

**Google Play Billing обязателен** для цифровых товаров в приложениях, распространяемых
через Play (политика Play). Токен релея = цифровой товар. Поэтому:
- `vault-android` платит **только** через Play Billing (через RevenueCat как агрегатор).
- Stripe/ЮKassa-чекауты из Android-сборки **отключаются** сборочным флагом.
- Desktop (`vault-desktop`) — ЮKassa (РФ) и Stripe (не-РФ).

### 4.3 Что нужно от ИП (ЮKassa, РФ)

1. Самозанятости **недостаточно** — ЮKassa работает с ИП и юрлицами.
2. Реквизиты: ИНН, ОГРНИП, расчётный счёт ИП в банке РФ.
3. Договор с ЮKassa: shopId + секретный ключ (в `VAULT_RELAY_ENV`, **не в коде**).
4. **54-ФЗ онлайн-касса**: чек обязателен при оплате физлицами — ЮKassa присылает
   фискальный чек сама (через свою кассу), это настраивается в личном кабинете, не в коде.
5. Ценовая политика: Pro 149 ₽/мес — эквивалентно ~$1.5,Stripe-цена для не-РФ: **$2.99/мес**.

---

## 5. Клиентский экран покупки

### 5.1 Размещение

`vault-desktop/src/components/SettingsPage.vue`, **новая секция перед блоком релея**
(сейчас `relayEnabled` — строка 244). Три состояния:

```
trial:    "Тестовый период: осталось 12 дней"                    + [Купить Pro]
active:   "Pro активен до 25 окт 2026 · устройств 2/3"           + [Продлить]
expired:  "⚠ Pro закончился — релей работает в режиме Free"      + [Продлить]
free:     "Бесплатный тариф: 100 конвертов/день"                 + [Купить Pro]
```

Иконка/бейдж Pro — также в заголовке чата (маленький маркер, без блокировки функций).

### 5.2 Новые функции в `relay-client.js`

```js
export async function fetchTokenInfo(account, relayUrl)     // GET /relay/tokens/info
export async function purchaseCheckout(account, plan, months)  // POST /relay/purchase/checkout
export async function purchaseVerify(account, checkoutId)   // POST /relay/purchase/verify
export async function activateToken(account, token)         // POST /relay/tokens/activate
export const KV_PRO = 'relay-pro-state';   // { plan, paid_until, checkout_id } — для офлайн-грейс
```

Кэш `fp` уже есть (`myFingerprint`, `relay-client.js:130-146`) — переиспользуем.
После `purchaseVerify` клиент сам вызывает `activateToken`, затем кладёт токен в
`relay-list` через существующий `setMyToken` — **других путей записи токена не появилось**.

### 5.3 Офлайн-фолбэк и защита от подмены часов

- Клиент хранит `KV_PRO.paid_until` после каждого успешного `/tokens/info`.
- Если релей **недоступен** (health-fail, `relayHealthUrl` `relay-client.js:188`) —
  клиент доверяет локальному `paid_until` ещё **7 дней** (grace period), показывая
  пометку «офлайн-режим». Сообщения ходят, как у Pro.
- **Анти-подмена часов:** локальный `paid_until` клиент comparing по `performance.timeOrigin`
  + monotonic-таймеру, а не по `Date.now()` пользователя. Серверное время — единственный
  авторитетный `paid_until`; gрейс закрывается при первом успешном `/tokens/info`.
- `/tokens/info` отдаёт `grace_until` — серверная граница, чтобы клиент не «удлинял» грейс бесконечно.

### 5.4 i18n

Новые ключи в `vault-desktop/src/locales/ru.js` (и `en.js`) — продолжение серии `relay_*`:

```
pro_title, pro_trial_left, pro_active_until, pro_expired_warn, pro_free_limit,
pro_buy, pro_renew, pro_offline_badge, pro_daily_left, pro_devices
```

---

## 6. Безопасность

| Угроза | Защита |
|---|---|
| Подделка токена | HMAC-SHA256 по server_key; в v2 MAC покрывает `plan`+`sub`+`paid_until` → подмена тарифа ломает подпись. `parse` = `ct_eq` (constant-time, уже есть `tokens.rs:196`) |
| Перехват | TLS 443 обязательно (уже `relay-protocol.md` §4) |
| Повторная оплата | Идемпотентный `checkout_id` (один `fp`+`plan` → один чекаут); verify идемпотентен по `sub` |
| Шаринг токена | `token_bindings` (fp), лимит устройств по `sub`. v1-токены — как сейчас, 1 fp |
| Отмена оплаты | `PayStatus::Refunded` → сервер добавляет `sub` в `revoked_subs`; проверяется в `relay_pub`/`relay_poll` |
| Подмена часов клиентом | Серверное `now()` — авторитет; клиентский grace ограничен 7 сутками и `grace_until` с сервера |
| Развязка при рестарте сервера | **Персистентность** подписок и привязок (раздел 7, шаг 2) — сейчас всё in-memory |
| Утечка логов | Не логировать: значения токенов, fp, `payment_url`, тела конвертов. Образец уже есть: `main.rs:665` пишет только `register: token issued (unlimited=…, days=…)` — без значений. Метрики (`Metrics` в `main.rs`) — только счётчики, без идентификаторов |
| Корреляция метаданных | Осознанное ограничение MVP (`relay-protocol.md` §9.3) — актуально и для платных: релей не должен связывать оплату и переписку. `sub` — opaque, не email |

---

## 7. План внедрения (порядок разработки)

> Каждый шаг оставляет репозиторий компилируемым (`cargo check` зелёный после шага).
> Прежде чем трогать код — проверить `cargo check --release` и дымовые тесты
> (`vault-desktop/scripts/calls-smoke.mjs`, `video-smoke.mjs`).

**Шаг 1. `tokens.rs`: v2-формат.**
Добавить `Plan`, `V1_LEN`/`V2_LEN`, `issue_v2`, расширить `parse` (длина → версия).
Существующие тесты tokens не должны сломаться — v1-парсинг не меняется.

**Шаг 2. Персистентность (критично!).**
`store.rs` и `AppState` — in-memory. Добавить хранилище ( sled / RocksDB /
`sqlite`) для: `subscriptions { sub, plan, paid_until, revoked }`,
`token_bindings`, `device_count`. Перенести туда существующую логику
`check_token_binding`. **Без этого шага платные токены теряются при рестарте релея.**

**Шаг 3. `main.rs`: plan-aware лимиты.**
Заменить expiry-хак в `publisher_key` на `t.plan`. Подставлять лимиты тарифа
в `daily_pub`-гейт (`main.rs:216-241`) и TTL/очередь (`main.rs:246`, `MAX_QUEUE`).

**Шаг 4. Новые роуты.**
`/relay/purchase/{checkout,verify}`, `/relay/tokens/activate`, `/relay/tokens/info`
(раздел 3). Регистрация в `Router::new()` (`main.rs:710`). Под `VAULT_RELAY_PAYMENTS=0`
— всё отдаёт 402, как сейчас.

**Шаг 5. `PaymentProvider` + стаб.**
Трейт + `TestProvider` (мгновенно `Paid` по фиксированному `checkout_id`) —
**тестовые токены plan=Pro без реальной оплаты**. ЮKassa/RevenueCat/Stripe —
пустые заглушки, возвращающие `unavailable`, пока нет ИП.

**Шаг 6. `bin/gen_token.rs`.**
Расширить CLI: `vault-relay-gen <key> read|write <days> [count] --plan pro --sub <id> --months 12`.
Нужно для ручной выдачи тестерам и поддержки (промо сегодня = промо-ключ в
`relay_register`; завтра — `plan=Pro` на N дней).

**Шаг 7. Клиент `relay-client.js`.**
Функции раздела 5.2 + KV `relay-pro-state` + 7-дневный офлайн-грейс по monotonic-часам.

**Шаг 8. UI `SettingsPage.vue` + i18n.**
Экран покупки (раздел 5.1), ключи `pro_*` в `locales/ru.js` и `locales/en.js`.

**Шаг 9. Тесты.**
- Rust unit: `parse` v1/v2, MAC-подделка `plan`-байта → None, лимиты тарифа,
  идемпотентность checkout, device_limit, revoked_sub.
- Интеграционный `relay-server/tests/` (сейчас только `integration.sh`):
  чекаут → verify → activate → pub сверх Free-лимита проходит на Pro.
- Клиентский дымовой тест рядом с `scripts/calls-smoke.mjs`: мок `/purchase/verify`
  + `fetchTokenInfo` + грейс при недоступном релее.

---

## 8. Что НЕ входит в 0.6.2

- Платные **каналы** (ROADMAP §4 модель 1, M2) — отдельный этап; токены каналов
  остаются capability-токенами, платности не имеют.
- Маркетплейс мини-приложений (M3), enterprise-лицензии (M4+).
- Реферальная программа («пригласи друга → месяц Pro») — `monetization-plan.md:91`,
  можно добавить после отладки оплаты (проще всего — промо-ключ на 30 дней).
- Донаты (Delta Chat-стиль) — не требуют токенов, отдельная кнопка.

---

## 9. Риски и решения

| Риск | Решение |
|---|---|
| ЮKassa заблокирует/затянет онбординг ИП | Стартуем с `VAULT_RELAY_PAYMENTS=0`, весь флоу работает в test-режиме (`TestProvider`); включаем одним env-флагом без релиза |
| Google Play отклонит биллинг вне Play | На Android — только Play Billing (4.2); Stripe/ЮKassa — сборочным флагом `#ifdef` |
| Релей упал → «купил, но не работает» | Почта остаётся каналом истины (`relay-protocol.md` §3): 429/402 = тихая деградация, ничего не теряется. Это уже записано в `relay_off_warn` (`ru.js:71`) — не меняем |
| Цена отпугнёт free-базу | Free остаётся полностью рабочим: 100 конвертов/сут + 30-дневный trial = покрывает 95% личного использования. Платим только за объём |
| fp-привязка мешает смене устройства | `/tokens/activate` с device-лимитом тарифа; перенос устройства = «отвязать старое» в UI (добавить в шаг 8) |

---

*Документ создан 25.09.2026 на основе ручного аудита кода:
`relay-server/src/{tokens.rs, main.rs, store.rs, bin/gen_token.rs}`,
`vault-desktop/src/{relay-client.js, components/SettingsPage.vue, locales/ru.js}`,
`docs/design/relay-protocol.md`, `docs/ROADMAP-2026-08-16.md`,
`docs/promotion/monetization-plan.md`.*
