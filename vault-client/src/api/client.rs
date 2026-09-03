use serde::{Deserialize, Serialize};

/// Client configuration (serverless era).
///
/// Historically this struct also carried `base_url` / `access_token` /
/// `refresh_token` for the REST backend (localhost:9443). The backend was
/// the fields actually used by the CLI remain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub server: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            email: None,
            server: None,
        }
    }
}
