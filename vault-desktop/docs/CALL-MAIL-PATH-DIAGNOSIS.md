# Диагноз: входящий звонок не доставляется, когда релей остановлен, а activity лишь в фоне

Дата разбора: 02.10.2026 · ветка `feature/fcm-part-b` · HEAD `b77ac72` (0.1.195)
Стенд: koanmak@gmail.com (десктоп, звонящий) → koanmak@ya.ru (X50, Android 11, эко-режим ВКЛ, релей ОСТАНОВЛЕН).

Только анализ. Код не менялся, не собирался, не коммитился.

---

## Кратко — три слоя, все воспроизводятся по коду

| # | Слой | Файл:строка | Что ломается |
|---|---|---|---|
| 1 | Нативный монитор | `service_monitor.rs:975` + `MainActivity.kt:269/497/587` (в `b77ac72`) | `paused` = «activity не уничтожена», а не «приложение видно». После Home монитор не классифицирует **ничего**, а письмо **уничтожается** безвозвратно (`HandledByJs` → `remove_pending` без `seen_push`) |
| 2 | Эко-режим | `App.vue:1717` + `relay.js:198/242` | В эко `idleLoop()` **не запускается** → не поднимаются ни IMAP IDLE, ни `loadEmailsFast`, ни Rust-`IdleMonitor`. Остаётся только поллинг; и `startPolling(60000)` — **no-op**, интервал остаётся 30 с |
| 3 | Разбор батча | `email.rs:513` + `incoming.js:28/92` + `calls.js:261/408` | Батч приходит **новыми сверху** (desc по UID). `call_cancel` разбирается **раньше** `call_request`, успевает записать `call-seen`, и поздний `call_request` гаснет на `isCallSeen` — без рингтона, без экрана |

> ⚠️ В рабочем дереве есть **незакоммиченная** правка `MainActivity.kt` (+21/−2) с `onStop()`, которая частично закрывает слой 1 — но она не собрана и на стенде не проверялась. Подробности в блоке «Важно про uncommitted-правку» в разделе (ii).

---

## (i) КАК РАБОТАЛО РАНЬШЕ

### Точка отсчёта

`4616a0c` — 2026-08-29 20:46:45 +0300 — «feat(android): 0.1.82 — headless IMAP-монитор в Rust-процессе FGS».
Именно здесь появился headless-монитор и **контракт паузы**.

Ключевой дифф (`git show 4616a0c -- MainActivity.kt`) вводит ровно ту схему, что живёт до сих пор:

- `onCreate` → `nativePauseMonitor(true)`;
- `onResume` → `nativePauseMonitor(true)`;
- `onPause` → пауза **не снимается**, комментарий: «JS keep-alive продолжает доставлять и свёрнутым»;
- `onDestroy` → `nativePauseMonitor(false)`.

Тогда это было корректно, потому что рядом появился компенсирующий механизм — `MainActivity.onPause` вызывает `keepAliveWebView?.onResume()` (строки 489-496), чтобы JS не вставал на паузу. Вся схема держалась на допущении:

> «пока activity жива — JS (keep-alive WebView) доставляет сам даже свёрнутым, монитор молчит до onDestroy».

Нативная ветка тогда срабатывала так (`service_monitor.rs:1141-1194`):

```
typ == "call_request" && fresh && call_get_state == None
  → call_set_state(..., "ringing", caller)
  → crate::audio::audio_android::show_incoming_call_notification(&caller)   // :1181
```

и больше **никаких** гейтов по видимости приложения не было — ни в Rust, ни в Kotlin.

### Что именно сломалось с тех пор

Обе «компенсации» позже были разобраны на части, и ни одна не заменила нативную ветку для фонового случая:

