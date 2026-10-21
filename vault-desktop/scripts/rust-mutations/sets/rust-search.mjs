// Набор мутаций: rust-search
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-search',
  file: 'vault-client/src/vault/search.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "тема не ищется (забытые письма не находятся)",
      pattern: "                if entry.subject.to_lowercase().contains(&q) {\n                    score += 1.0;",
      replacement: "                if false {\n                    score += 1.0;" },
    { name: "поиск по телу отключён",
      pattern: "                if entry.body_preview.to_lowercase().contains(&q) {",
      replacement: "                if false {" },
    { name: "релевантность не ограничена единицей (порядок результатов едет)",
      pattern: "                        relevance: score.min(1.0),",
      replacement: "                        relevance: score," },
    { name: "сортировка по релевантности отключена (важное уходит вниз)",
      pattern: "            b.relevance\n                .partial_cmp(&a.relevance)\n                .unwrap_or(std::cmp::Ordering::Equal)\n                .then_with(|| b.entry.timestamp.cmp(&a.entry.timestamp))",
      replacement: "            b.entry.timestamp.cmp(&a.entry.timestamp)" },
    { name: "поиск в папке игнорирует папку (найдено лишнее)",
      pattern: "            .filter(|r| r.entry.folder_id.as_deref() == Some(folder_id))",
      replacement: "            .filter(|_| true)" },
  ],
};
