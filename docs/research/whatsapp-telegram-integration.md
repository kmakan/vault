# Интеграция шифрования Vault с WhatsApp/Telegram

## 1. Обзор подходов

### 1.1 Цель
Распространить E2E шифрование Vault на существующие мессенджеры
без необходимости замены их клиентов.

### 1.2 Варианты интеграции

| Подход | Описание | Сложность |
|--------|----------|-----------|
| **Прокси-клиент** | Vault работает как прокси между пользователями и платформой | Средняя |
| **Userbot** | Бот в аккаунте пользователя перехватывает сообщения | Низкая |
| **Плагин/Расширение** | Встраивание в клиент платформы | Высокая |
| **Собственный клиент** | Полная замена клиента | Очень высокая |

### 1.3 Рекомендованный подход
**Прокси-клиент** — Vault работает на устройстве пользователя,
шифрует сообщения перед отправкой в Telegram/WhatsApp, и расшифровывает
при получении. Платформа видит только зашифрованный текст.

---

## 2. Telegram интеграция

### 2.1 MTProto userbot

```rust
// Использование grammers (MTProto клиент)
use grammers_client::{Client, InputMessage};

pub struct TelegramBridge {
    client: Client,
    vault: VaultSession,
}

impl TelegramBridge {
    /// Принять сообщение из Telegram, расшифровать Vault
    pub async fn on_message(&self, msg: Message) -> Result<String> {
        if msg.text().starts_with("[WHISPER]") {
            let encrypted = &msg.text()[10..];
            let decrypted = self.vault.decrypt(encrypted)?;
            return Ok(decrypted);
        }
        Ok(msg.text().to_string())
    }

    /// Зашифровать и отправить через Telegram
    pub async fn send_encrypted(
        &self,
        chat_id: i32,
        plaintext: &str,
    ) -> Result<()> {
        let encrypted = self.vault.encrypt(plaintext)?;
        self.client.send_message(
            chat_id,
            InputMessage::text(format!("[WHISPER]{}", encrypted))
        ).await?;
        Ok(())
    }
}
```

### 2.2 Зависимости

```toml
[dependencies]
grammers = "0.7"
grammers-session = "0.7"
tokio = { version = "1", features = ["full"] }
```

### 2.3 Преимущества
- Не требует модификации Telegram
- Работает с любым чатом (1:1 и группы)
- Простая реализация через userbot API

### 2.4 Ограничения
- Telegram видит зашифрованный текст (но не расшифровывает)
- Нет встроенного отображения медиа (нужно отдельно)
- Работает только когда userbot запущен

---

## 3. WhatsApp интеграция

### 3.1 Baileys (Web API)

```rust
// Использование baileys через FFI или HTTP API
pub struct WhatsAppBridge {
    // Baileys работает через Node.js, нужен FFI мост
    api_url: String,
    vault: VaultSession,
}

impl WhatsAppBridge {
    pub async fn on_message(&self, msg: WhatsAppMessage) -> Result<String> {
        if msg.body.starts_with("[WHISPER]") {
            let encrypted = &msg.body[10..];
            let decrypted = self.vault.decrypt(encrypted)?;
            return Ok(decrypted);
        }
        Ok(msg.body.clone())
    }
}
```

### 3.2 Альтернативы
- **whatsapp-web.js** — Node.js библиотека
- **Chat-API** — коммерческий API
- **Baileys** — open-source WebSocket клиент

### 3.3 Ограничения
- WhatsApp может блокировать userbot аккаунты
- Нет стабильного API (в отличие от Telegram)
- Сложнее интеграция из-за отсутствия Rust библиотек

---

## 4. Архитектура прокси-клиента

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Vault    │────▶│   Bridge    │────▶│  Telegram/  │
│  Crypto     │◀────│   Layer     │◀────│  WhatsApp   │
└─────────────┘     └─────────────┘     └─────────────┘
     │                    │                    │
     │ E2E шифрование     │ MTProto/Baileys    │ Платформа
     │ (Kyber+XChaCha)   │ (userbot)          │ API
```

### 4.1 Компоненты

```rust
/// Мост между Vault и мессенджером
pub trait MessageBridge: Send + Sync {
    /// Принять сообщение из платформы
    async fn receive(&self) -> Result<BridgeMessage>;

    /// Отправить сообщение в платформу
    async fn send(&self, msg: BridgeMessage) -> Result<()>;

    /// Проверить доступность платформы
    async fn is_online(&self) -> bool;
}

/// Сообщение моста
pub struct BridgeMessage {
    pub platform: Platform,
    pub chat_id: String,
    pub sender: String,
    pub content: String, // Зашифрованный текст
    pub timestamp: DateTime<Utc>,
}

/// Платформы
pub enum Platform {
    Telegram,
    WhatsApp,
    Email, // Текущий Vault
}
```

### 4.2 Мультиплатформенный шифровальщик

```rust
pub struct MultiPlatformCrypto {
    bridges: HashMap<Platform, Box<dyn MessageBridge>>,
    vault: VaultSession,
}

