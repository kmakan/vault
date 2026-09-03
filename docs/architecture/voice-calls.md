# Vault — E2E Encrypted Voice Calls (архитектура, решение 22.08.2026)

> **Рерайт 22.08.2026**: прежняя версия (WebSocket-транспорт, телефонные аккаунты,
> собственная криптография фреймов ChaCha+HKDF) УСТАРЕЛА и конфликтует с решением
> 18.08.2026 (никаких публичных серверов). Своя крипта медиа не нужна — WebRTC
> даёт DTLS-SRTP.

## Принцип

```
Сигнализация: зашифрованные конверты Vault (email) — call_request/accept/sdp/end
Доставка:     IMAP IDLE (~1-3с), фолбэк поллинг (ускоренный до 2-3с во время звонка)
Медиа:        WebRTC P2P (DTLS-SRTP, E2EE) — webrtc-rs (Rust) в Tauri-бэкенде
NAT:          TURN пользователя (X2TURN, coturn over TLS/443) — настройка, без хардкода
```

**Vault = email для текста + WebRTC для голоса = неблокируемый мессенджер.**
Ни один публичный сервер установки/проведения звонка не требуется .

## Сигнализация (конверты Vault, stealth)

Пустая тема, шифрованное тело — провайдер видит «ещё одно письмо»:

```
{vault:1, id, type:'call_request', call_id, ts}           // вызов (гудки)
{vault:1, id, type:'call_accept', call_id, ts}            // ответ
{vault:1, id, type:'call_sdp',    call_id, sdp, ts}       // полный SDP (offer/answer)
{vault:1, id, type:'call_reject'|'call_end'|'call_missed', call_id, ts}
```

- `call_*` НЕ рендерится как сообщение чата — уходит в call-state-machine (App.vue).
- Дедуп по `call_id`, таймауты (30-45с ожидания accept), ретраи SMTP (как квитанции).
- ICE: для MVP — **полный SDP** (gathering 1-3с, один конверт `call_sdp`), non-trickle;
  trickle-ICE несколькими конвертами — как улучшение.

## Медиа (webrtc-rs)

- PeerConnection (audio track), DTLS-SRTP из коробки (E2EE, эфемерные ключи, FS).
- Аудио: **cpal** (микрофон/динамик; desktop ALSA/Pulse, android Oboe) + **opus**
  (48kHz mono, 20ms) + jitter buffer 50-100ms.
- Видео — позже (нативный захват; старт с аудио-MVP).

## ICE / TURN

- P2P: host + srflx кандидаты (домашние NAT проходят).
- Symmetric NAT без TURN → звонок невозможен; **TURN обязателен как настройка**.
- TURN поверх TLS 443: coturn (`alt-tls-listening-port=443`,
  `lt-cred-mech`, Let's Encrypt, релей 49152:65535) — неотличим от HTTPS для DPI.
- SettingsPage: список ICE-серверов (STUN/TURN) пользователя, ротация;
  публичные STUN — только dev-сборки.

## Почему не webview-WebRTC

Android WebView / WebView2 работают, но **Linux (WebKitGTK, наш desktop)
getUserMedia неполноценен** (GStreamer, permissions) — риск для флагманской
платформы. Нативный webrtc-rs даёт паритет desktop/android.

## План (M3, аудио-MVP ~12-16 дней)

1. **Сигнализация (2-3д)**: call_* типы + классификация + state machine + IDLE/ускоренный поллинг.
2. **Медиа (5-7д)**: webrtc-rs + cpal + opus + jitter buffer.
3. **ICE/TURN (2-3д)**: SDP-конверты, настройки ICE в UI, проверка на реальных NAT.
4. **UI (2-3д)**: экран звонка (входящий/исходящий, mute/speaker/end, длительность, 🔒),
   история звонков системными сообщениями, «пропущенный».
5. **Позже**: видео; групповые звонки (mesh 3-4 или SFU — отдельный research).

## Безопасность

1. Сигнализация: существующий X25519+ChaCha20-Poly1305 конверт (никакой новой крипты).
2. Медиа: DTLS-SRTP (стандарт WebRTC, эфемерные ключи).
3. Zero-metadata на медиа: P2P — провайдер ничего не видит; TURN (свой) — только IP.
4. Длительность звонка видна провайдеру email по timestamps — принято (как любое письмо).
5. Микрофон/камера: runtime-разрешения (паттерн POST_NOTIFICATIONS на Android).
