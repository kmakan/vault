# Vault feedback receiver

Tiny WSGI app (stdlib-only) behind nginx on vault-msg.ru:
`POST /api/feedback` -> sqlite, rate-limited (10/h per IP), CORS for
the Tauri WebView. Email (Settings -> Help fallback) remains the
backup channel; the app never sends anything from a server.

Deploy (VPS): file at /home/maksim/vault-feedback/app.py, venv with
gunicorn, systemd unit `vault-feedback` (127.0.0.1:8090), nginx
`location = /api/feedback` proxy_pass. Triage: local cron reads the
sqlite over SSH (vault-feedback-triage.py).
