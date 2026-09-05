# 🔐 MailCipher — Современные методы шифрования и передачи ключей

> **Последнее обновление**: 27.06.2026
> **Цель**: Выбор оптимальных методов шифрования для мессенджера на базе email

---

## 🎯 Требования

1. **Email как транспорт** — работает везде, без VPN
2. **Защита при перехвате** — даже если сообщение перехвачено, его нельзя прочесть
3. **Простота обмена ключами** — возможно даже вручную
4. **Групповые чаты** — шифрование для 3+ участников

---

## 📊 Современные симметричные шифры

### 1. AES-256-GCM (Gold Standard)

```python
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import os

# Генерация ключа
key = AESGCM.generate_key(bit_length=256)  # 32 байта

# Шифрование
aesgcm = AESGCM(key)
nonce = os.urandom(12)  # Уникальный nonce для каждого сообщения
ciphertext = aesgcm.encrypt(nonce, plaintext, associated_data)

# Расшифрование
plaintext = aesgcm.decrypt(nonce, ciphertext, associated_data)
```

**Преимущества:**
- Стандарт NIST
- Аутентифицированное шифрование (AEAD)
- Быстрое (аппаратное ускорение AES-NI)
- Защита от повторного использования (nonce)

**Недостатки:**
- Требует安全管理 nonce
- Сложная генерация ключей

---

### 2. ChaCha20-Poly1305

```python
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
import os

# Генерация ключа
key = ChaCha20Poly1305.generate_key()  # 32 байта

# Шифрование
chacha = ChaCha20Poly1305(key)
nonce = os.urandom(12)
ciphertext = chacha.encrypt(nonce, plaintext, associated_data)

# Расшифрование
plaintext = chacha.decrypt(nonce, ciphertext, associated_data)
```

**Преимущества:**
- Устойчивость к side-channel атакам
- Быстрое без аппаратного ускорения
- Идеально для мобильных устройств

---

### 3. XChaCha20-Poly1305

```python
from nacl.secret import SecretBox

# Генерация ключа
key = SecretBox.generate_key()

# Шифрование
box = SecretBox(key)
ciphertext = box.encrypt(plaintext)

# Расшифрование
plaintext = box.decrypt(ciphertext)
```

**Преимущества:**
- 192-битный nonce (можно генерировать случайно)
- Не нужно беспокоиться о повторах nonce
- Идеально для email (сообщения могут приходить в любом порядке)

---

## 📊 Асимметричные шифры (для обмена ключами)

### 1. X25519 (Curve25519)

```python
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey, X25519PublicKey
)

# Генерация ключей
private_key = X25519PrivateKey.generate()
public_key = private_key.public_key()

# Обмен ключами
shared_key = private_key.exchange(peer_public_key)

# shared_key теперь используется как ключ для ChaCha20
```

**Преимущества:**
- Маленький размер ключей (32 байта)
- Быстрое
- Устойчивое к квантовым атакам (пока)

---

### 2. Ed25519 (для подписей)

```python
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# Генерация ключей
private_key = Ed25519PrivateKey.generate()
public_key = private_key.public_key()

# Подпись
signature = private_key.sign(message)

# Проверка подписи
public_key.verify(signature, message)
```

---

### 3. RSA-4096 (классический)

```python
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes

# Генерация ключей
private_key = rsa.generate_private_key(
    public_exponent=65537,
    key_size=4096
)
public_key = private_key.public_key()

# Шифрование
ciphertext = public_key.encrypt(
    plaintext,
    padding.OAEP(
        mgf=padding.MGF1(algorithm=hashes.SHA256()),
        algorithm=hashes.SHA256(),
        label=None
    )
)

# Расшифрование
plaintext = private_key.decrypt(
    ciphertext,
    padding.OAEP(
        mgf=padding.MGF1(algorithm=hashes.SHA256()),
        algorithm=hashes.SHA256(),
        label=None
    )
)
```

---

## 🔑 Методы обмена ключами

### 1. Diffie-Hellman (DH)
**Классический метод**

```
Алиса: g^a mod p → Боб
Боб: g^b mod p → Алиса
Общий ключ: g^(ab) mod p
```

