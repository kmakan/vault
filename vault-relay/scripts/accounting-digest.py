#!/usr/bin/env python3
"""Ежедневная сводка учёта Vault: доход, чеки «Мой налог», налог НПД.

Источник цифр — сам релей (`GET /admin/payments`): он спрашивает ЮKassa и
сводит платежи с реестром чеков/налога. Скрипт только читает — ничего не
меняет и не отмечает.

Запуск (systemd-таймер, 09:00 MSK = 06:00 UTC):
    EnvironmentFile=/home/maksim/vault-relay/env               # VAULT_RELAY_ADMIN_KEY
    EnvironmentFile=-/home/maksim/vault-relay/accounting.env   # ntfy / SMTP

Переменные (все, кроме ключа релея, необязательные):
    VAULT_ACCOUNTING_RELAY_URL   http://127.0.0.1:8091
    VAULT_ACCOUNTING_DIGEST_FILE файл с последней сводкой (для чтения по SSH)
    VAULT_ACCOUNTING_NTFY_URL    полный URL topic — включает пуш через ntfy
    VAULT_ACCOUNTING_MAIL_TO     получатель(и) через запятую — включает письмо
    VAULT_ACCOUNTING_MAIL_FROM   отправитель (по умолчанию SMTP_USER)
    VAULT_ACCOUNTING_SMTP_HOST   smtp.yandex.ru
    VAULT_ACCOUNTING_SMTP_PORT   465 (465 = SSL, иначе STARTTLS)
    VAULT_ACCOUNTING_SMTP_USER
    VAULT_ACCOUNTING_SMTP_PASS   пароль приложения, НЕ основной пароль

Сводка всегда пишется в файл и stdout (journald). Доставка — ntfy (HTTPS,
работает при закрытых SMTP-портах) и/или письмо. Если канал настроен, но
не сработал, скрипт сообщает об этом; успех хотя бы одного канала — успех.
Секреты не печатаются никогда.
"""

import json
import os
import re
import smtplib
import ssl
import sys
import urllib.request
from email.message import EmailMessage
from email.utils import formatdate

TIMEOUT = 20

# День постановки владельца на учёт в НПД (первый налоговый период по ч. 1
# ст. 9 422-ФЗ идёт со дня регистрации до конца следующего месяца). Из
# окружения — чтобы не расходилось с «Мой налог».
NPD_REGISTERED = os.environ.get("VAULT_ACCOUNTING_NPD_REGISTERED", "29.10.2026")


def first_period_deadline(month_key):
    """Срок уплаты налога для ПЕРВОГО периода (месяц постановки на учёт).

    Первый налоговый период — со дня регистрации до конца следующего месяца
    (ч. 1 ст. 9 422-ФЗ), налог за него платится до 28-го числа месяца, который
    идёт ПОСЛЕ конца первого периода. Постановка 29.10.2026 → период
    29.10–30.11 → оплата до 28.12.2026. Для остальных месяцев срок обычный.
    """
    m = re.match(r"^(\d{4})-(\d{2})$", str(month_key or ""))
    if not m:
        return None
    reg = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})$", NPD_REGISTERED)
    if not reg:
        return None
    r_day, r_month, r_year = int(reg.group(1)), int(reg.group(2)), int(reg.group(3))
    year, month = int(m.group(1)), int(m.group(2))
    if (year, month) != (r_year, r_month):
        return None
    # конец первого периода = конец месяца, следующего за месяцем регистрации
    end_month = month + 1 if month < 12 else 1
    end_year = year if month < 12 else year + 1
    # оплата — 28-е числа месяца после конца первого периода
    pay_month = end_month + 1 if end_month < 12 else 1
    pay_year = end_year if end_month < 12 else end_year + 1
    return "{:02d}.{:02d}.{:04d}".format(PAY_DAY_OF_TAX, pay_month, pay_year)


PAY_DAY_OF_TAX = 28


def env(name, default=""):
    return (os.environ.get(name) or default).strip()


def money(kopecks):
    """14900 → «149,00 ₽» (как на странице учёта)."""
    rub, cent = divmod(int(kopecks), 100)
    rub_text = "{:,}".format(rub).replace(",", " ")
    return "{},{:02d} ₽".format(rub_text, cent)


