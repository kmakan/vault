# Доставка звонков/уведомлений НЕЗАВИСИМО от релея

Ветка: `feature/fcm-part-b`. Android-дерево: `src-tauri/gen/android` (Kotlin) + `src-tauri/src` (Rust) + `src` (JS).

**Суть:** эко-режим больше не означает «служба мертва». Служба `VaultForegroundService` остаётся жить
в **тихом** режиме (quiet FGS, канал `IMPORTANCE_MIN`) и каждые 60 с сама опрашивает
`GET <relay>/health`. Релей жив → эко (быстро, экономно). Релей мёртв → **тот же сервис**
переключается в уже существующий классический путь (`wake+wifi locks` + `nativeStartMonitor`,
т.е. headless IMAP IDLE из `service_monitor.rs`) = доставка по почте. Релей ожил → возврат в эко.

---

## (i) КАК РАБОТАЕТ СЕЙЧАС

### Классический путь (без эко) — «доставка почтой + служба Vault»

| Шаг | Файл:строка | Что делает |
|---|---|---|
| Старт службы | `MainActivity.kt:307-320` (`onCreate`, ветка `!ecoOn`) | `startForegroundService(VaultForegroundService)` |
| Wake/wifi locks | `VaultForegroundService.kt:95` `acquireLocks()` (вызов из `onCreate`) | `PARTIAL_WAKE_LOCK "vault:idle-wake"` + `WifiLock HIGH_PERF` — без них CPU/сеть засыпают и IMAP IDLE не читается |
| FGS + уведомление | `VaultForegroundService.kt:281-296` (`onStartCommand`, `!ecoMode`) | `startForeground(NOTIF_ID=9001, buildNotification(), DATA_SYNC)`; канал `vault_foreground` |
| **Монитор новых писем** | `VaultForegroundService.kt:121` `startHeadlessMonitor()` → `nativeStartMonitor(dataDir)` (строка 123) | JNI в Rust `service_monitor.rs:99` `Java_..._nativeStartMonitor` → tokio-таска `run_loop`: **IMAP IDLE + `fetch_newer` каждые 7с** (`IDLE_TICK`), расшифровка ключами из `$dataDir/.vault/keys`, курсоры в `monitor.db` |
| Доставка сообщения | `service_monitor.rs` → JNI `VaultForegroundService.showMessage()` | системное уведомление `vault_messages` / id 9003 |
| Доставка звонка | `service_monitor.rs:1140` (`typ == "call_request"`) → JNI `showIncomingCall()` (`VaultForegroundService.kt:1769`) | рингтон + FGS `phoneCall` + full-screen intent + экран принятия |
| Пауза при живом UI | `MainActivity.onResume/onDestroy` → `nativePauseMonitor` | пока activity жива, доставку делает JS, монитор молчит (дедуп) |
| Перезапуск после OEM-убийства | `onDestroy:150-153` / `onTaskRemoved:167-173` → `scheduleRestart()` (`VaultForegroundService.kt:970`) | `AlarmManager ELAPSED_REALTIME_WAKEUP +3с`, `START_STICKY` |

**Итог классики:** фоновая доставка **не зависит от релея вообще** — только IMAP. Релей тут
только ускоряет (копия конверта приходит за ~1с вместо 30-60с).

### Эко-путь (релей жив) — ДО правки

| Шаг | Файл:строка (ДО правки) | Что делает |
|---|---|---|
| Включение эко из UI | `src/features/relay.js:329` `onEcoMode(ctx, true)` | `api.idleStop()`; `api.pushSet(false)`; **`api.ecoSet(true)`** |
| JNI мост | `src-tauri/src/lib.rs:82` `eco_set` → строка 98: `method = if enabled { "ecoStop" } else { "ecoStart" }` | вызов статики `VaultForegroundService` |
| Гашение службы | `VaultForegroundService.ecoStop()` | `stopService(...)` + `stopForeground(REMOVE)` + `nativeStopMonitor()` + `releaseLocks()` |
| Не стартовать при открытии | `MainActivity.onCreate`, `if (ecoOn)` | сервис **не поднимается вообще** |
| Не воскрешать | `onDestroy` / `onTaskRemoved`, `if (ecoMode)` | ни `scheduleRestart`, ни ничего — сервис мёртв окончательно |
| Self-stop в эко | `onStartCommand`, ветка `ecoMode` | `stopSelf(); return START_NOT_STICKY` |
| Что оставалось как канал | релей-тикер в JS (`src/features/relay.js:114` `startRelayTicker`, 5с) + FCM (`VaultFirebaseMessagingService.kt`) | **оба живут только внутри процесса/WebView** |

### Что именно отключала эко-логика (ДО правки) — и почему это ломало доставку

