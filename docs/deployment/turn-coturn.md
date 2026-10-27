# TURN для звонков вне одной сети (coturn + временные креды от релея)

Задача: `t_18b4d871`. Без relay-кандидата WebRTC соединяет только пару
устройств внутри одного NAT, а телефоном пользуются в сети оператора — то есть
без TURN звонка в бою нет вообще.

## Как это устроено (решение, а не команды)

- Клиент перед сборкой PeerConnection просит `GET /relay/turn` с своим
  relay-токеном и получает пару `(username, credential)` + список TURN URL.
- `username = "<unix-истечение>:<метка>"`, `credential = base64(HMAC-SHA1(секрет, username))` —
  схема coturn `use-auth-secret` (REST API). Секрет живёт только на сервере.
  Украденная пара протухает через `CRED_TTL` (1 час), в APK постоянного пароля
  нет — его нельзя вытащить из бинаря и раздать чужому relay-трафику.
- Coturn сам сверяет срок из username и сам пересчитывает HMAC: продлевать
  пару нельзя по замыслу, «просроченный звонок» — это новый запрос кредам.
- Квоту решает СЕРВЕР (наше правило: клиент лимит не поднимает), и квота ОДНА:
  выдача кредитов тратит общий суточный бюджет релея токена — тот же счётчик
  `t:<hash>` и тот же порог тарифа (`daily_limit_for_token`), что у конвертов.
  100 unit бесплатно, Pro — 1000, Business — 10000, тестовый токен без лимита,
  канальному отказ (403). В тарифной сетке не появляется второе число, а
  купленный лимит нельзя обойти звонками. Одна выдача покрывает `CRED_TTL`
  часов разговора (клиент кэширует пару), поэтому звонки расходуют бюджет
  медленно: час разговора = один unit.
- Клиент кэширует пару на весь TTL и обновляет за 2 минуты до истечения, а
  любой отказ релея (503/401/402/403/429/сеть) — это `null`: мост остаётся на
  STUN, звонок не срывается.

Код: `vault-relay/src/turn.rs` (формула пары + лимиты по тарифам), роут
`relay_turn` в `vault-relay/src/main.rs`, `CallMediaManager::set_turn` +
команда `media_set_turn` в `vault-desktop/src-tauri/src/media.rs`,
`fetchTurnCredentials` в `vault-desktop/src/relay-client.js`, вызов `armTurn()`
в `vault-desktop/src/features/calls.js` перед каждым `media_start_outgoing` /
`media_accept_incoming`.

## Настройка сервера (root)

Признак того, что ничего не настроено: `GET /relay/turn` отвечает **503**.
Тогда звонки живут только внутри одной подсети.

1. Секрет — один и тот же в релеe и в coturn. Генерируем и кладём в env релея
   (файл принадлежит пользователю, sudo не нужен; значение в терминал не
   печатаем):

   ```bash
   # на сервере, от своего имени
   grep -q '^VAULT_TURN_SECRET=' /home/maksim/vault-relay/env || \
     printf 'VAULT_TURN_SECRET=%s\n' "$(openssl rand -hex 32)" >> /home/maksim/vault-relay/env
   chmod 600 /home/maksim/vault-relay/env
   ```

2. Coturn переводим на REST-креды (`/etc/turnserver.conf`). Секрет подхватываем
   из env-файла релея, не набирая и не печатая:

   ```bash
   sudo cp /etc/turnserver.conf /etc/turnserver.conf.bak-$(date +%F)
   sudo sh -c 'S=$(sed -n "s/^VAULT_TURN_SECRET=//p" /home/maksim/vault-relay/env | head -1)
     grep -vE "^user=" /etc/turnserver.conf.bak-$(date +%F) | sudo tee /etc/turnserver.conf >/dev/null
     printf "use-auth-secret\nstatic-auth-secret=%s\nrealm=vault-msg.ru\n" "$S" | sudo tee -a /etc/turnserver.conf >/dev/null'
   ```

   Строки `user=…` удаляем обязательно: в конфиге их было две (одна с пустым
   паролем) — это постоянный аккаунт, который REST-схема не отменяет.
   `lt-cred-mech` и `realm` можно оставить как есть (`use-auth-secret` подразумевает
   long-term auth), дубликаты строк coturn терпит.

3. Рестарт и проверка, что требует auth:

   ```bash
   sudo systemctl restart coturn && systemctl is-active coturn
   ```

4. Релей — новая сборка с роутом `/relay/turn` + env из шага 1:

   ```bash
   sudo systemctl restart vault-relay   # после того, как бинарь обновлён
   ```

   Диапазон ретрансляционных портов (49160-65534/UDP) на этом хосте открыт:
   хостового firewall'а нет (`nft list ruleset` пуст, ufw неактивен). Если
   появится — открыть надо и UDP 3478, и этот диапазон.

## Проверка

```bash
VAULT_RELAY_TOKEN=<токен аккаунта> ./scripts/turn-probe.sh
```

Ожидание: `шаг 1 … code=401 realm=vault-msg.ru nonce=есть` (сервер живёт и
требует auth), затем `шаг 2 … code=200 … relay=<адрес> lifetime=3600` — пара
принята, relay-кандидат реально выдаётся. `code=403` на шаге 2 = секрет релея и
`static-auth-secret` разошлись (или пара просрочена).

Живая приёмка: телефон в сети оператора (LTE, Wi-Fi выключен) ↔ десктоп за
домашним NAT; в логе десктопа `[media] TURN creds applied`, в SDP присутствует
`typ relay`, аудио держит обе стороны.

## Меры (что ловит регресс)

- `rust-relay-turn` — формула пары, срок, TURN URL (6 мутаций).
- `rust-relay-turn-api` — HTTP-контракт роута: статусы, ttl в ответе, общий с
  конвертами ключ счётчика и зависимость порога от тарифа, метрика 429
  (9 мутаций).
- `relay-client-mut` + `relay-client-smoke` раздел 12 — кэш кредов, запас на
  обновление, срок из ответа, тихий отказ вместо сорванного звонка, пустые поля.
- `media::tests::turn_creds_zamenyayut_relay_i_ne_trogayut_stun` — креды
  заменяют relay-запись, не трогая STUN, и не накапливаются при повторной выдаче.
