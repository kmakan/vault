# Whisper — Шифрование

E2E шифрование для защищенной переписки.

## Архитектура шифрования

```
┌─────────────────────────────────────────────────────────┐
│                    WHISPER E2E                           │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Клиент A                                          │ │
│  │  Приватный ключ (X25519)                           │ │
│  │  Публичный ключ (64 байта)                         │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Diffie-Hellman Key Exchange                       │ │
│  │  Shared Secret = X25519(privA, pubB)               │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  HKDF Key Derivation                              │ │
│  │  Message Key = HKDF(shared_secret, salt, info)     │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  XChaCha20-Poly1305 Encryption                     │ │
│  │  Ciphertext = Encrypt(message_key, nonce, plaintext)│ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Email Transport (IMAP/SMTP)                       │ │
│  │  X-Whisper-Encrypted: 1                            │ │
│  │  Subject: [WHISPER] ...                             │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Алгоритмы

### Обмен ключами: X25519

**Что это:** Алгоритм Diffie-Hellman на эллиптических кривых.

**Как работает:**
1. Клиент A генерирует приватный ключ `privA` и публичный ключ `pubA`
2. Клиент B генерирует приватный ключ `privB` и публичный ключ `pubB`
3. A вычисляет `shared_secret = X25519(privA, pubB)`
4. B вычисляет `shared_secret = X25519(privB, pubA)`
5. Оба получают одинаковый `shared_secret`

**Безопасность:**
- 256-битная ключевая стойкость
- Защита от quantum-атак (пока что)
- Forward secrecy (при ротации ключей)

### Вывод ключей: HKDF

**Что это:** HMAC-based Key Derivation Function.

**Как работает:**
```
message_key = HKDF(
    ikm = shared_secret,
    salt = random_salt,
    info = "whisper-message",
    length = 32
)
```

**Зачем:**
- Преобразует shared_secret в ключ для шифрования
- Добавляет соль для дополнительной безопасности
- Позволяет выводить разные ключи для разных целей

### Шифрование: XChaCha20-Poly1305

**Что это:** AEAD (Authenticated Encryption with Associated Data).

**Как работает:**
```
ciphertext, tag = XChaCha20-Poly1305(
    key = message_key,
    nonce = random_192_bit,
    plaintext = message,
    associated_data = header
)
```

**Характеристики:**
- Скорость: ~3 GB/s на современных CPU
- Nonce: 192 бита (уникальность гарантирована)
- Аутентификация: Poly1305 MAC

## Процесс шифрования

### Шаг 1: Подготовка

```rust
// Клиент A хочет отправить сообщение B
let message = "Привет!";
let recipient_pubkey = load_public_key("bob@example.com");
```

### Шаг 2: Обмен ключами

```rust
// Вычисляем shared secret
let shared_secret = x25519_diffie_hellman(my_private_key, recipient_pubkey);

// Выводим message key
let message_key = hkdf(
    ikm: shared_secret,
    salt: random_bytes(32),
    info: "whisper-message",
    length: 32
);
```

### Шаг 3: Шифрование

```rust
// Генерируем уникальный nonce
let nonce = random_bytes(24); // 192 бита

// Шифруем
let (ciphertext, tag) = xchacha20_poly1305_encrypt(
    key: message_key,
    nonce: nonce,
    plaintext: message.as_bytes(),
    associated_data: header.as_bytes()
);
```

### Шаг 4: Форматирование

```rust
// Формируем email
let email = format!(
    "X-Whisper-Encrypted: 1\r\n\
     X-Whisper-Type: message\r\n\
     X-Whisper-ID: {msg_id}\r\n\
     Subject: [WHISPER] {subject}\r\n\
     \r\n\
     {nonce_hex}:{ciphertext_hex}:{tag_hex}"
);
```

## Процесс дешифрования

### Шаг 1: Получение

```rust
// Получаем email
let email = fetch_message("msg-123");
```

### Шаг 2: Проверка

```rust
// Проверяем маркер Whisper
if !email.headers.contains("X-Whisper-Encrypted: 1") {
    return Err("Not a Whisper message");
}

// Проверяем отправителя в контактах
if !contacts.is_whisper_contact(&email.from) {
    return Err("Sender not in contact list");
}
```

### Шаг 3: Обмен ключами

```rust
// Вычисляем shared secret
let shared_secret = x25519_diffie_hellman(
    my_private_key,
    load_public_key(&email.from)
);

// Выводим message key (тот же salt!)
let message_key = hkdf(
    ikm: shared_secret,
    salt: nonce[0..32], // nonce содержит salt
    info: "whisper-message",
    length: 32
);
```

### Шаг 4: Дешифрование

```rust
// Дешифруем
let plaintext = xchacha20_poly1305_decrypt(
    key: message_key,
    nonce: nonce,
    ciphertext: ciphertext,
    associated_data: header.as_bytes(),
    tag: tag
)?;