**Проблема**: Нет аутентификации (Man-in-the-Middle)

---

### 2. X25519 Key Agreement
**Современный стандарт**

```python
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

# Алиса
alice_private = X25519PrivateKey.generate()
alice_public = alice_private.public_key()

# Боб
bob_private = X25519PrivateKey.generate()
bob_public = bob_private.public_key()

# Обмен
alice_shared = alice_private.exchange(bob_public)
bob_shared = bob_private.exchange(alice_public)

# alice_shared == bob_shared (общий секрет)
```

---

### 3. Password-Authenticated Key Exchange (PAKE)
**Для обмена ключами через пароль**

#### SRP (Secure Remote Password)
```python
# Алиса и Боб знают один и тот же пароль
# Сервер НЕ видит пароль

# Алиса
srp_client = SRPClient(username, password)
A = srp_client.get_public_ephemeral()

# Боб (сервер)
srp_server = SRPServer(username, verifier)
B = srp_server.get_public_ephemeral()

# Обмен
session_key = srp_client.process_challenge(B, salt)
session_key = srp_server.verify(A, M1)
```

**Преимущества:**
- Пароль не передаётся
- Сервер не хранит пароль
- Устойчивость к brute-force

---

### 4. OPAQUE (Asymmetric PAKE)
**Новейший стандарт (IETF RFC 9497)**

```python
# Протокол OPAQUE
# 1. Клиент генерирует ключевую пару
# 2. Сервер хранит "замаскированный" ключ
# 3. При входе происходит обмен ключами
# 4. Сервер не видит ни пароль, ни ключ
```

**Преимущества:**
- Сервер не видит пароль
- Сервер не видит ключ
- Устойчивость к атакам на сервер

---

## 📧 Специфика для email-мессенджера

### Архитектура шифрования

```
┌─────────────────────────────────────────────────────────────┐
│                    MailCipher Шифрование                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Уровень 1: Генерация ключей                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ • Ed25519 (идентификация)                           │   │
│  │ • X25519 (обмен ключами)                            │   │
│  │ • ChaCha20 (шифрование сообщений)                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Уровень 2: Обмен ключами                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ • Встреча вживую (QR-код)                          │   │
│  │ • Через email (зашифрованно)                       │   │
│  │ • Через пароль (PAKE/OPAQUE)                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Уровень 3: Шифрование сообщений                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ • XChaCha20-Poly1305 (сообщения)                   │   │
│  │ • Ed25519 (подпись)                                │   │
│  │ • Nonce = random(192 bits)                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Уровень 4: Транспорт (Email)                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ • SMTP/IMAP                                        │   │
│  │ • TLS 1.3 (дополнительная защита)                  │   │
│  │ • Зашифрованное тело письма                        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Процесс обмена ключами

#### Вариант 1: Встреча вживую
```
1. Алиса и Боб встречаются
2. Алиса показывает QR-код со своим публичным ключом
3. Боб сканирует QR-код
4. Боб отправляет свой публичный ключ Алисе (через email, зашифрованно)
5. Теперь они могут переписываться
```

#### Вариант 2: Через email
```
1. Алиса регистрируется в MailCipher
2. Алиса вводит email Боба
3. MailCipher отправляет Бобу приглашение
4. Боб принимает и вводит пароль
5. MailCipher генерирует общий ключ (PAKE)
6. Ключи шифруются и хранятся в БД
```

#### Вариант 3: Через пароль
```
1. Алиса и Боб договариваются о пароле (лично)
2. Алиса вводит пароль в MailCipher
3. MailCipher генерирует ключ из пароля (Argon2id)
4. Боб вводит тот же пароль
5. MailCipher генерирует тот же ключ
```

---

## 🏆 Рекомендации для MailCipher

### Для шифрования сообщений
**Рекомендация**: XChaCha20-Poly1305

```python
from nacl.secret import SecretBox

class MessageEncryption:
    def __init__(self, key):
        self.box = SecretBox(key)
    
    def encrypt(self, plaintext):
        """Шифрование сообщения"""
        return self.box.encrypt(plaintext.encode())
    
    def decrypt(self, ciphertext):
        """Расшифрование сообщения"""
        return self.box.decrypt(ciphertext).decode()
