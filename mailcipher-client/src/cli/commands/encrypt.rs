use anyhow::Result;
use std::io::Read;
use std::path::PathBuf;

use crate::crypto::Encryptor;
use crate::cli::output::Output;

pub fn run(encryptor: &Encryptor, file: Option<PathBuf>, stdin_mode: bool) -> Result<()> {
    let encrypted = if let Some(path) = file {
        encryptor.encrypt_file(&path)?
    } else if stdin_mode {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        encryptor.encrypt_text(&buf)
    } else {
        Output::error("Provide a file path or use --stdin");
        anyhow::bail!("No input");
    };

    println!("{}", encrypted);
    Ok(())
}
