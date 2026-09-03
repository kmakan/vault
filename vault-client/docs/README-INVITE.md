# Vault — Система приглашений

Архитектура добавления контактов по модели Signal.

## Принцип работы

```
┌─────────────────────────────────────────────────────────┐
│  Пользователь A          │  Пользователь B              │
│                           │                              │
│  1. Генерирует invite     │                              │
│     /invite B             │                              │
│                           │                              │
│  2. Получает ссылку/QR    │  3. Сканирует QR             │
│                           │     /accept <ссылка>         │
│                           │                              │
│  4. Получает ключ B       │  5. Получает ключ A         │
│                           │                              │
│  6. Подтверждает           │  7. Контакт добавлен         │
│     /confirm B            │     /confirm A               │
│                           │                              │
│  ═══════════════════════  ══════════════════════════════ │
│  Начинается переписка с E2E шифрованием                  │
└─────────────────────────────────────────────────────────┘
```

## Генерация приглашения

### Команда

```bash
/invite <email>
```

### Пример

```bash
/invite alice@example.com
```

### Вывод

```
Invite generated for alice@example.com

Link: https://vault.chat/invite/Xk9f2mN...
Expires: 2024-01-16 15:30:00 UTC
One-time: yes

QR code:
████████████████████████████
██ ▄▄▄▄▄ █▀█ █▄▀▀▄█ ▄▄▄▄▄ ██
██ █   █ █▀▀▀█ ▀▄█ █ █   █ ██
██ █▄▄▄█ █▀ █▀▀██▄▀█ █▄▄▄█ ██
██▄▄▄▄▄▄▄█▄▀ ▀▄█▄▀ █▄▄▄▄▄▄▄██
██▄▀  ▀▄▄▀▄▀▀▄▄▄▀▄▄▀▄▄▀▄▄▀▄██
███ ███ █▄ ▄█▄█▀▄▀▄▀▄▄▄▀▀▄███
██▄█▄▀▄▄▄▀█▄█▀▄▄ ▄▀▄▄▄▀▄▄▄██
██▄▄▄▄▄▄▄█▀▄▄▀▄▄▀▄▄▄ █▄▄▀▄██
██ ▄▄▄▄▄ █ ▄▀▄▄▀▄▀▄█ █▄█▄▄██
██ █   █ █▄▀▄▀▀▄▄▀▄▄█▄▄▄▀▄██
██ █▄▄▄█ █▀▄▄▀█▄▀▄▄▄▄█▄▄▄ ██
██▄▄▄▄▄▄▄█▄▄█▄▄██▄▄▄█▄▄▄▄▄██
████████████████████████████████

Scan with Vault mobile app or visit the link.
```

## Принятие приглашения

### Команда

```bash
/accept <ссылка_или_Vault_ID>
```

### Примеры

```bash
# По ссылке
/accept https://vault.chat/invite/Xk9f2mN...

# По Vault ID (email)
/accept alice@example.com
```

### Вывод

```
Processing invite from alice@example.com...

Contact: alice@example.com
Fingerprint: a1b2:c3d4:e5f6:g7h8:i9j0:k1l2:m3n4:o5p6

Your fingerprint: x9w8:v7u6:t5s4:r3q2:p1o0:n9m8:l7k6:j5i4

⚠️  Verify fingerprint with contact before confirming!

Do you want to add this contact? [y/N]:
```

## Подтверждение контакта

### Команда

```bash
/confirm <email>
```

### Процесс

1. **A** отправляет invite → **B** получает
2. **B** принимает invite → отправляет свой ключ **A**
3. **A** получает ключ **B** → подтверждает
4. **B** получает подтверждение → контакт добавлен

### Статусы контакта

| Статус | Описание |
|--------|----------|
| `pending` | Invite отправлен, ожидает принятия |
| `accepted` | Invite принят, ожидает подтверждения |
| `verified` | Контакт добавлен, ключи обменяны |
| `blocked` | Контакт заблокирован |

## Vault ID

### Что это

Уникальный идентификатор пользователя в системе Vault.

### Формат

```
vault:<email>
```

Пример: `vault:alice@example.com`

### Генерация

```bash
# Просмотр своего Vault ID
/vault-id

# Вывод:
# Your Vault ID: vault:user@gmail.com
```

### Использование

1. **Приглашение по ID:**
   ```bash
   /invite vault:alice@example.com
   ```

2. **Принятие по ID:**
   ```bash
   /accept vault:bob@outlook.com
   ```

3. **Публикация ID:**
   ```bash
   # Можно поделиться Vault ID с другом
   # Он использует его для приглашения
   ```

