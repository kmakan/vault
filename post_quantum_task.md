# Задача: Добавить пост-квантовое шифрование (Kyber-1024)

## Текущее состояние

### Backend (Rust)
- Пути: /home/maksim/vault/vault-backend
- Файл: src/crypto/mod.rs (162 строки) — экспорт крипто-модулей
- Файл: src/crypto/signing.rs (164 строки) — Ed25519 подпись
- Зависимости: x25519-dalek 2.0, ed25519-dalek 2.1, chacha20poly1305 0.10

### Desktop (Vue/Tauri)
- Пути: /home/maksim/vault/vault-desktop
- Файл: package.json — Vue 3 + Tauri 2 (нет WASM крипто)
- Зависимости: @tauri-apps/api, @tauri-apps/plugin-shell, qrcode, vue

## Задачи для реализации

### 1. Backend: Kyber-1024 KEM

Файл: src/crypto/post_quantum.rs

Реализовать:
- KyberKeyPair — структура для хранения Kyber ключей
- generate_kyber_keypair() -> KyberKeyPair
- kyber_encapsulate(pk) -> (ciphertext, shared_secret)
- kyber_decapsulate(sk, ct) -> shared_secret
- Кириллические комментарии на русском

Зависимости в Cargo.toml:
pqcrypto-kyber = "0.8"
pqcrypto-kem = "0.8"

### 2. Backend: Hybrid Encryption (X25519 + Kyber)

Файл: src/crypto/hybrid.rs

Реализовать:
- HybridKeyExchange — объединяет X25519 и Kyber
- generate_hybrid_keypair() -> (x25519_secret, x25519_public, kyber_pk)
- hybrid_encapsulate(pk) -> (x25519_ct, kyber_ct, hybrid_secret)
- hybrid_decapsulate(sk, x25519_ct, kyber_ct) -> hybrid_secret
- Логика: hybrid_secret = HKDF-SHA256(x25519_secret || kyber_secret)

Экспорт в mod.rs добавить модули post_quantum и hybrid.

### 3. Desktop: WASM Kyber

Файл: src/crypto/kyber_wasm.ts

Реализовать через wasm-bindgen:
- generateKyberKeyPair()
- kyberEncapsulate(pk)
- kyberDecapsulate(sk, ct)

### 4. Обновить API

Файл: src/keys/models.rs

Добавить поля:
- kyber_public_key: Option<String>
- kyber_secret_key: Option<String>
- hybrid_x25519_public: Option<String>
- hybrid_x25519_secret: Option<String>

### 5. Тесты

Файл: tests/post_quantum_test.rs

Тесты:
- Kyber key generation
- Kyber encapsulate/decapsulate roundtrip
- Hybrid key exchange roundtrip
- Hybrid secret derivation consistency

## Требования

1. Все файлы на русском языке (комментарии, документация)
2. Следовать стилю проекта (см. signing.rs)
3. Base64 encoding для ключей в API
4. Валидация длин ключей и ciphertext
5. Тесты должны проходить (cargo test)
6. Не менять существующий код, только добавлять новый

## Выходные данные

Создай/обнови следующие файлы:
1. src/crypto/post_quantum.rs
2. src/crypto/hybrid.rs
3. src/crypto/mod.rs (обновить экспорт)
4. Cargo.toml (добавить зависимости)
5. src/keys/models.rs (добавить поля)
6. tests/post_quantum_test.rs
7. src/crypto/kyber_wasm.ts
8. package.json (добавить WASM зависимости)
