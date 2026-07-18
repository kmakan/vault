# Vault — E2E Encrypted Voice Calls

## Конкурентное преимущество

| Транспорт | Кто блокирует | Vault |
|-----------|--------------|-------|
| Email | Никто | ✅ сообщения |
| WebSocket | ISP/FRB могут | ⚠️ нотификации |
| Телефонный звонок | Никто | ✅ голосовые звонки |
| P2P/BitTorrent | ISP блокируют | ❌ отложено |

**Vault = email для текста + телефон для голоса = неблокируемый мессенджер**

## Модель аккаунта

```sql
ALTER TABLE users ADD COLUMN phone VARCHAR(20);      -- номер телефона (E.164)
ALTER TABLE users ADD COLUMN phone_verified BOOLEAN;  -- верифицирован ли
ALTER TABLE users ADD COLUMN voice_enabled BOOLEAN;   -- включены ли звонки
```

Пользователь РЕГИСТРИРУЕТСЯ через:
1. **Email** — для сообщений (уже есть)
2. **Телефон** — для звонков (новое)

Номер телефона = "адрес" для звонков, как email = адрес для сообщений.

## Криптография звонков

### Деривация голосового ключа

Уже обменянные X25519 ключи → ECDH → HKDF → голосовой ключ:

```
shared_secret = X25519_ECDH(my_private_key, peer_public_key)
voice_key = HKDF(shared_secret, salt="vault-voice-v1", info=call_id, 32 bytes)
```

**Никаких новых обменов ключами не нужно.** Голосовой ключ = производная от уже обменённых ключей.

### Шифрование аудио-фреймов

Каждый аудио-фрейм (30ms Opus):

```
[Frame#N][ChaCha20-Poly1305(voice_key, nonce=N, opus_data)]
```

- Nonce: 12 байт (4 байта call_id + 8 байта sequence number)
- Auth tag: 16 байт (Poly1305)
- Overhead: 28 байт на фрейм

### Синхронизация ключей

```
Alice                          Bob
  |                              |
  |-- email: "calling you" ----->|  (содержит: call_id, Alice's ephemeral_pub)
  |<-- email: "accepting" -------|  (содержит: call_id, Bob's ephemeral_pub)
  |                              |
  |  ECDH(Alice_priv, Bob_ephem) |
  |  ECDH(Alice_ephem, Bob_pub)  |
  |  HKDF(combined, "vault-voice-v1") = voice_key
  |                              |
  |-- encrypted audio via WS --->|
  |<-- encrypted audio via WS ---|
```

## Архитектура

### Сигнализация (Email)

```
1. Alice нажимает "Позвонить Bob"
2. Alice генерирует ephemeral X25519 ключ
3. Alice отправляет email Bob:
   {
     "type": "call_request",
     "call_id": "uuid",
     "ephemeral_pub": "base64...",
     "timestamp": "ISO8601",
     "signature": "Ed25519_sign..."
   }
4. Bob получает email → приложение показывает входящий звонок
5. Bob принимает → генерирует свой ephemeral ключ
6. Bob отправляет email Alice:
   {
     "type": "call_accept",
     "call_id": "uuid",
     "ephemeral_pub": "base64...",
     "timestamp": "ISO8601",
     "signature": "Ed25519_sign..."
   }
7. Оба вычисляют voice_key через ECDH + HKDF
```

### Аудио-транспорт (WebSocket)

```
WebSocket channel (существующий):
├── Нотификации (уже работает)
├── Аудио фреймы (новое)
│   ├── Frame type: 0x01 (encrypted opus)
│   ├── Frame type: 0x02 (control: mute/unmute/end)
│   └── Frame type: 0x03 (key rotation)
└── Сигнализация (call_request/accept/end)
```

### Альтернатива: прямой телефонный звонок

Если WebSocket недоступен (нет интернета):

```
1. Alice дозванивается до Bob через обычный телефон
2. Оба приложения определяют входящий/исходящий звонок
3. Приложение захватывает микрофон (AudioRecord API)
4. Opus encode → ChaCha20 encrypt → отправка через audio stream
5. На стороне Bob: decrypt → Opus decode → AudioTrack play
```

**Проблема:** Android не даёт перехватить аудио обычного звонка без root/Accessibility. 
**Решение:** Использовать VoIP (WebSocket) как основной транспорт для звонков.

## Android Implementation

### Крипто-слой (Kotlin)

