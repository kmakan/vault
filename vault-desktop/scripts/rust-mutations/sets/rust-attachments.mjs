// Набор мутаций: rust-attachments
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-attachments',
  file: 'vault-client/src/vault/attachments.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "вложение не добавляется к сообщению (файл пропадает)",
      pattern: "            .or_default()\n            .push(meta);",
      replacement: "            .or_default();" },
    { name: "отметка «скачано» не ставится (файл качается снова)",
      pattern: "                att.mark_downloaded(path);",
      replacement: "                att.downloaded = false;" },
    { name: "размер вложений не считается (лимит не работает)",
      pattern: "            .map(|a| a.size)\n            .sum()",
      replacement: "            .map(|a| 0u64)\n            .sum()" },
    { name: "конверт файла принимается без заголовка Type: file",
      pattern: "        if type_str != \"file\" {\n            anyhow::bail!(\"Expected Type: file, got: {}\", type_str);\n        }",
      replacement: "        if false {\n            anyhow::bail!(\"Expected Type: file, got: {}\", type_str);\n        }" },
    { name: "конверт без версии принимается",
      pattern: "        let _version = version.context(\"Missing Version in header\")?;",
      replacement: "        let _version = version.unwrap_or_else(|| \"0\".to_string());" },
    { name: "разделитель заголовка и тела не обязателен",
      pattern: "        let sep_pos = block\n            .find(\"---\")\n            .context(\"Missing header/body separator\")?;",
      replacement: "        let sep_pos = block.find(\"---\").unwrap_or(0);" },
    { name: "признак конверта файла не проверяет Type: file",
      pattern: "            && input.contains(\"Type: file\")",
      replacement: "            && true" },
  ],
};
