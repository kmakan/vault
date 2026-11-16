#!/usr/bin/env python3
"""Восстановить в «Отправленных» копии писем, ушедших по SMTP.

Почему: SMTP-отправка НЕ кладёт копию в «Отправленные» — это делает только
веб-интерфейс или явный APPEND. Из-за этого в ящике vault-msg@ya.ru видны
ответы RuStore, но не наши письма: со стороны выглядит, будто мы писали
не с этого адреса. На самом деле From был верный (ответы пришли сюда же).

Скрипт собирает те же письма (тема, дата, текст, вложения) и кладёт копии
в Sent с флагом \\Seen. Ничего не отправляет.
"""
import imaplib
import os
import re
import ssl
from datetime import datetime
from email.message import EmailMessage
from email.utils import format_datetime

ENV = os.path.expanduser("~/.config/vault-relay/rustore-mail.env")
NOTES = os.path.expanduser("~/Notes/Projects/mailcipher")
RELEASE = os.path.expanduser("~/vault-releases/0.1.289")
SITE = os.path.expanduser("~/vault-site")

LETTERS = [
    {
        "file": f"{NOTES}/rustore-site-down-note-2026-11-15.md",
        "subject": ("Vault (2063778522), версия 0.1.289 — статус оператора ПДн "
                    "подтверждён, временная недоступность сайта"),
        "date": datetime(2026, 11, 15, 21, 27, 37).astimezone(),
        "attach": [
            f"{RELEASE}/RKN-NOTIFICATION-100494543.pdf",
            f"{RELEASE}/RKN-CROSSBORDER-100494565.pdf",
            f"{SITE}/privacy.html",
            f"{SITE}/pd.html",
        ],
    },
    {
        "file": f"{NOTES}/rustore-site-restored-2026-11-16.md",
        "subject": ("Re: Vault (2063778522), версия 0.1.289 — сайт снова доступен, "
                    "статус оператора ПДн без изменений"),
        "date": datetime(2026, 11, 16, 14, 10, 30).astimezone(),
        "attach": [],
    },
    {
        "file": f"{NOTES}/rustore-all-clear-2026-11-16.md",
        "subject": ("Re: Vault (2063778522), версия 0.1.289 — сервер восстановлен, "
                    "всё работает"),
        "date": datetime(2026, 11, 16, 18, 58, 32).astimezone(),
        "attach": [],
    },
]


def load_env() -> dict:
    env = {}
    for line in open(ENV, encoding="utf-8"):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    return env


def body_of(path: str) -> str:
    text = open(path, encoding="utf-8").read()
    lines = text.split("\n")
    if lines and lines[0].startswith("Тема:"):
        text = "\n".join(lines[1:]).lstrip("\n")
    return text


def build(env: dict, item: dict) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = env["VAULT_SMTP_USER"]
    msg["To"] = "support@rustore.ru"
    msg["Subject"] = item["subject"]
    msg["Date"] = format_datetime(item["date"])
    msg.set_content(body_of(item["file"]))
    for path in item["attach"]:
        if not os.path.exists(path):
            print("  нет вложения:", path)
            continue
        data = open(path, "rb").read()
        ctype = "application/pdf" if path.endswith(".pdf") else "text/html"
        maintype, subtype = ctype.split("/", 1)
        msg.add_attachment(data, maintype=maintype, subtype=subtype,
                           filename=os.path.basename(path))
    return msg


def main() -> int:
    env = load_env()
    ctx = ssl.create_default_context()
    m = imaplib.IMAP4_SSL("imap.yandex.ru", 993, ssl_context=ctx, timeout=40)
    m.login(env["VAULT_SMTP_USER"], env["VAULT_SMTP_PASS"])

    typ, _ = m.select("Sent")
    if typ != "OK":
        print("нет папки Sent")
        return 1
    typ, data = m.search(None, "ALL")
    have = set()
    for i in (data[0].split() if typ == "OK" else []):
        typ, d = m.fetch(i, "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE)])")
        if typ == "OK" and isinstance(d[0], tuple):
            have.add(d[0][1].decode("utf-8", "replace").strip())

    added = 0
    for item in LETTERS:
        msg = build(env, item)
        # уже есть такая копия? (сверяем тему в заголовках папки)
        if any(item["subject"][:40] in h for h in have):
            print("уже есть:", item["subject"][:50])
            continue
        raw = msg.as_bytes()
        typ, resp = m.append("Sent", "\\Seen", imaplib.Time2Internaldate(item["date"]), raw)
        print(("добавлено: " if typ == "OK" else "ошибка: ") + item["subject"][:60])
        if typ == "OK":
            added += 1
    m.logout()
    print(f"итого добавлено копий: {added}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
