#!/usr/bin/env python3
"""Письмо в RuStore о статусе оператора ПДн — но только если сайт недоступен.

Зачем: модерация RuStore (0.1.289) может открыть vault-msg.ru/pd.html и
увидеть таймаут из-за аварии хостинга. Письмо снимает эту зависимость:
прикладывает уведомления РКН и копии страниц политики.

Условие отправки: сайт НЕ отдаёт 200 по /pd.html. Если сайт жив — письмо не
нужно, скрипт молча выходит (код 0).

Коды выхода: 0 — отправлено или не требуется; 1 — сайт жив, но есть ошибка;
2 — сайт недоступен, письмо не ушло (нет пароля/сети/SMTP).
"""
import os
import smtplib
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime
from email.message import EmailMessage

ENV = os.path.expanduser("~/.config/vault-relay/rustore-mail.env")
LOG = os.path.expanduser("~/.hermes/logs/rustore-note.log")
SITE = "https://vault-msg.ru/pd.html"
TO = "support@rustore.ru"
SUBJECT = ("Vault (2063778522), версия 0.1.289 — статус оператора ПДн "
           "подтверждён, временная недоступность сайта")
RELEASE = os.path.expanduser("~/vault-releases/0.1.289")
SITE_DIR = os.path.expanduser("~/vault-site")
ATTACH = [
    os.path.join(RELEASE, "RKN-NOTIFICATION-100494543.pdf"),
    os.path.join(RELEASE, "RKN-CROSSBORDER-100494565.pdf"),
    os.path.join(SITE_DIR, "privacy.html"),
    os.path.join(SITE_DIR, "pd.html"),
]
BODY_FILE = os.path.expanduser(
    "~/Notes/Projects/mailcipher/rustore-site-down-note-2026-11-15.md")


def log(line: str) -> None:
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(datetime.now().isoformat(timespec="seconds") + " " + line + "\n")


def notify(title: str, body: str, urgency: str = "normal") -> None:
    try:
        subprocess.run(["notify-send", "-u", urgency, title, body], timeout=10)
    except Exception:
        pass


def site_alive() -> tuple[bool, str]:
    """Сайт жив, если /pd.html отдаёт 200 за 15 с."""
    req = urllib.request.Request(SITE, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status == 200, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def load_env() -> dict:
    env = {}
    with open(ENV, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v
    return env


def build(env: dict) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = f"Vault <{env['VAULT_SMTP_USER']}>"
    msg["To"] = TO
    msg["Subject"] = SUBJECT
    with open(BODY_FILE, encoding="utf-8") as f:
        text = f.read()
    # тело письма — после заголовка «Тема:», служебная строка в письмо не идёт
    text = text.split("\n", 1)[1].strip() if text.lower().startswith("тема:") else text
    msg.set_content(text)
    for path in ATTACH:
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        with open(path, "rb") as f:
            data = f.read()
        name = os.path.basename(path)
        if name.endswith(".pdf"):
            msg.add_attachment(data, maintype="application", subtype="pdf",
                               filename=name)
        else:
            msg.add_attachment(data, maintype="text", subtype="html",
                               filename=name)
    return msg


def save_sent_copy(msg: EmailMessage, env: dict) -> None:
    """Копия письма в «Отправленные».

    SMTP-отправка копию не сохраняет — в ящике остаются только ответы
    RuStore, и со стороны выглядит, будто мы писали не с этого адреса
    (проверено 16.11). Поэтому кладём копию сами, через IMAP APPEND.
    """
    try:
        import imaplib
        ctx = ssl.create_default_context()
        with imaplib.IMAP4_SSL("imap.yandex.ru", 993, ssl_context=ctx,
                               timeout=40) as im:
            im.login(env["VAULT_SMTP_USER"], env["VAULT_SMTP_PASS"])
            im.append("Sent", "\\Seen",
                      imaplib.Time2Internaldate(datetime.now()), msg.as_bytes())
    except Exception as e:
        log(f"копия в «Отправленные» не легла: {type(e).__name__}: {e}")


def main() -> int:
    alive, why = site_alive()
    if alive:
        log(f"сайт доступен ({why}) — письмо в RuStore не требуется")
        return 0
    log(f"сайт недоступен ({why}) — готовим письмо")

    if "--dry-run" in sys.argv:
        env = load_env()
        msg = build(env)
        print("Кому:", msg["To"])
        print("Тема:", msg["Subject"])
        print("Вложения:", [p for p in ATTACH])
        print("Строк тела:", msg.get_body(preferencelist=("plain",)).get_content().count("\n"))
        return 0

    try:
        env = load_env()
    except Exception as e:
        log(f"нет {ENV}: {e}")
        notify("RuStore: письмо не ушло", "нет файла с паролем SMTP", "critical")
        return 2

    try:
        msg = build(env)
    except FileNotFoundError as e:
        log(f"нет вложения: {e}")
        notify("RuStore: письмо не ушло", f"нет вложения {e}", "critical")
        return 2

    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(env["VAULT_SMTP_HOST"], int(env["VAULT_SMTP_PORT"]),
                              context=ctx, timeout=40) as s:
            s.login(env["VAULT_SMTP_USER"], env["VAULT_SMTP_PASS"])
            s.send_message(msg)
    except Exception as e:
        log(f"SMTP отказал: {type(e).__name__}: {e}")
        notify("RuStore: письмо не ушло", f"{type(e).__name__}: {e}", "critical")
        return 2

    save_sent_copy(msg, env)
    log(f"письмо отправлено на {TO} (сайт: {why})")
    notify("RuStore: письмо отправлено",
           "статус оператора ПДн + копии страниц политики", "normal")
    return 0


if __name__ == "__main__":
    sys.exit(main())
