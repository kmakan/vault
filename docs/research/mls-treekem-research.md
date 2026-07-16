# MLS (Messaging Layer Security) — Исследование для Whisper

## 1. Что такое MLS

**MLS** (Messaging Layer Security) — IETF-стандарт (RFC 9420) для安全な групповой коммуникации.
Разработан для масштабируемых групп с тысячами участников.

### Ключевые идеи
- **TreeKEM** — древовидная структура для эффективного обновления ключей
- **Forward secrecy** — компрометация ключа не раскрывает прошлые сообщения
- **Post-compromise security** — восстановление после компрометации ключа
- **Asynchronous** — участники могут добавляться без ожидания ответа

---

## 2. Архитектура TreeKEM

### 2.1 Древовидная структура

```
         [root]
        /      \
      [L]      [R]
     /   \    /   \
   [LL] [LR] [RL] [RR]
```

- Каждый лист — участник группы
- Каждый узел хранит **encrypted key package**
- При добавлении/удалении — обновляется O(log N) узлов

### 2.2 Операции

| Операция | Сложность | Описание |
|----------|-----------|----------|
| Add member | O(log N) | Добавление участника |
| Remove member | O(log N) | Удаление участника |
| Update keys | O(log N) | Обновление ключей для forward secrecy |
| Encrypt message | O(N) | Шифрование для всех участников |

### 2.3 Key Schedule

```
init_secret → epoch_secret → handshake_secret → application_secret
                                    ↓                    ↓
                          шифрование Handshake   шифрование сообщений
```

---

## 3. Rust-библиотеки для MLS

### 3.1 openmls (Primary)

```toml
[dependencies]
openmls = "0.6"
openmls_rust_crypto = "0.6"
tls_codec = "0.4"
```

**Преимущества:**
- Полная реализация RFC 9420
- Поддержка X25519, Ed25519, AES-128-GCM
- TreeKEM с рахис- tree
- Active社区 (FRANKLY Project)

**Ограничения:**
- Нет встроенной post-quantum поддержки
- Нужен отдельный крипто-бэкенд

### 3.2 snowlight

```toml
[dependencies]
snowlight = "0.1"
```

**Преимущества:**
- Простота использования
- WireGuard-подобный хендшейк

**Ограничения:**
- Не полная MLS реализация
- Менее активное развитие

---

## 4. Интеграция с Whisper

### 4.1 Текущая архитектура

```
Whisper: X25519 + Kyber (post-quantum ECDH)
         ↓
    Session Keys
         ↓
    XChaCha20-Poly1305
```

### 4.2 Предлагаемая архитектура с MLS

```
MLS Layer (group management):
├── TreeKEM key distribution
├── Group epoch management  
├── Membership changes
└── Forward secrecy
         ↓
Whisper Layer (message encryption):
├── Post-quantum keys (Kyber)
├── XChaCha20-Poly1305
└── HMAC-SHA512
```

### 4.3 Гибридный подход

```rust
pub struct GroupManager {
    // MLS для управления группами
    mls_group: openmls::group::MlsGroup,
    
    // Whisper для post-quantum шифрования
    whisper_crypto: WhisperCrypto,
    
    // Сессионные ключи
    session_keys: HashMap<MemberId, SessionKey>,
}

impl GroupManager {
    /// Добавить участника через MLS, но с post-quantum ключом
    pub fn add_member_with_pq(
        &mut self,
        member: Member,
        pq_key: KyberPublicKey,
    ) -> Result<()> {
        // 1. Добавляем через MLS TreeKEM
        self.mls_group.add_members(vec![member.key_package])?;
        
        // 2. Обновляем post-quantum ключ
        self.session_keys.insert(member.id, SessionKey {
            mlkem: pq_key,
            x25519: member.x25519_key,
        });
        
        Ok(())
    }
}
```

---

## 5. Реализация для Whisper

### 5.1 Этапы

| Этап | Описание | Сложность |
|------|----------|-----------|
| 1 | Базовая интеграция openmls | 2 недели |
| 2 | Гибридный TreeKEM + Kyber | 3 недели |
| 3 | Миграция с текущей системы | 2 недели |
| 4 | Тестирование | 1 неделя |

### 5.2 Структура кода

```
src/whisper/
├── mls/
│   ├── mod.rs          // Точка входа
│   ├── group.rs        // Управление группами
│   ├── treekem.rs      // TreeKEM операции
│   ├── key_schedule.rs // Расписание ключей
│   └── epoch.rs        // Эпохи групп
├── crypto/
│   ├── pq_mls.rs       // Post-quantum MLS
│   └── hybrid.rs       // Гибридные ключи
└── protocol/
    └── mls_handshake.rs // MLS handshake через email
```

### 5.3 Пример интеграции

```rust
use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;

pub struct MlsGroupManager {
    crypto: OpenMlsRustCrypto,
    group_config: MlsGroupConfig,
}

impl MlsGroupManager {
    pub fn create_group(
        &self,
        members: Vec<Member>,
    ) -> Result<MlsGroup> {
        let group_config = MlsGroupConfig::builder()
            .wire_format(WireFormat::MlsPublicMessage)
            .build();
        
        let group = MlsGroup::new_with_config(
            &self.crypto,
            &self.crypto,
            group_config,
            GroupId::random(&self.crypto),
            None, // No PSK
        )?;
        
        // Добавляем участников
        for member in members {
            group.add_members(
                &self.crypto,
                &self.crypto,
                &[member.key_package],
            )?;
        }
        
        Ok(group)
    }
    
    pub fn send_application_message(
        &self,
        group: &mut MlsGroup,
        message: &[u8],
    ) -> Result<MlsMessage> {
        // Шифруем сообщение через MLS
        let encrypted = group.apply_message(
            &self.crypto,
            message,
        )?;
        
        Ok(encrypted)
    }
}
```

---

## 6. Сравнение с текущей системой

| Аспект | Текущая система | С MLS |
|--------|----------------|-------|
| Forward secrecy | Полная | Полная |
| Post-compromise security | Нет | Да (KeyUpdate) |
| Масштабируемость | O(N) | O(log N) |
| Asynchronous | Да | Да |
| Post-quantum | Да (Kyber) | Нет (нужна интеграция) |
| Простота | Высокая | Средняя |

---

## 7. Рекомендации

### Для Whisper — гибридный подход

1. **Сохранить текущую систему** для 1:1 чатов (простая и пост-квантовая)
2. **Добавить MLS** только для групп >10 участников
3. **Гибридные ключи**: TreeKEM для управления, Kyber для шифрования
4. **Постепенная миграция**:MLS как опциональный слой

### Приоритеты

| Приоритет | Задача |
|-----------|--------|
| P0 | Сохранить пост-квантовое шифрование |
| P1 | Интеграция openmls |
| P2 | Гибридный TreeKEM + Kyber |
| P3 | Тестирование производительности |

---

## 8. Ссылки

- [RFC 9420 - MLS](https://datatracker.ietf.org/doc/rfc9420/)
- [openmls - Rust MLS](https://github.com/openmls/openmls)
- [TreeKEM论文](https://eprint.iacr.org/2018/1045.pdf)
- [MLS Protocol](https://messaginglayersecurity.info/)

---

*Последнее обновление: Июль 2026*
*Автор: Whisper Research*
