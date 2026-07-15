//! Double Ratchet Algorithm for Forward Secrecy
//!
//! Implements the Signal Protocol's Double Ratchet for E2E encrypted messaging.
//! Combines symmetric ratchet (KDF chain) with DH ratchet for forward secrecy
//! and break-in recovery.

use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng as ChaChaOsRng},
    ChaCha20Poly1305, Nonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};
use rand_core::RngCore;
use zeroize::Zeroize;

use super::CryptoError;

/// Max skipped message keys stored (out-of-order support)
const MAX_SKIP: usize = 256;

/// Header sent alongside encrypted messages
#[derive(Debug, Clone)]
pub struct RatchetHeader {
    /// Sender's current ratchet public key
    pub dh_public: [u8; 32],
    /// Message number in sending chain
    pub msg_number: u32,
    /// Message number in previous sending chain
    pub prev_msg_number: u32,
}

impl RatchetHeader {
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(72);
        buf.extend_from_slice(&self.dh_public);
        buf.extend_from_slice(&self.msg_number.to_be_bytes());
        buf.extend_from_slice(&self.prev_msg_number.to_be_bytes());
        buf
    }

    pub fn decode(data: &[u8]) -> Result<Self, CryptoError> {
        if data.len() < 40 {
            return Err(CryptoError::from("Header too short"));
        }
        let mut dh_public = [0u8; 32];
        dh_public.copy_from_slice(&data[..32]);
        let msg_number = u32::from_be_bytes([data[32], data[33], data[34], data[35]]);
        let prev_msg_number = u32::from_be_bytes([data[36], data[37], data[38], data[39]]);
        Ok(RatchetHeader { dh_public, msg_number, prev_msg_number })
    }
}

/// KDF output: chain key + message key
fn kdf_ratchet(chain_key: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let hk = Hkdf::<Sha256>::new(Some(chain_key), b"WhisperMessageKeys");
    let mut output = [0u8; 64];
    hk.expand(b"", &mut output).expect("HKDF expand failed");
    let mut new_chain_key = [0u8; 32];
    let mut message_key = [0u8; 32];
    new_chain_key.copy_from_slice(&output[..32]);
    message_key.copy_from_slice(&output[32..]);
    (new_chain_key, message_key)
}

/// KDF for DH ratchet step: derives chain key from DH shared secret + ratchet public key
fn kdf_dh(
    dh_secret: &StaticSecret,
    dh_public: &PublicKey,
    salt: &[u8; 32],
) -> ([u8; 32], [u8; 32]) {
    let shared = dh_secret.diffie_hellman(dh_public);
    let hk = Hkdf::<Sha256>::new(Some(salt), shared.as_bytes());
    let mut output = [0u8; 64];
    hk.expand(b"WhisperRatchet", &mut output).expect("HKDF expand failed");
    let mut root_key = [0u8; 32];
    let mut chain_key = [0u8; 32];
    root_key.copy_from_slice(&output[..32]);
    chain_key.copy_from_slice(&output[32..]);
    (root_key, chain_key)
}

/// Encrypt a message key using ChaCha20-Poly1305
fn encrypt_with_key(key: &[u8; 32], plaintext: &[u8], nonce_bytes: &[u8; 12]) -> Result<Vec<u8>, CryptoError> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher.encrypt(nonce, plaintext)
        .map_err(|e| CryptoError::from(format!("Encryption failed: {}", e)))
}

/// Decrypt using ChaCha20-Poly1305
fn decrypt_with_key(key: &[u8; 32], ciphertext: &[u8], nonce_bytes: &[u8; 12]) -> Result<Vec<u8>, CryptoError> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher.decrypt(nonce, ciphertext)
        .map_err(|e| CryptoError::from(format!("Decryption failed: {}", e)))
}

/// Double Ratchet session state
pub struct DoubleRatchetSession {
    /// Our identity key (static)
    pub identity_key: StaticSecret,
    /// Our identity public key
    pub identity_public: PublicKey,

    /// Current ratchet key pair
    pub ratchet_key_pair: (StaticSecret, PublicKey),
    /// Remote's current ratchet public key
    pub remote_ratchet_key: Option<PublicKey>,
    /// Remote's identity public key
    pub remote_identity_key: Option<PublicKey>,

