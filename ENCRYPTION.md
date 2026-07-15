# 🔐 MailCipher — Современные методы шифрования

> **Последнее обновление**: 27.06.2026
> **Цель**: Полное исследование методов шифрования для мессенджера

---

## 📊 Современные протоколы E2E шифрования

### 1. Signal Protocol (Gold Standard)
**Используется**: Signal, WhatsApp, Facebook Messenger, Google Messages

**Компоненты:**
- **X3DH** (Extended Triple Diffie-Hellman) — обмен ключами
- **Double Ratchet** — обновление ключей
- **AES-256-GCM** — симметричное шифрование
- **Ed25519** — цифровые подписи

**Преимущества:**
- Forward secrecy (компрометация ключа не раскрывает прошлое)
- Future secrecy (компрометация ключа не раскрывает будущее)
- Deniability (нельзя доказать авторство)

**Недостатки:**
- Сложная реализация
- Требует постоянной синхронизации

---

### 2. MLS (Messaging Layer Security)
**Используется**: IETF стандарт, Signal (экспериментально), Keybase

**Компоненты:**
- **TreeKEM** — обновление ключей для групп
- **DS** (Digital Signatures) — подписи
- **HPKE** (Hybrid Public Key Encryption) — шифрование

**Преимущества:**
- Масштабируемость для групп (до 1000+ участников)
- Эффективное обновление ключей
- IETF стандарт (RFC 9420)

**Недостатки:**
- Молодой протокол (2023)
- Сложная реализация

---

### 3. Keybase Protocol
**Используется**: Keybase, Zoom ( end-to-end)

**Компоненты:**
- **Saltpack** — формат шифрования
- **KBNK** — обмен ключами
- **Teams** — групповое шифрование

**Преимущества:**
- Простая модель
- Поддержка команд/групп
- PGP совместимость

**Недостатки:**
- Менее распространён
- Keybase закрыт (Zoom купил)

---

## 🔑 Обмен ключами (Key Exchange)

### 1. Diffie-Hellman (DH)
**Классический метод** для обмена ключами через незащищённый канал.

```
Алиса: g^a mod p → Боб
Боб: g^b mod p → Алиса
Общий ключ: g^(ab) mod p
```

**Проблема**: Нет аутентификации (Man-in-the-Middle)

### 2. X3DH (Extended Triple Diffie-Hellman)
**Современный стандарт** для Signal Protocol.

```
Алиса имеет:
  - Identity Key (IK_a)
  - Signed Pre-Key (SPK_a)
  - One-Time Pre-Keys (OPK_a1, OPK_a2, ...)

Боб имеет:
  - Identity Key (IK_b)
  - Signed Pre-Key (SPK_b)
  - One-Time Pre-Keys (OPK_b1, OPK_b2, ...)

Обмен:
  DH1 = DH(IK_a, SPK_b)
  DH2 = DH(SPK_a, IK_b)
  DH3 = DH(SPK_a, SPK_b)
  DH4 = DH(IK_a, OPK_b)  # одноразовый

  Master Secret = KDF(DH1 || DH2 || DH3 || DH4)
```

**Преимущества:**
- Аутентификация через Identity Keys
- Forward secrecy через One-Time Pre-Keys
- Асинхронность (Боб не должен быть онлайн)

### 3. Смешанный обмен (Hybrid Key Exchange)
**Для пост-квантовой безопасности**

```
Klassisches DH + Kyber/BIKE/HQC (пост-квантовые алгоритмы)

Master Secret = KDF(DH_secret || PQ_secret)
```

**Используется**: Signal (экспериментально), Apple (iMessage)

---

## 👥 Групповое шифрование

### Проблема
При N участниках нужно N*(N-1)/2 пар ключей. При добавлении/удалении участника — перенастройка всех ключей.

### Решения

#### 1. Sender Keys (Signal Groups)
**Принцип**: Каждый участник генерирует ключ и рассылает его каждому участнику штучно.

```
Участник A:
  1. Генерирует Sender Key: SK_A
  2. Шифрует SK_A ключом каждого участника
  3. Рассылает зашифрованные SK_A

Участник B:
  1. Получает зашифрованный SK_A
  2. Расшифровывает своим приватным ключом
  3. Получает SK_A

Шифрование сообщения:
  Ciphertext = AES-GCM(SK_A, Message)
```

**Проблема**: При удалении участника нужно пересылать ключи всем.

#### 2. TreeKEM (MLS Protocol)
**Современное решение** для масштабируемых групп.

```
Структура: Бинарное дерево

        [Root Key]
       /          \
  [Left Key]    [Right Key]
    /    \        /    \
  [A]   [B]    [C]   [D]

Обновление ключей:
  - При добавлении участника: обновляется путь от листа до корня
  - При удалении: то же самое
  - Сложность: O(log N) вместо O(N)
```

**Преимущества:**
- Эффективное обновление ключей
- Масштабируемость до 1000+ участников
- Forward secrecy для групп