1. **`6240d03` (2026-09-30, S5-2)** — «call-UI по видимости приложения». Появился гейт `MainActivity.appVisible` в `showIncomingCall` (`VaultForegroundService.kt:1773`) и гейты `document.visibilityState === 'visible'` в `calls.js:305/312`. Логика верная (не дублировать), но она **подавляет нативный показ и в фоне** — потому что в фоне `visibilityState !== 'visible'`, а `appVisible === false`, и единственный носитель показа (натив) оказывается отключённым ровно тогда, когда он нужен.
2. **`a6f1485` (2026-10-01, S6)** — снят безусловный `dismissIncomingCall` из `onResume`. Это починило «Ответить → экран не появился», но оставило `paused` в прежнем состоянии.
3. **Эко-режим (`c51dbca` 0.1.180, `28a923a` 0.1.181, `b77ac72` 0.1.195)** — `App.vue:1717`:
   ```js
   this.startPolling()
   if (this.ecoMode) { this.startPolling(60000); this.startRelayTicker(); }
   else this.idleLoop();
   ```
   В эко ветка `idleLoop()` **не выполняется**. А `api.idleStart()` вызывается **только** из `idleLoop` (`relay.js:198`). Значит в эко не работают: IMAP IDLE, `loadEmailsFast` (`relay.js:224`), Rust-`IdleMonitor` (`lib.rs:431`, а значит и событие `mail-changed` → `App.vue:1618`). Доставка в эко = **только** `startPolling` → `loadEmails` → `processIncoming`.

Итог: контракт из `4616a0c` («JS доставит за activity») был написан под классический режим с живым `idleLoop`. В эко он остался, а страховки с другой стороны не стало.


---

## (ii) ЧТО СЕЙЧАС — цепочка вызовов, где теряется `call_request`

### Слой 1. Нативный монитор: `paused` трактуется как «activity жива»

Признак «activity alive» — единственный булев флаг `MonitorState.paused` (`service_monitor.rs:66`).

Кто его ставит (**номера строк — по РАБОЧЕМУ ДЕРЕВУ, см. блок «Важно про uncommitted-правку» ниже**):

| Момент | Файл:строка | Действие |
|---|---|---|
| `MainActivity.onCreate` | `MainActivity.kt:269` | `nativePauseMonitor(true)` |
| `MainActivity.onResume` | `MainActivity.kt:549` | `nativePauseMonitor(true)` |
| `MainActivity.onPause` | `MainActivity.kt:468-500` | паузу не снимает; комментарий 497-499: «Снятие паузы — в onStop» |
| `MainActivity.onDestroy` | `MainActivity.kt:602-606` | `nativePauseMonitor(false)` |

JNI → Rust: `service_monitor.rs:173-183` (`Java_com_vault_vault_MainActivity_nativePauseMonitor`), лог `[svc-monitor] paused={}`.

> ### ⚠️ Важно про uncommitted-правку в дереве
>
> На момент разбора `git status` показывает **незакоммиченную правку** `MainActivity.kt` (+21/−2), которая **уже реализует часть Правки 1**: добавлен `override fun onStop()` (`MainActivity.kt:509-518`), который делает `appVisible = false` + `nativePauseMonitor(false)` — то есть снимает паузу именно при невидимости приложения. Её комментарий (`502-508`) пересказывает корневой диагноз этого отчёта почти дословно.
>
> **Осторожно:** этот код **не собран и на стенде не проверен**. Номера строк в коммите `b77ac72` (который стоял на стенде как 0.1.195) для того же участка — `497-498` (комментарий в `onPause`) и `587` (`nativePauseMonitor(false)` в `onDestroy`); `onStop` там отсутствует. Ниже по тексту ссылки даны на рабочее дерево, если не указано иное.

**То есть после нажатия Home activity не уничтожена → `paused` остаётся `true`.** Это ровно то состояние, на котором стоял стенд (в коммите `b77ac72`, без `onStop`).

В рабочем дереве есть `onStop` (`MainActivity.kt:509-518`), который снимает паузу — но он **не в той сборке, что стояла на стенде**, поэтому весь анализ ниже относится к поведению `b77ac72`.

Дальше — `deliver_entry`, и это **первая** же проверка, до фетча тела, до расшифровки, до классификации:

```rust
// service_monitor.rs:973-977
async fn deliver_entry(ctx: &Ctx<'_>, e: &mut PendingEntry) -> Outcome {
    // Открыта MainActivity → JS сам доставляет и уведомляет.
    if monitor().paused.lock().map(|p| *p).unwrap_or(false) {
        return Outcome::HandledByJs;
    }
```

А `drain_pending` на `Outcome::HandledByJs` (**`service_monitor.rs:919-925`**):

```rust
Outcome::HandledByJs => {
    log::info!("[svc-monitor] handled by JS (activity alive): {}", entry.from);
    remove_pending(ctx, &entry.mid);       // ← БЕЗ seen_push
}
```