def fetch_report(base, admin_key):
    url = base.rstrip("/") + "/admin/payments"
    req = urllib.request.Request(url, headers={"x-admin-key": admin_key})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def overdue_mark(flag):
    return " (ПРОСРОЧЕН)" if flag else ""


def compose(report):
    lines = []
    lines.append("Учёт оплат Vault — на {}".format(report.get("as_of", "?")))
    lines.append("")
    lines.append(
        "Доход (подтверждённые оплаты): {}".format(report.get("income_text", "—"))
    )
    lines.append(
        "Налог НПД (оценка с вычетом): {}".format(report.get("tax_text", "—"))
    )
    lines.append(
        "Остаток вычета: {}".format(
            money(report.get("deduction_left_kopecks", 0))
        )
    )
    unaccounted = int(report.get("unaccounted", 0))
    if unaccounted:
        lines.append(
            "Без чека: {} — сформируйте в «Мой налог» и отметьте на странице "
            "учёта (штраф 20% суммы расчёта, минимум 1000 ₽).".format(unaccounted)
        )
    pending = int(report.get("pending", 0))
    canceled = int(report.get("canceled", 0))
    if pending or canceled:
        lines.append(
            "Ожидают оплаты: {}. Отменённых (в т.ч. брошенных чекаутов): {}.".format(
                pending, canceled
            )
        )
    err = report.get("error")
    if err:
        lines.append("")
        lines.append(
            "ВНИМАНИЕ: ЮKassa не ответила ({}), суммы могут быть неполными.".format(err)
        )

    months = report.get("months") or []
    if months:
        lines.append("")
        lines.append("Месяцы и налог (срок чека — 9-е, налога — 28-е):")
        for m in months:
            head = "  {} ({}): доход {}, налог {}".format(
                m.get("label", "?"),
                m.get("key", "?"),
                m.get("income_text", "—"),
                m.get("tax_text", "—"),
            )
            if m.get("tax_paid"):
                head += " — налог отмечен уплаченным"
            lines.append(head)
            lines.append(
                "    чек — до {}{}".format(
                    m.get("receipt_deadline", "?"),
                    overdue_mark(m.get("receipt_overdue")),
                )
            )
            # Срок налога: для ПЕРВОГО периода (месяц постановки на учёт) —
            # не 28-е этого месяца, а 28-е месяца после конца первого периода
            # (постановка 29.10 → период 29.10–30.11 → оплата до 28.12).
            key = m.get("key", "")
            tax_kopecks = 0
            try:
                tax_kopecks = int(str(m.get("tax_text", "0")).replace(" ", "").replace("₽", "").replace(",", ".").split(".")[0])
            except Exception:
                tax_kopecks = 0
            if tax_kopecks and tax_kopecks <= 100 and not m.get("tax_paid"):
                lines.append(
                    "    налог — накоплен (до 100 ₽ не платится, переносится в следующий период)"
                )
            else:
                deadline = first_period_deadline(key) or m.get("tax_deadline", "?")
                lines.append(
                    "    налог — до {}{}{}".format(
                        deadline,
                        overdue_mark(m.get("tax_overdue")),
                        "" if m.get("tax_paid") else " — не отмечен уплаченным",
                    )
                )

    missing = [
        e for e in (report.get("entries") or []) if not e.get("receipt_at")
    ]
    if missing:
        lines.append("")
        lines.append("Оплаты без чека:")
        for e in missing:
            test = " [тестовый]" if e.get("test") else ""
            lines.append(
                "  {} — {} — {}{}".format(
                    e.get("created_msk", "?"),
                    e.get("amount_text", "—"),
                    e.get("description", ""),
                    test,
                )
            )

    lines.append("")
    lines.append(
        "Налог платится в «Мой налог» → «Начисления» до 28-го числа "
        "следующего месяца; автоплатёж включается в банке "
        "(Т-Банк/Сбер/Альфа/ВТБ/МТС)."
    )
    lines.append(
        "Ставка 4% (доходы от физлиц) минус бонус-вычет 10 000 ₽, который "
        "расходуется постепенно (ставка падает до 3% на первом 1 млн ₽ дохода). "
        "Если начисленный налог не превышает 100 ₽, он переносится в следующий "
        "период — платить пока не нужно (ч. 2 ст. 11 422-ФЗ)."
    )
    if NPD_REGISTERED:
        lines.append(
            "Первый налоговый период — с {} (день постановки на учёт) по 30.11.2026: "
            "квитанция приходит до 12.12, оплата — до 28.12.2026. Доходы октября "
            "входят в этот первый период, а не в отдельный «октябрьский».".format(
                NPD_REGISTERED
            )
        )
    return "\n".join(lines)


