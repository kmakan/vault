# Аварийный комплект Vault

Заведён 15.11.2026, когда VPS 17633 лежал уже 11 часов, а выяснилось, что
локальных копий сайтов, конфигурации nginx и данных релея у нас нет вообще:
всё жило только на сервере. Этот каталог закрывает ту часть риска, которую
можно закрыть без доступа к серверу.

## Что внутри

| путь | что это |
|---|---|
| `sites/` | снимок `/home/maksim/vault-site` без `releases/` (2 МБ): все страницы, `pay.html`, `pd.html`, `store/LISTING.md`, `latest.json` |
| `services/systemd/` | юниты и скрипты из `vault-relay/deploy/` — релей, учёт, НПД, мониторинг, gov-bypass |
| `services/nginx/` | реконструкция вхостов по документации (сверить с живым сервером, когда поднимется) |
| `secrets.md` | какие секреты нужны релею, где они лежат, что можно перевыпустить, а что менять нельзя |
| `MANIFEST.sha256` | контрольные суммы снимка |

## Чего здесь НЕТ (и это надо снять с сервера первым делом после подъёма)

1. `~/vault-relay/env` и `~/vault-relay/accounting.env` — секреты релея.
2. `~/vault-relay/accounting-digest.py` — скрипт сводки (в репозитории его нет).
3. Конфиги nginx (`/etc/nginx/sites-enabled/*`) и TLS-сертификаты.
4. Данные: `vault-relay-state.json` (аккаунты, подписки, незавершённые оплаты,
   коды) и `vault-relay-accounting.json` (учёт доходов). Плюс `*.bak-*`.
5. `crontab -l`, `/etc/hosts` (блок `# BEGIN vault-gov-bypass`), правила ufw.

Как только SSH пустит, `~/.hermes/scripts/vault-server-recover.sh` снимает
состояние релея автоматически, а `vault-backup-pull.timer` — ежедневно.

## Порядок восстановления с нуля

1. **DNS.** Пять имён на один адрес: `vault-msg.ru`, `vault-msg.tech`,
   `medauto.moscow`, `xn--80aeed8aq1a.xn--80adxhks` (медавто.москва),
   `office-pereezdi.ru`. MX/SPF/DKIM/DMARC — см. `~/Notes/Projects/mailcipher/mails.md`.
2. **Базовая машина.** Пользователь `maksim`, ключ `~/.ssh/virt_box`, SSH по
   ключу, ufw: 22/80/443.
3. **nginx + сертификаты.** Вхосты — `services/nginx/`, сертификаты через
   certbot (`certbot --nginx -d <домен>` для каждого имени).
4. **Релей.** `cargo build --release` в `vault-relay/` на самой машине (glibc
   хоста, не кросс-сборка), бинарь в `~/vault-relay/`, слушает 127.0.0.1:8091.
5. **Секреты.** Вернуть `env` и `accounting.env` из бэкапа. Если бэкапа нет —
   см. `secrets.md`: часть значений перевыпускается, `VAULT_RELAY_KEY` менять
   нельзя без потери выданных кодов.
6. **Данные.** Положить `vault-relay-state.json` и `vault-relay-accounting.json`
   рядом с бинарём, права 0600, владелец `maksim`.
7. **Сайты.** `rsync -a docs/recovery/sites/ server:/var/www/vault-msg/ru/`
   (плюс `sites/en/` в `/en/`), ассеты APK — из `/home/maksim/vault-releases/`.
8. **Юниты.** `services/systemd/*` → `/etc/systemd/system/` (или user-юниты,
   у которых суффикс `-user`), `systemctl daemon-reload && enable --now`.
9. **Проверки.** `/relay/health` через публичный домен, все пять имён по HTTPS,
   `systemctl is-active nginx vault-relay`, `free -h`, `journalctl -p err -b`.
10. **Витрина.** `latest.json` / `latest-en.json` в корне сайта и в `en/`,
    ассеты в `releases/` — сверить sha256 скачанного.

## Как поддерживать

- Снимок `sites/` обновлять после каждого релиза сайта:
  `rsync -a --delete --exclude releases --exclude .git /home/maksim/vault-site/ docs/recovery/sites/`
- Данные релея тянет `vault-backup-pull.timer` (ежедневно, 04:30) —
  в `~/backups/vault-relay/<дата>/`, хранится 14 дней.
- Каталог лежит в репозитории `whisper` и уезжает в оба ремоута: если умрёт
  и ноутбук, сайты и юниты останутся.
