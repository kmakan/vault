#!/usr/bin/env python3
"""Второе письмо в RuStore: сайт восстановлен, причина была не на нашей стороне.

Отправляется ОДИН раз и только при выполнении всех условий:
  1. сайт реально отвечает 200 по /pd.html (дважды с интервалом 15 с, чтобы не
     поймать мигающий подъём);
  2. первое письмо (о недоступности) действительно ушло — есть штамп
     ~/.hermes/state/rustore-note-sent;
  3. второе письмо ещё не отправлялось — нет штампа
     ~/.hermes/state/rustore-restored-sent.

Коды выхода: 0 — отправлено или не требуется; 1 — ошибка при живом сайте;
2 — письмо не ушло (SMTP/сеть).
"""
import importlib.util
import os
import smtplib
import ssl
import sys
import time
from datetime import datetime
from email.message import EmailMessage

FIRST = os.path.expanduser("~/.hermes/scripts/rustore-site-note-send.py")
BODY = os.path.expanduser(
    "~/Notes/Projects/mailcipher/rustore-site-restored-2026-11-16.md")
SENT_FIRST = os.path.expanduser("~/.hermes/state/rustore-note-sent")
SENT_THIS = os.path.expanduser("~/.hermes/state/rustore-restored-sent")
TO = "support@rustore.ru"
SUBJECT = ("Re: Vault (2063778522), версия 0.1.289 — сайт снова доступен, "
           "статус оператора ПДн без изменений")

spec = importlib.util.spec_from_file_location("rustore_first", FIRST)
first = importlib.util.module_from_spec(spec)
spec.loader.exec_module(first)


def build(env: dict) -> EmailMessage:
    with open(BODY, encoding="utf-8") as f:
        text = f.read()
    # первая строка файла — тема, в тело не идёт
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
    if os.path.exists(SENT_THIS):
        return 0
    if not os.path.exists(SENT_FIRST):
        first.log("восстановление: первое письмо не отправлялось — не дополняем")
        return 0

    alive, why = first.site_alive()
    if not alive:
        return 0
    time.sleep(15)
    alive2, why2 = first.site_alive()
    if not alive2:
        first.log(f"сайт мигнул ({why} → {why2}) — ждём устойчивого подъёма")
        return 0

    try:
        env = first.load_env()
    except Exception as e:
        first.log(f"нет {first.ENV}: {e}")
        first.notify("RuStore: письмо о восстановлении не ушло",
                     "нет файла с паролем SMTP", "critical")
        return 2

    try:
        msg = build(env)
    except FileNotFoundError as e:
        first.log(f"нет текста письма: {e}")
        return 2

    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(env["VAULT_SMTP_HOST"], int(env["VAULT_SMTP_PORT"]),
                              context=ctx, timeout=40) as s:
            s.login(env["VAULT_SMTP_USER"], env["VAULT_SMTP_PASS"])
            s.send_message(msg)
    except Exception as e:
        first.log(f"SMTP отказал: {type(e).__name__}: {e}")
        first.notify("RuStore: письмо о восстановлении не ушло",
                     f"{type(e).__name__}: {e}", "critical")
        return 2

    first.save_sent_copy(msg, env)
    os.makedirs(os.path.dirname(SENT_THIS), exist_ok=True)
    with open(SENT_THIS, "w", encoding="utf-8") as f:
        f.write(datetime.now().isoformat(timespec="seconds") + "\n")
    first.log(f"письмо о восстановлении отправлено на {TO} (сайт: {why2})")
    first.notify("RuStore: письмо о восстановлении отправлено",
                 "сайт снова доступен, причина — авария провайдера", "normal")
    return 0


if __name__ == "__main__":
    sys.exit(main())
