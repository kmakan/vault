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
