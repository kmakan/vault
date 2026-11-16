#!/usr/bin/env python3
"""Подготовка демо-ящика для модераторов RuStore: копия и чистка.

Зачем: в vault_msg@mail.ru лежат следы тестов смены почты (39 писем). Модератор
не должен видеть чужую переписку и наши тестовые письма. Перед удалением всё
сохраняется в ~/backups/demo-mailbox/<дата>/ как .eml — если что-то понадобится,
оно не потеряно.

Пароль берётся из ~/Notes/Projects/mailcipher/mails.md (раздел нужного ящика),
в вывод не попадает.

Использование:
  demo-mailbox-clean.py --dry-run     # только показать, что будет удалено
  demo-mailbox-clean.py               # копия + удаление
  demo-mailbox-clean.py --check       # проверить IMAP/SMTP, ничего не менять
"""
import base64
import email
import imaplib
import os
import re
import smtplib
import ssl
import sys
from datetime import datetime

MAILS = os.path.expanduser("~/Notes/Projects/mailcipher/mails.md")
BACKUP = os.path.expanduser("~/backups/demo-mailbox")
BOXES = [
    ("vault_msg@mail.ru", "imap.mail.ru", "smtp.mail.ru"),
    ("vault_msg@bk.ru", "imap.mail.ru", "smtp.mail.ru"),
]
FOLDERS = ["INBOX", "Отправленные", "Sent", "Спам", "Spam", "Корзина", "Trash",
           "Черновики", "Drafts"]


def utf7_decode(name: str) -> str:
    """Модифицированный UTF-7 из IMAP → обычная строка (для сверки имён папок)."""
    out, i = [], 0
    while i < len(name):
        if name[i] != "&":
            out.append(name[i]); i += 1; continue
        j = name.find("-", i)
        if j < 0:
            out.append(name[i:]); break
        chunk = name[i + 1:j]
        if not chunk:
            out.append("&")
        else:
            b64 = chunk.replace(",", "/")
            b64 += "=" * (-len(b64) % 4)
            try:
                out.append(base64.b64decode(b64).decode("utf-16-be"))
            except Exception:
                out.append(chunk)
        i = j + 1
    return "".join(out)


def folder_map(m) -> dict:
    """{отображаемое имя: имя для select (ASCII, как отдал сервер)}."""
    typ, data = m.list()
    res = {}
    for raw in data or []:
        s = raw.decode("ascii", "replace") if isinstance(raw, bytes) else raw
        mm = re.search(r'"([^"]*)"$', s)
        if not mm:
            continue
        sel = mm.group(1)
        res.setdefault(utf7_decode(sel), sel)
    res.setdefault("INBOX", "INBOX")
    return res


def password_for(addr: str) -> str:
    """Достаёт app password из mails.md: раздел «## ... <addr> ...» → строка с паролем."""
    text = open(MAILS, encoding="utf-8").read()
    # делим по заголовкам разделов
    chunks = re.split(r"\n## ", text)
    for ch in chunks:
        if addr in ch.split("\n", 1)[0]:
            m = re.search(r"Парол[^\n]*?:\s*`?([A-Za-z0-9]{8,})`?", ch, re.I)
            if m:
                return m.group(1)
    raise SystemExit(f"пароль для {addr} не найден в {MAILS}")


def main() -> int:
    dry = "--dry-run" in sys.argv[1:]
    check_only = "--check" in sys.argv[1:]
    only = None
    for a in sys.argv[1:]:
        if a.startswith("--box="):
            only = a.split("=", 1)[1]
    stamp = datetime.now().strftime("%Y-%m-%d")
    rc = 0

    for addr, imap_host, smtp_host in BOXES:
        if only and addr != only:
            continue
        try:
            pw = password_for(addr)
        except SystemExit as e:
            print(f"{addr}: {e}")
            rc = 1
            continue
        ctx = ssl.create_default_context()
        try:
            m = imaplib.IMAP4_SSL(imap_host, 993, ssl_context=ctx, timeout=30)
            m.login(addr, pw)
        except Exception as e:
            print(f"{addr}: вход IMAP не удался — {type(e).__name__}: {e}")
            rc = 1
            continue

        total = 0
        names = folder_map(m)
        targets = [n for n in names
                   if n in FOLDERS or n.startswith("INBOX/")]
        for folder in targets:
            sel = names.get(folder)
            if not sel:
                continue
            typ, _ = m.select(f'"{sel}"' if " " in sel else sel)
            if typ != "OK":
                continue
            typ, data = m.search(None, "ALL")
            ids = data[0].split() if typ == "OK" else []
            if not ids:
                continue
            total += len(ids)
            print(f"{addr} [{folder}]: {len(ids)} писем")
            if check_only or dry:
                continue
            dest = os.path.join(BACKUP, stamp, addr, folder.replace("/", "_"))
            os.makedirs(dest, exist_ok=True)
            os.chmod(os.path.join(BACKUP, stamp), 0o700)
            for i in ids:
                typ, d = m.fetch(i, "(RFC822)")
                if typ != "OK" or not isinstance(d[0], tuple):
                    continue
                msg = email.message_from_bytes(d[0][1])
                subj = re.sub(r"[^\w.-]+", "_", str(msg.get("Subject", "no-subject")))[:60]
                with open(os.path.join(dest, f"{i.decode()}_{subj}.eml"), "wb") as f:
                    f.write(d[0][1])
            m.store(",".join(x.decode() for x in ids), "+FLAGS", "\\Deleted")
            m.expunge()
            print(f"{addr} [{folder}]: сохранено и удалено {len(ids)}")

        if not (check_only or dry):
            m.select("INBOX")
            typ, data = m.search(None, "ALL")
            left = len(data[0].split()) if typ == "OK" else -1
            print(f"{addr}: после чистки в INBOX {left} писем")
        m.logout()

        if check_only or dry:
            continue
        try:
            with smtplib.SMTP_SSL(smtp_host, 465, context=ctx, timeout=30) as s:
                s.login(addr, pw)
            print(f"{addr}: SMTP-вход ок")
        except Exception as e:
            print(f"{addr}: SMTP не пустил — {type(e).__name__}: {e}")
            rc = 1
        print(f"{addr}: всего обработано {total}")

    return rc


if __name__ == "__main__":
    sys.exit(main())