Сравните с `Delivered` (`:910-917`) и `Dead` (`:926-935`) — оба делают `seen_push`. **`HandledByJs` — единственная ветка, которая не помечает письмо доставленным.** При этом курсор IMAP уже продвинут выше по `run_loop` (`service_monitor.rs:613-616`, `save_cursors`), поэтому `fetch_newer` это письмо **больше никогда не вернёт**.

> **Письмо-вызов на нативной стороне уничтожено безвозвратно.** Ветка `show_incoming_call_notification` (`service_monitor.rs:1181`) недостижима, пока activity жива.

Это и есть строка `[svc-monitor] handled by JS (activity alive): koanmak@gmail.com` на стенде.

### Слой 2. В эко у JS нет быстрого канала — и таймер поллинга не тот

`App.vue:1717` в эко не вызывает `idleLoop()`, а значит не поднимаются:
- `api.idleStart(...)` → `relay.js:198` → Rust `IdleMonitor` (`lib.rs:431`) → событие `mail-changed` → `App.vue:1598-1618`;
- `loadEmailsFast` → `relay.js:224` (отдельный IMAP-клиент, «быстрый фетч для звонков»).

Плюс отдельный дефект: `startPolling` вызывается дважды подряд — `App.vue:1716` без аргумента, затем `App.vue:1717` с `60000`. Но `relay.js:242` — `if (ctx.pollTimer) return;`. Второй вызов **no-op**, интервал остаётся **30 с**, а не 60.

Итог: в эко при убитом релее единственный путь доставки — `loadEmails` раз в 30 секунд. Звонок, который звонящий снял через 7 секунд (04:19:09 → 04:19:16), физически не мог быть обработан раньше следующего тика.

### Слой 3. В батче `call_cancel` разбирается раньше `call_request` — и гасит его

Это и есть причина «JS увидел только `call_cancel`».

**Порядок в батче — новизна первой.** `fetch_newer` возвращает `messages.sort_by(|a, b| b.id.cmp(&a.id))` (`email.rs:513`) — по убыванию UID, то есть **от новых к старым**. `loadEmails` этот массив `fetched` не пересортировывает (сортируется только `merged` для UI, `App.vue:4975`) и передаёт в обработку как есть:

```js
// App.vue:5000
if (fetched.length) await this.processIncoming(fetched, { notify: silent });
```

`processIncoming` идёт по пулу в исходном порядке (`incoming.js:28`), а `handleCallSignal` вызывается **без `await`**:

```js
// incoming.js:90-94
const callSig = ctx.parseCallSignal(plain);
if (callSig) {
  ctx.handleCallSignal(callSig, from).catch(e => console.warn('[call] signal failed:', e));
  return null;
}
```

Значит `call_cancel` (UID больше, пришёл позже) запускает свой `handleCallSignal` **первым**, и он доходит до:

```js
// calls.js:402-409  (case 'call_cancel' / 'call_end' / 'call_reject')
// ЗАПОМНИТЬ ТЕРМИНАЛЬНЫЙ call_id ВСЕГДА ...
await rememberCallSeen(ctx, call_id);          // persist kv 'call-seen'
```

Почти сразу после этого `call_request` с **тем же** `call_id` доходит до своего guard:

```js
// calls.js:260-263
if (type === 'call_request' && !(ctx.currentCall && ctx.currentCall.call_id === call_id)) {
    if (await isCallSeen(ctx, call_id)) return;   // ← ТИХИЙ ВЫХОД
    await rememberCallSeen(ctx, call_id);
}
```

`rememberCallSeen` — это `kvGet` + `kvSet` (`calls.js:46-59`), `isCallSeen` — `kvGet` (`calls.js:38-44`). Так как `cancel` был запущен раньше, его `kvSet` успевает лечь до того, как `kvGet` запроса разрешится, и **`call_request` выходит на строке 261 — до `case 'call_request'` (`:273`), до `incoming_ringing` (`:296`), до `playCallSound` (`:306`) и до `mediaShowIncomingCall` (`:313`)**.

Отсюда ровно то, что на стенде: лог `[JS] [call] signal call_cancel muqgd45yof1i5qn6 ... state=idle current=null` — `currentCall` пуст, рингтона нет, уведомления нет, экрана нет.


### Слой 3б. Дополнительный признак: тело `call_request` не фетчилось

Стенд: `[fetch_bodies] folder=INBOX requested=1 returned=1 empty_uids=[]`. Этот лог — из `email.rs:712` (`fetch_bodies`), а он вызывается **только** из JS-пути `api.fetchEmailBodies` (`api.js:1221`) ← `ensureBodies` (`incoming.js:56`).