impl MultiPlatformCrypto {
    /// Отправить сообщение через выбранную платформу
    pub async fn send_via(
        &self,
        platform: Platform,
        chat_id: &str,
        plaintext: &str,
    ) -> Result<()> {
        let bridge = self.bridges.get(&platform)
            .context("Platform not configured")?;

        // Шифруем через Vault
        let encrypted = self.vault.encrypt(plaintext)?;

        // Отправляем через мост
        bridge.send(BridgeMessage {
            platform,
            chat_id: chat_id.to_string(),
            content: encrypted,
            ..Default::default()
        }).await?;

        Ok(())
    }

    /// Получить сообщение из любой платформы
    pub async fn receive_from(
        &self,
        platform: Platform,
    ) -> Result<String> {
        let bridge = self.bridges.get(&platform)
            .context("Platform not configured")?;

        let msg = bridge.receive().await?;

        // Расшифровываем
        let decrypted = self.vault.decrypt(&msg.content)?;
        Ok(decrypted)
    }
}
```

---

## 5. Реализация для Vault

### 5.1 Этапы

| Этап | Описание | Срок |
|------|----------|------|
| 1 | Telegram userbot мост | 1 неделя |
| 2 | Базовое шифрование через Telegram | 3 дня |
| 3 | WhatsApp мост (Baileys) | 2 недели |
| 4 | Мультиплатформенный интерфейс | 1 неделя |
| 5 | Тестирование | 1 неделя |

### 5.2 Структура кода

```
src/vault/
├── bridge/
│   ├── mod.rs           // Точка входа
│   ├── telegram.rs      // MTProto userbot
│   ├── whatsapp.rs      // Baileys/Web API
│   ├── traits.rs        // MessageBridge trait
│   └── manager.rs       // Управление мостами
└── protocol/
    └── bridge_message.rs // Формат сообщений
```

### 5.3 Пример CLI интеграции

```bash
# Подключить Telegram
/bridge telegram

# Отправить через Telegram
/send telegram <chat_id> Привет!

# Получить из Telegram
/inbox telegram

# Отключить
/unbridge telegram
```

---

## 6. Безопасность

### 6.1 Модель угроз

| Угроза | Риск | Митигация |
|--------|------|-----------|
| Платформа видит зашифрованный текст | Средний | Стеганография (опционально) |
| Userbot аккаунт заблокирован | Низкий | Резервный email-транспорт |
| MITM на userbot | Низкий | TLS + верификация серверов |
| Compromised device | Высокий | Hardware security key |

### 6.2 Стеганография (опционально)

```rust
/// Замаскировать зашифрованное сообщение как обычный текст
pub fn steganograph(encrypted: &str) -> String {
    // Конвертируем base64 в "нормальные" слова
    let words = encrypted
        .as_bytes()
        .chunks(3)
        .map(|chunk| {
            let idx = u32::from_be_bytes([
                chunk[0], chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0), 0
            ]);
            WORD_LIST[idx as usize % WORD_LIST.len()]
        })
        .collect::<Vec<_>>();

    format!("Кстати, {}", words.join(" "))
}
```

---

## 7. Тестирование

### 7.1 Unit-тесты

```rust
#[tokio::test]
async fn test_telegram_bridge_encrypt_decrypt() {
    let bridge = TelegramBridge::new(mock_client());
    let msg = "Hello, Vault!";

    // Шифруем
    let encrypted = bridge.encrypt_for_telegram(msg).unwrap();
    assert!(encrypted.starts_with("[WHISPER]"));
    assert_ne!(encrypted, msg);

    // Расшифровываем
    let decrypted = bridge.decrypt_from_telegram(&encrypted).unwrap();
    assert_eq!(decrypted, msg);
}
```

### 7.2 Интеграционные тесты

```rust
#[tokio::test]
async fn test_cross_platform_message() {
    let vault = VaultSession::new();
    let telegram = TelegramBridge::new(test_client());
    let email = EmailBridge::new(test_imap());

    // Отправляем через Telegram
    telegram.send_encrypted("user123", "Cross-platform!").await.unwrap();

    // Получаем через Email (другой пользователь)
    let received = email.receive().await.unwrap();
    assert_eq!(received.content, "Cross-platform!");
}
```

---

## 8. Заключение

### Рекомендации
1. **Начать с Telegram** — стабильный API, хорошая поддержка
2. **WhatsApp как вторичный** — более рискованно из-за блокировок
3. **Сохранить email как основной** — most reliable transport
4. **Мультиплатформенность** — единый интерфейс для всех платформ

### Приоритеты
| Приоритет | Задача |
|-----------|--------|
| P0 | Telegram userbot мост |
| P1 | Базовое E2E через Telegram |
| P2 | WhatsApp мост |
| P3 | Мультиплатформенный интерфейс |
| P4 | Стеганография |

---

*Последнее обновление: Июль 2026*
*Автор: Vault Research*
