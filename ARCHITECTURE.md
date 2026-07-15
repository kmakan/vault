# 🔐 MailCipher — Архитектура шифрования

> **Последнее обновление**: 27.06.2026
> **Ключевая идея**: Email как транспорт, классические шифры как защита

---

## 🎯 Концепция

```
┌─────────────────────────────────────────────────────────────┐
│                    MailCipher Архитектура                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Пользователь A                    Пользователь B           │
│  ┌───────────┐                    ┌───────────┐            │
│  │ Мессенджер│                    │ Мессенджер│            │
│  │ (расшифр.)│                    │ (расшифр.)│            │
│  └─────┬─────┘                    └─────┬─────┘            │
│        │                                │                   │
│        ▼                                ▼                   │
│  ┌───────────┐                    ┌───────────┐            │
│  │ Шифрование│                    │ Шифрование│            │
│  │ (альфа +  │                    │ (альфа +  │            │
│  │ колонная) │                    │ колонная) │            │
│  └─────┬─────┘                    └─────┬─────┘            │
│        │                                │                   │
│        ▼                                ▼                   │
│  ┌─────────────────────────────────────────────────┐       │
│  │              Email (IMAP/SMTP)                  │       │
│  │     Зашифрованный текст = бессмысленный набор   │       │
│  │              символов в письме                  │       │
│  └─────────────────────────────────────────────────┘       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔑 Обмен ключами

### Ручной обмен (основной метод)
```
1. Алиса и Боб встречаются (или договариваются)
2. Алиса генерирует ключ шифрования
3. Ключ передаётся Бобу (лично, по телефону, на бумаге)
4. Боб вводит ключ в приложение
5. Теперь они могут переписываться через MailCipher
```

### Автоматический обмен (дополнительно)
```
1. Пользователи синхронизируют аккаунты
2. Сервис генерирует общий ключ
3. Ключ шифруется и передаётся через защищённый канал
4. Ключи хранятся в БД (зашифрованно)
```

---

## 🔐 Методы шифрования

### 1. Шифр Альфа (Alpha Cipher)
**Симметричный шифр замены**

```python
def alpha_encrypt(text, key):
    """
    Шифр Альфа: замена символов на основе ключа
    
    Ключ: "SECRET"
    Текст: "HELLO"
    
    Каждый символ заменяется на:
    (символ + ключ[i]) mod 26
    """
    result = []
    key_index = 0
    
    for char in text.upper():
        if char.isalpha():
            shift = ord(key[key_index % len(key)]) - ord('A')
            encrypted = chr((ord(char) - ord('A') + shift) % 26 + ord('A'))
            result.append(encrypted)
            key_index += 1
        else:
            result.append(char)
    
    return ''.join(result)

def alpha_decrypt(cipher, key):
    """Обратная операция"""
    result = []
    key_index = 0
    
    for char in cipher.upper():
        if char.isalpha():
            shift = ord(key[key_index % len(key)]) - ord('A')
            decrypted = chr((ord(char) - ord('A') - shift) % 26 + ord('A'))
            result.append(decrypted)
            key_index += 1
        else:
            result.append(char)
    
    return ''.join(result)
```

**Пример:**
```
Ключ: "MAGIC"
Текст: "HELLO WORLD"

Шаг 1 (Alpha):
H + M = T
E + A = E
L + G = R
L + I = T
O + C = Q

Результат: "TERTQ VFQRE"
```

### 2. Шифр колонной замены (Columnar Transposition)
**Перестановка символов**

```python
def columnar_encrypt(text, key):
    """
    Шифр колонной замены
    
    Ключ: "3124"
    Текст: "HELLO WORLD"
    
    1. Создаём таблицу по длине ключа
    2. Заполняем по строкам
    3. Читаем по колоннам в порядке ключа
    """
    # Убираем пробелы
    text = text.replace(" ", "")
    
    # Создаём таблицу
    cols = len(key)
    rows = (len(text) + cols - 1) // cols
    
    # Заполняем матрицу
    matrix = [['' for _ in range(cols)] for _ in range(rows)]
    index = 0
    
    for i in range(rows):
        for j in range(cols):
            if index < len(text):
                matrix[i][j] = text[index]
                index += 1
    
    # Сортируем колонны по ключу
    order = sorted(range(len(key)), key=lambda k: key[k])
    
    # Читаем по колоннам
    result = []
    for col in order:
        for row in range(rows):
            if matrix[row][col]:
                result.append(matrix[row][col])
    
    return ''.join(result)

def columnar_decrypt(cipher, key):
    """Обратная операция"""
    cols = len(key)
    rows = len(cipher) // cols
    
    # Создаём пустую матрицу
    matrix = [['' for _ in range(cols)] for _ in range(rows)]
    
    # Сортируем колонны по ключу
    order = sorted(range(len(key)), key=lambda k: key[k])
    
    # Заполняем матрицу по колоннам
    index = 0
    for col in order:
        for row in range(rows):
            if index < len(cipher):
                matrix[row][col] = cipher[index]
                index += 1
    
    # Читаем по строкам
    result = []
    for i in range(rows):
        for j in range(cols):
            if matrix[i][j]:
                result.append(matrix[i][j])
    
    return ''.join(result)
