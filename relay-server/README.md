# Vault relay

Push-ускоритель поверх email-транспорта: дублирует (не заменяет) почтовую
доставку. Сервер видит только opaque-токены и зашифрованные байты —
wire-формат конвертов не меняется, email-путь остаётся единственным
источником истины (relay упал = тихая деградация, ничего не теряется).

Дизайн: docs/design/relay-protocol.md. Политика publish (анонимный/по
write-токену) — конфиг VAULT_RELAY_ANON_PUB, оба режима поддерживаются.

## API
- POST /relay/pub   {v,to,id,exp,body} → 200 {mid} | 400 | 402 | 413 | 429
- GET  /relay/poll?wait=N  (Authorization: VaultRelay <read-token>) → [конверты] | 204
- GET  /relay/ws    WebSocket: hello → msg → ack (at-least-once, не-ack'нутые возвращаются)
- GET  /metrics, /health

## Токены (stateless HMAC)
token = b64url(key_id ‖ scope ‖ expiry ‖ HMAC-SHA256(server_key, ...))
Генерация: ./target/release/gen_token <server_key_hex> read|write <days> [count]
Очередь получателя адресуется mac-хэшем read-токена. Никаких email, БД
пользователей, логов тел — только счётчики в /metrics.

## Запуск
VAULT_RELAY_KEY=<64 hex> VAULT_RELAY_ADDR=127.0.0.1:8091 VAULT_RELAY_ANON_PUB=1 vault-relay

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
