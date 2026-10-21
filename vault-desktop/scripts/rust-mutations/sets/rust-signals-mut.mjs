// Набор мутаций: rust-signals-mut
// Цель: убедиться, что смоук cargo test -p vault-client --lib ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-signals-mut',
  file: 'vault-client/src/vault/signals.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "метка data-письма не проверяется (чужой JSON принимается за data)",
      pattern: "    if obj.get(\"vault_dod_data\").and_then(|v| v.as_i64()) != Some(1) {",
      replacement: "    if false {" },
    { name: "непустое тело не требуется (получатель подставит пустой файл)",
      pattern: "    if data.is_empty() {\n        return None;\n    }",
      replacement: "    if false {\n        return None;\n    }" },
    { name: "ссылка на вложение теряется (файл подставится не к тому вложению)",
      pattern: "    let reference = obj\n        .get(\"ref\")\n        .and_then(|v| v.as_str())\n        .unwrap_or(\"\")\n        .to_string();",
      replacement: "    let reference = String::new();" },
    { name: "тело data-письма теряется",
      pattern: "    let data = obj.get(\"data\").and_then(|v| v.as_str()).unwrap_or(\"\").to_string();",
      replacement: "    let data = String::new();" },
    { name: "маркер формата data-письмы уезжает (получатель не признает письмо своим)",
      pattern: "        vault_dod_data: 1,",
      replacement: "        vault_dod_data: 2," },
    { name: "в собранном data-письме ссылка пустая (файл придёт не к тому вложению)",
      pattern: "        reference,",
      replacement: "        reference: \"\"," },
  ],
};
