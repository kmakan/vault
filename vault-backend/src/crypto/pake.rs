//! Simplified PAKE Password-Authenticated Key Exchange
//!
//! Provides password-based key derivation with salt.
//! Uses HKDF-SHA256 for all cryptographic operations.
//!
//! NOTE: This is a simplified implementation for demonstration.
//! For production, use a proper PAKE protocol like SPAKE2+ or OPAQUE.

use rand::Rng;
use hkdf::Hkdf;
use sha2::Sha256;

use super::CryptoError;

const SALT_SIZE: usize = 32;
const SHARED_SECRET_SIZE: usize = 32;

/// Server-side state after registration
#[derive(Debug, Clone)]
pub struct PakeState {
    pub password_verifier: Vec<u8>,
    pub salt: Vec<u8>,
}

/// Message exchanged during PAKE handshake
#[derive(Debug, Clone)]
pub struct PakeMessage {
    pub client_public: Vec<u8>,
    pub proof: Vec<u8>,
    pub salt: Vec<u8>,
}

/// Server-side response message
#[derive(Debug, Clone)]
pub struct PakeResponse {
    pub server_public: Vec<u8>,
    pub proof: Vec<u8>,
}

/// Generate random salt
fn generate_salt() -> Vec<u8> {
    let mut salt = vec![0u8; SALT_SIZE];
    rand::thread_rng().fill(&mut salt[..]);
    salt
}

/// Derive key material from password and salt using HKDF
fn derive_key(password: &str, salt: &[u8], info: &[u8]) -> Vec<u8> {
    let hk = Hkdf::<Sha256>::new(Some(salt), password.as_bytes());
    let mut output = vec![0u8; SHARED_SECRET_SIZE];
    hk.expand(info, &mut output)
        .expect("HKDF expansion should not fail");
    output
}

/// Server-side registration: creates password verifier
pub fn register(password: &str) -> PakeState {
    let salt = generate_salt();
    let verifier = derive_key(password, &salt, b"verifier");

    PakeState {
        password_verifier: verifier,
        salt,
    }
}

/// Client-side initiation of PAKE handshake
pub fn initiate(password: &str, salt: &[u8]) -> (Vec<u8>, PakeMessage) {
    let shared_secret = derive_key(password, salt, b"shared_secret");
    let client_public = derive_key(password, salt, b"client_public");
    let proof = derive_key(password, salt, b"client_proof");

    (shared_secret, PakeMessage {
        client_public,
        proof,
        salt: salt.to_vec(),
    })
}

/// Server-side response to client's PAKE message
///
/// NOTE: This simplified version uses the verifier to derive proofs.
/// In production, use proper SPAKE2+ or OPAQUE protocol.
pub fn respond(
    password_verifier: &[u8],
    client_msg: &PakeMessage,
) -> Result<(Vec<u8>, PakeResponse), CryptoError> {
    // Simplified: server derives its own proof from verifier
    let hk = Hkdf::<Sha256>::new(Some(&client_msg.salt), password_verifier);

    let mut server_proof = vec![0u8; SHARED_SECRET_SIZE];
    hk.expand(b"server_proof", &mut server_proof)
        .map_err(|e| CryptoError::from(format!("HKDF expansion failed: {}", e)))?;

    let mut server_public = vec![0u8; SHARED_SECRET_SIZE];
    hk.expand(b"server_public", &mut server_public)
        .map_err(|e| CryptoError::from(format!("HKDF expansion failed: {}", e)))?;

    Ok((password_verifier.to_vec(), PakeResponse {
        server_public,
        proof: server_proof,
    }))
}

/// Client-side verification of server's PAKE response
pub fn verify_server(
    password: &str,
    salt: &[u8],
    response: &PakeResponse,
) -> Result<Vec<u8>, CryptoError> {
    // Client derives expected server proof using password
    let expected_proof = derive_key(password, salt, b"server_proof");

    if expected_proof != response.proof {
        return Err(CryptoError::from("Invalid server proof"));
    }

    // Derive the actual shared secret
    let shared_secret = derive_key(password, salt, b"shared_secret");
    Ok(shared_secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_creates_verifier() {
        let state = register("mypassword");
        assert_eq!(state.password_verifier.len(), SHARED_SECRET_SIZE);
        assert_eq!(state.salt.len(), SALT_SIZE);
    }

    #[test]
    fn test_shared_secret_length() {
        let state = register("test");
        let (secret, _) = initiate("test", &state.salt);
        assert_eq!(secret.len(), SHARED_SECRET_SIZE);
    }

    #[test]
    fn test_unique_salts() {
        let state1 = register("password");
        let state2 = register("password");
        assert_ne!(state1.salt, state2.salt);
    }

    #[test]
    fn test_deterministic_with_same_salt() {
        let state = register("password");
        let (secret1, _) = initiate("password", &state.salt);
        let (secret2, _) = initiate("password", &state.salt);
        assert_eq!(secret1, secret2);
    }

    #[test]
    fn test_different_passwords_different_secrets() {
        let state = register("password1");
        let (secret1, _) = initiate("password1", &state.salt);
        let (secret2, _) = initiate("password2", &state.salt);
        assert_ne!(secret1, secret2);
    }

    #[test]
    fn test_server_response_format() {
        let state = register("mypassword");
        let (_, client_msg) = initiate("mypassword", &state.salt);
        let (verifier, response) = respond(&state.password_verifier, &client_msg).unwrap();

        assert_eq!(verifier.len(), SHARED_SECRET_SIZE);
        assert_eq!(response.server_public.len(), SHARED_SECRET_SIZE);
        assert_eq!(response.proof.len(), SHARED_SECRET_SIZE);
    }
}
