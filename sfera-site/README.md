# Sfera / Vault site

Новый сайт двух изданий на Django REST + Vue SSR.

- `vault-msg.ru` — русская редакция;
- `vault-msg.tech` — английская редакция;
- один Django-проект, общая база, контент привязан к `django.contrib.sites.Site`;
- каждая фича — отдельное Django-приложение в `apps/`;
- Vue SSR отдаёт HTML, Django REST — данные;
- руководство Sfera хранится в markdown и импортируется в `docs`.

## Быстрый старт

```bash
cd /home/maksim/whisper/sfera-site
uv venv .venv
. .venv/bin/activate
uv pip install -r requirements.txt
python manage.py migrate
python manage.py import_legacy_site --source /home/maksim/vault-site
python manage.py runserver 127.0.0.1:8000
```

Проверка импорта без потери текста:

```bash
python scripts/verify_import.py --source /home/maksim/vault-site
```

## Frontend

```bash
cd frontend
npm install
npm run build
SITE_HOST=vault-msg.ru API_ORIGIN=http://127.0.0.1:8000 PORT=3100 node server.mjs
```

Порт 3000 на этой машине занят BookOrbit, поэтому локальный SSR — на 3100.

## Проверки

```bash
python manage.py test apps.core
python manage.py check
```

## Важно

Перед любым изменением nginx/systemd на сервере — `docs/SITE-MIGRATION-RUNBOOK.md`:
SSH, релей, ЮKassa, чеки и обратная связь должны остаться рабочими.
