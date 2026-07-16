use anyhow::Result;
use std::io::Read;
use std::path::PathBuf;

use crate::cli::output::Output;
use crate::crypto::{DecryptedContent, Decryptor};

pub fn run(
    decryptor: &Decryptor,
    file: Option<PathBuf>,
    stdin_mode: bool,
    output: Option<PathBuf>,
) -> Result<()> {
    let input = if let Some(path) = file {
        std::fs::read_to_string(&path)?
    } else if stdin_mode {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        buf
    } else {
        Output::error("Provide a file path or use --stdin");
        anyhow::bail!("No input");
    };

    match decryptor.decrypt(&input)? {
        DecryptedContent::Text(text) => {
            if let Some(out_path) = output {
                std::fs::write(&out_path, &text)?;
                Output::success(&format!("Written to {}", out_path.display()));
            } else {
                print!("{}", text);
            }
        }
        DecryptedContent::File {
            data,
            filename,
            content_type,
        } => {
            let out = output.unwrap_or_else(|| PathBuf::from(&filename));
            std::fs::write(&out, &data)?;
            Output::success(&format!(
                "File '{}' ({}) written to {}",
                filename,
                content_type,
                out.display()
            ));
        }
    }

    Ok(())
}