`requested=1` означает, что из всего батча тело подтянулось **для одного** письма. При этом `empty_uids=[]` — то есть отказа IMAP не было, «мёртвый uid» не отмечен. Значит тело `call_request` в `ctx.emailBodyCache` не попало, а `classify` на нём молча уходит:

```js
// incoming.js:76-77
const body = ctx.emailBodyCache[`${m.folder || 'INBOX'}:${m.uid || m.id}`] || '';
if (!body || !crypto.isEncrypted(body)) return null;      // ← БЕЗ ЛОГА
```

Это **единственные** «тихие» точки отбрасывания на пути `fetch → handleCallSignal` (кроме `ensureBodies:61`, где `catch (e) { /* тела не обязательны */ }` тоже молчит, и `processIncoming:24` с гейтом `cryptoReady`, но тот выкинул бы и `call_cancel` тоже).

Смежный дефект, который усиливает неопределённость: `EmailMessage` в Rust имеет поле **`id`** (`email.rs:56`), а поля `uid` нет. В JS почти везде стоит `m.uid || m.id`, но в дедупах используется голое `m.uid`:

- `App.vue:4946,4957` — `const k = m.uid + '|' + (m.folder || 'INBOX')` → для **всех** писем `k === "undefined|INBOX"`;
- `relay.js:91-92` — то же;
- `incoming.js:265` — `const mid = m.uid + '|' + ...` → то же.

То есть ключ дедупа писем в UI-списке и в счётчике непрочитанных у всех писем одинаковый. На разбор звонка это не влияет напрямую, но делает `[fetch_bodies] requested=1` плохо интерпретируемым и затягивает диагностику.

### Сводная цепочка (файл:строка)

```
IMAP: письмо call_request лежит в INBOX
  │
  ├─ Rust monitor: run_loop (service_monitor.rs:610) → ingest_message (:871) → drain_pending (:900)
  │    └─ deliver_entry (:973) → paused==true (MainActivity.kt:269/530, НЕ снят в onPause :497)
  │         └─ return Outcome::HandledByJs (:975-977)
  │              └─ drain_pending: remove_pending БЕЗ seen_push (:919-925)
  │                   └─ курсор уже продвинут (:613-616) → письмо больше НИКОГДА не вернётся нативно
  │                        (show_incoming_call_notification :1181 — недостижима)
  │
  └─ JS: только startPolling 30с (App.vue:1717 + relay.js:242 — startPolling(60000) это no-op)
       └─ loadEmails (App.vue:4883) → fetchEmailsIncremental (:4929)
            └─ fetch_newer — БАТЧ СОРТИРОВАН ПО УБЫВАНИЮ UID (email.rs:513) → cancel ПЕРЕД request
                 └─ processIncoming (App.vue:5000) → incoming.js:28 (порядок сохраняется)
                      ├─ ensureBodies (incoming.js:56) → [fetch_bodies] requested=1
                      │    └─ тело call_request не закэшировано → classify:77 return null (МОЛЧА)
                      └─ для cancel: handleCallSignal БЕЗ await (incoming.js:92)
                           └─ calls.js:408 rememberCallSeen(call_id)   ← ЗАПИСАЛА В 'call-seen'
                      для request (позже):
                           └─ calls.js:261 isCallSeen(call_id)==true → return
                                └─ ни incoming_ringing (:296), ни рингтона (:306), ни экрана (:313)
```

### Одна фраза-вывод

**Сломано `service_monitor.rs:975`: нативный headless-монитор трактует `paused` как «activity жива» — флаг ставится в `MainActivity.onCreate` и `onResume`, в `onPause` НЕ снимается, и снимается только в `onDestroy` — и на этом основании через `Outcome::HandledByJs` (`service_monitor.rs:919-925`, `remove_pending` **без** `seen_push`, при уже продвинутом курсоре `:613-616`) безвозвратно уничтожает письмо-вызов, отдавая доставку в JS; в эко-режиме JS этот handoff принять не может, потому что `App.vue:1717` не запускает `idleLoop()` (а значит и `api.idleStart`/`loadEmailsFast`, `relay.js:198/224`), остаётся только 30-секундный `startPolling` (второй вызов `startPolling(60000)` — no-op из-за `relay.js:242`), и когда батч наконец приходит, `email.rs:513` отдаёт его по убыванию UID, так что `call_cancel` успевает записать `call-seen` (`calls.js:408`) раньше, чем `call_request` дойдёт до своего guard-а (`calls.js:261`) и тихо от него уйдёт.**

