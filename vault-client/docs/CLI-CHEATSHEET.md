# Vault CLI — Шпаргалка

Быстрый справочник по командам.

## Сессия

| Команда | Описание |
|---------|----------|
| `/help [topic]` | Помощь (общая или по теме) |
| `/quit`, `/exit`, `/q` | Выход |
| `/clear`, `/cls` | Очистить экран |
| `/status` | Статус подключения |

## Подключение

| Команда | Описание |
|---------|----------|
| `/connect <email> <password> [server]` | Подключить аккаунт |
| `/disconnect` | Отключить аккаунт |

### Примеры

```bash
/connect user@gmail.com abcdefghijklmnop
/connect user@outlook.com abcdefghijklmnop outlook.office365.com
```

## Ключи

| Команда | Описание |
|---------|----------|
| `/keygen` | Генерация пары ключей |
| `/keys` | Просмотр ключей |
| `/keyshare <contact>` | Поделиться ключом |
| `/fingerprint` | Показать fingerprint |
| `/verify <contact>` | Верифицировать контакт |

## Контакты

| Команда | Описание |
|---------|----------|
| `/invite <email>` | Сгенерировать invite |
| `/accept <ссылка>` | Принять invite |
| `/confirm <email>` | Подтвердить контакт |
| `/contacts` | Список контактов |
| `/whois <email>` | Информация о контакте |
| `/add <email> [name]` | Добавить контакт |
| `/remove <email>` | Удалить контакт |
| `/block <email>` | Заблокировать |
| `/unblock <email>` | Разблокировать |
| `/vault-id` | Показать Vault ID |

## Чат

| Команда | Описание |
|---------|----------|
| `/chat <contact>` | Начать чат |
| `/leave` | Выйти из чата |
| `/send <message>` | Отправить сообщение |
| `/reply <id> <message>` | Ответить на сообщение |
| `/thread <subject>` | Показать тред |

### В режиме чата

| Действие | Описание |
|----------|----------|
| `Enter` | Отправить сообщение |
| `Esc` | Выйти из чата |

## Входящие

| Команда | Описание |
|---------|----------|
| `/inbox` | Показать Vault-сообщения |
| `/read <id>` | Прочитать сообщение |

## Шифрование

| Команда | Описание |
|---------|----------|
| `/encrypt <text>` | Зашифровать текст |
| `/decrypt <text>` | Расшифровать текст |

## Файлы

| Команда | Описание |
|---------|----------|
| `/attach <path>` | Прикрепить файл |
| `/sendfile <path>` | Отправить зашифрованный файл |

## Группы

| Команда | Описание |
|---------|----------|
| `/group create <name>` | Создать группу |
| `/group add <email> <group>` | Добавить участника |
| `/group remove <email> <group>` | Удалить участника |
| `/group send <group> <message>` | Отправить в группу |
| `/group members <group>` | Участники группы |
| `/group leave <group>` | Покинуть группу |

## Настройки

| Команда | Описание |
|---------|----------|
| `/settings` | Просмотр настроек |
| `/set <key> <value>` | Изменить настройку |

## Горячие клавиши

| Клавиша | Действие |
|---------|----------|
| `Enter` | Отправить / Выполнить |
| `Tab` | Автодополнение |
| `↑` / `↓` | История команд |
| `Ctrl+C` | Отмена / Выход |
| `Ctrl+L` | Очистить экран |
| `Ctrl+A` | Начало строки |
| `Ctrl+E` | Конец строки |
| `Ctrl+K` | Удалить до конца |
| `Ctrl+U` | Удалить до начала |

## Статусы сообщений

| Статус | Иконка | Цвет |
|--------|--------|------|
| Отправлено | ✓ | Серый |
| Доставлено | ✓✓ | Белый |
| Прочитано | ✓✓ | Синий |

## Автодополнение серверов

| Домен | IMAP | SMTP |
|-------|------|------|
| gmail.com | imap.gmail.com | smtp.gmail.com |
| outlook.com | outlook.office365.com | smtp.office365.com |
| yandex.ru | imap.yandex.com | smtp.yandex.com |
| mail.ru | imap.mail.ru | smtp.mail.ru |

## Примеры

### Полный цикл

```bash
# 1. Подключение
/connect user@gmail.com abcdefghijklmnop

# 2. Ключи
/keygen

# 3. Приглашение
/invite alice@example.com

# 4. Чат
/chat alice@example.com
Привет!
/leave
```

### Группа

```bash
/group create "Project"
/group add alice@company.com "Project"
/group send "Project" Запускаем проект!
```

### Шифрование

```bash
/encrypt Мой секрет
# 04a1b2c3d4...

/decrypt 04a1b2c3d4...
# Мой секрет
```

## Лицензия

MIT License
