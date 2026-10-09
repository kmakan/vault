---
title: Recovery-resilience — воспроизведение и проверка двух defect без реальных данных
date: 2026-10-10
status: branch-verification
branch: fix/recovery-resilience
---

# Recovery-resilience — инженерный runbook (branch-verification)

> Статус `branch-verification`: код и перечисленные гейты проверены PM,
> но патч не установлен на устройство и не опубликован как новый релиз.
> Все проверки идут без реальных ящиков/секретов: моки (desktop) и синтетика (rust).

## 0. Контекст и границы

- Ветка: `fix/recovery-resilience`. Последняя публичная точка: `c22b82c`.
- Последний опубликованный релиз: **v0.1.219** (tag `1bddd31`) — уже на обеих
  площадках; GitHub `/releases/latest` → `/tag/v0.1.219`; `latest.json` на
  vault-msg.ru и .tech = `0.1.219` (09.10). Артефакты (APK / tar.gz) отдаёт
  RU-хаб `vault-msg.ru/releases/`, HTTP 200; Privacy/Terms обе локали HTTP 200.
- На `.tech` отдельного `/releases/` нет (404) — это НЕ баг загрузки: ссылки
  намеренно ведут на RU artifact hub.
- Данный патч релиза ещё НЕ выпускал; ссылок на его релиз здесь НЕТ и их НЕ
  выдумывать. X50 данные НЕ удалять, `pm clear` НЕ запускать.

## 1. Defect t_6f01962a — устойчивость recoverFromEscrow (desktop, моки)

Сверено read-only по `vault-desktop/src/features/recovery.js`:

- `recoverFromEscrow(ctx, mnemonic, { api, crypto, invoke })` — отдельный
  модуль-фича; `App.vue` — только делегат (все зависимости инъекцией).
- Проверка мнемоники ДО запроса писем (validate before fetch).
- Кандидаты: только пустые `subject`, лимит 80 (`slice(0, 80)`).
- Группировка по `folder`; UID → строки (`uids.map(String)`).
- `parse`/`unwrap` ОТДЕЛЬНОГО кандидата в try/catch: чужое/битое письмо
  пропускается (skip), не обрывает поиск правильного.
- `import_backup` — ВНЕ candidate-catch (меняет дисковое состояние): ошибка
  пробрасывается вызывающему, потенциально частичный import НЕ продолжается.
- Исчерпание кандидатов → `false`.
- `api.fetchEmails` (шаг fetch) без try/catch → reject к вызывающему.
- `email_fetch_bodies` одной папки в try/catch → skip, переход к след. папке.
- Логи НЕ содержат тело письма / backup / слова / текст ошибок.

Команда (моки, без реальной сети и дисковых данных):

```bash
cd /home/maksim/whisper/vault-desktop && node scripts/recovery-smoke.mjs && npm run build
```

PM: **23 pass, 0 fail**; template-check **28 компонентов**, Vite build green.
Коммит: **029edd0**. Критерии:

- Тест лимита поправлен PM: mock обращался к `state` до инициализации,
  а production-catch проглатывал ReferenceError. Теперь независимая fixture
  возвращает 80 тел; отдельная проверка требует `parseCalls === 80`.
- Наличие кейсов: validate-before-fetch; лимит 80; пустые subject; folder
  grouping; UID-строки; `false` при исчерпании; reject при ошибке
  `fetchEmails`; skip parse/unwrap чужого письма; проброс ошибки
  `import_backup`.
- `npm run build` ранее проходил (наблюдение PM), но это НЕ on-device приёмка
  — поведение на устройстве этим не подтверждается.

## 2. Defect t_2d0ae2b3 — потеря read-timeout после IDLE (vendor/imap)

Сверено read-only по `vendor/imap/src/extensions/idle.rs`:

- История: зависание на ящике (8422 письма), 13+ мин sleeping TCP established.
  Конкретный эпизод НЕ воспроизведён — проверяется независимый defect.
- `connect_imap` уже ставит socket read/write = 30s. Но `idle.rs::timed_wait`
  БЕЗУСЛОВНО вызывал `set_read_timeout(None)` после `wait_inner`, ДО
  `Drop::terminate()` (чтение ответа DONE); далее команды шли unbounded.
- Фикс: getter `SetReadTimeout::read_timeout` + перегрузки Tcp/TLS;
  сохранённое значение восстанавливается на Ok и Err.
  - default getter `Ok(None)` — обратная совместимость кастомных транспортов;
    кастомный persistent timeout требует перегрузки getter.
- ВАЖНО: НЕ считать, что tokio timeout прерывает sync read — imap 2.4.1
  блокирующий, `t_timeout` может быть неэффективен.
- Таймаут-тесты лежат инлайн в `idle.rs`: живые вызовы Client/login/IDLE,
  fake-stream отдаёт по байту, поэтому DONE-read не скрывается read-ahead.
- **t_fabe43e0 остаётся открытой**: исходное зависание full-scan не воспроизведено.
  IDLE использует EmailState.2, полный скан — .0; найденный дефект нельзя
  объявлять доказанной причиной конкретного Gmail-инцидента.

Команды:

```
cd /home/maksim/whisper && cargo test --manifest-path vendor/imap/Cargo.toml --lib --offline
cd /home/maksim/whisper && cargo check --manifest-path vendor/imap/Cargo.toml --offline
```

PM: **58 passed, 0 failed** (51 прежний + 7 новых); cargo check с TLS и
без default features прошёл. Коммит: **054f41b**. Критерии:

- Сохранённый timeout восстанавливается на Ok и Err (Drop/terminate read
  ограничен восстановленным timeout, не None).
- Два последовательных wait с разными idle-timeout НЕ перезатирают исходный
  30s (нет утечки None).
- Геттер `TcpStream` делегирует реальному сокету (loopback, без внешней сети).
- Getter TLS проверен вычиткой делегации и компиляцией, без живого TLS-теста.
- Android aarch64 cargo check vendored IMAP без default features прошёл;
  это не проверка TLS на Android и не сборка APK.

Baseline vendor/imap: 51 lib-тест зелёный (данные PM). Существующие warning
`redundant_semicolons` в `client.rs` и future-incompat `imap-proto`/`nom` —
пред-существующие, НЕ считать newly fixed. Android-проверки — за менеджером.

## 3. Комплексный гейт src-tauri

```
cd /home/maksim/whisper/vault-desktop/src-tauri && cargo check --offline && cargo test --lib --offline
```

PM: cargo check и cargo build прошли; **86 lib-тестов passed, 0 failed**.
Сборку/установку APK этот документ НЕ описывает и НЕ обещает.

## 4. Уже подтверждено ранее (B6b, 09.10) — НЕ считать незавершённым Leg B

- synthetic users 11/12 на эмуляторе; восстановленная keypair совпала; 15s;
  346 сообщений / 80 кандидатов.
- НЕ доказано полной проверкой: контакты/группы (в тесте было 0 контактов);
  смена пароля ящика; файловый import.
- X50 данные НЕ удалять; `pm clear` НЕ запускать.

## 5. Открытая граница safety (вне текущих фиксов)

- `api.login` с `remember=true` пишет credential/localStorage ДО завершения
  recovery: при ошибке/рестарте auto-login может создать новую пару ключей.
  Поэтому recovery НЕ полностью безопасен при сбое — задача **t_b5da2e97**:
  атомарное завершение recovery-onboarding и failure/restart тест.
- Первый полный скан: busy-lock возвращает пусто (`lib.rs`
  `email_fetch_messages`) — отдельный future-тест recovery-vs-poll.