```

### Для обмена ключами
**Рекомендация**: X25519 + OPAQUE

```python
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

class KeyExchange:
    def __init__(self):
        self.private_key = X25519PrivateKey.generate()
        self.public_key = self.private_key.public_key()
    
    def get_public_key_bytes(self):
        """Публичный ключ для передачи"""
        return self.public_key.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw
        )
    
    def exchange(self, peer_public_key_bytes):
        """Обмен ключами"""
        peer_public_key = X25519PublicKey.from_public_bytes(
            peer_public_key_bytes
        )
        shared_key = self.private_key.exchange(peer_public_key)
        return shared_key  # 32 байта для ChaCha20
```

### Для группового шифрования
**Рекомендация**: Sender Keys (упрощённый TreeKEM)

```python
class GroupEncryption:
    def __init__(self):
        self.sender_keys = {}
    
    def add_member(self, member_id, member_public_key):
        """Добавление участника"""
        # Генерируем новый ключ для группы
        group_key = SecretBox.generate_key()
        
        # Шифруем ключ публичным ключом участника
        encrypted_key = encrypt_with_public_key(
            group_key, member_public_key
        )
        
        # Сохраняем
        self.sender_keys[member_id] = {
            'key': group_key,
            'encrypted_key': encrypted_key
        }
    
    def remove_member(self, member_id):
        """Удаление участника"""
        # Удаляем ключ участника
        del self.sender_keys[member_id]
        
        # Генерируем новый ключ для всех оставшихся
        new_group_key = SecretBox.generate_key()
        
        for mid, data in self.sender_keys.items():
            # Шифруем новый ключ для каждого участника
            encrypted_key = encrypt_with_public_key(
                new_group_key, get_public_key(mid)
            )
            self.sender_keys[mid] = {
                'key': new_group_key,
                'encrypted_key': encrypted_key
            }
```

---

## 📋 Сравнение методов

| Метод | Безопасность | Скорость | Простота | Для групп |
|-------|--------------|----------|----------|-----------|
| **AES-256-GCM** | ✅ Высокая | ✅ Быстро | ⚠️ Средне | ❌ |
| **ChaCha20-Poly1305** | ✅ Высокая | ✅ Быстро | ✅ Просто | ❌ |
| **XChaCha20-Poly1305** | ✅ Высокая | ✅ Быстро | ✅ Просто | ❌ |
| **X25519** | ✅ Высокая | ✅ Быстро | ✅ Просто | ❌ |
| **RSA-4096** | ✅ Высокая | ❌ Медленно | ⚠️ Средне | ❌ |
| **SRP** | ✅ Высокая | ⚠️ Средне | ❌ Сложное | ❌ |
| **OPAQUE** | ✅✅ Очень высокая | ⚠️ Средне | ❌ Сложное | ❌ |
| **Sender Keys** | ✅ Высокая | ✅ Быстро | ✅ Просто | ✅ |

---

## 📋 Задачи для канбана

### Обновлённые задачи:
1. "Настроить XChaCha20-Poly1305 для шифрования"
2. "Настроить X25519 для обмена ключами"
3. "Реализовать PAKE/OPAQUE для обмена через пароль"
4. "Настроить QR-код для обмена ключами вживую"
5. "Реализовать групповое шифрование (Sender Keys)"
6. "Добавить подпись Ed25519"
7. "Настроить генерацию ключей (Argon2id)"

---

## 📚 Литература

1. **libsodium Documentation**: https://doc.libsodium.org/
2. **Cryptography.io**: https://cryptography.io/
3. **OPAQUE Protocol**: https://www.ietf.org/archive/id/draft-irtf-cfrg-opaque-09.html
4. **Signal Protocol**: https://signal.org/docs/
5. **X25519**: https://cr.yp.to/ecdh.html

---

> **Вывод**: Для MailCipher рекомендуется:
> - **Шифрование**: XChaCha20-Poly1305 (простое, безопасное)
> - **Обмен ключами**: X25519 (быстрое, modern)
> - **Группы**: Sender Keys (простая реализация)
> - **Дополнительно**: OPAQUE для обмена через пароль
