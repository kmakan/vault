//! X3DH (Extended Triple Diffie-Hellman) Key Exchange
//!
//! Implements the Signal Protocol's X3DH for asynchronous key agreement.
//! Uses separate key types: Ed25519 for signing, X25519 for DH operations.

use ed25519_dalek::{SigningKey, Signer, Verifier, VerifyingKey, Signature};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use rand::rngs::OsRng;
use rand_core::RngCore;
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::CryptoError;

pub const X25519_PUB_KEY_SIZE: usize = 32;
pub const X25519_SECRET_KEY_SIZE: usize = 32;
pub const ED25519_SECRET_KEY_SIZE: usize = 32;
pub const ED25519_PUB_KEY_SIZE: usize = 32;
pub const SHARED_SECRET_SIZE: usize = 32;
pub const OPK_ID_SIZE: usize = 4;
pub const SPK_ID_SIZE: usize = 4;
pub const SIGNATURE_SIZE: usize = 64;

/// Generate X25519 keypair
fn generate_x25519_keypair() -> ([u8; X25519_SECRET_KEY_SIZE], [u8; X25519_PUB_KEY_SIZE]) {
    let mut secret_bytes = [0u8; X25519_SECRET_KEY_SIZE];
    OsRng.fill_bytes(&mut secret_bytes);
    let secret = StaticSecret::from(secret_bytes);
    let public = PublicKey::from(&secret);
    (secret_bytes, public.to_bytes())
}

/// Generate Ed25519 signing keypair
fn generate_ed25519_keypair() -> ([u8; ED25519_SECRET_KEY_SIZE], [u8; ED25519_PUB_KEY_SIZE]) {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    (signing_key.to_bytes(), verifying_key.to_bytes())
}

/// X3DH Identity Key Pair (long-term)
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct X3DHIdentityKeyPair {
    #[zeroize(skip)]
    pub ik_public: [u8; X25519_PUB_KEY_SIZE],
    pub ik_secret: [u8; X25519_SECRET_KEY_SIZE],
    // Ed25519 key for signing SPK
    #[zeroize(skip)]
    pub signing_public: [u8; ED25519_PUB_KEY_SIZE],
    pub signing_secret: [u8; ED25519_SECRET_KEY_SIZE],
}

/// X3DH Signed Pre-Key Pair
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct X3DHSignedPreKeyPair {
    pub spk_id: [u8; SPK_ID_SIZE],
    #[zeroize(skip)]
    pub spk_public: [u8; X25519_PUB_KEY_SIZE],
    pub spk_secret: [u8; X25519_SECRET_KEY_SIZE],
}

/// X3DH One-Time Pre-Key Pair
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct X3DHOneTimePreKeyPair {
    pub opk_id: [u8; OPK_ID_SIZE],
    #[zeroize(skip)]
    pub opk_public: [u8; X25519_PUB_KEY_SIZE],
    pub opk_secret: [u8; X25519_SECRET_KEY_SIZE],
}

/// Complete X3DH Key Bundle (public info shared with initiator)
#[derive(Debug, Clone)]
pub struct X3DHKeyBundle {
    pub ik_public: [u8; X25519_PUB_KEY_SIZE],
    pub signing_public: [u8; ED25519_PUB_KEY_SIZE],
    pub spk_id: [u8; SPK_ID_SIZE],
    pub spk_public: [u8; X25519_PUB_KEY_SIZE],
    pub spk_signature: [u8; SIGNATURE_SIZE],
    pub opk_id: [u8; OPK_ID_SIZE],
    pub opk_public: [u8; X25519_PUB_KEY_SIZE],
}

/// X3DH Initialization Message (sent by Alice to Bob)
#[derive(Debug, Clone)]
pub struct X3DHInitMessage {
    pub sender_ik: [u8; X25519_PUB_KEY_SIZE],
    pub sender_signing: [u8; ED25519_PUB_KEY_SIZE],
    pub ephemeral_public: [u8; X25519_PUB_KEY_SIZE],
    pub spk_id: [u8; SPK_ID_SIZE],
    pub opk_id: [u8; OPK_ID_SIZE],
    pub ad: Vec<u8>,
}

/// X3DH Session with shared secret
pub struct X3DHSession {
    pub shared_secret: [u8; SHARED_SECRET_SIZE],
    pub ad: Vec<u8>,
}

