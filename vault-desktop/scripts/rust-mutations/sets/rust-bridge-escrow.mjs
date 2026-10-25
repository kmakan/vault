// Набор мутаций: rust-bridge-escrow — «это наше эскроу-письмо».
//
// ЗАЧЕМ. Recovery-письмо ищется по содержимому (тема пустая, X-Vault-* нет —
// стелс), поэтому вопрос «наше это письмо или чужой JSON» решает только этот
// предикат: метка `"key_escrow"`, версия конверта = 1, тип = key_escrow.
// Ошибка стоит не косметики: принятый чужой payload — это попытка распаковать
// не то, а отвергнутый свой — «12 слов не помогают».
//
// ВТОРАЯ ПРИЧИНА. До 24.10 этот предикат был продублирован в смоуке
// (`key_escrow_smoke.rs`), и копия ОТСТАЛА от оригинала: в проде тело чистится
// от CR/LF, потому что отправка рвёт длинное письмо жёсткими переносами внутри
// JSON, а в копии такой чистки не было. То есть устойчивость к порванному
// письму не проверялась ничем, а смоук выглядел зелёным. Копию убрали, смоук
// зовёт настоящую команду; мутации ниже ловятся уже ею.
export default {
  id: 'rust-bridge-escrow',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  file: 'vault-desktop/src-tauri/src/lib.rs',
  smoke: 'cargo test -p vault-desktop --lib',
  kind: 'lib',
  timeoutMs: 1_200_000,
  mutations: [
    { name: 'переносы строк не вырезаются (порванное при отправке письмо не читается)',
      pattern: "    let cleaned: String = body.chars().filter(|c| *c != '\\n' && *c != '\\r').collect();",
      replacement: '    let cleaned: String = body.to_string();' },
    { name: 'версия конверта не сверяется (чужой формат принимается за эскроу)',
      pattern: '            if v.get("vault").and_then(|x| x.as_i64()) == Some(1)\n                && v.get("type").and_then(|x| x.as_str()) == Some("key_escrow")',
      replacement: '            if true\n                && v.get("type").and_then(|x| x.as_str()) == Some("key_escrow")' },
    { name: 'тип письма не сверяется (profile-письмо принимается за эскроу)',
      pattern: '            if v.get("vault").and_then(|x| x.as_i64()) == Some(1)\n                && v.get("type").and_then(|x| x.as_str()) == Some("key_escrow")',
      replacement: '            if v.get("vault").and_then(|x| x.as_i64()) == Some(1)\n                && true' },
  ],
};
