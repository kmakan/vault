#!/usr/bin/env python3
"""
Whisper/MailCipher — Email Integration Test
Тест IMAP/SMTP на реальных Gmail аккаунтах.

Тесты:
  1. IMAP подключение + чтение писем
  2. SMTP отправка письма
  3. Круговой тест: A→B, проверка получения на B
  4. Шифрование+отправка: зашифровать → отправить → получить → расшифровать
"""

import imaplib
import smtplib
import email
from email.mime.text import MIMEText
from email.header import decode_header
import time
import sys
import os
import base64
import secrets

# ─── Конфигурация ───────────────────────────────────────────────

ACCOUNTS = {
    "alice": {
        "email": "icemaksim@gmail.com",
        "password": "rrlb wmsn uxoj wctq",
        "imap_server": "imap.gmail.com",
        "imap_port": 993,
        "smtp_server": "smtp.gmail.com",
        "smtp_port": 587,
    },
    "bob": {
        "email": "koanmak@gmail.com",
        "password": "ldel yktv cwhq wrvs",
        "imap_server": "imap.gmail.com",
        "imap_port": 993,
        "smtp_server": "smtp.gmail.com",
        "smtp_port": 587,
    },
}

# ─── Простой шифр (Alpha + Columnar) ────────────────────────────

def alpha_encrypt(text: str, key: str) -> str:
    """Шифр Альфа: замена символов на основе ключа (только ASCII A-Z)"""
    result = []
    key_idx = 0
    for ch in text.upper():
        if 'A' <= ch <= 'Z':
            shift = ord(key[key_idx % len(key)]) - ord('A')
            encrypted = chr((ord(ch) - ord('A') + shift) % 26 + ord('A'))
            result.append(encrypted)
            key_idx += 1
        else:
            result.append(ch)
    return ''.join(result)


def alpha_decrypt(cipher: str, key: str) -> str:
    """Обратная операция Alpha (только ASCII A-Z)"""
    result = []
    key_idx = 0
    for ch in cipher.upper():
        if 'A' <= ch <= 'Z':
            shift = ord(key[key_idx % len(key)]) - ord('A')
            decrypted = chr((ord(ch) - ord('A') - shift) % 26 + ord('A'))
            result.append(decrypted)
            key_idx += 1
        else:
            result.append(ch)
    return ''.join(result)


def columnar_encrypt(text: str, key: str) -> str:
    """Шифр колонной замены"""
    text = text.replace(" ", "")
    cols = len(key)
    rows = (len(text) + cols - 1) // cols

    # Заполняем матрицу по строкам
    matrix = [['' for _ in range(cols)] for _ in range(rows)]
    idx = 0
    for i in range(rows):
        for j in range(cols):
            if idx < len(text):
                matrix[i][j] = text[idx]
                idx += 1

    # Читаем по колоннам в порядке ключа
    order = sorted(range(len(key)), key=lambda k: key[k])
    result = []
    for col in order:
        for row in range(rows):
            ch = matrix[row][col]
            if ch:
                result.append(ch)
    return ''.join(result)


def columnar_decrypt(cipher: str, key: str) -> str:
    """Обратная операция Columnar"""
    cols = len(key)
    order = sorted(range(len(key)), key=lambda k: key[k])

    total = len(cipher)
    full_rows = total // cols
    extra = total % cols  # сколько первых колонн (по индексу) имеют +1

    # Колонны 0..extra-1 имеют full_rows+1, остальные full_rows
    col_lengths = {}
    for c in range(cols):
        col_lengths[c] = full_rows + (1 if c < extra else 0)

    # Заполняем матрицу по колоннам в порядке ключа
    num_rows = full_rows + (1 if extra else 0)
    matrix = [['' for _ in range(cols)] for _ in range(num_rows)]
    idx = 0
    for col_idx in order:
        length = col_lengths[col_idx]
        for row in range(length):
            if idx < len(cipher):
                matrix[row][col_idx] = cipher[idx]
                idx += 1

    # Читаем по строкам
    result = []
    for i in range(num_rows):
        for j in range(cols):
            if matrix[i][j]:
                result.append(matrix[i][j])
    return ''.join(result)