/// Sign message with Ed25519
fn sign_message(
    secret_key: &[u8; ED25519_SECRET_KEY_SIZE],
    message: &[u8],
) -> Result<[u8; SIGNATURE_SIZE], CryptoError> {
    let signing_key = SigningKey::from_bytes(secret_key);
    let signature = signing_key.sign(message);
    Ok(signature.to_bytes())
}

/// Verify Ed25519 signature
fn verify_ed25519_signature(
    public_key: &[u8; ED25519_PUB_KEY_SIZE],
    message: &[u8],
    signature: &[u8; SIGNATURE_SIZE],
) -> Result<bool, CryptoError> {
    let verifying_key = VerifyingKey::from_bytes(public_key)
        .map_err(|e| CryptoError::from(format!("Invalid Ed25519 public key: {}", e)))?;
    let sig = Signature::from_bytes(signature);
    Ok(verifying_key.verify(message, &sig).is_ok())
}

/// Generate complete X3DH key bundle
pub fn generate_x3dh_bundle() -> Result<(X3DHKeyBundle, X3DHIdentityKeyPair, X3DHSignedPreKeyPair, X3DHOneTimePreKeyPair), CryptoError> {
    let (ik_secret, ik_public) = generate_x25519_keypair();
    let (signing_secret, signing_public) = generate_ed25519_keypair();

    let mut spk_id_bytes = [0u8; SPK_ID_SIZE];
    OsRng.fill_bytes(&mut spk_id_bytes);
    let (spk_secret, spk_public) = generate_x25519_keypair();

    // Sign SPK with Ed25519 signing key
    let spk_signature = sign_message(&signing_secret, &spk_public)?;

    let mut opk_id_bytes = [0u8; OPK_ID_SIZE];
    OsRng.fill_bytes(&mut opk_id_bytes);
    let (opk_secret, opk_public) = generate_x25519_keypair();

    let identity = X3DHIdentityKeyPair {
        ik_public,
        ik_secret,
        signing_public,
        signing_secret,
    };

    let spk = X3DHSignedPreKeyPair {
        spk_id: spk_id_bytes,
        spk_public,
        spk_secret,
    };

    let opk = X3DHOneTimePreKeyPair {
        opk_id: opk_id_bytes,
        opk_public,
        opk_secret,
    };

    let bundle = X3DHKeyBundle {
        ik_public,
        signing_public,
        spk_id: spk_id_bytes,
        spk_public,
        spk_signature,
        opk_id: opk_id_bytes,
        opk_public,
    };

    Ok((bundle, identity, spk, opk))
}

/// Perform X3DH key exchange as initiator (Alice)
pub fn x3dh_initiate(
    alice_identity: &X3DHIdentityKeyPair,
    bob_bundle: &X3DHKeyBundle,
    ad: &[u8],
) -> Result<(X3DHSession, X3DHInitMessage), CryptoError> {
    // Verify SPK signature with Ed25519
    if !verify_ed25519_signature(&bob_bundle.signing_public, &bob_bundle.spk_public, &bob_bundle.spk_signature)? {
        return Err(CryptoError::from("SPK signature verification failed"));
    }

    // Parse keys
    let alice_ik = StaticSecret::from(alice_identity.ik_secret);
    let bob_ik = PublicKey::from(bob_bundle.ik_public);
    let bob_spk = PublicKey::from(bob_bundle.spk_public);
    let bob_opk = PublicKey::from(bob_bundle.opk_public);

    // Generate ephemeral key pair
    let mut ephemeral_secret_bytes = [0u8; X25519_SECRET_KEY_SIZE];
    OsRng.fill_bytes(&mut ephemeral_secret_bytes);
    let ephemeral_secret = StaticSecret::from(ephemeral_secret_bytes);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);

    // Compute 4 DH shared secrets
    let dh1 = alice_ik.diffie_hellman(&bob_spk);
    let dh2 = ephemeral_secret.diffie_hellman(&bob_ik);
    let dh3 = ephemeral_secret.diffie_hellman(&bob_spk);
    let dh4 = ephemeral_secret.diffie_hellman(&bob_opk);

    // Derive shared secret using HKDF-SHA256
    let mut ikm = Vec::with_capacity(X25519_PUB_KEY_SIZE * 4);
    ikm.extend_from_slice(dh1.as_bytes());
    ikm.extend_from_slice(dh2.as_bytes());
    ikm.extend_from_slice(dh3.as_bytes());
    ikm.extend_from_slice(dh4.as_bytes());

    let hk = Hkdf::<Sha256>::new(Some(ad), &ikm);
    let mut shared_secret = [0u8; SHARED_SECRET_SIZE];
    hk.expand(b"VaultX3DH", &mut shared_secret)
        .map_err(|e| CryptoError::from(format!("HKDF expansion failed: {}", e)))?;

    let init_message = X3DHInitMessage {
        sender_ik: alice_identity.ik_public,
        sender_signing: alice_identity.signing_public,
        ephemeral_public: ephemeral_public.to_bytes(),
        spk_id: bob_bundle.spk_id,
        opk_id: bob_bundle.opk_id,
        ad: ad.to_vec(),
    };

    Ok((
        X3DHSession {
            shared_secret,
            ad: ad.to_vec(),
        },
        init_message,
    ))
}