#### 3.排除 Lists (Exclude Lists)
**Используется**: Keybase, Slack

```
1. Создаётся список исключённых участников
2. Ключ обновляется с учётом исключений
3. Все участники получают новый ключ
```

---

## 🎯 Рекомендации для MailCipher

### Для 1:1 чатов
**Рекомендация**: Signal Protocol (X3DH + Double Ratchet)

```python
# Пример использования
from signal_protocol import IdentityKeyPair, SessionBuilder

# Генерация ключей
identity_key = IdentityKeyPair.generate()

# Обмен ключами
session_builder = SessionBuilder(store, remote_address)
session_builder.process_pre_key_bundle(pre_key_bundle)

# Шифрование
cipher = SessionCipher(store, remote_address)
ciphertext = cipher.encrypt(b"Hello, World!")
```

### Для групповых чатов
**Рекомендация**: TreeKEM (MLS) или Sender Keys (проще)

#### Вариант A: Sender Keys (простая реализация)
```python
class GroupEncryption:
    def __init__(self, members):
        self.members = members
        self.sender_keys = {}
    
    def add_member(self, member):
        # Генерируем ключ для нового участника
        sender_key = generate_sender_key()
        # Рассылаем зашифрованный ключ каждому участнику
        for m in self.members:
            encrypted_key = encrypt_with_key(sender_key, m.public_key)
            send_key(m, encrypted_key)
        self.sender_keys[member] = sender_key
    
    def remove_member(self, member):
        # Генерируем новый ключ для всех
        new_sender_key = generate_sender_key()
        # Рассылаем всем кроме удалённого
        for m in self.members:
            if m != member:
                encrypted_key = encrypt_with_key(new_sender_key, m.public_key)
                send_key(m, encrypted_key)
        # Обновляем ключи
        for m in self.members:
            if m != member:
                self.sender_keys[m] = new_sender_key
```

#### Вариант B: TreeKEM (сложная реализация, но масштабируемая)
```python
class TreeKEM:
    def __init__(self):
        self.tree = BinaryTree()
    
    def add_member(self, member):
        # Добавляем лист в дерево
        leaf = self.tree.add_leaf(member)
        # Обновляем ключи от листа до корня
        self.update_path(leaf)
    
    def remove_member(self, leaf):
        # Удаляем лист
        self.tree.remove_leaf(leaf)
        # Обновляем ключи
        self.update_path(leaf.parent)
    
    def update_path(self, node):
        # Обновляем ключи на пути от node до root
        while node:
            node.key = derive_key(node.left.key, node.right.key)
            node = node.parent
```

### Для шифрования сообщений
**Рекомендация**: AES-256-GCM + libsodium

```python
from nacl.secret import SecretBox

# Шифрование
box = SecretBox(key)
ciphertext = box.encrypt(message)

# Расшифрование
plaintext = box.decrypt(ciphertext)
```

---

## 🔒 Дополнительные методы

### 1. Стеганография
**Спрятать сообщение внутри другого файла**

```python
# Скрытие текста в изображении
def hide_message_in_image(image_path, message):
    img = Image.open(image_path)
    # LSB стеганография
    # ...
```

### 2. Шифрование колонной замены
**Классический метод, но слабый для современных атак**

```
Ключ: "KEY"
Текст: "HELLO WORLD"

Колонны:
K E Y
H E L L O   W O R L D

Шифр: EOLE HWRL L OD
```

**Проблема**: Частотный анализ, малое количество ключей

### 3. Двойное шифрование (Envelope Encryption)
**Используется**: AWS KMS, Google Cloud KMS

```
1. Генерируется Data Key (DK)
2. Данные шифруются DK
3. DK шифруется Master Key (MK)
4. Сохраняются: зашифрованные данные + зашифрованный DK
```

---

## 📋 Задачи для канбана

### Новые задачи:
1. "Исследовать Signal Protocol (X3DH + Double Ratchet)"
2. "Исследовать MLS (TreeKEM) для групп"
3. "Настроить libsodium для шифрования"
4. "Реализовать обмен ключами (X3DH)"
5. "Реализовать Double Ratchet"
6. "Настроить групповое шифрование (Sender Keys)"
7. "Добавить пост-квантовое шифрование (Kyber)"

---

## 📚 Литература

1. **Signal Protocol Specification**: https://signal.org/docs/
2. **MLS Protocol**: https://www.ietf.org/archive/id/draft-ietf-mls-protocol-20.html
3. **libsodium Documentation**: https://doc.libsodium.org/
4. **TreeKEM**: https://eprint.iacr.org/2018/1021.pdf
5. **X3DH**: https://signal.org/docs/specifications/x3dh/
6. **Double Ratchet**: https://signal.org/docs/specifications/doubleratchet/

---

> **Вывод**: Для MailCipher рекомендуется Signal Protocol для 1:1 чатов и Sender Keys (упрощённый TreeKEM) для групп. Пост-квантовое шифрование можно добавить позже как опцию.
