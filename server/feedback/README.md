# Vault feedback receiver

Tiny WSGI app (stdlib-only) behind nginx on vault-msg.ru:
`POST /api/feedback` -> sqlite, rate-limited (10/h per IP), CORS for
the Tauri WebView. Email (Settings -> Help fallback) remains the
backup channel; the app never sends anything from a server.

Deploy (VPS): app.py in a directory of your choice, venv with
gunicorn, systemd unit `vault-feedback` listening on 127.0.0.1:8090
(set VAULT_FEEDBACK_DB to the sqlite path), nginx
`location = /api/feedback` proxy_pass. Triage: read the sqlite with
any client or a small script over SSH.