let message = String::from_utf8(plaintext)?;
```

## Формат сообщения

### Email заголовки

```
X-Whisper-Encrypted: 1
X-Whisper-Type: message
X-Whisper-ID: msg-abc123
X-Whisper-Reply-To: msg-xyz789
Subject: [WHISPER] Re: Meeting notes
Content-Type: text/plain; charset=utf-8
```

### Тело сообщения

```
{nonce_hex}:{ciphertext_hex}:{tag_hex}
```

Пример:
```
a1b2c3d4e5f6...:04a1b2c3d4e5f6...:f7e8d9c0b1a2...
```

### Двоичный формат

```
┌─────────────────────────────────────────────────────────┐
│  Nonce (24 байта)                                      │
│  ├── Salt (32 байта) для HKDF                          │
│  └── Nonce (12 байта) для XChaCha20                     │
├─────────────────────────────────────────────────────────┤
│  Ciphertext (N байт)                                   │
├─────────────────────────────────────────────────────────┤
│  Tag (16 байт) Poly1305                                │
└─────────────────────────────────────────────────────────┘
```

## Статусы сообщений

### Отправлено (✓)

```rust
// После успешной отправки через SMTP
MessageStatus::Sent
```

### Доставлено (✓✓)

```rust
// После получения encrypted receipt
MessageStatus::Delivered
```

### Прочитано (✓✓ синий)

```rust
// После получения encrypted read receipt
MessageStatus::Read
```

### Receipt формат

```
X-Whisper-Encrypted: 1
X-Whisper-Type: receipt
X-Whisper-Reply-To: msg-abc123
Subject: [WHISPER-RECEIPT] Read

{encrypted_receipt}
```

## Групповое шифрование

### Архитектура

```
┌─────────────────────────────────────────────────────────┐
│  Группа: "Project Team"                                 │
│                                                          │
│  Участники:                                             │
│  ├── Alice (creator)                                    │
│  ├── Bob                                                │
│  └── Carol                                              │
│                                                          │
│  Ключи:                                                 │
│  ├── Group Key (общий)                                  │
│  ├── Alice_Key (зашифрован group key)                   │
│  ├── Bob_Key (зашифрован group key)                     │
│  └── Carol_Key (зашифрован group key)                   │
└─────────────────────────────────────────────────────────┘
```

### Процесс

1. **Создание группы:**
   ```rust
   let group_key = generate_random_key(32);
   ```

2. **Добавление участника:**
   ```rust
   // Шифруем group key публичным ключом участника
   let encrypted_group_key = x25519_encrypt(
       group_key,
       participant_pubkey
   );
   ```

3. **Отправка сообщения:**
   ```rust
   // Шифруем group key
   let ciphertext = xchacha20_poly1305_encrypt(
       key: group_key,
       nonce: nonce,
       plaintext: message
   );
   ```

## Хранение ключей

### Локальное хранилище

```
~/.whisper/
├── keys/
│   ├── private.key    # Приватный ключ (зашифрован)
│   ├── public.key     # Публичный ключ
│   └── fingerprint    # Отпечаток
├── contacts/
│   ├── alice.key      # Публичный ключ Alice
│   ├── bob.key        # Публичный ключ Bob
│   └── ...
└── groups/
    ├── project-team/
    │   ├── group.key  # Group key (зашифрован)
    │   └── members    # Список участников
    └── ...
```

### Шифрование ключей

```rust
// Приватный ключ зашифрован мастер-паролем
let encrypted_private_key = aes256_gcm_encrypt(
    key: master_password_hash,
    nonce: random_bytes(12),
    plaintext: private_key
);
```

## Forward Secrecy

### Что это

Каждое сообщение использует уникальный ключ. Компрометация одного ключа не влияет на другие.

### Как работает

1. **Ротация ключей:**
   ```rust
   // Каждые N сообщений
   let new_key = hkdf(
       ikm: current_key,
       salt: random_bytes(32),
       info: "whisper-rotate",
       length: 32
   );
   ```

2. **Уничтожение старых ключей:**
   ```rust
   // Безопасное удаление
   secure_zero(old_key);
   ```

## Безопасность

### Атаки и защита

| Атака | Защита |
|-------|--------|
| MITM | Верификация fingerprint |
| Replay attacks | Уникальные nonce |
| Brute force | 256-битные ключи |
| Quantum attacks | X25519 (пока что безопасно) |
| Key compromise | Forward secrecy |

### Проверка целостности

```rust
// Poly1305 MAC проверяет целостность
let is_valid = poly1305_verify(
    tag: received_tag,
    key: mac_key,
    ciphertext: ciphertext,
    associated_data: header
);
```

## Рекомендации

1. **Верифицируйте ключи** при личной встрече
2. **Используйте сильные пароли** для аккаунтов
3. **Регулярно обновляйте** ключи
4. **Не делитесь** приватными ключами
5. **Проверяйте статус** контактов

## Лицензия

MIT License