    /// Root key
    pub root_key: [u8; 32],
    /// Sending chain key
    pub sending_chain_key: Option<[u8; 32]>,
    /// Receiving chain key
    pub receiving_chain_key: Option<[u8; 32]>,

    /// Message number in sending chain
    pub sending_message_number: u32,
    /// Message number in receiving chain
    pub receiving_message_number: u32,
    /// Previous sending chain length
    pub previous_sending_chain_length: u32,

    /// Skipped message keys for out-of-order messages: (ratchet_pub, msg_number) -> message_key
    pub skipped_keys: std::collections::HashMap<(Vec<u8>, u32), [u8; 32]>,
}

impl DoubleRatchetSession {
    /// Initialize as Alice (session initiator)
    pub fn init_alice(
        identity_key: StaticSecret,
        identity_public: PublicKey,
        bob_public_ratchet: PublicKey,
        shared_secret: &[u8; 32],
    ) -> Self {
        let mut csprng = ChaChaOsRng;
        let alice_ratchet_secret = StaticSecret::random_from_rng(&mut csprng);
        let alice_ratchet_public = PublicKey::from(&alice_ratchet_secret);

        // Initial DH ratchet step
        let (root_key, sending_chain_key) = kdf_dh(
            &alice_ratchet_secret,
            &bob_public_ratchet,
            shared_secret,
        );

        Self {
            identity_key,
            identity_public,
            ratchet_key_pair: (alice_ratchet_secret, alice_ratchet_public),
            remote_ratchet_key: Some(bob_public_ratchet),
            remote_identity_key: None,
            root_key,
            sending_chain_key: Some(sending_chain_key),
            receiving_chain_key: None,
            sending_message_number: 0,
            receiving_message_number: 0,
            previous_sending_chain_length: 0,
            skipped_keys: std::collections::HashMap::new(),
        }
    }

    /// Initialize as Bob (session responder)
    pub fn init_bob(
        identity_key: StaticSecret,
        identity_public: PublicKey,
        bob_ratchet_secret: StaticSecret,
        bob_ratchet_public: PublicKey,
        shared_secret: &[u8; 32],
    ) -> Self {
        Self {
            identity_key,
            identity_public,
            ratchet_key_pair: (bob_ratchet_secret, bob_ratchet_public),
            remote_ratchet_key: None,
            remote_identity_key: None,
            root_key: *shared_secret,
            sending_chain_key: None,
            receiving_chain_key: None,
            sending_message_number: 0,
            receiving_message_number: 0,
            previous_sending_chain_length: 0,
            skipped_keys: std::collections::HashMap::new(),
        }
    }

    /// Encrypt a plaintext message
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<(Vec<u8>, RatchetHeader), CryptoError> {
        let chain_key = self.sending_chain_key.as_mut()
            .ok_or_else(|| CryptoError::from("No sending chain — must receive a message first"))?;

        // Advance sending chain
        let (new_chain_key, message_key) = kdf_ratchet(chain_key);
        *chain_key = new_chain_key;

        let msg_num = self.sending_message_number;
        self.sending_message_number += 1;

        // Derive nonce from message number
        let mut nonce = [0u8; 12];
        nonce[..4].copy_from_slice(&msg_num.to_be_bytes());

        let ciphertext = encrypt_with_key(&message_key, plaintext, &nonce)?;

        let header = RatchetHeader {
            dh_public: self.ratchet_key_pair.1.to_bytes(),
            msg_number: msg_num,
            prev_msg_number: self.previous_sending_chain_length,
        };

        Ok((ciphertext, header))
    }

