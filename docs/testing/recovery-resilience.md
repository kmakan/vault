---
title: Recovery-resilience — безопасный onboarding и ограниченный TLS full-scan
date: 2026-10-10
status: branch-verification
branch: fix/recovery-resilience
---

# Recovery-resilience — инженерный runbook (branch-verification)

> Статус `branch-verification`: код и перечисленные гейты проверены PM,
> но патч не установлен на устройство и не опубликован как новый релиз.
> Проверки патча идут без реальных ящиков/секретов: живой Vue с синтетическим
> IPC и localhost TLS-IMAP. Read-only осмотр X50 относится к старой 0.1.219.

## 0. Контекст и границы

- Ветка: `fix/recovery-resilience`, база `release/public` = `c22b82c`.
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

PM: cargo check/build/fmt прошли; **94 lib-теста passed, 0 failed**
(86 прежних + 8 TLS/full-scan). Полный shipping-крейт прошёл
`cargo check --target aarch64-linux-android --offline` с NDK 27.0.12077973.
Это компиляция Android/TLS кода, НЕ Android TLS runtime и НЕ готовый APK.
Сборку/установку APK этот документ НЕ описывает и НЕ обещает.

## 4. Уже подтверждено ранее (B6b, 09.10) — НЕ считать незавершённым Leg B

- synthetic users 11/12 на эмуляторе; восстановленная keypair совпала; 15s;
  346 сообщений / 80 кандидатов.
- НЕ доказано полной проверкой: контакты/группы (в тесте было 0 контактов);
  смена пароля ящика; файловый import.
- X50 данные НЕ удалять; `pm clear` НЕ запускать.

## 5. Safety onboarding — t_b5da2e97 (код проверен, device review впереди)

- `features/recovery-session.js`: несекретный persisted-флаг
  `vault-recovery-pending=1` ДО login, после проверки слов. Отсутствие
  подтверждённой записи флага блокирует connect/import (fail closed).
- `api.login({deferPersistence:true})`: подключение/сессия только в RAM,
  никаких token/email/credentials/legacy migration до импорта.
- Startup/auto-login при pending не загружают credentials и не генерируют
  новую личность. Обычный login также не обходит pending.
- `initCrypto({allowCreate:false})`: только загрузка. Создание X25519
  разрешено лишь явному обычному login, а не mounted/recovery/auto-login.
- Backup обязан содержать допустимую identity keypair ДО import; после
  import загруженный publicKey сравнивается с keypair именно этого backup.
  `{}` или прежний посторонний ключ не могут дать ложный restore success.
- File import failure виден в UI, без попытки другого escrow. Commit
  выполняется после import + key reload, флаг снимается последним и
  проверяется read-back. Failure/restart сохраняет флаг; старые credentials
  не удаляются. Сбой после начала commit может оставить новые token/email,
  но флаг всё равно блокирует auto-login.
- PM исправила ошибку Cline wiring `t` → `this.t`: компиляция и тест
  изолированного feature-модуля не ловили ReferenceError на кнопке. Теперь
  smoke исполняет сам делегат App, не только проверяет regex на импорт.

Гейт: `cd vault-desktop && node scripts/recovery-session-smoke.mjs`:
**141 pass, 0 fail**. Это реальные JS-модули/методы, моки native/crypto,
НЕ Rust disk-import или Android E2E. `recovery-smoke.mjs`: **23/0**;
template-check **28 компонентов**, Vite green.

Реальный Vue в браузере, синтетический Tauri boundary, проверено:
1. fetch error → видимая ошибка, 0 generate/import/save_credentials;
2. reload после отказа → recovery-форма, 0 credential load/generate;
3. import error → видимая ошибка, флаг остаётся, 0 generate/save_credentials;
4. success → import → reload того же publicKey → save_credentials,
   0 generate, cryptoReady=true, флаг снят.

На X50 через ADB проверена только прежняя **0.1.219**: запуск приложения,
портрет 360×800, login-screen отсутствует, в DOM 8 contact-item.
Не устанавливались APK, не импортировались ключи, не очищались данные.
`groupsRendered=0` на вкладке контактов НЕ означает «групп нет».

## 6. Full-scan — t_fabe43e0 (ограничение wire-path, не причинность Gmail)

- LIST + INBOX(250) + Junk(150) + Self(100) + final SELECT INBOX целиком в
  `spawn_blocking` на owned session; общий production-бюджет **30с**.
- Deadline/future-drop вызывает реальный TCP `shutdown(Both)` через
  RAII guard. JoinHandle-drop сам по себе running worker не останавливает.
  Session/cancellation handle/selected_folder инвалидируются на error;
  late worker не может вернуть сессию в клиент. На success они возвращаются.
- LIST и сетевой сбой optional-folder больше не выдаются за пустой ящик.
  Отсутствующая optional-folder пропускается; UID/headers/dedup/лимиты
  сохранены; Sent/All не сканируются.
- Busy slot возвращает явную ошибку, не `Ok([])`. Нет скрытого немедленного
  75с retry; следующий deliberate scan вызывает ensure_connected с backoff.
- **30с — бюджет самого скана после соединения, не всего CONNECT**.
  DNS/TCP/TLS/login используют прежний синхронный connect и per-read
  timeout; глобальную отмену этого этапа текущий патч не реализует.

Тесты: `src-tauri/src/email/full_scan_tests.rs`, 8 тестов, localhost TLS,
самоподписанный CA/key только в RAM. Certificate/hostname validation
включены; тест доверяет своему CA, никаких production TLS bypass.

- Reproducer старого механизма: `timeout(40ms)` вокруг sync wire-body
  вернулся лишь через **356.89ms** (socket timeout 350ms), heartbeat starved.
  Это демонстрация дефекта, не запуск исторической версии на Gmail.
- LIST/SELECT/SEARCH/FETCH/final SELECT stall: **121.19–121.36ms** при
  бюджете 120ms, heartbeat жив. Peer EOF проверен; sentinel на единственном
  blocking-потоке доказывает, что worker действительно вышел.
- Drip без tagged completion, внешняя отмена future, healthy headers/empty
  subject/dedup/session, missing optional vs broken Junk/Self, два timeout
  с последующим healthy TLS reconnect, busy/disconnected ошибки — green.
- Reconnect fixture использует тот же connect_imap_with_tls с trust своего
  CA; deadline backoff в тесте сдвигается в прошлое, не реальная сеть/Gmail.

**Не закрывать t_fabe43e0 утверждением «причина Gmail доказана»:** общий
bounded full-scan реализован/проверен; конкретный эпизод 09.10 и device
приёмка новой сборки ещё не подтверждены.

## 7. Оставшиеся границы

- `import_backup` последовательно пишет keypair/peers/SQLite. JS guard не
  делает Rust disk-import транзакцией: I/O-сбой после первой записи может
  оставить частичный backup. Не заявлять rollback старой личности/данных
  доказанным; нужен отдельный staged import + rollback/fault-injection гейт.
- Новая сборка не установленa на X50, публичная версия остаётся 0.1.219.
  До безопасной device-приёмки не merge в stable, не публиковать релиз.
- Step 5 Preview safety-прогон завершён, full-scan-прогон упал по
  `429 Daily free limit reached` с частичными правками. PM довела Rust
  вручную и повторила реальные гейты; отчёт Cline не заменяет верификацию.
