#!/usr/bin/env python3
"""Слежение за тикетом хостера King Servers (WHMCS).

Зачем: сервер лежит, а ответ поддержки — единственный сигнал, когда его
поднимут. Почту/панель владелец может не открыть, поэтому скрипт сам забирает
страницу тикета, находит последнее сообщение и уведомляет ТОЛЬКО при изменении.

Авторизация: живая кука берётся из хранилища сессий Firefox (файл
sessionstore-backups/recovery.jsonlz4, формат mozLz40: 12-байтный заголовок +
сырой LZ4-блок). Кука не печатается и не логируется.

Коды выхода: 0 — без изменений; 10 — изменение (есть новый ответ);
20 — авторизация протухла (нужно один раз войти в панель в Firefox);
1 — сеть/разбор.
"""
import ctypes
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request

TICKET_URL = "https://control.king-servers.com/viewticket.php?tid=320239&c=R4h52kgC&language=russian"
HOST = "control.king-servers.com"
STATE = os.path.expanduser("~/.hermes/state/ks-ticket.last")
LOG = os.path.expanduser("~/.hermes/logs/ks-ticket.log")


def log(line: str) -> None:
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line.rstrip() + "\n")


def notify(title: str, body: str, urgency: str = "normal") -> None:
    try:
        subprocess.run(["notify-send", "-u", urgency, title, body], timeout=10)
    except Exception:
        pass


def firefox_cookies() -> dict:
    """Куки control.king-servers.com из последнего профиля Firefox."""
    base = os.path.expanduser("~/.mozilla/firefox")
    cands = glob.glob(base + "/*/sessionstore-backups/recovery.jsonlz4")
    if not cands:
        return {}
    path = max(cands, key=os.path.getmtime)
    raw = open(path, "rb").read()
    if raw[:8] != b"mozLz40\x00":
        return {}
    body = raw[12:]
    lib = ctypes.CDLL("liblz4.so.1")
    out = ctypes.create_string_buffer(len(body) * 8)
    n = lib.LZ4_decompress_safe(body, out, len(body), len(out))
    if n <= 0:
        return {}
    data = json.loads(out.raw[:n].decode("utf-8", "replace"))

    found: dict = {}

    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("cookies"), list):
                for c in o["cookies"]:
                    host = str(c.get("host") or c.get("domain") or "")
                    if HOST in host:
                        found[c.get("name")] = c.get("value")
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data)
    return found


def fetch(url: str, cookies: dict) -> tuple[int, str]:
    header = "; ".join(f"{k}={v}" for k, v in cookies.items())
    req = urllib.request.Request(url, headers={
        "Cookie": header,
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html",
    })
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)


def thread_messages(html: str) -> list[tuple[str, str]]:
    """Сообщения треда: (автор, текст).

    Автор важен: 15.11 сторож принял НАШЕ ЖЕ сообщение за ответ поддержки и
    выдал всплывашку «новый ответ по тикету». Разметка WHMCS помечает автора
    аватаром `ktd-avatar-support` (сотрудник) или `ktd-avatar-client` (мы);
    аватар стоит ПЕРЕД заголовком сообщения, поэтому автора берём как ближайший
    аватар слева от блока тела `data-reply-body-N`.
    """
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    bodies = list(re.finditer(r'data-reply-body-\d+>', text))
    avatars = [
        (m.start(), "support" if m.group(1) == "support" else "client")
        for m in re.finditer(r"ktd-avatar ktd-avatar-(support|client)", text)
    ]
    msgs: list[tuple[str, str]] = []
    for idx, m in enumerate(bodies):
        end = bodies[idx + 1].start() if idx + 1 < len(bodies) else len(text)
        raw = text[m.end():end]
        cut = raw.find('class="ktd-message-actions"')
        if cut >= 0:
            raw = raw[:cut]
        author = ""
        for pos, who in avatars:
            if pos < m.start():
                author = who
            else:
                break
        plain = re.sub(r"<[^>]+>", " ", raw.replace("&nbsp;", " "))
        body = re.sub(r"\s+", " ", plain).strip()
        if body:
            msgs.append((author, body))
    return msgs


def main() -> int:
    cookies = firefox_cookies()
    if not cookies:
        log(f"{__import__('datetime').datetime.now().isoformat(timespec='seconds')} нет куки хоста в Firefox — нужен вход в панель")
        notify("King Servers: нужен вход в панель", "Кука тикета пропала — откройте панель в Firefox один раз", "critical")
        return 20

    status, html = fetch(TICKET_URL, cookies)
    if status in (301, 302, 303) or "login-new.php" in html[:2000]:
        log(f"{__import__('datetime').datetime.now().isoformat(timespec='seconds')} сессия панели истекла")
        notify("King Servers: сессия истекла", "Войдите в панель в Firefox — иначе ответ поддержки не увидим", "critical")
        return 20
    if status != 200:
        log(f"{__import__('datetime').datetime.now().isoformat(timespec='seconds')} панель не ответила: {status}")
        return 1

    msgs = thread_messages(html)
    if not msgs:
        log(f"{__import__('datetime').datetime.now().isoformat(timespec='seconds')} тред не разобран")
        return 1

    last_author, last = msgs[-1]
    digest = hashlib.sha256((str(len(msgs)) + "\n" + last_author + "\n" + last).encode("utf-8")).hexdigest()

    prev = ""
    if os.path.exists(STATE):
        prev = open(STATE, encoding="utf-8").read().strip()
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        f.write(digest)

    if prev and prev != digest:
        stamp = __import__("datetime").datetime.now().isoformat(timespec="seconds")
        if last_author == "client":
            # наше собственное сообщение: писать его в лог можно, будить
            # владельца «новым ответом поддержки» — нельзя
            log(f"{stamp} наше сообщение в тикете (ответа поддержки нет): {last[:200]}")
            return 0
        log(f"{stamp} НОВОЕ сообщение в тикете: {last[:400]}")
        notify("King Servers: новый ответ по тикету", last[:400], "critical")
        return 10
    return 0


if __name__ == "__main__":
    sys.exit(main())