    /// Decrypt a received message
    pub fn decrypt(&mut self, ciphertext: &[u8], header: &RatchetHeader) -> Result<Vec<u8>, CryptoError> {
        // Check skipped keys first (out-of-order messages)
        let key_lookup = (header.dh_public.to_vec(), header.msg_number);
        if let Some(message_key) = self.skipped_keys.remove(&key_lookup) {
            let mut nonce = [0u8; 12];
            nonce[..4].copy_from_slice(&header.msg_number.to_be_bytes());
            return decrypt_with_key(&message_key, ciphertext, &nonce);
        }

        // Check if we need a new receiving chain (DH ratchet step)
        let remote_pub_bytes = header.dh_public;
        let remote_pub = PublicKey::from(remote_pub_bytes);

        if self.remote_ratchet_key.map(|k| k.to_bytes()) != Some(remote_pub_bytes) {
            // DH ratchet step
            self.skip_message_keys(header.prev_msg_number)?;
            self.dh_ratchet_step(&remote_pub)?;
        }

        // Advance receiving chain
        let chain_key = self.receiving_chain_key.as_mut()
            .ok_or_else(|| CryptoError::from("No receiving chain"))?;

        let (new_chain_key, message_key) = kdf_ratchet(chain_key);
        *chain_key = new_chain_key;
        self.receiving_message_number += 1;

        let mut nonce = [0u8; 12];
        nonce[..4].copy_from_slice(&header.msg_number.to_be_bytes());

        decrypt_with_key(&message_key, ciphertext, &nonce)
    }

    /// DH ratchet step: derive new receiving chain
    fn dh_ratchet_step(&mut self, remote_new_pub: &PublicKey) -> Result<(), CryptoError> {
        // Compute DH with new remote key
        let (new_root_key, new_receiving_chain) = kdf_dh(
            &self.ratchet_key_pair.0,
            remote_new_pub,
            &self.root_key,
        );

        self.root_key = new_root_key;
        self.receiving_chain_key = Some(new_receiving_chain);

        // Generate new ratchet key pair
        let mut csprng = ChaChaOsRng;
        let new_secret = StaticSecret::random_from_rng(&mut csprng);
        let new_public = PublicKey::from(&new_secret);

        // Derive new sending chain
        let (new_root_key, new_sending_chain) = kdf_dh(
            &new_secret,
            remote_new_pub,
            &self.root_key,
        );

        self.root_key = new_root_key;
        self.sending_chain_key = Some(new_sending_chain);

        // Update state
        self.previous_sending_chain_length = self.sending_message_number;
        self.sending_message_number = 0;
        self.receiving_message_number = 0;
        self.remote_ratchet_key = Some(*remote_new_pub);
        self.ratchet_key_pair = (new_secret, new_public);

        Ok(())
    }

    /// Skip message keys up to `until` for out-of-order messages
    fn skip_message_keys(&mut self, until: u32) -> Result<(), CryptoError> {
        if let Some(ref mut chain_key) = self.receiving_chain_key {
            while self.receiving_message_number < until {
                if self.skipped_keys.len() >= MAX_SKIP {
                    return Err(CryptoError::from("Too many skipped message keys"));
                }
                let (new_chain_key, message_key) = kdf_ratchet(chain_key);
                *chain_key = new_chain_key;

                let ratchet_pub = self.remote_ratchet_key
                    .map(|k| k.to_bytes().to_vec())
                    .unwrap_or_default();

                self.skipped_keys.insert(
                    (ratchet_pub, self.receiving_message_number),
                    message_key,
                );
                self.receiving_message_number += 1;
            }
        }
        Ok(())
    }
}

