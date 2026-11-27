# Переезд сайта: обязательные проверки сервера

Сайт `vault-msg.ru` / `vault-msg.tech` — не только страницы. На том же сервере
работают SSH, nginx, релей Vault, приём обратной связи, ЮKassa и выдача чеков.
Переезд не должен их ломать. Этот файл — стоп-лист перед любым изменением
nginx/systemd и после него.

## Что нельзя трогать без отдельного решения

- `sshd` и доступ по SSH;
- `nginx.service` и его рабочие конфиги без бэкапа и `nginx -t`;
- `vault-relay.service` и маршруты `/relay/*`, особенно
  `/relay/purchase/checkout`, `/relay/purchase/verify`,
  `/relay/purchase/yk-notify`;
- `vault-feedback.service` и приём обращений;
- настройки ЮKassa, чеки в «Мой налог», секреты в env;
- certbot и `/.well-known/acme-challenge/`;
- DNS-записи доменов;
- uptime-мониторы `vault-ru` и `vault-en`.

## Preflight (до любых правок)

```bash
ssh server 'uptime; systemctl is-active nginx vault-relay vault-feedback'
```

Дополнительно проверить:

```bash
curl -sI https://vault-msg.ru/ | head -1
curl -sI https://vault-msg.tech/ | head -1
curl -s https://vault-msg.ru/relay/plans | head -c 300
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  https://vault-msg.ru/relay/purchase/checkout      # ожидается 422, не 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  https://vault-msg.ru/relay/purchase/yk-notify     # ожидается 400, не 404
```

Проверить, что страницы оплаты и юридические страницы живы:

```bash
for p in /pay.html /pricing.html /privacy.html /terms.html /offer.html /pd.html /requisites.html; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://vault-msg.ru$p"
done
```

Не отправлять реальный платёж и не создавать чек в рамках проверки. Достаточно
того, что маршрут отвечает ожидаемым кодом, а не 404/502.

## Staging

1. Новый Django/SSR поднимается на отдельных портах (`127.0.0.1:8000`,
   `127.0.0.1:3100`) и не занимает порт 3000 — он занят BookOrbit.
2. Проверка через `curl --resolve` или временный `server_name`, не меняя
   основной `root`.
3. nginx-конфиг копируется в `/etc/nginx/sites-available/` с суффиксом
   `-staging`; `nginx -t` обязателен.
4. Только после зелёного smoke — переключение upstream/root.

## Cutover

- Сохранить копию текущего `sites/vault-msg/{ru,en}`.
- Новый фронт положить в отдельный каталог, переключить `root` симлинком,
  а не удалять старое дерево.
- `/relay/`, `/api/` (релея), `/feedback`, `/.well-known/` — отдельные
  `location`, они не должны попасть в SSR-fallback.
- `nginx -t` до `systemctl reload nginx`.
- Если `nginx -t` не проходит — откат конфига, reload не делать.

## Postflight (после cutover)

Повторить preflight целиком, плюс:

- `https://vault-msg.ru/` и `https://vault-msg.tech/` отдают 200 и правильный
  `<title>`;
- `/pricing`, `/pay`, `/legal/*` отдают 200;
- старые `.html` отдают 301 на новые адреса;
- `/relay/plans` — 200, `/relay/purchase/checkout` — 422, `yk-notify` — 400;
- `vault-feedback` active, тестовое обращение не отправлять без нужды;
- `systemctl is-active nginx vault-relay vault-feedback` — все `active`;
- uptime-мониторы `vault-ru`/`vault-en` зелёные;
- в `journalctl -u nginx -n 50` нет 502/504 на `/relay/`;
- SSH-сессия не разорвана, вход по ключу работает.

## Rollback

1. Вернуть предыдущий `root`/upstream.
2. `nginx -t && systemctl reload nginx`.
3. Проверить preflight.
4. Если сломан релей — не перезапускать его «на всякий случай»: сначала
   посмотреть `journalctl -u vault-relay -n 100`, затем решать.

## Отдельно про чеки ЮKassa

- Сайт не должен проксировать `/relay/purchase/yk-notify` через Django:
  вебхук принимает релей.
- Если меняется `pay.html`, сохранить его URL или сделать 301 на новый
  `/pay`; старые сборки приложения ссылаются на `/pay.html`.
- Не менять `VAULT_RELAY_YOOKASSA_*` в рамках миграции сайта.
- После переезда проверить, что тестовый checkout возвращает 422 (валидация),
  а не 404; реальный платёж — только по отдельному решению владельца.