def send_mail(subject, body, cfg):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg["mail_from"]
    msg["To"] = ", ".join(cfg["mail_to"])
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(body, charset="utf-8")
    host, port = cfg["smtp_host"], cfg["smtp_port"]
    ctx = ssl.create_default_context()
    if port == 465:
        smtp = smtplib.SMTP_SSL(host, port, timeout=TIMEOUT, context=ctx)
    else:
        smtp = smtplib.SMTP(host, port, timeout=TIMEOUT)
        smtp.starttls(context=ctx)
    try:
        smtp.login(cfg["smtp_user"], cfg["smtp_pass"])
        smtp.send_message(msg)
    finally:
        try:
            smtp.quit()
        except Exception:
            pass


def send_ntfy(url, title, body):
    req = urllib.request.Request(url, data=body.encode("utf-8"), method="POST")
    req.add_header("Content-Type", "text/plain; charset=utf-8")
    req.add_header("Title", title)
    req.add_header("Tags", "moneybag")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        if not 200 <= resp.status < 300:
            raise RuntimeError("ntfy ответил {}".format(resp.status))


def main(argv):
    dry_run = "--dry-run" in argv
    admin_key = env("VAULT_RELAY_ADMIN_KEY")
    if not admin_key:
        print(
            "accounting-digest: нет VAULT_RELAY_ADMIN_KEY (ожидается из env релея)",
            file=sys.stderr,
        )
        return 2
    base = env("VAULT_ACCOUNTING_RELAY_URL", "http://127.0.0.1:8091")
    try:
        report = fetch_report(base, admin_key)
    except Exception as exc:
        print("accounting-digest: отчёт не получен: {}".format(exc), file=sys.stderr)
        return 1

    body = compose(report)
    print(body)

    out = env("VAULT_ACCOUNTING_DIGEST_FILE")
    if out:
        tmp = out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, out)

    to = [a.strip() for a in env("VAULT_ACCOUNTING_MAIL_TO").split(",") if a.strip()]
    user = env("VAULT_ACCOUNTING_SMTP_USER")
    password = env("VAULT_ACCOUNTING_SMTP_PASS")
    ntfy_url = env("VAULT_ACCOUNTING_NTFY_URL")
    mail_ready = bool(to and user and password)

    if not ntfy_url and not mail_ready:
        print(
            "accounting-digest: сводка в файле; доставка не настроена "
            "(нет VAULT_ACCOUNTING_NTFY_URL и SMTP-переменных)"
        )
        return 0
    if dry_run:
        print("accounting-digest: --dry-run, доставка не выполнялась")
        return 0

    sent = 0
    if ntfy_url:
        try:
            send_ntfy(ntfy_url, "Vault accounting digest", body)
            sent += 1
            print("accounting-digest: сводка отправлена в ntfy")
        except Exception as exc:
            print(
                "accounting-digest: ntfy не ответил: {}".format(exc),
                file=sys.stderr,
            )
    if mail_ready:
        subject = "Vault — учёт на {}: доход {}, без чека {}".format(
            report.get("as_of", "?"),
            report.get("income_text", "—"),
            int(report.get("unaccounted", 0)),
        )
        cfg = {
            "mail_to": to,
            "mail_from": env("VAULT_ACCOUNTING_MAIL_FROM", user),
            "smtp_host": env("VAULT_ACCOUNTING_SMTP_HOST", "smtp.yandex.ru"),
            "smtp_port": int(env("VAULT_ACCOUNTING_SMTP_PORT", "465")),
            "smtp_user": user,
            "smtp_pass": password,
        }
        try:
            send_mail(subject, body, cfg)
            sent += 1
            print("accounting-digest: письмо отправлено: {}".format(", ".join(to)))
        except Exception as exc:
            print(
                "accounting-digest: письмо не ушло: {}".format(exc),
                file=sys.stderr,
            )
    return 0 if sent else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