/// Perform X3DH key exchange as responder (Bob)
pub fn x3dh_respond(
    bob_identity: &X3DHIdentityKeyPair,
    bob_spk_secret: &[u8; X25519_SECRET_KEY_SIZE],
    bob_opk_secret: &[u8; X25519_SECRET_KEY_SIZE],
    init_message: &X3DHInitMessage,
) -> Result<X3DHSession, CryptoError> {
    let alice_ik = PublicKey::from(init_message.sender_ik);
    let ephemeral = PublicKey::from(init_message.ephemeral_public);
    let bob_ik = StaticSecret::from(bob_identity.ik_secret);
    let bob_spk = StaticSecret::from(*bob_spk_secret);
    let bob_opk = StaticSecret::from(*bob_opk_secret);

    // Compute 4 DH shared secrets (same as Alice)
    let dh1 = bob_spk.diffie_hellman(&alice_ik);
    let dh2 = bob_ik.diffie_hellman(&ephemeral);
    let dh3 = bob_spk.diffie_hellman(&ephemeral);
    let dh4 = bob_opk.diffie_hellman(&ephemeral);

    // Derive shared secret using HKDF-SHA256
    let mut ikm = Vec::with_capacity(X25519_PUB_KEY_SIZE * 4);
    ikm.extend_from_slice(dh1.as_bytes());
    ikm.extend_from_slice(dh2.as_bytes());
    ikm.extend_from_slice(dh3.as_bytes());
    ikm.extend_from_slice(dh4.as_bytes());

    let hk = Hkdf::<Sha256>::new(Some(&init_message.ad), &ikm);
    let mut shared_secret = [0u8; SHARED_SECRET_SIZE];
    hk.expand(b"VaultX3DH", &mut shared_secret)
        .map_err(|e| CryptoError::from(format!("HKDF expansion failed: {}", e)))?;

    Ok(X3DHSession {
        shared_secret,
        ad: init_message.ad.clone(),
    })
}

/// Serialize X3DHInitMessage
pub fn serialize_init_message(msg: &X3DHInitMessage) -> Vec<u8> {
    let mut buf = Vec::with_capacity(
        X25519_PUB_KEY_SIZE * 2 + ED25519_PUB_KEY_SIZE + SPK_ID_SIZE + OPK_ID_SIZE + 8 + msg.ad.len(),
    );
    buf.extend_from_slice(&msg.sender_ik);
    buf.extend_from_slice(&msg.sender_signing);
    buf.extend_from_slice(&msg.ephemeral_public);
    buf.extend_from_slice(&msg.spk_id);
    buf.extend_from_slice(&msg.opk_id);
    let ad_len = msg.ad.len() as u32;
    buf.extend_from_slice(&ad_len.to_le_bytes());
    buf.extend_from_slice(&msg.ad);
    buf
}