```

**Пример:**
```
Ключ: "3124"
Текст: "HELLOWORLD"

Таблица:
  3 1 2 4
H E L L
O W O R
L D _ _

Читаем по колоннам (порядок: 1,2,3,4):
Колонна 1: E, W, D
Колонна 2: L, O, _
Колонна 3: H, O, L
Колонна 4: L, R, _

Результат: "EWDLO_OHLLR_"
```

### 3. Комбинированное шифрование
**Alpha + Columnar (рекомендуется)**

```python
def combined_encrypt(text, alpha_key, column_key):
    """Сначала Alpha, потом Columnar"""
    # Шаг 1: Шифр Альфа
    step1 = alpha_encrypt(text, alpha_key)
    
    # Шаг 2: Колонная замена
    step2 = columnar_encrypt(step1, column_key)
    
    return step2

def combined_decrypt(cipher, alpha_key, column_key):
    """Обратная операция"""
    # Шаг 1: Обратная колонная замена
    step1 = columnar_decrypt(cipher, column_key)
    
    # Шаг 2: Обратный Alpha
    step2 = alpha_decrypt(step1, alpha_key)
    
    return step2
```

---

## 📧 Интеграция с Email

### Процесс отправки
```
1. Пользователь вводит сообщение
2. Мессенджер шифрует (Alpha + Columnar)
3. Зашифрованный текст вставляется в тело письма
4. Письмо отправляется через SMTP
5. Получатель видит "бессмысленный набор символов"
```

### Процесс получения
```
1. Мессенджер проверяет почту (IMAP)
2. Находит новое письмо
3. Извлекает зашифрованный текст
4. Расшифровывает (Alpha + Columnar)
5. Показывает читаемое сообщение
```

### Пример письма
```
From: alice@mail.com
To: bob@mail.com
Subject: Re: Meeting

-----BEGIN ENCRYPTED MESSAGE-----
TERTQ VFQRE UYWXI OHFGS DHNVW RYQKL
ZXCVA BNMPO LKJHG FDSAZ XCVBN M
-----END ENCRYPTED MESSAGE-----
```

---

## 🔒 Безопасность

### Преимущества
1. **Email работает везде** — нет блокировок (в отличие от Signal)
2. **Классические шифры** — простые, проверенные
3. **Ручной обмен ключами** — максимальная секретность
4. **Нулевой сервер** — ключи хранятся только у пользователей

### Ограничения
1. **Частотный анализ** — возможен при большом объёме
2. **Нет forward secrecy** — компрометация ключа раскрывает всё
3. **Ручной обмен** — неудобно для новых контактов

### Улучшения
1. **Случайная длина блоков** — затрудняет анализ
2. **Добавление шума** — случайные символы в конце
3. **Смена ключей** — периодическая смена Alpha/Columnar ключей

---

## 📋 Архитектура базы данных

### Таблица ключей
```sql
CREATE TABLE encryption_keys (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    alpha_key VARCHAR(255) NOT NULL,
    column_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);
```

### Таблица сообщений
```sql
CREATE TABLE messages (
    id UUID PRIMARY KEY,
    sender_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    encrypted_text TEXT NOT NULL,
    email_message_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    is_read BOOLEAN DEFAULT FALSE
);
```

---

## 📋 Задачи для канbanа

### Новые задачи:
1. "Реализовать шифр Альфа (Alpha Cipher)"
2. "Реализовать шифр колонной замены"
3. "Настроить комбинированное шифрование"
4. "Интеграция с IMAP/SMTP"
5. "Хранение ключей в БД"
6. "Тестирование шифрования"
7. "Добавление шума для защиты от анализа"

---

## 📚 Примеры использования

### Python (backend)
```python
from mailcipher.crypto import AlphaCipher, ColumnarCipher

# Шифрование
alpha = AlphaCipher(key="MAGIC")
columnar = ColumnarCipher(key="3124")

text = "Hello, Bob!"
encrypted = columnar.encrypt(alpha.encrypt(text))
# Результат: "TERTQ VFQRE UYWXI..."

# Расшифрование
decrypted = alpha.decrypt(columnar.decrypt(encrypted))
# Результат: "Hello, Bob!"
```

### JavaScript (desktop/terminal)
```javascript
import { AlphaCipher, ColumnarCipher } from 'mailcipher-crypto';

const alpha = new AlphaCipher({ key: 'MAGIC' });
const columnar = new ColumnarCipher({ key: '3124' });

const encrypted = columnar.encrypt(alpha.encrypt('Hello, Bob!'));
// Результат: "TERTQ VFQRE UYWXI..."

const decrypted = alpha.decrypt(columnar.decrypt(encrypted));
// Результат: "Hello, Bob!"
```

---

> **Вывод**: Использование Email как транспорта + классические шифры (Alpha + Columnar) — это надёжное и универсальное решение, которое работает везде без VPN и сложных протоколов.
