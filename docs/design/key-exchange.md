# Key Exchange Design — Vault

## Концепция

Vault не имеет сервера. Пользователи общаются через email (IMAP/SMTP).
Для установки E2E шифрования нужно безопасно обменяться ключами.

## Методы обмена ключами

### 1. QR Code (见面时)
```
Пользователь A показывает QR → Пользователь B сканирует
```
- **Безопасность**: Максимальная (физический обмен)
- **VPN**: Не нужен
- **Использование**: Лучший вариант при встрече
- **Реализация**: `kitty.rs` (терминал) + Desktop UI

### 2. Signal
```
Пользователь A → Signal → Пользователь B
  └─ vault:alice@example.com
  └─ pubkey: 04a1b2c3d4...
  └─ fingerprint: ABCD-1234-EF56
```
- **Безопасность**: Высокая (E2E)
- **VPN**: ⚠️ Заблокирован в:
  - Россия (с 2022)
  - Китай
  - Иран
  - ОАЭ (частично)
- **Предупреждение**: 
  ```
  ⚠️ Signal заблокирован в вашем регионе.
  Рекомендуется использовать VPN для обмена ключами.
  Альтернативы: SimpleX, PGP Email, ручное копирование.
  ```

### 3. SimpleX Chat
```
Пользователь A → SimpleX → Пользователь B
  └─ vault:alice@example.com
  └─ pubkey: 04a1b2c3d4...
```
- **Безопасность**: Высокая (нет номера телефона, E2E)
- **VPN**: ⚠️ Может быть заблокирован
- **Предупреждение**:
  ```
  ⚠️ SimpleX может быть заблокирован в вашем регионе.
  Используйте VPN или другой метод.
  ```

### 4. PGP Email
```
Пользователь A → Зашифрованное PGP письмо → Пользователь B
  └─ Vault Key Exchange
  └─ pubkey: 04a1b2c3d4...
  └─ fingerprint: ABCD-1234-EF56
```
- **Безопасность**: Высокая (если PGP настроен правильно)
- **VPN**: Не нужен
- **Предупреждение**:
  ```
  ℹ️ Убедитесь, что получатель использует PGP.
  Ключ будет зашифрован на его публичный PGP ключ.
  ```

### 5. Briar (Android P2P)
```
Пользователь A ↔ Briar ↔ Пользователь B
  └─ Vault Key Exchange
  └─ pubkey: 04a1b2c3d4...
```
- **Безопасность**: Очень высокая (P2P, без сервера, через Tor)
- **VPN**: Не нужен (использует Tor)
- **Предупреждение**:
  ```
  ℹ️ Требуется Android с приложением Briar.
  Подключение через Tor (может быть медленным).
  ```

### 6. Ручное копирование
```
Пользователь A копирует ключ → Передаёт через любой канал → Пользователь B вставляет
```
- **Безопасность**: Зависит от канала передачи
- **VPN**: Не нужен
- **Предупреждение**:
  ```
  ⚠️ Никогда не передавайте ключи незашифрованным каналом!
  Убедитесь, что получатель сверит fingerprint.
  ```

## Формат ключа для обмена

```
Vault Key Exchange
─────────────────────
Email: alice@example.com
Public Key: 04a1b2c3d4e5f6...
Fingerprint: ABCD-1234-EF56-7890
─────────────────────
```

## CLI команды

```bash
# Показать свой ключ для обмена
/vaultid
/sharekey signal      # Показать ключ для Signal
/sharekey simplex     # Показать ключ для SimpleX  
/sharekey pgp         # Показать ключ для PGP
/sharekey briar       # Показать ключ для Briar
/sharekey copy        # Показать ключ для ручного копирования

# Импортировать ключ собеседника
/importkey <vault-id> <pubkey> <fingerprint>
```

## Desktop UI

```
┌─────────────────────────────────────────┐
│  Share Your Vault Key                  │
├─────────────────────────────────────────┤
│  [QR Code]  [Signal]  [SimpleX]         │
│  [PGP]      [Briar]   [Copy]            │
├─────────────────────────────────────────┤
│  ┌─────────────────────────────────┐    │
│  │  Vault Key Exchange           │    │
│  │  ─────────────────────────────  │    │
│  │  Email: alice@example.com       │    │
│  │  Public Key: 04a1b2c3d4...      │    │
│  │  Fingerprint: ABCD-1234-EF56    │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ⚠️ Signal заблокирован в вашем        │
│     регионе. Используйте VPN.           │
└─────────────────────────────────────────┘
```

## Реализация

### invite.rs — новые методы

```rust
pub enum ShareMethod {
    QRCode,
    Signal,
    SimpleX,
    PgpEmail,
    Briar,
    ManualCopy,
}

pub struct ShareKeyInfo {
    pub email: String,
    pub public_key: String,
    pub fingerprint: String,
    pub method: ShareMethod,
    pub vpn_warning: Option<String>,
}

impl ShareKeyInfo {
    pub fn for_method(method: ShareMethod, email: &str, pubkey: &str) -> Self {
        let fingerprint = Contact::compute_fingerprint(pubkey);
        let vpn_warning = match method {
            ShareMethod::Signal => Some(
                "Signal заблокирован в некоторых регионах (Россия, Китай, Иран). \
                 Используйте VPN для обмена ключами.".to_string()
            ),
            ShareMethod::SimpleX => Some(
                "SimpleX может быть заблокирован в вашем регионе. \
                 Используйте VPN или другой метод.".to_string()
            ),
            _ => None,
        };
        
        Self {
            email: email.to_string(),
            public_key: pubkey.to_string(),
            fingerprint,
            method,
            vpn_warning,
        }
    }
    
    pub fn to_text(&self) -> String {
        format!(
            "Vault Key Exchange\n\
             ─────────────────────\n\
             Email: {}\n\
             Public Key: {}\n\
             Fingerprint: {}\n\
             ─────────────────────",
            self.email, self.public_key, self.fingerprint
        )
    }
}
```

## Приоритет реализации

1. **v0.1.0 (20.08)**: QR Code + ручное копирование
2. **v0.2.0**: Signal + SimpleX
3. **v0.3.0**: PGP Email + Briar

## Связанные задачи

- `t_c963c98a`: Signal method + VPN warning
- `t_812d2ef7`: SimpleX method + VPN warning
- `t_21a6fec1`: PGP email method
- `t_c91509b5`: Briar method (Android P2P)
- `t_62f0a00a`: Manual copy + safety warnings
- `t_07e30b68`: CLI: /sharekey commands
