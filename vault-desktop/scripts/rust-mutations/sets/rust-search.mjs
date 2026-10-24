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
    // recent() раньше не был измерен: тест кормил 5 записей с ОДИНАКОВЫМ
    // timestamp (make_entry = Utc::now()) и проверял только длину — сортировку
    // можно было удалить целиком.
    { name: "«недавние» не сортируются (порядок выдаёт HashMap)",
      pattern: "        entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));\n        entries.into_iter().take(limit).collect()",
      replacement: "        entries.into_iter().take(limit).collect()" },
    { name: "«недавние» отсортированы от старых к новым",
      pattern: "        entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));\n        entries.into_iter().take(limit).collect()",
      replacement: "        entries.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));\n        entries.into_iter().take(limit).collect()" },
  ],
};
