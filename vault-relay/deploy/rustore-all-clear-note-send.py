#!/usr/bin/env python3
"""Третье письмо в RuStore: сервер восстановлен, всё работает, спасибо за понимание.

Отправляется ОДИН раз (штамп ~/.hermes/state/rustore-all-clear-sent).
Условия: первое письмо ушло, сайт отвечает 200 по /pd.html.

Использование: rustore-all-clear-note-send.py [--dry-run]
Коды выхода: 0 — отправлено/не требуется; 2 — письмо не ушло.
"""
import importlib.util
import os
import smtplib
import ssl
import sys
from datetime import datetime
from email.message import EmailMessage

FIRST = os.path.expanduser("~/.hermes/scripts/rustore-site-note-send.py")
BODY = os.path.expanduser(
    "~/Notes/Projects/mailcipher/rustore-all-clear-2026-11-16.md")
SENT_FIRST = os.path.expanduser("~/.hermes/state/rustore-note-sent")
SENT_THIS = os.path.expanduser("~/.hermes/state/rustore-all-clear-sent")
TO = "support@rustore.ru"
SUBJECT = ("Re: Vault (2063778522), версия 0.1.289 — сервер восстановлен, "
           "всё работает")

spec = importlib.util.spec_from_file_location("rustore_first", FIRST)
first = importlib.util.module_from_spec(spec)
spec.loader.exec_module(first)

DRY = "--dry-run" in sys.argv[1:]


def build(env: dict) -> EmailMessage:
    with open(BODY, encoding="utf-8") as f:
        text = f.read()
    lines = text.split("\n")
    if lines and lines[0].startswith("Тема:"):
        text = "\n".join(lines[1:]).lstrip("\n")

    msg = EmailMessage()
    msg["From"] = env["VAULT_SMTP_USER"]
    msg["To"] = TO
    msg["Subject"] = SUBJECT
    msg["Date"] = datetime.now().astimezone().strftime("%a, %d %b %Y %H:%M:%S %z")
    msg.set_content(text)
    return msg


def main() -> int:
    if os.path.exists(SENT_THIS) and not DRY:
        return 0
    if not os.path.exists(SENT_FIRST):
        first.log("всё-в-порядке: первое письмо не отправлялось — не пишем")
        return 0

    alive, why = first.site_alive()
    if not alive:
        first.log(f"всё-в-порядке: сайт не отвечает ({why}) — не пишем")
        return 0

    env = first.load_env()
    msg = build(env)

    if DRY:
        print(f"Кому: {msg['To']}\nТема: {msg['Subject']}\n\n{msg.get_content()}")
        return 0

    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(env["VAULT_SMTP_HOST"], int(env["VAULT_SMTP_PORT"]),
                              context=ctx, timeout=40) as s:
            s.login(env["VAULT_SMTP_USER"], env["VAULT_SMTP_PASS"])
            s.send_message(msg)
    except Exception as e:
        first.log(f"SMTP отказал (всё-в-порядке): {type(e).__name__}: {e}")
        first.notify("RuStore: письмо «всё работает» не ушло",
                     f"{type(e).__name__}: {e}", "critical")
        return 2

    first.save_sent_copy(msg, env)
    os.makedirs(os.path.dirname(SENT_THIS), exist_ok=True)
    with open(SENT_THIS, "w", encoding="utf-8") as f:
        f.write(datetime.now().isoformat(timespec="seconds") + "\n")
    first.log(f"письмо «сервер восстановлен, всё работает» отправлено на {TO}")
    first.notify("RuStore: письмо «всё работает» отправлено",
                 "сервер восстановлен, открытых вопросов нет", "normal")
    return 0


if __name__ == "__main__":
    sys.exit(main())