/// Deserialize X3DHInitMessage
pub fn deserialize_init_message(data: &[u8]) -> Result<X3DHInitMessage, CryptoError> {
    let min_len = X25519_PUB_KEY_SIZE + ED25519_PUB_KEY_SIZE + X25519_PUB_KEY_SIZE + SPK_ID_SIZE + OPK_ID_SIZE + 4;
    if data.len() < min_len {
        return Err(CryptoError::from("Init message too short"));
    }

    let mut offset = 0;
    let mut sender_ik = [0u8; X25519_PUB_KEY_SIZE];
    sender_ik.copy_from_slice(&data[offset..offset + X25519_PUB_KEY_SIZE]);
    offset += X25519_PUB_KEY_SIZE;

    let mut sender_signing = [0u8; ED25519_PUB_KEY_SIZE];
    sender_signing.copy_from_slice(&data[offset..offset + ED25519_PUB_KEY_SIZE]);
    offset += ED25519_PUB_KEY_SIZE;

    let mut ephemeral_public = [0u8; X25519_PUB_KEY_SIZE];
    ephemeral_public.copy_from_slice(&data[offset..offset + X25519_PUB_KEY_SIZE]);
    offset += X25519_PUB_KEY_SIZE;

    let mut spk_id = [0u8; SPK_ID_SIZE];
    spk_id.copy_from_slice(&data[offset..offset + SPK_ID_SIZE]);
    offset += SPK_ID_SIZE;

    let mut opk_id = [0u8; OPK_ID_SIZE];
    opk_id.copy_from_slice(&data[offset..offset + OPK_ID_SIZE]);
    offset += OPK_ID_SIZE;

    let ad_len = u32::from_le_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]) as usize;
    offset += 4;

    if data.len() < offset + ad_len {
        return Err(CryptoError::from("Init message truncated"));
    }

    let ad = data[offset..offset + ad_len].to_vec();

    Ok(X3DHInitMessage {
        sender_ik,
        sender_signing,
        ephemeral_public,
        spk_id,
        opk_id,
        ad,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_x3dh_bundle() {
        let (bundle, identity, spk, opk) = generate_x3dh_bundle().unwrap();
        assert_eq!(bundle.ik_public, identity.ik_public);
        assert_eq!(bundle.spk_public, spk.spk_public);
        assert_eq!(bundle.opk_public, opk.opk_public);
        assert_eq!(bundle.spk_id, spk.spk_id);
        assert_eq!(bundle.opk_id, opk.opk_id);
    }

    #[test]
    fn test_spk_signature() {
        let (bundle, _, _, _) = generate_x3dh_bundle().unwrap();
        assert!(verify_ed25519_signature(
            &bundle.signing_public,
            &bundle.spk_public,
            &bundle.spk_signature
        ).unwrap());
    }

    #[test]
    fn test_x3dh_full_exchange() {
        // Bob generates keys
        let (bob_bundle, bob_identity, bob_spk, bob_opk) = generate_x3dh_bundle().unwrap();

        // Alice initiates
        let alice_identity = {
            let (ik_secret, ik_public) = generate_x25519_keypair();
            let (signing_secret, signing_public) = generate_ed25519_keypair();
            X3DHIdentityKeyPair {
                ik_public,
                ik_secret,
                signing_public,
                signing_secret,
            }
        };

        let ad = b"associated_data";
        let (session_alice, init_msg) = x3dh_initiate(&alice_identity, &bob_bundle, ad).unwrap();

        // Bob responds
        let session_bob = x3dh_respond(&bob_identity, &bob_spk.spk_secret, &bob_opk.opk_secret, &init_msg).unwrap();

        // Both should derive the same shared secret
        assert_eq!(session_alice.shared_secret, session_bob.shared_secret);
        assert_eq!(session_alice.ad, session_bob.ad);
    }

    #[test]
    fn test_x3dh_different_keys_different_secrets() {
        let (bob_bundle1, bob_identity1, bob_spk1, bob_opk1) = generate_x3dh_bundle().unwrap();
        let (bob_bundle2, bob_identity2, bob_spk2, bob_opk2) = generate_x3dh_bundle().unwrap();

        let alice_identity = {
            let (ik_secret, ik_public) = generate_x25519_keypair();
            let (signing_secret, signing_public) = generate_ed25519_keypair();
            X3DHIdentityKeyPair {
                ik_public,
                ik_secret,
                signing_public,
                signing_secret,
            }
        };

        let ad = b"test";
        let (session1, _) = x3dh_initiate(&alice_identity, &bob_bundle1, ad).unwrap();
        let (session2, _) = x3dh_initiate(&alice_identity, &bob_bundle2, ad).unwrap();

        assert_ne!(session1.shared_secret, session2.shared_secret);
    }

    #[test]
    fn test_x3dh_wrong_opk_fails() {
        let (bob_bundle, bob_identity, bob_spk, _) = generate_x3dh_bundle().unwrap();
        let (_, _, _, wrong_opk) = generate_x3dh_bundle().unwrap();

        let alice_identity = {
            let (ik_secret, ik_public) = generate_x25519_keypair();
            let (signing_secret, signing_public) = generate_ed25519_keypair();
            X3DHIdentityKeyPair {
                ik_public,
                ik_secret,
                signing_public,
                signing_secret,
            }
        };

        let ad = b"test";
        let (session_alice, init_msg) = x3dh_initiate(&alice_identity, &bob_bundle, ad).unwrap();

        // Bob tries to respond with wrong OPK
        let session_bob = x3dh_respond(&bob_identity, &bob_spk.spk_secret, &wrong_opk.opk_secret, &init_msg).unwrap();

        // Different OPKs -> different shared secret
        assert_ne!(session_alice.shared_secret, session_bob.shared_secret);
    }

    #[test]
    fn test_x3dh_signature_verification() {
        let (bundle, _, _, _) = generate_x3dh_bundle().unwrap();

        // Tamper with signature
        let mut bad_bundle = bundle.clone();
        bad_bundle.spk_signature[0] ^= 0xff;

        assert!(!verify_ed25519_signature(
            &bundle.signing_public,
            &bad_bundle.spk_public,
            &bad_bundle.spk_signature
        ).unwrap());
    }

    #[test]
    fn test_x3dh_shared_secret_length() {
        let (bob_bundle, bob_identity, bob_spk, bob_opk) = generate_x3dh_bundle().unwrap();

        let alice_identity = {
            let (ik_secret, ik_public) = generate_x25519_keypair();
            let (signing_secret, signing_public) = generate_ed25519_keypair();
            X3DHIdentityKeyPair {
                ik_public,
                ik_secret,
                signing_public,
                signing_secret,
            }
        };

        let ad = b"test";
        let (session, init_msg) = x3dh_initiate(&alice_identity, &bob_bundle, ad).unwrap();
        assert_eq!(session.shared_secret.len(), SHARED_SECRET_SIZE);
    }

    #[test]
    fn test_x3dh_serialize_deserialize() {
        let alice_identity = {
            let (ik_secret, ik_public) = generate_x25519_keypair();
            let (signing_secret, signing_public) = generate_ed25519_keypair();
            X3DHIdentityKeyPair {
                ik_public,
                ik_secret,
                signing_public,
                signing_secret,
            }
        };

        let (bob_bundle, _, _, _) = generate_x3dh_bundle().unwrap();
        let ad = b"test associated data";
        let (_, init_msg) = x3dh_initiate(&alice_identity, &bob_bundle, ad).unwrap();

        let serialized = serialize_init_message(&init_msg);
        let deserialized = deserialize_init_message(&serialized).unwrap();

        assert_eq!(init_msg.sender_ik, deserialized.sender_ik);
        assert_eq!(init_msg.sender_signing, deserialized.sender_signing);
        assert_eq!(init_msg.ephemeral_public, deserialized.ephemeral_public);
        assert_eq!(init_msg.spk_id, deserialized.spk_id);
        assert_eq!(init_msg.opk_id, deserialized.opk_id);
        assert_eq!(init_msg.ad, deserialized.ad);
    }

    #[test]
    fn test_x3dh_wrong_signing_key_rejects() {
        let (bob_bundle, _, _, _) = generate_x3dh_bundle().unwrap();
        let (_, bad_identity) = {
            let (_, signing_public) = generate_ed25519_keypair();
            let (ik_secret, ik_public) = generate_x25519_keypair();
            let (signing_secret, _) = generate_ed25519_keypair();
            (ik_secret, X3DHIdentityKeyPair {
                ik_public,
                ik_secret,
                signing_public,
                signing_secret,
            })
        };

        // Verify with wrong signing key
        assert!(!verify_ed25519_signature(
            &bad_identity.signing_public,
            &bob_bundle.spk_public,
            &bob_bundle.spk_signature
        ).unwrap());
    }
}
