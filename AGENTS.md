# Vault (MailCipher) — AGENTS.md

## Роли агентов

### PM (Project Manager)
- **Ответственность**: Планирование, координация, документация, канбан
- **Доступ**: Полный доступ к документации, конфигурации агентов
- **Команды**: `hermes kanban`, `mimo run`, делегирование задач

### Editor (Агент-редактор кода)
- **Ответственность**: Написание, рефакторинг, исправление кода
- **Доступ**: Чтение/запись кода, выполнение команд
- **Использование**: `cd ~/vault && mimo run "задача" --agent editor`
- **Особенности**: 
  - Используй graphify перед работой с кодом
  - Следуй стилю проекта
  - Запускай `cargo check` / `cargo test` после изменений

### DevOps (Агент инфраструктуры)
- **Ответственность**: Деплой, серверы, CI/CD, nginx, PM2, SSL, мониторинг
- **Доступ**: Чтение/запись кода, выполнение команд
- **Использование**: `cd ~/vault && mimo run "задача" --agent devops`
- **Особенности**: 
  - Настройка systemd сервисов
  - Docker compose для dev/staging
  - Nginx конфигурация
  - Мониторинг и логирование

### Security (Агент безопасности)
- **Ответственность**: Аудит секретов, зависимости, кода, конфигураций
- **Доступ**: Только чтение (read-only)
- **Использование**: `cd ~/vault && mimo run "аудит" --agent security`
- **Особенности**: 
  - Сканирование git истории на секреты
  - Проверка зависимостей (cargo audit, npm audit)
  - Анализ кода на уязвимости
  - Проверка конфигураций

### Documentation (Агент документации)
- **Ответственность**: API docs, архитектура, гайды, ADR, changelog
- **Доступ**: Чтение/запись документации
- **Использование**: Делегирование через PM

### Test (Агент тестирования)
- **Ответственность**: Unit, integration, e2e, property-based, fuzzing тесты
- **Доступ**: Чтение/запись кода, выполнение тестов
- **Использование**: Делегирование через PM

## Порядок работы

### 1. Начало сессии
```bash
# Проверка статуса
hermes kanban --board mailcipher list

# Просмотр текущих задач
hermes kanban --board mailcipher stats
```

### 2. Делегирование задач editor
```bash
cd ~/vault
mimo run "Описание задачи" --agent editor
```

### 3. Делегирование задач devops
```bash
cd ~/vault
mimo run "Описание задачи" --agent devops
```

### 4. Аудит безопасности
```bash
cd ~/vault
mimo run "Выполнить аудит безопасности по чек-листу из docs/agents/security-agent.md" --agent security
```

### 5. Обновление документации
```bash
cd ~/vault
mimo run "Обновить документацию для X" --agent build
# с промптом "act as documentation writer"
```

## Конфигурация агентов

Агенты настроены в `~/.config/mimocode/mimocode.json`:

```json
{
  "model": "mimo/mimo-auto",
  "agent": {
    "editor": {
      "description": "Агент для написания и рефакторинга кода",
      "permission": { "read": "allow", "write": "allow", "bash": "allow" }
    },
    "devops": {
      "description": "Агент для инфраструктуры и деплоя",
      "permission": { "read": "allow", "write": "allow", "bash": "allow" }
    },
    "security": {
      "description": "Агент для аудита безопасности (read-only)",
      "permission": { "read": "allow", "write": "deny", "bash": "allow" }
    }
  }
}
```

## Канбан

Доска: `mailcipher` (56 ready + 2 todo задач)

### Приоритеты
1. **Backend (Rust)** — базовая структура
2. **Клиент: чаты и групповые чаты** (terminal/ratatui)
3. **Шифрование** (после стабильности клиента)
4. **Ручная загрузка ключей** + генератор в клиенте

### Команды канбана
```bash
# Просмотр задач
hermes kanban --board mailcipher list

# Взять задачу
hermes kanban --board mailcipher claim t_XXXXXXXX

# Отметить выполнение
hermes kanban --board mailcipher complete t_XXXXXXXX

# Добавить комментарий
hermes kanban --board mailcipher comment t_XXXXXXXX "текст"
```

## Директории проекта

```
~/vault/                          # Код проекта
├── mailcipher-backend/             # Rust Axum + SQLx + PostgreSQL
├── docs/                           # Документация
│   ├── agents/                     # Инструкции для агентов
│   ├── architecture/               # ADR, схема БД
│   ├── api/                        # OpenAPI, эндпоинты
│   ├── development/                # Гайды по разработке
│   ├── deployment/                 # Docker, Nginx, systemd
│   ├── security/                   # Threat model, аудит
│   └── operations/                 # Мониторинг, бэкапы

/home/maksim/Notes/Projects/mailcipher/  # Исходная документация
├── ARCHITECTURE.md
├── ENCRYPTION.md
├── KEY_EXCHANGE.md
├── README.md
└── STATUS.md
```

## Важные замечания

1. **Security агент** — ТОЛЬКО чтение, не пишет код
2. **Все агенты** — используют graphify перед работой с кодом
3. **Секреты** — НИКОГДА не хардкодить, использовать .env / vault
4. **Тесты** — обязательны после изменений кода
5. **Документация** — обновлять в том же PR, что и код