```kotlin
// VoiceKeyDerivation.kt
class VoiceKey(
    private val myPrivateKey: ByteArray,      // 32 bytes X25519
    private val peerPublicKey: ByteArray,      // 32 bytes X25519
    private val myEphemeralPrivate: ByteArray, // 32 bytes
    private val peerEphemeralPublic: ByteArray, // 32 bytes
) {
    fun deriveVoiceKey(callId: ByteArray): ByteArray {
        // ECDH 1: my_private × peer_ephemeral
        val shared1 = X25519.ecdh(myPrivateKey, peerEphemeralPublic)
        // ECDH 2: my_ephemeral × peer_public
        val shared2 = X25519.ecdh(myEphemeralPrivate, peerPublicKey)
        // Combine
        val combined = shared1 + shared2
        // HKDF → voice_key
        return HKDF.derive(
            ikm = combined,
            salt = "vault-voice-v1".toByteArray(),
            info = callId,
            length = 32
        )
    }
}
```

### Аудио-слой (Kotlin)

```kotlin
// AudioCapture.kt
class AudioCapture {
    private val recorder = AudioRecord(
        MediaRecorder.AudioSource.MIC,
        48000,                    // sample rate
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        AudioRecord.getMinBufferSize(48000, CHANNEL_IN_MONO, ENCODING_PCM_16BIT)
    )
    
    private val encoder = OpusEncoder(48000, 1, OpusApplication.VOIP)
    
    fun captureAndEncrypt(voiceKey: ByteArray, sequenceNumber: Long): ByteArray {
        val pcm = readFrame(960)  // 20ms at 48kHz
        val opus = encoder.encode(pcm)
        val nonce = buildNonce(callId, sequenceNumber)
        return ChaCha20Poly1305.encrypt(voiceKey, nonce, opus)
    }
}
```

### WebSocket-транспорт

```kotlin
// VoiceWebSocket.kt
class VoiceWebSocket(url: String) {
    fun sendEncryptedAudio(frame: ByteArray) {
        // Frame format: [type:1][seq_no:8][encrypted_audio:N]
        val packet = ByteArray(1 + 8 + frame.size)
        packet[0] = 0x01  // audio frame type
        packet.putLong(1, sequenceNumber)
        frame.copyInto(packet, 9)
        websocket.send(packet)
    }
}
```

## Сценарии

### 1. Оба онлайн (WebSocket)
```
Alice → [email: call_request] → Bob
Alice ← [email: call_accept]  ← Bob
Alice ←→ [WebSocket: encrypted audio] ←→ Bob
```

### 2. Bob оффлайн (push notification)
```
Alice → [email: call_request] → Bob
Bob ← [FCM push: "Vault: входящий звонок"] 
Bob открывает приложение → [email: call_accept] → Alice
Alice ←→ [WebSocket: encrypted audio] ←→ Bob
```

### 3. Нет интернета у Bob
```
Alice → [email: call_request] → Bob (отложено)
Bob → [email: call_accept] → Alice (когда появится интернет)
Звонок невозможен без соединения
```

### 4. Оба без интернета (мечта)
```
Невозможно — нужна сеть для сигнализации
Альтернатива: Bluetooth/NFC для обмена ключами → P2P аудио
```

## Безопасность

1. **Forward secrecy**: ephemeral ключи для каждого звонка
2. **Post-quantum**: гибрид X25519+Kyber для долгосрочной безопасности
3. **Key rotation**: обновление voice_key каждые 5 минут
4. **No metadata on server**: email содержит только зашифрованный контент
5. **Ключи не хранятся**:ephemeral ключи удаляются после звонка

## Фазы реализации

### Фаза 1: Крипто (2-3 дня)
- [ ] `derive_voice_key()` — деривация из X25519
- [ ] `encrypt_audio_frame()` — ChaCha20-Poly1305 для Opus
- [ ] `decrypt_audio_frame()` — обратная операция
- [ ] Nonce management (call_id + sequence)

### Фаза 2: Аудио (3-5 дней)
- [ ] Opus encoder/decoder (Android NDK)
- [ ] AudioRecord захват (48kHz, mono)
- [ ] AudioTrack воспроизведение
- [ ] Jitter buffer (50ms)

### Фаза 3: Транспорт (2-3 дня)
- [ ] WebSocket расширение для аудио
- [ ] Frame types (audio, control, key_rotation)
- [ ] Connection management

### Фаза 4: UI (2-3 дня)
- [ ] Экран звонка (входящий/исходящий)
- [ ] Кнопки mute/unmute/speaker/end
- [ ] Индикатор длительности
- [ ] Индикатор шифрования (замочек)

### Фаза 5: Сигнализация (1-2 дня)
- [ ] Call request/accept через email
- [ ] Push notification для входящих
- [ ] Таймауты и retry

**Итого: 10-16 дней**