*(Номера строк `MainActivity.kt` здесь — для коммита `b77ac72`, который стоял на стенде: `onCreate:269`, `onResume:530`, комментарий в `onPause:497-498`, `onDestroy:587`. В рабочем дереве участок сдвинут и добавлен `onStop` — см. блок «Важно про uncommitted-правку».)*


---

## (iii) МИНИМАЛЬНЫЙ ФИКС (описание, без реализации)

### Правка 1 (главная). `paused` должен означать «приложение видно», а не «activity жива»

> **Статус: в рабочем дереве уже есть незакоммиченная реализация** — `onStop()` в `MainActivity.kt:509-518` снимает паузу при невидимости. Она концептуально верна (снимает паузу при Home, возвращает в `onResume:549`). Но она **не собрана и на стенде не проверена**, поэтому ниже — что стоит проверить в ней дополнительно.

Затрагивает: `MainActivity.kt:497-499` / `509-518`, при необходимости `service_monitor.rs:975`.

Проверить по существу:

- **`onStop` вместо `onPause` — правильный выбор.** `onPause` срабатывает и при диалоге поверх приложения (activity ещё видима) — там отдавать доставку нативу рано, а `onStop` означает «действительно не видно». Симметрия с `onResume:549` корректна.
- **Проверить, что `onStop` действительно вызывается на X50/Android 11 при нажатии Home** — это единственный факт, который ломает или чинит всю схему. Подтвердить логом `[VaultRust] onStop: headless monitor un-paused (app not visible)` (`MainActivity.kt:514`).
- **Осторожно с `onDestroy:606`.** Сейчас пауза снимается и там; при `onStop` → `onDestroy` это двойное снятие безвредно, но стоит убедиться, что нет пути, где `onDestroy` вызывается без предшествующего `onStop`.
- **Дубль при возврате.** `onResume:549` ставит `paused=true` и `appVisible=true` (`MainActivity.kt:531`). Если возврат в UI происходит раньше, чем JS успеет поднять `idleLoop`, нативный и JS-путь могут пересечься. Стоит проверить сценарий «ответили на звонок → сразу открыли приложение».
- **Симметричная, более честная альтернатива** (требует правки Rust): передавать в Rust **два** признака вместо одного — «activity жива» и «activity видима»; `HandledByJs` возвращать только при `visible == true`. Тогда контракт `service_monitor.rs:975` перестаёт зависеть от Kotlin и от того, в какой именно колбэк Android решил позвать.

**Правка 1 обязательна.** Без неё любые улучшения в JS — косметика: нативный путь, ради которого написан `service_monitor.rs:1141-1194`, недостижим в принципе.

### Правка 2. Убрать гонку «cancel гасит свой же request»

Затрагивает: `email.rs:513`, `incoming.js:28`, `calls.js:260-263/402-409`.

Три независимых варианта (по возрастанию инвазивности):

- **2a (минимальный).** В `processIncoming` (`incoming.js:28`) сортировать `pool` по `date` **по возрастанию** перед разбором, чтобы терминальные сигналы всегда обрабатывались после `call_request` того же `call_id`. Тогда `rememberCallSeen` из `call_cancel` уже не сможет затереть ещё не обработанный request. Побочный эффект — «свежие сверху» порядок меняется только для внутреннего разбора, UI-список (`merged`) не трогаем.
- **2b.** В `calls.js:408` не писать `call-seen` для терминального сигнала, пока для этого `call_id` не обрабатывался `call_request` (хранить в kv не просто Set, а запись с `ts` типа сигнала и сравнивать).
- **2c.** `await` на `incoming.js:92` (сделать `handleCallSignal` синхронным в конвейере) + явная сортировка. Убирает класс гонок целиком, но меняет поведение всего батча (медленнее на больших батчах).

### Правка 3. Вернуть в эко быстрый канал доставки

Затрагивает: `App.vue:1716-1717`, `relay.js:242`.

