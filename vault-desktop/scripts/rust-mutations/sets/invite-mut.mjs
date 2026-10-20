// Набор мутаций: rust-invite (инвайты)
// Цель: убедиться, что смоук cargo test -p vault-client --lib ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// ПРИМЕЧАНИЕ. Мутация «использованный инвайт снова валиден» УБРАНА как
// эквивалентная: mark_used выставляет status = Accepted, а валидность требует
// Pending, поэтому использованный инвайт невалиден и без проверки `used`.

export default {
  id: 'rust-invite',
  file: 'vault-client/src/vault/invite.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [

    { name: "истёкший инвайт считается валидным",
      pattern: "        self.status == InviteStatus::Pending && !self.used && now < self.expires_at",
      replacement: "        self.status == InviteStatus::Pending && !self.used" },
    { name: "использованный инвайт не отмечается (ссылку можно переиспользовать)",
      pattern: "        self.used = true;",
      replacement: "        self.used = false;" },
    { name: "ссылка ведёт на чужой домен (инвайт уходит мимо приложения)",
      pattern: "        format!(\"https://vault.chat/invite/{}\", base64url_encode(&json))",
      replacement: "        format!(\"https://evil.example/invite/{}\", base64url_encode(&json))" },
    { name: "из ссылки не читаются отправитель и ключ (получатель не знает, кто прислал)",
      pattern: "            return Some((payload.id, payload.sender, payload.key));",
      replacement: "            return Some((payload.id, String::new(), String::new()));" },
    { name: "ссылка не читается (приглашение не работает)",
      pattern: "        let payload_b64 = link.strip_prefix(\"https://vault.chat/invite/\")?;",
      replacement: "        let payload_b64 = link.strip_prefix(\"https://example.invalid/\")?;" },
  ],
};