## Безопасность приглашений

### Ограничения

| Параметр | Значение |
|----------|----------|
| Срок действия | 24 часа |
| Использование | Одноразовое |
| Подпись | Обязательная |
| Шифрование | Ключи зашифрованы |

### Проверка подлинности

```bash
# При принятии invite проверяется:
1. Подпись отправителя
2. Срок действия
3. Уже использован ли invite
4. Корректность ключей
```

### Защита от атак

| Атака | Защита |
|-------|--------|
| Подмена invite | Электронная подпись |
| Повторное использование | Одноразовые токены |
| MITM | Верификация fingerprint |
| Брутфорс | Ограничение попыток |

## Верификация ключей

### Зачем

Убедиться, что ключ принадлежит реальному контакту.

### Как

1. **Личная встреча:**
   ```bash
   # Сравните fingerprint面对面
   /whois alice@example.com
   # Покажите fingerprint на экране
   ```

2. **Через защищенный канал:**
   ```bash
   # Отправьте fingerprint через Signal/Telegram
   /fingerprint
   # Вывод: a1b2:c3d4:e5f6:...
   ```

3. **Сканирование QR:**
   ```bash
   # При личной встрече
   /verify alice@example.com
   # Покажите QR-код для сканирования
   ```

### Статус верификации

```bash
/whois alice@example.com

# Вывод:
# Contact: alice@example.com
# Status: verified ✓
# Fingerprint: a1b2:c3d4:e5f6:...
# Key: verified ✓
```

## Управление контактами

### Список контактов

```bash
/contacts

# Вывод:
# #   Email                 Name       Status    Last seen
# 1   alice@example.com     Alice      verified  2 min ago
# 2   bob@outlook.com       Bob        pending   never
```

### Удаление контакта

```bash
/remove alice@example.com
```

### Блокировка

```bash
/block alice@example.com
```

### Разблокировка

```bash
/unblock alice@example.com
```

## Группы

### Создание группы

```bash
/group create "Project Team"

# Вывод:
# Group created: Project Team
# Group ID: grp_abc123...
```

### Добавление участника

```bash
/group add alice@example.com "Project Team"

# Вывод:
# Invite sent to alice@example.com for group "Project Team"
```

### Удаление участника

```bash
/group remove alice@example.com "Project Team"
```

### Отправка в группу

```bash
/group send "Project Team" Всем привет!
```

### Просмотр участников

```bash
/group members "Project Team"

# Вывод:
# Group: Project Team
# Members:
#   1. user@gmail.com (creator)
#   2. alice@example.com (verified)
#   3. bob@outlook.com (pending)
```

## Примеры сценариев

### Сценарий 1: Друг приглашает друга

```bash
# Alice генерирует invite
/invite bob@example.com

# Bob получает ссылку от Alice
# (через SMS, мессенджер, лично)

# Bob принимает
/accept https://vault.chat/invite/Xk9f2mN...

# Bob подтверждает
/confirm alice@example.com

# Alice подтверждает
/confirm bob@example.com

# Контакт добавлен!
/chat bob@example.com
Привет Bob!
```

### Сценарий 2: Деловая встреча

```bash
# На встрече обмениваются Vault ID

# Alice показывает свой ID
/vault-id
# vault:alice@company.com

# Bob сканирует QR
/accept vault:alice@company.com

# После встречи Alice подтверждает
/confirm bob@partner.com

# Начинается зашифрованная переписка
/chat bob@partner.com
Обсудим контракт?
```

### Сценарий 3: Групповой проект

```bash
# Создаем группу
/group create "Project Alpha"

# Добавляем участников
/group add alice@company.com "Project Alpha"
/group add bob@partner.com "Project Alpha"
/group add carol@client.com "Project Alpha"

# Общаемся
/group send "Project Alpha" Проект запущен!

# Все участники видят сообщение
```

## FAQ

### Q: Что если я потерял приватный ключ?

**A:** К сожалению, потеря приватного ключа означает потерю доступа к переписке. Рекомендуется сделать резервную копию.

### Q: Можно ли добавить контакт без invite?

**A:** Нет, для безопасности必须使用 систему приглашений.

### Q: Как проверить, что контакт настоящий?

**A:** Сравните fingerprint при личной встрече или через защищенный канал.

### Q: Что если invite истек?

**A:** Сгенерируйте новый invite.

### Q: Можно ли добавить контакт по номеру телефона?

**A:** В текущей версии только по email. Поддержка телефонов планируется.

## Лицензия

MIT License