- `startPolling(60000)` после `startPolling()` — мёртвый вызов. Либо убрать первый, либо добавить в `startPolling` (`relay.js:241-242`) логику перезаписи интервала.
- В эко при `relayHealth` ≥ 3 фейлов (`relay.js:146-149`, `enterRelayOfflineRescue`) поднимается `idleLoop` — но только если JS вообще исполняется. Стоит продумать возврат `idleLoop()`/`api.idleStart()` и в эко-фолбэке, иначе при спящем WebView фолбэк недостижим (это уже зафиксировано в комментарии `relay.js:171-174` и в `docs/RELAY-INDEPENDENT-DELIVERY.md:136-138`).

### Правка 4 (диагностика, обязательна перед следующим стендом)

Затрагивает: `incoming.js:61, 76-77`.


### Риски правок

| Риск | Откуда | Как снимается |
|---|---|---|
| Дубль показа (натив + in-app overlay) | Правка 1 включает нативную ветку в фоне | Уже закрыт: `VaultForegroundService.kt:1773` (`appVisible`) и `calls.js:305/312` (`visibilityState`). В **фоне** `appVisible==false` и `visibilityState!=='visible'` → натив отработает, а JS-ветка на Android в фоне HTML5-рингтон не играет, так что дубля звука нет; проверить на стенде |
| Дубль **уведомлений о сообщениях** (не о звонках) | Правка 1 возвращает нативный `notify()` для обычных писем, которые раньше отдавались JS | Дедуп нативной стороны — `notify_seen` в `monitor.db` (`service_monitor.rs:882`, `seen_push`); он не пересекается с JS-дедупом в `vault.db`. Риск реален, требует проверки |
| Рост трафика/батареи | Нативный монитор активен, пока открыто приложение | `IDLE_TICK` = 7 с (`service_monitor.rs:56`); в эко это заметный фон. Возможно, стоит увеличить тик при `!visible` |
| Гонка `call-seen` вернётся в другом виде | Правка 2 меняет порядок | После 2a нужно убедиться, что ретрасляция `call_request` (каждые 15 с) не поднимает звонок повторно — за это отвечает `calls.js:277` (`currentCall` check) |
| `startPolling` с перезаписью интервала | Правка 3 | Может задваивать таймеры, если не чистить `pollTimer` — правка должна идти через существующий `stopPolling` (`relay.js:302-306`) |

---

## Проверка на стенде после правки

```bash
# 0. Сработал ли uncommitted onStop() (MainActivity.kt:509-518) — базовый признак Правки 1:
adb logcat -s VaultRust | grep -F 'onStop: headless monitor un-paused'

# 1. Нативная ветка заработала в фоне (главный признак):
adb logcat -s VaultRust | grep -E 'svc-monitor.*call .* NEW|ringing, jni_ok=true'

# 2. Гонка cancel/request ушла (должны появиться оба сигнала):
adb logcat | grep -F '[call] signal call_request'

# 3. Монитор больше не выкидывает письмо при невидимом приложении:
adb logcat -s VaultRust | grep -F 'handled by JS (activity alive)'
# (после Правки 1 в фоне этой строки быть НЕ должно)

# 4. Разбор батча больше не молчит (Правка 4):
adb logcat | grep -E 'incoming\] drop|ensureBodies.*failed'
```

Ожидаемая последовательность в фоне при живом релее **или** без него:
`fetch_newer` → `svc-monitor call <id> NEW ... ringing, jni_ok=true` → рингтон + full-screen intent, **без** участия JS.

---

## Что НЕ проверялось (только анализ кода)

- Живой стенд не собирался и не прогонялся (условие задачи — только чтение).
- Не проверено, успевает ли `rememberCallSeen` из `cancel` реально обогнать `isCallSeen` из `request` на конкретном устройстве — это **гонка**, и порядок её разрешения зависит от планировщика IPC. Слой 3б (тело не фетчилось) — конкурирующее объяснение того же симптома, поэтому Правка 4 (лог отбрасываний) нужна, чтобы их различить.
- Не проверено поведение при `push_mode=true` (ntfy-путь) — оно в этой ветке не участвует.
- `vault-android/`, `vault-client/`, `relay-server/` не анализировались — задача про Android-дерево `src-tauri/gen/android` + общий фронтенд `src/`.

Сегодня обе точки отбрасывания письма **молчат**. Добавить одну строку лога с `mid`/`uid`/`folder`/причиной (`no-body`, `body-fetch-failed`, `not-encrypted`) — иначе следующий заход снова даст «JS увидел только cancel» без возможности отличить слои 3 и 3б.
