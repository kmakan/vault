// Набор мутаций: rust-status
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-status',
  file: 'vault-client/src/vault/status.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "статус «прочитано» парсится как «доставлено»",
      pattern: "            \"read\" => Some(MessageStatus::Read),",
      replacement: "            \"read\" => Some(MessageStatus::Delivered)," },
    { name: "проводная строка статуса меняется (JS не распознает)",
      pattern: "            MessageStatus::Read => \"read\",",
      replacement: "            MessageStatus::Read => \"Read\"," },
    { name: "неизвестный статус принимается как «доставлено»",
      pattern: "            _ => None,",
      replacement: "            _ => Some(MessageStatus::Delivered)," },
    { name: "цвет «прочитано» не отличается от «доставлено»",
      pattern: "            MessageStatus::Read => \"blue\",",
      replacement: "            MessageStatus::Read => \"white\"," },
    { name: "иконка «доставлено» не отличается от «отправлено»",
      pattern: "            MessageStatus::Delivered => \"✓✓\",",
      replacement: "            MessageStatus::Delivered => \"✓\"," },
    { name: "разбор статуса регистрозависим (READ не принимается)",
      pattern: "        match s.to_lowercase().as_str() {",
      replacement: "        match s {" },
  ],
};
