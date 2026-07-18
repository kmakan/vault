# Vault — Plan: Avatars + Chat Fixes + Website + Monetization

## ✅ Completed

### Avatars (DONE)
- [x] Backend: avatar endpoints (POST/GET/DELETE for users + groups)
- [x] Frontend: AvatarUpload, UserAvatar, GroupSettings
- [x] API sync (localStorage → PostgreSQL)

### Chat Fixes (DONE)
- [x] Message delivery status (✓ sent / ✓✓ delivered / ✓✓ read)
- [x] Typing indicators (WebSocket)

## Current: Test Groups + Bug Fixes

### 1. Test Groups with Real Emails
- [ ] Create test group with 2+ real email addresses
- [ ] Test: send message to group → all members receive
- [ ] Test: reply from different email → all see it
- [ ] Test: add/remove member

### 2. Bug Fixes
- [ ] Fix: message ordering (timestamp sync)
- [ ] Fix: file attachment preview (images, documents)
- [ ] Fix: UI polish (dark mode, responsiveness)

## After: Website (BEFORE GitHub)

### 3. Domain Setup
- [x] vault-msg.ru — registered (199₽/год, nethouse.ru)
- [x] vault-msg.tech — registered (~$12/год)
- [ ] DNS configuration (A/CNAME records)
- [ ] SSL certificates (Let's Encrypt)

### 4. Landing Page
- [ ] vault-msg.ru — main page (Russian)
- [ ] vault-msg.tech — international page (English)
- [ ] Features description
- [ ] Download links (Desktop: .deb/.rpm/.exe)
- [ ] Screenshots / demo
- [ ] Privacy policy
- [ ] Terms of service

### 5. Pro Version Page
- [ ] Pro features description
- [ ] Pricing page
- [ ] Payment integration (Stripe/Paddle)
- [ ] License key delivery

## Monetization Strategy

### Revenue Model
- **Free**: Desktop app (GitHub + website download)
- **Pro**: Android app (Google Play subscription)

### Pro Features (Android)
- Voice calls (E2E encrypted)
- Video calls
- Groups up to 100 people
- Priority support
- Advanced encryption settings

### Distribution
- **Desktop**: GitHub (free) + vault-msg.ru/tech (download page)
- **Android**: Google Play Store (free + Pro subscription)
- **Website**: vault-msg.ru/tech (landing page + Pro page)

## GitHub Release (AFTER Website)

### 6. GitHub Setup
- [ ] Create GitHub repository
- [ ] Add README, LICENSE (MIT)
- [ ] Add CONTRIBUTING guide
- [ ] Add issue templates
- [ ] Add CI/CD (GitHub Actions)

### 7. Desktop Release
- [ ] Build scripts (Tauri)
- [ ] Release artifacts (.deb, .rpm, .exe, .dmg)
- [ ] Auto-update mechanism
- [ ] Version numbering

## Deferred: Voice Calls (Pro Feature)

### Phase 1: Crypto
- [ ] `derive_voice_key()` — X25519 ECDH + HKDF
- [ ] `encrypt_audio_frame()` — ChaCha20-Poly1305
- [ ] `decrypt_audio_frame()` — reverse
- [ ] Nonce management (call_id + sequence)

### Phase 2: Audio
- [ ] Opus encoder/decoder
- [ ] AudioRecord capture (48kHz, mono)
- [ ] AudioTrack playback
- [ ] Jitter buffer (50ms)

### Phase 3: Transport
- [ ] WebSocket extension for audio frames
- [ ] Frame types (audio, control, key_rotation)
- [ ] Connection management

### Phase 4: UI
- [ ] Call screen (incoming/outgoing)
- [ ] Mute/unmute/speaker/end buttons
- [ ] Duration indicator
- [ ] Encryption indicator (lock icon)

### Phase 5: Signaling
- [ ] Call request/accept via email
- [ ] Push notification for incoming calls
- [ ] Timeouts and retry

## Deferred: Android Client

### Phase 1: Setup
- [ ] Kotlin/Jetpack Compose project
- [ ] Tauri Mobile or native (TBD)
- [ ] Google Play Store setup

### Phase 2: Core Features
- [ ] Auth (email + password)
- [ ] Chat (text messages)
- [ ] Groups
- [ ] E2E encryption

### Phase 3: Pro Features
- [ ] Voice calls (WebRTC)
- [ ] Video calls
- [ ] Push notifications

## Total Estimate
- ✅ Avatars + Chat Fixes: DONE
- Website: 5-7 days
- GitHub Release: 2-3 days
- Voice Calls: 10-16 days (deferred)
- Android Client: 20-30 days (deferred)

## Domains
- **vault-msg.ru** — Russian audience (199₽/год)
- **vault-msg.tech** — International (~$12/год)
