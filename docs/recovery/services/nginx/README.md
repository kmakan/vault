# Вхосты nginx — реконструкция, не копия

Живых конфигов у нас нет: они лежали только на сервере. Ниже — минимальная
рабочая форма, собранная по документации (`docs/RELEASE-RUNBOOK.md`: релей на
127.0.0.1:8091, nginx проксирует; `/admin/*` наружу не отдаётся) и по самой
структуре сайта (`index.html` в корне, английская версия в `en/`, ассеты APK в
`releases/`, страница оплаты `pay.html`).

**Обязательно сверить с живым сервером** после подъёма: `nginx -T` и
`/etc/nginx/sites-enabled/*` — и заменить этот файл настоящими.

## Один вхост на имя

`vault-msg.ru.conf` (остальные четыре — копии с заменой `server_name` и `root`):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name vault-msg.ru www.vault-msg.ru;

    # ACME-проверка живёт отдельно, чтобы продление не зависело от редиректа
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://vault-msg.ru$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name vault-msg.ru www.vault-msg.ru;

    ssl_certificate     /etc/letsencrypt/live/vault-msg.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vault-msg.ru/privkey.pem;

    root /var/www/vault-msg/ru;
    index index.html;

    # релей: публичный путь /relay/* → локальный 8091
    location /relay/ {
        proxy_pass http://127.0.0.1:8091/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        client_max_body_size 2m;
    }

    # служебное наружу не отдаём
    location /admin/ { return 404; }

    # ассеты релизов: большие файлы, кэш надолго
    location /releases/ {
        root /var/www/vault-msg/ru;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # latest.json без кэша: по нему приложение узнаёт о новой версии
    location = /latest.json {
        root /var/www/vault-msg/ru;
        add_header Cache-Control "no-cache, must-revalidate";
    }
}
```

## Английская версия

Отдельный вхост на том же имени не нужен: `en/` — подкаталог. Достаточно
второго `root` не делать, а положить `en/` внутрь корня. Если на сервере было
разделение на два сайта (`/ru/` и `/en/`), конфиг собирается из двух таких
блоков с разными `root`.

## Имена и корни

| домен | `server_name` | `root` (проверить) |
|---|---|---|
| vault-msg.ru | `vault-msg.ru www.vault-msg.ru` | `/var/www/vault-msg/ru` |
| vault-msg.tech | `vault-msg.tech www.vault-msg.tech` | `/var/www/vault-msg/ru` |
| medauto.moscow | `medauto.moscow www.medauto.moscow` | `/var/www/medauto` |
| медавто.москва | `xn--80aeed8aq1a.xn--80adxhks` | `/var/www/medavto` |
| office-pereezdi.ru | `office-pereezdi.ru www.office-pereezdi.ru` | `/var/www/office` |

## Сертификаты

`certbot --nginx -d vault-msg.ru -d www.vault-msg.ru` для каждого имени;
продление — `certbot renew --deploy-hook "systemctl reload nginx"` в таймере.
Кириллический домен в certbot передаётся в punycode-форме.
