use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier, SECRET_KEY_LENGTH, PUBLIC_KEY_LENGTH};
use rand::rngs::OsRng;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use super::CryptoError;

pub struct Ed25519Signer {
    signing_key: SigningKey,
}

#[derive(Debug, Clone)]
pub struct Ed25519KeyPair {
    pub secret_key: Vec<u8>,
    pub public_key: Vec<u8>,
}

impl Ed25519Signer {
    pub fn generate_keypair() -> Ed25519KeyPair {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();

        Ed25519KeyPair {
            secret_key: signing_key.to_bytes().to_vec(),
            public_key: verifying_key.to_bytes().to_vec(),
        }
    }

    pub fn from_secret_key(secret_key: &[u8; SECRET_KEY_LENGTH]) -> Result<Self, CryptoError> {
        let signing_key = SigningKey::from_bytes(secret_key);
        Ok(Self { signing_key })
    }

    pub fn from_secret_key_base64(encoded: &str) -> Result<Self, CryptoError> {
        let bytes = BASE64.decode(encoded)
            .map_err(|e| CryptoError::from(format!("Invalid base64 secret key: {}", e)))?;
        
        if bytes.len() != SECRET_KEY_LENGTH {
            return Err(CryptoError::from(format!(
                "Invalid secret key length: expected {}, got {}",
                SECRET_KEY_LENGTH,
                bytes.len()
            )));
        }

        let mut key_bytes = [0u8; SECRET_KEY_LENGTH];
        key_bytes.copy_from_slice(&bytes);
        Self::from_secret_key(&key_bytes)
    }

    pub fn public_key_base64(&self) -> String {
        BASE64.encode(self.signing_key.verifying_key().to_bytes())
    }

    pub fn sign(&self, message: &[u8]) -> Signature {
        self.signing_key.sign(message)
    }

    pub fn sign_base64(&self, message: &[u8]) -> String {
        let signature = self.sign(message);
        BASE64.encode(signature.to_bytes())
    }
}

pub fn verify_signature(
    public_key_base64: &str,
    message: &[u8],
    signature_base64: &str,
) -> Result<bool, CryptoError> {
    let pk_bytes = BASE64.decode(public_key_base64)
        .map_err(|e| CryptoError::from(format!("Invalid base64 public key: {}", e)))?;
    
    if pk_bytes.len() != PUBLIC_KEY_LENGTH {
        return Err(CryptoError::from(format!(
            "Invalid public key length: expected {}, got {}",
            PUBLIC_KEY_LENGTH,
            pk_bytes.len()
        )));
    }

    let mut pk_array = [0u8; PUBLIC_KEY_LENGTH];
    pk_array.copy_from_slice(&pk_bytes);
    let verifying_key = VerifyingKey::from_bytes(&pk_array)
        .map_err(|e| CryptoError::from(format!("Invalid public key: {}", e)))?;

    let sig_bytes = BASE64.decode(signature_base64)
        .map_err(|e| CryptoError::from(format!("Invalid base64 signature: {}", e)))?;
    
    if sig_bytes.len() != 64 {
        return Err(CryptoError::from(format!(
            "Invalid signature length: expected 64, got {}",
            sig_bytes.len()
        )));
    }

    let mut sig_array = [0u8; 64];
    sig_array.copy_from_slice(&sig_bytes);
    let signature = Signature::from_bytes(&sig_array);

    Ok(verifying_key.verify(message, &signature).is_ok())
}

pub fn verify_signature_bytes(
    public_key: &[u8; PUBLIC_KEY_LENGTH],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<bool, CryptoError> {
    let verifying_key = VerifyingKey::from_bytes(public_key)
        .map_err(|e| CryptoError::from(format!("Invalid public key: {}", e)))?;
    
    let sig = Signature::from_bytes(signature);
    Ok(verifying_key.verify(message, &sig).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_and_sign() {
        let keypair = Ed25519Signer::generate_keypair();
        let signer = Ed25519Signer::from_secret_key_base64(
            &BASE64.encode(&keypair.secret_key)
        ).unwrap();

        let message = "Hello, World!";
        let signature = signer.sign_base64(message.as_bytes());
        
        assert!(verify_signature(&BASE64.encode(&keypair.public_key), message.as_bytes(), &signature).unwrap());
    }

    #[test]
    fn test_verify_wrong_message() {
        let keypair = Ed25519Signer::generate_keypair();
        let signer = Ed25519Signer::from_secret_key_base64(
            &BASE64.encode(&keypair.secret_key)
        ).unwrap();

        let message = "Hello, World!";
        let signature = signer.sign_base64(message.as_bytes());
        
        let wrong_message = "Wrong message";
        assert!(!verify_signature(&BASE64.encode(&keypair.public_key), wrong_message.as_bytes(), &signature).unwrap());
    }

    #[test]
    fn test_verify_wrong_key() {
        let keypair1 = Ed25519Signer::generate_keypair();
        let keypair2 = Ed25519Signer::generate_keypair();
        
        let signer = Ed25519Signer::from_secret_key_base64(
            &BASE64.encode(&keypair1.secret_key)
        ).unwrap();

        let message = "Hello, World!";
        let signature = signer.sign_base64(message.as_bytes());
        
        assert!(!verify_signature(&BASE64.encode(&keypair2.public_key), message.as_bytes(), &signature).unwrap());
    }

    #[test]
    fn test_invalid_base64_key() {
        assert!(Ed25519Signer::from_secret_key_base64("not-valid-base64!@#").is_err());
    }
}