def combined_encrypt(text: str, alpha_key: str, column_key: str) -> str:
    return columnar_encrypt(alpha_encrypt(text, alpha_key), column_key)


def combined_decrypt(cipher: str, alpha_key: str, column_key: str) -> str:
    return alpha_decrypt(columnar_decrypt(cipher, column_key), alpha_key)


# ─── Тестовые функции ───────────────────────────────────────────

class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []

    def ok(self, name: str):
        self.passed += 1
        print(f"  ✅ {name}")

    def fail(self, name: str, reason: str):
        self.failed += 1
        self.errors.append((name, reason))
        print(f"  ❌ {name}: {reason}")

    def summary(self):
        total = self.passed + self.failed
        print(f"\n{'='*60}")
        print(f"Результат: {self.passed}/{total} пройдено, {self.failed} провалено")
        if self.errors:
            print("\nОшибки:")
            for name, reason in self.errors:
                print(f"  • {name}: {reason}")
        print(f"{'='*60}")
        return self.failed == 0


def decode_mime_header(header_value):
    """Декодировать MIME-заголовок"""
    if header_value is None:
        return "(none)"
    decoded_parts = decode_header(header_value)
    result = []
    for part, charset in decoded_parts:
        if isinstance(part, bytes):
            result.append(part.decode(charset or 'utf-8', errors='replace'))
        else:
            result.append(part)
    return ''.join(result)


def imap_connect(account_name: str, acc: dict):
    """Подключиться к IMAP"""
    print(f"  Подключение IMAP к {acc['imap_server']}:{acc['imap_port']}...")
    mail = imaplib.IMAP4_SSL(acc['imap_server'], acc['imap_port'])
    mail.login(acc['email'], acc['password'])
    print(f"  авторизация {acc['email']} — OK")
    return mail


def smtp_connect(account_name: str, acc: dict):
    """Подключиться к SMTP"""
    print(f"  Подключение SMTP к {acc['smtp_server']}:{acc['smtp_port']}...")
    server = smtplib.SMTP(acc['smtp_server'], acc['smtp_port'])
    server.starttls()
    server.login(acc['email'], acc['password'])
    print(f"  авторизация {acc['email']} — OK")
    return server