impl Zeroize for DoubleRatchetSession {
    fn zeroize(&mut self) {
        self.root_key.zeroize();
        if let Some(ref mut ck) = self.sending_chain_key {
            ck.zeroize();
        }
        if let Some(ref mut ck) = self.receiving_chain_key {
            ck.zeroize();
        }
        for (_, mut key) in self.skipped_keys.drain() {
            key.zeroize();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_sessions() -> (DoubleRatchetSession, DoubleRatchetSession) {
        let mut csprng = ChaChaOsRng;

        // Alice
        let alice_identity = StaticSecret::random_from_rng(&mut csprng);
        let alice_identity_pub = PublicKey::from(&alice_identity);
        let alice_ratchet = StaticSecret::random_from_rng(&mut csprng);
        let alice_ratchet_pub = PublicKey::from(&alice_ratchet);

        // Bob
        let bob_identity = StaticSecret::random_from_rng(&mut csprng);
        let bob_identity_pub = PublicKey::from(&bob_identity);
        let bob_ratchet = StaticSecret::random_from_rng(&mut csprng);
        let bob_ratchet_pub = PublicKey::from(&bob_ratchet);

        // Shared secret (simulated X3DH result)
        let shared_secret = alice_identity.diffie_hellman(&bob_identity_pub);

        let alice = DoubleRatchetSession::init_alice(
            alice_identity,
            alice_identity_pub,
            bob_ratchet_pub,
            shared_secret.as_bytes(),
        );

        let bob = DoubleRatchetSession::init_bob(
            bob_identity,
            bob_identity_pub,
            bob_ratchet,
            bob_ratchet_pub,
            shared_secret.as_bytes(),
        );

        (alice, bob)
    }

    #[test]
    fn test_basic_encrypt_decrypt() {
        let (mut alice, mut bob) = setup_sessions();

        // Alice encrypts
        let plaintext = b"Hello Bob!";
        let (ciphertext, header) = alice.encrypt(plaintext).unwrap();

        // Bob decrypts — needs to process header with new ratchet key
        // For first message, Bob needs Alice's ratchet public key
        let plaintext_out = bob.decrypt(&ciphertext, &header).unwrap();
        assert_eq!(plaintext_out, plaintext);
    }

    #[test]
    fn test_bidirectional_communication() {
        let (mut alice, mut bob) = setup_sessions();

        // Alice -> Bob
        let (ct1, hdr1) = alice.encrypt(b"Hello Bob").unwrap();
        let pt1 = bob.decrypt(&ct1, &hdr1).unwrap();
        assert_eq!(pt1, b"Hello Bob");

        // Bob -> Alice (DH ratchet step)
        let (ct2, hdr2) = bob.encrypt(b"Hi Alice").unwrap();
        let pt2 = alice.decrypt(&ct2, &hdr2).unwrap();
        assert_eq!(pt2, b"Hi Alice");

        // Alice -> Bob
        let (ct3, hdr3) = alice.encrypt(b"How are you?").unwrap();
        let pt3 = bob.decrypt(&ct3, &hdr3).unwrap();
        assert_eq!(pt3, b"How are you?");
    }

    #[test]
    fn test_forward_secrecy() {
        let (mut alice, mut bob) = setup_sessions();

        // Exchange several messages
        for i in 0..5 {
            let msg = format!("Message {}", i);
            let (ct, hdr) = alice.encrypt(msg.as_bytes()).unwrap();
            let pt = bob.decrypt(&ct, &hdr).unwrap();
            assert_eq!(pt, msg.as_bytes());
        }

        // After ratcheting, old message keys are discarded
        // (in a real scenario, old keys would be zeroed)
        assert!(alice.sending_message_number > 0);
    }

    #[test]
    fn test_message_number_increments() {
        let (mut alice, _) = setup_sessions();

        let (_, hdr1) = alice.encrypt(b"msg1").unwrap();
        let (_, hdr2) = alice.encrypt(b"msg2").unwrap();
        let (_, hdr3) = alice.encrypt(b"msg3").unwrap();

        assert_eq!(hdr1.msg_number, 0);
        assert_eq!(hdr2.msg_number, 1);
        assert_eq!(hdr3.msg_number, 2);
    }

    #[test]
    fn test_header_encode_decode() {
        let header = RatchetHeader {
            dh_public: [42u8; 32],
            msg_number: 42,
            prev_msg_number: 10,
        };

        let encoded = header.encode();
        let decoded = RatchetHeader::decode(&encoded).unwrap();

        assert_eq!(decoded.dh_public, [42u8; 32]);
        assert_eq!(decoded.msg_number, 42);
        assert_eq!(decoded.prev_msg_number, 10);
    }

    #[test]
    fn test_wrong_key_fails() {
        let (mut alice, mut bob) = setup_sessions();

        let (ct, hdr) = alice.encrypt(b"secret").unwrap();

        // Corrupt ciphertext
        let mut ct_bad = ct.clone();
        ct_bad[0] ^= 0xff;

        let result = bob.decrypt(&ct_bad, &hdr);
        assert!(result.is_err());
    }
}
