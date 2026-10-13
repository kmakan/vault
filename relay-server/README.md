# Vault relay

Push-ускоритель поверх email-транспорта: дублирует (не заменяет) почтовую
доставку. Сервер видит только opaque-токены и зашифрованные байты —
wire-формат конвертов не меняется, email-путь остаётся единственным
источником истины (relay упал = тихая деградация, ничего не теряется).

Дизайн: docs/design/relay-protocol.md. Отправитель публикации обязан
предъявить креды: заголовок `Authorization: VaultRelay <write-token>` (для
каналов — write-токен канала) ЛИБО свой read-токен в теле `tok` — так шлёт
клиент с M2.4, им же считается суточный лимит и проверяется привязка к fp.
«Чистая анонимность» (ни заголовка, ни `tok`) допускается только при
`VAULT_RELAY_ANON_PUB=1` — совместимость со старыми сборками; в проде
выключено (`=0`), тогда публикация без кредов получает 401. Метрики
`/metrics`: `pub_hdr` — личный write-токен в `Authorization`, `pub_tok` —
свой read-токен в теле, `pub_anon` — анонимные (при включённом kill-switch,
в проде ноль), `channel_pub` — публикации в каналы, `rejected` — отказы.
Инвариант: `pub_ok = pub_hdr + pub_tok + pub_anon + channel_pub` (закреплён
тестом) — то есть по метрикам видно, что каждая принятая публикация
атрибутирована.

## API
- POST /relay/pub   {v,to,id,exp,body,tok,fp} → 200 {mid} | 400 | 401 | 402 | 413 | 429
  (401 = отправитель не предъявил кредов, а ANON_PUB=0)
- GET  /relay/poll?wait=N  (Authorization: VaultRelay <read-token>) → [конверты] | 204
- GET  /relay/ws    WebSocket: hello → msg → ack (at-least-once, не-ack'нутые возвращаются)
- GET  /metrics, /health

## Токены (stateless HMAC)
token = b64url(key_id ‖ scope ‖ expiry ‖ HMAC-SHA256(server_key, ...))
Генерация: ./target/release/gen_token <server_key_hex> read|write <days> [count]
Очередь получателя адресуется mac-хэшем read-токена. Никаких email, БД
пользователей, логов тел — только счётчики в /metrics.

## Запуск
VAULT_RELAY_KEY=<64 hex> VAULT_RELAY_ADDR=127.0.0.1:8091 VAULT_RELAY_ANON_PUB=0 vault-relay
# ANON_PUB: 0 = анонимная публикация запрещена (прод). Дефолт в коде — 1
# (совместимость при отсутствии переменной), поэтому в юните ставим явный 0.

## Персист привязок (VAULT_RELAY_STATE)
Привязки FCM-токенов (тема → reg_token) и per-topic рингтоны звонка
живут в одном JSON-файле и ПЕРЕЖИВАЮТ рестарт релея. Без этого после
рестарта будить нечем: клиент считает, что зарегистрирован (кэш в prefs),
релей — что нет, а запасного ntfy-моста на проде нет.

- Путь: `VAULT_RELAY_STATE`, дефолт `./vault-relay-state.json`
  (WorkingDirectory сервиса). Рекомендуется абсолютный путь, напр.
  `/home/maksim/vault-relay/state.json` — иначе смена WorkingDirectory
  в unit-файле тихо «теряет» привязки.
- `VAULT_RELAY_STATE=off` — персист выключен (поведение как до t_44e210b4).
- Формат: `{"v":1,"saved_at":<unix>,"topic_fcm":{<тема>:<reg_token>},
  "topic_ringtone":{<тема>:<url>}}`. Запись атомарная (temp + rename),
  права 0600 (в файле лежат reg_token'ы — адреса доставки).
- Битый/отсутствующий файл НЕ мешает старту: релей поднимается с пустыми
  картами и чинит их первым же POST /relay/fcm/register.
- TTL по времени не вводится: запись живёт до следующей регистрации того
  же токена, а сгоревший reg_token вычищается по ответу FCM
  `UNREGISTERED`.
