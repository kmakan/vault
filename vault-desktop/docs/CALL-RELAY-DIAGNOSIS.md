# Диагноз: исходящий звонок с десктопа не попадает в relay-очередь получателя

Дата разбора: 01.10.2026 · ветка `feature/fcm-part-b` · стенд: koanmak@gmail.com (десктоп) → koanmak@ya.ru (Android, эко-режим).

## (i) КОРЕНЬ

Peer-токен получателя (адрес его relay-очереди) **никогда не попадал в `kv_store` десктопа**, поэтому `relayPublish()` выходил по ветке `no-peer-token` и звонок уходил только почтой (FCM на телефоне не будился: pub-запроса к релею не было вообще — `pub_ok 0`, `pub_anon 0`).

Точка разрыва — **две независимые, обе в JS этого дерева**:

1. **`parseEnvelope()` выбрасывал поле `tok` из конверта.** Поле клалось в исходящие (`App.vue buildEnvelope`, `calls.js sendCallEnvelope`), но при разборе входящего конверта объект `env` собирался из явного списка полей **без `tok`** (`App.vue:3134` до правки). Поэтому `incoming.js:116 if (env.tok …)` всегда было ложно: **email-приход не учил peer-токен ни для одного обычного конверта** — вариант **(б)**. У call-конвертов путь другой (`parseCallSignal` возвращает сырой объект, `calls.js:203`), там `sig.tok` был виден — но звонок шёл ВПЕРЁД с десктопа, а знание токена телефона десктоп может получить только из входящего конверта телефона.
2. **Гейт `ctx.relayEnabled` душил и обучение, и вложение `tok`.** Он стоял на обеих сторонах обмена: `incoming.js:116` (не учить), `calls.js:203` (не учить на call-сигналах), `calls.js:136` (не вкладывать свой токен), `App.vue:3115` (не вкладывать свой токен). На стенде `relay-enabled` в kv **отсутствует** → `getSettings()` (`relay-client.js:173`) даёт `enabled = true` по умолчанию, но кэш `ctx.relayEnabled` инициализируется только в трёх ветках входа (login/auto-login/recovery, `App.vue:1689 / 2307 / 4255`) и в мобильном WebView-восстановлении может остаться `false` — вариант **(в)**. Гейт не имел смысла (выключенный релей ≠ нельзя отдать собеседнику адрес своей очереди) и делал обмен токенами необратимо хрупким.

Дополнительно: **`setPeerToken()` глотал ошибку записи `db_kv_set`** — вариант **(г)** нельзя было исключить по логам (write падал молча). Теперь логируется явно.

Цепочка вызовов (было):
- Отправка: `calls.js sendCallEnvelope` → `relay.relayPublish()` (`relay-client.js:289`) → `getSettings()` → `pickLiveRelay()` → `peers[<url>][<chatId>]` пусто → `console.log('[relay] publish skip: no-peer-token …')`, возврат `{ok:false, why:'no-peer-token'}` — **результат игнорировался вызывающим кодом** → SMTP уходит (`calls.js:172-186`).
- Обучение (должно было выучить токен телефона на десктопе): входящий конверт → `incoming.js processIncoming/classify` → `ctx.parseEnvelope(plain)` (**`tok` потерян**) → `env.tok === undefined` → `setPeerToken()` **не вызывается**.
## (ii) ИЗМЕНЕНИЯ

Только JS. Не трогали: email/SMTP-путь, крипто, wire-формат конвертов (поле `tok` уже было в формате — просто терялось при разборе), Rust/Android/Kotlin, `tauri.conf.json`, локали, зависимости. Без рефакторинга и новых зависимостей.

| Файл:строки | Что | Зачем |
|---|---|---|
| `src/App.vue:3135` (`parseEnvelope`) | в список полей `env` добавлено `tok: typeof obj.tok === 'string' ? obj.tok : ''` | **Ключевая правка.** Без неё `incoming.js` физически не мог увидеть токен в email-конверте — обучение не работало ни при каком состоянии релея. |
| `src/App.vue:3115-3122` (`buildEnvelope`) | снят гейт `if (this.relayEnabled)` вокруг вложения `env.tok` | адрес нашей очереди нужен собеседнику независимо от нашего переключателя; иначе выключенный релей у одного навсегда ломает обмен. |
| `src/features/calls.js:136-144` (`sendCallEnvelope`) | снят гейт `if (ctx.relayEnabled)` вокруг `body.tok` | то же для call-конвертов (`call_request/accept/answer/end/reject`). |
| `src/features/calls.js:217` (`handleCallSignal`) | `if (sig.tok && ctx.relayEnabled)` → `if (sig.tok)` | обучение на входящих call-сигналах больше не зависит от флага релея. |
| `src/features/incoming.js:116` (`classify`) | `if (env.tok && ctx.relayEnabled)` → `if (env.tok)` | то же для обычных конвертов; канал (email/relay) значения не имеет — relay-копии приходят в `relayConsume` → виртуальные письма → тот же `classify`. Формат записи остаётся ровно `{relayUrl:{chatId(lower):token}}` через `setPeerToken()`. |
| `src/features/calls.js:161-178` (`sendCallEnvelope`) | перед публикацией — `hasPeerToken(ctx.email, peer)`; если токен неизвестен — лог `[relay] call: peer token unknown for <peer> → email-only`. Результат `relayPublish()` больше не отбрасывается: `.then()` печатает `[relay] call publish skipped for <peer> → <why>`, `.catch()` — ошибку | видимость на стенде: причина пропуска больше не теряется между fire-and-forget вызовом и `try/catch`. Сама ветка `'[relay] publish skip: …'` в `relayPublish` выполняется и печатает (`relay-client.js:316/329/333`) — внешний `try/catch` её не съедал, но результата видно не было. |
| `src/relay-client.js:213-221` (`setPeerToken`) | `db_kv_set` обёрнут в `try/catch` с логом `[relay] peer token SAVE FAILED <chatId>: <err>` (затем rethrow) | исключает вариант (г): раньше падение записи выглядело как «токен не выучился». |
| `src/relay-client.js:224-238` (новый `hasPeerToken`) | экспорт диагностики: проверяет `memPeers` + `peers[<url>]` по всем релеям списка, тем же источником, что и `relayPublish` | чтобы лог «peer token unknown» не врал (учитывает и активный, и фолбэк-релей). |

