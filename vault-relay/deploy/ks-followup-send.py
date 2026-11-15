#!/usr/bin/env python3
"""Отправка хостеру выводов и просьбы о перезагрузке ВМ — по сроку 18:30.

Условия отправки (все обязательны):
  * поддержка НЕ ответила после 12:05 UTC (число сообщений сотрудников не выросло);
  * сайт всё ещё не отдаёт 200 (авария не кончилась сама);
  * это сообщение ещё не отправлялось.

Иначе — молча выходит. Так «отправь в 18:30» не превращается в спам, если к
этому времени они ответят или сервер поднимется.

Коды выхода: 0 — отправлено или отправка не нужна; 1 — не удалось отправить;
2 — нет куки/панель не открылась.
"""
import hashlib
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime

WATCH = os.path.expanduser("~/.hermes/scripts/ks-ticket-watch.py")
BODY = os.path.expanduser("~/Notes/Projects/mailcipher/ks-followup-2026-11-15.md")
LOG = os.path.expanduser("~/.hermes/logs/ks-followup.log")
SENT = os.path.expanduser("~/.hermes/state/ks-followup-sent")
SITE = "https://vault-msg.ru/pd.html"
# Сообщений сотрудников на момент постановки срока: 09:44 и 12:05 UTC.
BASELINE_STAFF = 2


def log(line: str) -> None:
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(datetime.now().isoformat(timespec="seconds") + " " + line + "\n")


def notify(title: str, body: str, urgency: str = "normal") -> None:
    try:
        subprocess.run(["notify-send", "-u", urgency, title, body], timeout=10)
    except Exception:
        pass


def site_alive() -> bool:
    try:
        with urllib.request.urlopen(urllib.request.Request(
                SITE, headers={"User-Agent": "Mozilla/5.0"}), timeout=12) as r:
            return r.status == 200
    except Exception:
        return False


def main() -> int:
    spec = importlib.util.spec_from_file_location("ks", WATCH)
    ks = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ks)

    with open(BODY, encoding="utf-8") as f:
        text = f.read()
    digest = hashlib.sha256(text.encode()).hexdigest()[:16]

    if os.path.exists(SENT) and open(SENT, encoding="utf-8").read().strip() == digest:
        log("уже отправлено — повторно не шлём")
        return 0

    if site_alive():
        log("сайт ожил — отправка не нужна")
        return 0

    cookies = ks.firefox_cookies()
    if not cookies:
        log("нет куки панели в Firefox")
        notify("King Servers: сообщение не ушло", "кука панели пропала", "critical")
        return 2

    status, html = ks.fetch(ks.TICKET_URL, cookies)
    if status != 200 or "login-new.php" in html[:2000]:
        log(f"панель не открылась: {status}")
        notify("King Servers: сообщение не ушло", f"панель ответила {status}", "critical")
        return 2

    staff = [m for m in ks.thread_messages(html) if m[0] == "support"]
    if len(staff) > BASELINE_STAFF:
        log(f"поддержка ответила ({len(staff)} сообщений) — отправка отменена")
        return 0

    if "--check" in sys.argv:
        print(f"решение: отправлять (сайт лежит; ответов поддержки {len(staff)}, "
              f"новых нет — базовых {BASELINE_STAFF})")
        return 0

    m = re.search(r'name="token" value="([a-f0-9]{20,})"', html)
    if not m:
        log("не нашла token формы ответа")
        notify("King Servers: сообщение не ушло", "нет token формы", "critical")
        return 1
    token = m.group(1)

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt",
                                     delete=False) as f:
        f.write(text)
        path = f.name
    try:
        header = "; ".join(f"{k}={v}" for k, v in cookies.items())
        url = ks.TICKET_URL.split("&language=")[0] + "&postreply=true"
        res = subprocess.run(
            ["curl", "-sS", "--max-time", "40", "-o", "/dev/null",
             "-w", "%{http_code}", "-H", f"Cookie: {header}",
             "-A", "Mozilla/5.0", "-F", f"token={token}",
             "-F", f"replymessage=<{path}", url],
            capture_output=True, text=True, timeout=60)
        code = (res.stdout or "").strip()
    finally:
        os.unlink(path)

    if code != "302":
        log(f"отправка не удалась: HTTP {code} {res.stderr.strip()[:200]}")
        notify("King Servers: сообщение не ушло", f"панель ответила {code}", "critical")
        return 1

    os.makedirs(os.path.dirname(SENT), exist_ok=True)
    with open(SENT, "w", encoding="utf-8") as f:
        f.write(digest)

    log("выводы и просьба о перезагрузке отправлены в тикет #320239")
    notify("King Servers: отправлены выводы и просьба",
           "перезагрузка ВМ, инцидент ЦОД, состояние накопителя", "normal")
    return 0


if __name__ == "__main__":
    sys.exit(main())