1. `ecoStop()` → `context.stopService(...)` — **убивался единственный носитель доставки**.
2. `onStartCommand` (eco) → `stopSelf()` — любой `START_STICKY`-рестарт системы тоже self-stop.
3. `MainActivity.onCreate` (eco) → сервис не стартует.
4. `onDestroy`/`onTaskRemoved` (eco) → **нет** `scheduleRestart` → AlarmManager-будильника нет.
5. `pushModeStop()` (eco) → `ecoStop()`.

Ключевой момент: **проверка «жив ли релей» была только в JS** —
`src/features/relay.js:146-149` (`_relayFails >= 3 → enterRelayOfflineRescue`),

### Эко-путь — ПОСЛЕ правки (эта работа)

| Шаг | Файл:строка | Что делает |
|---|---|---|
| Тихий FGS в эко | `VaultForegroundService.kt:284-306` (`onStartCommand`, ветка `ecoMode`) | `startForeground(NOTIF_ID, buildQuietNotification(), DATA_SYNC)` — канал `vault_service_quiet_min` (`IMPORTANCE_MIN`, не рендерится в шторке) **вместо** `stopSelf()` |
| Арматура health-чека | `VaultForegroundService.kt:1055` `enterEcoRelayWatch()` → `scheduleEcoHealthCheck()` (`:1083`) | `AlarmManager.setExactAndAllowWhileIdle(ELAPSED_REALTIME_WAKEUP, +60с)`, `PendingIntent.getService` с `ACTION_ECO_HEALTH` (`com.vault.vault.ECO_HEALTH`, `:1303`), requestCode 1 (не конфликтует с `scheduleRestart` requestCode 0) |
| Срабатывание будильника | `onStartCommand:183` (`intent.action == ACTION_ECO_HEALTH`) → `onEcoHealthAlarm()` (`:1119`) → демон-поток `vault-eco-watch` → `runEcoHealthDecision()` (`:1137`) | сеть **не на main-потоке** (иначе ANR на 5с connectTimeout) |
| Health-чек | `probeRelayHealth()` (`:1173`) | `GET <relay>/health`, 5с — **тот же контракт**, что `relayHealthUrl()` в `src/relay-client.js:262-267`; URL берётся из prefs `fcm_relay_url` (его пишет JS-мост `VaultFcm.register` → `VaultFirebaseMessagingService.setRelayCredentials`), дефолт `https://vault-msg.ru/relay` |
| Фолбэк в почту | `enterRelayFallbackMail()` (`:1204`) | 3 неудачи подряд (`ECO_HEALTH_FAIL_LIMIT`) → `mailFallbackActive=true` (персист в `eco_mail_fallback`) + `ecoMode=false` + `acquireLocks()` + `startHeadlessMonitor()` + обычный FGS |
| Возврат в эко | `leaveRelayFallbackMail()` (`:1263`) | успешный `/health` → `nativeStopMonitor()` + `releaseLocks()` + тихий FGS + `enterEcoRelayWatch()` |
| Anti-flap | `:1034` `ECO_HEALTH_FAIL_RETRY = 6` | в фолбэке порог выше (6 неудач), будильник вдвое реже (120с) — не «дёргаем» IMAP-монитор |

Флаги состояния: `relayHealthFails` (`@Volatile`), `mailFallbackActive` (`@Volatile`),
персист — prefs `eco_mail_fallback` + `eco_relay_fails`.

### Ничего не тронуто (по требованию)