**Все места, где клиент УЧИТ peer-токен** (после правок — ни одно не зависит от `relayEnabled`):
1. `src/features/incoming.js:116-128` — email- **и** relay-приход обычного конверта (`classify`; relay-копии приходят как виртуальные письма `folder:'RELAY'` из `src/features/relay.js:22 relayConsume`).
2. `src/features/calls.js:217-229` — приход call-конверта (`memLearn` + `setPeerToken`).
3. `src/components/SettingsPage.vue:664` — ручной ввод (`relayAddPeer`); `:671` — удаление.

**Все места, где при ОТПРАВКЕ в конверт кладётся `tok`:**
1. `src/App.vue:3118-3122` (`buildEnvelope`) — обычные сообщения, вложения, group-конверты (все идут через `buildEnvelope`).
2. `src/features/calls.js:140-144` (`sendCallEnvelope`) — все call-сигналы.
3. `src/relay-client.js:324-347` (`relayPublish`) — поле `tok` в теле `POST /pub` (адрес нашей очереди для сервера/FCM-маршрутизации; это HTTP-тело, не конверт).

Не вкладывают `tok`: `src/features/profiles.js:164`, `src/features/poll.js:99`, `src/features/duress.js:170` (профили/голосования/SOS) — не трогали, на звонок не влияет.

## (iii) ЧТО НЕ ПРОВЕРЕНО на живом стенде и как это проверить

Не проверено (только анализ кода + косвенные факты стенда):
- **Вариант (а)**: кладёт ли Android-клиент на телефоне `tok` в исходящие конверты вообще. Мы правили только JS этого дерева (общий фронтенд), Kotlin/Android по условию не трогали. Если телефон собран из этого же JS — правка применится; если из другого билда, проверить отдельно.
- Реальное значение `ctx.relayEnabled` в момент вызова на десктопе и на телефоне (оно и было ключевым гейтом).
- **Вариант (г)**: падал ли `db_kv_set` для `relay-peer-tokens`. Теперь будет видно в логе явно.
- Метрики релея `pub_ok 0 / pub_anon 0 / poll_hits 0 / register_ok 0` не опровергают диагноз (pub не доходил до HTTP), но и не подтверждают его напрямую — нужен новый замер.
- Живой стенд не собирался и не прогонялся по условию задачи; синтаксис JS проверен (`node --check` по `relay-client.js`, `features/calls.js`, `features/incoming.js` и по вырезанному `<script>` блоку `App.vue`).

Как проверить на стенде (после сборки/установки):

1. Лог приложения. Desktop: консоль WebView (в dev — stdout процесса Tauri); Android: `adb logcat`.

```bash
# (в) peer-токен неизвестен на момент звонка
grep -F "[relay] call: peer token unknown for" app.log
# причина пропуска публикации из relayPublish (не съедается)
grep -E "\[relay\] publish skip|\[relay\] call publish skipped" app.log
# обучение токена (входящий канал) и возможный сбой записи
grep -F "[relay] peer token auto-learned" app.log
grep -F "[relay] peer token SAVE FAILED" app.log
```

2. Проверка, что peer-токен реально записан (на стенде ключа не было вообще):

```bash
sqlite3 /home/maksim/.local/share/com.vault.vault/vault.db \
 "SELECT key, substr(value,1,200) FROM kv_store
  WHERE account='koanmak@gmail.com'
    AND key IN ('relay-peer-tokens','relay-enabled','relay-active','relay-list');"
# ожидается непустой relay-peer-tokens вида
# {"https://vault-msg.ru/relay":{"koanmak@ya.ru":"<tok>"}}
```

3. Метрики релея — после исходящего звонка `pub_ok` обязан стать > 0:

```bash
curl -s https://vault-msg.ru/relay/metrics
# ожидается: pub_ok >= 1; у получателя на телефоне poll_hits > 0
```

4. Сторона телефона (FCM-регистрация жива, pub дошёл до получателя):

```bash
ssh server 'journalctl -u vault-relay --since "-10min" | grep -i -E "fcm|pub|poll"'
```

Ожидаемая последовательность после правки при ПЕРВОМ звонке (peer-токен ещё не выучен — это нормально для самого первого контакта между аккаунтами): в логе `[relay] call: peer token unknown for koanmak@ya.ru → email-only`. После того как телефон ответит (accept/reject/любое сообщение) и его конверт с `tok` дойдёт — `[relay] peer token auto-learned: koanmak@ya.ru`, ключ `relay-peer-tokens` появляется в kv, и следующий звонок уходит через релей (`pub_ok +1`, FCM будит телефон). То есть полное «пробуждение с первого раза» возможно только после того, как обмен токенами уже состоялся хотя бы один раз; чтобы проверить его с нуля, ключ `relay-peer-tokens` надо предварительно удалить у обеих сторон.