def test_imap_read(mail, test_name="чтение INBOX"):
    """Прочитать последние письма из INBOX"""
    status, data = mail.select("INBOX")
    if status != 'OK':
        raise Exception(f"Не удалось выбрать INBOX: {status}")

    msg_count = int(data[0])
    print(f"  писем в INBOX: {msg_count}")

    if msg_count == 0:
        return []

    # Берём последние 5
    start = max(1, msg_count - 4)
    status, msg_ids = mail.fetch(f"{start}:{msg_count}", "(UID)")
    if status != 'OK':
        raise Exception(f"Fetch UID failed: {status}")

    messages = []
    for item in msg_ids:
        if isinstance(item, tuple):
            uid_part = item[0].decode() if item[0] else ""
            # Извлечь UID
            if b'UID' in (item[1] or b''):
                uid_str = item[1].decode()
                uid = uid_str.split('UID')[1].strip().rstrip(')')
                messages.append(uid)

    # Теперь читаем заголовки
    result = []
    status, data = mail.uid("search", None, "ALL")
    if status == 'OK':
        all_uids = data[0].split()
        # Берём последние 5
        for uid in all_uids[-5:]:
            status, msg_data = mail.uid("fetch", uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            if status == 'OK' and msg_data[0]:
                header_bytes = msg_data[0][1]
                msg = email.message_from_bytes(header_bytes)
                result.append({
                    'uid': uid.decode(),
                    'from': decode_mime_header(msg.get('From')),
                    'subject': decode_mime_header(msg.get('Subject')),
                    'date': decode_mime_header(msg.get('Date')),
                })

    return result


def send_test_email(smtp, from_email: str, to_email: str, subject: str, body: str):
    """Отправить тестовое письмо"""
    msg = MIMEText(body, 'plain', 'utf-8')
    msg['From'] = from_email
    msg['To'] = to_email
    msg['Subject'] = subject

    smtp.sendmail(from_email, [to_email], msg.as_string())
    print(f"  отправлено: {from_email} → {to_email}")


def find_message_by_subject(mail, subject: str, timeout: int = 30) -> bool:
    """Найти письмо по теме с таймаутом"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, data = mail.uid("search", None, "ALL")
        if status == 'OK':
            all_uids = data[0].split()
            for uid in all_uids[-10:]:  # проверяем последние 10
                status, msg_data = mail.uid("fetch", uid, "(BODY.PEEK[HEADER.FIELDS (SUBJECT)])")
                if status == 'OK' and msg_data[0]:
                    header_bytes = msg_data[0][1]
                    msg = email.message_from_bytes(header_bytes)
                    msg_subject = decode_mime_header(msg.get('Subject'))
                    if subject in msg_subject:
                        return True
        time.sleep(2)
    return False


def fetch_body_by_subject(mail, subject: str) -> str | None:
    """Найти и вернуть тело письма по теме"""
    status, data = mail.uid("search", None, "ALL")
    if status != 'OK':
        return None

    all_uids = data[0].split()
    for uid in all_uids:
        status, msg_data = mail.uid("fetch", uid, "(BODY.PEEK[HEADER.FIELDS (SUBJECT)])")
        if status == 'OK' and msg_data[0]:
            header_bytes = msg_data[0][1]
            msg = email.message_from_bytes(header_bytes)
            msg_subject = decode_mime_header(msg.get('Subject'))
            if subject in msg_subject:
                # Fetch full message for proper MIME decoding
                status, body_data = mail.uid("fetch", uid, "(RFC822)")
                if status == 'OK' and body_data[0]:
                    full_bytes = body_data[0][1]
                    full_msg = email.message_from_bytes(full_bytes)
                    # Извлекаем текст из MIME-структуры
                    if full_msg.is_multipart():
                        for part in full_msg.walk():
                            ct = part.get_content_type()
                            if ct == 'text/plain':
                                payload = part.get_payload(decode=True)
                                if payload:
                                    charset = part.get_content_charset() or 'utf-8'
                                    return payload.decode(charset, errors='replace').strip()
                    else:
                        payload = full_msg.get_payload(decode=True)
                        if payload:
                            charset = full_msg.get_content_charset() or 'utf-8'
                            return payload.decode(charset, errors='replace').strip()
                    # Fallback: raw body
                    body_bytes = body_data[0][1]
                    return body_bytes.decode('utf-8', errors='replace').strip()
    return None


# ─── Основной тест ──────────────────────────────────────────────

def main():
    results = TestResult()
    timestamp = int(time.time())
    alice_mail = None
    bob_mail = None
    alice_smtp = None
    bob_smtp = None

    print("=" * 60)
    print("Whisper/MailCipher — Email Integration Test")
    print("=" * 60)

    # ── Тест 1: IMAP подключение ──────────────────────────────────
    print("\n📧 Тест 1: IMAP подключение")
    try:
        alice_mail = imap_connect("alice", ACCOUNTS["alice"])
        results.ok("Alice IMAP подключение")
    except Exception as e:
        results.fail("Alice IMAP подключение", str(e))

    try:
        bob_mail = imap_connect("bob", ACCOUNTS["bob"])
        results.ok("Bob IMAP подключение")
    except Exception as e:
        results.fail("Bob IMAP подключение", str(e))

    if not alice_mail or not bob_mail:
        print("\n⚠️  IMAP подключение не удалось, дальнейшие тесты невозможны")
        results.summary()
        sys.exit(1)

    # ── Тест 2: Чтение писем ─────────────────────────────────────
    print("\n📬 Тест 2: Чтение писем из INBOX")
    try:
        alice_msgs = test_imap_read(alice_mail, "alice INBOX")
        results.ok(f"Alice INBOX ({len(alice_msgs)} писем)")
        for m in alice_msgs:
            print(f"    📨 {m['from'][:40]} | {m['subject'][:50]}")
    except Exception as e:
        results.fail("Alice INBOX", str(e))

    try:
        bob_msgs = test_imap_read(bob_mail, "bob INBOX")
        results.ok(f"Bob INBOX ({len(bob_msgs)} писем)")
        for m in bob_msgs:
            print(f"    📨 {m['from'][:40]} | {m['subject'][:50]}")
    except Exception as e:
        results.fail("Bob INBOX", str(e))

    # ── Тест 3: SMTP подключение + отправка ───────────────────────
    print("\n📤 Тест 3: SMTP отправка")
    try:
        alice_smtp = smtp_connect("alice", ACCOUNTS["alice"])
        results.ok("Alice SMTP подключение")
    except Exception as e:
        results.fail("Alice SMTP подключение", str(e))

    try:
        bob_smtp = smtp_connect("bob", ACCOUNTS["bob"])
        results.ok("Bob SMTP подключение")
    except Exception as e:
        results.fail("Bob SMTP подключение", str(e))

    # ── Тест 4: Отправка A→B ─────────────────────────────────────
    test_subject = f"[Whisper Test] {timestamp}"
    test_body = f"Это тестовое письмо от Whisper/MailCipher.\nTimestamp: {timestamp}\nПришло время: {time.strftime('%H:%M:%S')}"

    print(f"\n📨 Тест 4: Отправка Alice → Bob")
    print(f"  Тема: {test_subject}")
    try:
        send_test_email(
            alice_smtp,
            ACCOUNTS["alice"]["email"],
            ACCOUNTS["bob"]["email"],
            test_subject,
            test_body,
        )
        results.ok("Отправка Alice → Bob")
    except Exception as e:
        results.fail("Отправка Alice → Bob", str(e))

    # Ждём доставки
    print("  ⏳ Ожидание доставки (до 30 сек)...")
    time.sleep(3)

    # ── Тест 5: Получение на B ────────────────────────────────────
    print(f"\n📥 Тест 5: Поиск письма на Bob")
    try:
        found = find_message_by_subject(bob_mail, test_subject, timeout=30)
        if found:
            results.ok("Bob получил письмо от Alice")
        else:
            results.fail("Bob получил письмо", "Письмо не найдено за 30 сек")
    except Exception as e:
        results.fail("Bob получил письмо", str(e))

    # ── Тест 6: Шифрование → отправка → расшифрование ─────────────
    print(f"\n🔐 Тест 6: Шифрование (Alpha + Columnar)")
    alpha_key = "MAGIC"
    column_key = "3124"
    original_text = "Привет, Боб! Это зашифрованное сообщение через Whisper. Timestamp: " + str(timestamp)

    try:
        encrypted = combined_encrypt(original_text, alpha_key, column_key)
        print(f"  Оригинал: {original_text[:60]}...")
        print(f"  Зашифр.:  {encrypted[:60]}...")

        decrypted = combined_decrypt(encrypted, alpha_key, column_key)
        # Сравниваем (колонная замена убирает пробелы)
        original_no_spaces = original_text.replace(" ", "").upper()
        if decrypted == original_no_spaces:
            results.ok("Шифрование/расшифрование (Alpha + Columnar)")
        else:
            results.fail("Шифрование/расшифрование",
                         f"Расшифр. текст не совпадает.\n    Ожидалось: {original_no_spaces[:80]}\n    Получено: {decrypted[:80]}")
    except Exception as e:
        results.fail("Шифрование/расшифрование", str(e))

    # ── Тест 7: Зашифрованное письмо A→B ─────────────────────────
    enc_subject = f"[Whisper Encrypted] {timestamp}"
    enc_body = f"-----BEGIN ENCRYPTED MESSAGE-----\n{encrypted}\n-----END ENCRYPTED MESSAGE-----"

    print(f"\n🔒 Тест 7: Зашифрованное письмо Alice → Bob")
    print(f"  Тема: {enc_subject}")
    try:
        send_test_email(
            alice_smtp,
            ACCOUNTS["alice"]["email"],
            ACCOUNTS["bob"]["email"],
            enc_subject,
            enc_body,
        )
        results.ok("Отправка зашифрованного письма Alice → Bob")
    except Exception as e:
        results.fail("Отправка зашифрованного письма", str(e))

    print("  ⏳ Ожидание доставки (до 30 сек)...")
    time.sleep(3)

    # ── Тест 8: Получение + расшифрование на B ────────────────────
    print(f"\n📥 Тест 8: Получение зашифрованного письма на Bob")
    try:
        # Ждём доставки (Gmail может задерживать)
        print("  ⏳ Ожидание доставки (до 60 сек)...")
        found = find_message_by_subject(bob_mail, enc_subject, timeout=60)
        if not found:
            # Может быть задержка — попробуем ещё раз с полным поиском
            print("  ⏳ Повторный поиск...")
            time.sleep(10)
            found = find_message_by_subject(bob_mail, enc_subject, timeout=30)
        if found:
            body = fetch_body_by_subject(bob_mail, enc_subject)
            if body:
                # Извлекаем зашифрованный текст
                if "BEGIN ENCRYPTED MESSAGE" in body:
                    start = body.index("BEGIN ENCRYPTED MESSAGE") + len("BEGIN ENCRYPTED MESSAGE")
                    end = body.index("END ENCRYPTED MESSAGE")
                    enc_text = body[start:end].strip()
                    decrypted = combined_decrypt(enc_text, alpha_key, column_key)
                    original_no_spaces = original_text.replace(" ", "").upper()
                    if decrypted == original_no_spaces:
                        results.ok("Bob расшифровал письмо")
                        print(f"    Расшифр.: {decrypted[:60]}...")
                    else:
                        results.fail("Расшифрование на Bob",
                                     f"Текст не совпадает.\n    Ожидалось: {original_no_spaces[:80]}\n    Получено: {decrypted[:80]}")
                else:
                    # Отладка: показать что нашли
                    print(f"    [debug] Тело письма ({len(body)} символов):")
                    print(f"    [debug] {repr(body[:200])}")
                    results.fail("Расшифрование на Bob", "Не найдены маркеры ENCRYPTED MESSAGE")
            else:
                results.fail("Получение зашифрованного письма", "Письмо не найдено")
        else:
            results.fail("Получение зашифрованного письма", "Письмо не найдено (таймаут)")
    except Exception as e:
        results.fail("Расшифрование на Bob", str(e))

    # ── Тест 9: Ответ B→A ────────────────────────────────────────
    reply_subject = f"[Whisper Reply] {timestamp}"
    reply_body = f"Ответ от Bob! Timestamp: {timestamp}"

    print(f"\n📨 Тест 9: Ответ Bob → Alice")
    try:
        send_test_email(
            bob_smtp,
            ACCOUNTS["bob"]["email"],
            ACCOUNTS["alice"]["email"],
            reply_subject,
            reply_body,
        )
        results.ok("Отправка Bob → Alice")
    except Exception as e:
        results.fail("Отправка Bob → Alice", str(e))

    print("  ⏳ Ожидание доставки (до 30 сек)...")
    time.sleep(3)

    print(f"\n📥 Тест 10: Поиск ответа на Alice")
    try:
        found = find_message_by_subject(alice_mail, reply_subject, timeout=30)
        if found:
            results.ok("Alice получила ответ от Bob")
        else:
            results.fail("Alice получила ответ", "Письмо не найдено за 30 сек")
    except Exception as e:
        results.fail("Alice получила ответ", str(e))

    # ── Очистка ───────────────────────────────────────────────────
    print("\n🧹 Очистка соединений...")
    try:
        if alice_smtp:
            alice_smtp.quit()
        if bob_smtp:
            bob_smtp.quit()
        if alice_mail:
            alice_mail.logout()
        if bob_mail:
            bob_mail.logout()
    except:
        pass

    # ── Итоги ─────────────────────────────────────────────────────
    success = results.summary()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