- SMTP/IMAP-транспорт `src-tauri/src/email.rs` — не тронут.
- `service_monitor.rs` (логика headless-монитора) — не тронут.
- Крипто, wire-формат конвертов, `tauri.conf.json`, список зависимостей, `vault-android/` — не тронуты.
- Правка S6 (`@Volatile callActive`, `:1325`; ранний выход в `ecoStop`, `:593`) — **сохранена**
  и дополнительно продублирована в новых путях (`enterRelayFallbackMail`, `:1210`;

---

## (ii) ИЗМЕНЕНИЯ

### `src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultForegroundService.kt`

| Строки | Изменение | Зачем |
|---|---|---|
| `47-64` (`onCreate`) | читаем персист `eco_mail_fallback`; если фолбэк был активен — стартуем в **классическом** режиме и взводим recovery-watch | фолбэк переживает OEM-убийство процесса; иначе после убийства доставка снова замолчала бы до первого успешного health-чека |
| `95-119` | **вынесено** `acquireLocks()` из `onCreate` | eco-фолбэк включает почтовую доставку **на живом сервисе**, без пересоздания процесса и без обрыва звонка |
| `121-127` | **вынесено** `startHeadlessMonitor()` из `onStartCommand` | то же — для фолбэка; поведение классики не изменилось |
| `130-156` (`onDestroy`) | в эко вместо «не воскрешать» — `scheduleEcoHealthCheck()` | после смерти сервиса health-чек всё равно сработает (PendingIntent живёт в системе) |
| `162-174` (`onTaskRemoved`) | в эко вместо «не воскрешать» — `scheduleEcoHealthCheck()` | то же после смахивания из recents |
| `176-216` (`onStartCommand`) | **новое**: ветка `ACTION_ECO_HEALTH` — обрабатывается первой; игнор при выключенном эко; `startForeground(quiet)` для контракта foregroundService | доставка перестаёт зависеть от живого WebView |
| `217-306` (`onStartCommand`, `ecoMode`) | **`stopSelf()` убран** → тихий FGS + `enterEcoRelayWatch()`; call-mode отдаёт `START_STICKY` вместо `NOT_STICKY` | **главный фикс**: сервис в эко жив → может заметить падение релея |
| `586-651` (`ecoStop`) | **`stopService()` убран**: живой сервис → quiet-режим; нет сервиса → поднимаем в quiet-режиме; при активном фолбэке (JS уже подтвердил здоровье релея) → `leaveRelayFallbackMail()` | эко больше не уничтожает носитель доставки |
| `686-701` (`ecoStart`) | гасим eco-будильник, чистим `mailFallbackActive`/`relayHealthFails`/персист | эко выключили по-настоящему — health-чек больше не нужен |
| `1027-1303` | **новая секция «ЭКО-НЕЗАВИСИМОСТЬ»**: константы, `enterEcoRelayWatch`, `cancelEcoHealthCheck`, `scheduleEcoHealthCheck`, `onEcoHealthAlarm`, `runEcoHealthDecision`, `probeRelayHealth`, `enterRelayFallbackMail`, `leaveRelayFallbackMail`, `ACTION_ECO_HEALTH` | переиспользует существующий `/health`, существующий `AlarmManager`-будильник (`scheduleRestart`) и существующий классический режим; новых сервисов/зависимостей/протоколов нет |
| `1993-2020` (`dismissIncomingCall`) | в эко вместо `stopSelf()` — возврат в тихий FGS + `enterEcoRelayWatch()`; при активном фолбэке остаёмся в почтовом режиме | после звонка в эко не остаётся «ничего» |

### `src-tauri/gen/android/app/src/main/java/com/vault/vault/MainActivity.kt`

| Строки | Изменение | Зачем |
|---|---|---|
| `290-312` (`onCreate`) | в эко **стартуем тихий сервис** + `enterEcoRelayWatch(this)` (было: «не стартуем вовсе») | health-чек должен существовать с первого запуска |
| `586-600` (`onDestroy`) | при `ecoModeEnabled` → `enterEcoRelayWatch(applicationContext)` | activity уничтожена, но релей продолжает опрашиваться |

### `src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultBootReceiver.kt`

| Строки | Изменение | Зачем |
|---|---|---|
| `19-36` | при `eco_mode=true` (и `push_mode=false`) поднимаем тихий сервис + `enterEcoRelayWatch` | после ребута, когда релей не поднялся вместе с телефоном, звонки не должны ждать ручного открытия приложения |

### `src/features/relay.js`

| Строки | Изменение | Зачем |
|---|---|---|
| `164-186` (`enterRelayOfflineRescue`) | только комментарии: этот rescue живёт **только при живом UI**; переключение в фоне делает нативный eco-watch | документация фактических границ JS-пути |
| `344-349` (`onEcoMode`, eco-ветка) | комментарий: `api.ecoSet(true)` → тихий режим, а не «остановка службы» | фиксирует новый контракт `eco_set` |

### `src/locales/{ru,en,zh}.js` (строка 68, `eco_on_toast`)

Текст тоста больше не обещает «фоновое соединение остановлено» — теперь «доставка через релей,
если релей лежит — доставка по почте». Только UI-строка, логика не затронута.

### `src-tauri/gen/android/app/proguard-rules.pro` (`+9`, перед блоком `pushModeStart`)

`-keepclassmembers` на `enterEcoRelayWatch` / `cancelEcoHealthCheck`. Вызываются из Kotlin,
R8 обычно держит их сам, но эко-health-чек — тихая точка отказа доставки, держим явно.

### Не изменялось намеренно

`src-tauri/src/lib.rs` (`eco_set`/`push_set` — сигнатуры и JNI-вызовы прежние),
`src-tauri/src/email.rs`, `src-tauri/src/service_monitor.rs`, `src/relay-client.js`
(health-чек нативно повторяет существующий контракт, новый JS-API не заводился),
`src-tauri/tauri.conf.json`, зависимости, `vault-android/`.

  `dismissIncomingCall`, `:1974`) и в `onStartCommand` (call-mode → `START_STICKY`).

а JS исполняется только в живом WebView. Стоит процессу уснуть — падение релея
обнаруживать **некому**, и `enterRelayOfflineRescue` (строка 164) недостижим.
Ровно это и показал стенд: при `systemctl stop vault-relay` в logcat **ноль строк** —
приложение спало, `VaultRust`/`VaultFCM` молчали, письмо-вызов лежало непрочитанным.
