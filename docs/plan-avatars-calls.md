# Vault — Plan: Avatars + Chat Fixes + Phone Calls

## Immediate: Avatars + Chat Fixes

### 1. Avatar Upload (Settings Panel)
- [ ] Backend: `POST /api/user/avatar` — upload PNG/JPG, max 500KB
- [ ] Backend: store in `~/.vault/avatars/` (local) + email attachment (sync)
- [ ] Frontend: `AvatarUpload.vue` component in settings
- [ ] Frontend: crop/resize to 256x256 before upload
- [ ] Frontend: preview in settings panel

### 2. Avatars in Chat List
- [ ] Frontend: `UserAvatar.vue` — support `avatarUrl` prop (show image if available)
- [ ] Frontend: chat list shows avatar next to contact name
- [ ] Frontend: group chat shows group avatar

### 3. Group Avatars
- [ ] Backend: `POST /api/groups/:id/avatar` — upload group avatar
- [ ] Frontend: group settings allow avatar upload
- [ ] Frontend: group chat shows avatar in list and header

### 4. Test Groups with Real Emails
- [ ] Create test group with 2+ real email addresses
- [ ] Test: send message to group → all members receive
- [ ] Test: reply from different email → all see it
- [ ] Test: add/remove member

### 5. Chat Fixes
- [ ] Fix: message delivery status (sent/delivered/read)
- [ ] Fix: typing indicators
- [ ] Fix: message ordering (timestamp sync)
- [ ] Fix: file attachment preview (images, documents)

## Before GitHub Push: Phone Calls

### 6. Phone Number in Account
- [ ] Backend: add `phone` column to users table
- [ ] Backend: phone verification via SMS (Twilio/Vonage)
- [ ] Frontend: phone number input in registration/settings
- [ ] Frontend: phone verification UI

### 7. Voice Calls Architecture
- [ ] Doc: finalize voice-calls.md (update with Pro version)
- [ ] Kanban: add voice call tasks

### 8. Pro Version Monetization
- [ ] Doc: define Pro features (voice calls, group size, storage)
- [ ] Backend: subscription model (Stripe/crypto)
- [ ] Frontend: Pro badge, upgrade prompt

## Deferred: Voice Call Implementation

### Phase 1: Crypto (2-3 days)
- [ ] `derive_voice_key()` — X25519 ECDH + HKDF
- [ ] `encrypt_audio_frame()` — ChaCha20-Poly1305
- [ ] `decrypt_audio_frame()` — reverse
- [ ] Nonce management (call_id + sequence)

### Phase 2: Audio (3-5 days)
- [ ] Opus encoder/decoder (Android NDK)
- [ ] AudioRecord capture (48kHz, mono)
- [ ] AudioTrack playback
- [ ] Jitter buffer (50ms)

### Phase 3: Transport (2-3 days)
- [ ] WebSocket extension for audio frames
- [ ] Frame types (audio, control, key_rotation)
- [ ] Connection management

### Phase 4: UI (2-3 days)
- [ ] Call screen (incoming/outgoing)
- [ ] Mute/unmute/speaker/end buttons
- [ ] Duration indicator
- [ ] Encryption indicator (lock icon)

### Phase 5: Signaling (1-2 days)
- [ ] Call request/accept via email
- [ ] Push notification for incoming calls
- [ ] Timeouts and retry

## Total Estimate
- Avatars + Chat Fixes: 3-5 days
- Phone Number + Pro: 2-3 days
- Voice Calls: 10-16 days (deferred)
