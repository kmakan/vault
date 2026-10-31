// Набор мутаций: rust-bridge-letter-keys
//
// ЗАЧЕМ. 31.10 приложение теряло письма там же, где терял их бот: ключ
// собеседника брался одной строкой `peerKeys[from]`. Починка вынесла решение
// «каким ключом открывать» в ядро (`vault_core::identity`, меры `rust-identity`
// и `rust-listen-decrypt`), но мосту остались два дела, каждое из которых —
// отдельный класс молчаливой потери письма:
//   1) КНИГА: два места записи (`contacts.json` + `keys/peer_keys.json`),
//      отказ одного источника не отменяет второй;
//   2) ФОРМА КОНВЕРТА: `PQ1:<kemct>|<sender_ek>|<wire>` против legacy —
//      раньше битый PQ-конверт проваливался в legacy и отдавал ошибку base64,
//      а отсутствие PQ-семени было неотличимо от «ключа нет».
// Порядок, дедуп и потолок здесь НЕ мутируются — они в ядре и уже измерены
// там; сюда бьём только по проводке «что куда передаётся и как расшифровывается».
//
// ИМЕНА ПРОБ (смоук `letter_keys` обязан собрать все девять):
//   a_letter_opens_with_the_key_stored_under_an_alias
//   a_hint_alone_opens_the_letter_and_stays_the_normal_path
//   a_stale_hint_does_not_stop_the_book
//   the_senders_own_key_is_tried_first_and_wins_the_dedup
//   a_pq_letter_also_opens_with_the_alias_key
//   a_pq_letter_without_seed_is_a_named_refusal
//   a_malformed_pq_envelope_is_not_reported_as_bad_base64
//   an_empty_book_is_a_different_refusal_than_a_wrong_key
//   the_book_is_the_union_of_contacts_and_stored_keys

export default {
  id: 'rust-bridge-letter-keys',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/letter_keys.rs',
  smoke: 'cargo test -p vault-desktop --lib letter_keys',
  timeoutMs: 900_000,
  mutations: [
    // ── форма конверта ──
    { name: 'гибридный конверт не опознаётся и падает в legacy (PQ-защита исчезает незаметно)',
      pattern: '    let Some(rest) = trimmed.strip_prefix("PQ1:") else {',
      replacement: '    let Some(rest) = trimmed.strip_prefix("PQ2:") else {' },
    { name: 'битый PQ-конверт не отвергается именной ошибкой (выход за индекс вместо MalformedPq)',
      pattern: '    if parts.len() != 3 {',
      replacement: '    if parts.len() > 3 {' },
    { name: 'отсутствие PQ-семени перестаёт быть отдельным отказом (диагноз съезжает на «ключа нет»)',
      pattern: '    if matches!(wire, Wire::Pq { .. }) && my_pq_seed.is_none() {',
      replacement: '    if false {' },
    { name: 'в гибрид ключи отправителя и получателя переставлены (PQ-письмо не открывается никогда)',
      pattern: '            crypto_pq::hybrid_decrypt_vault(wire, private_key, key.public_key, seed, kemct)',
      replacement: '            crypto_pq::hybrid_decrypt_vault(wire, key.public_key, private_key, seed, kemct)' },
    { name: 'legacy-ветка выбрасывает ключ пира (расшифровка «как себе» — письмо контакта не читается)',
      pattern: '        Wire::Legacy => crypto::decrypt_vault_cmd(body, private_key, Some(key.public_key))',
      replacement: '        Wire::Legacy => crypto::decrypt_vault_cmd(body, private_key, None)' },

    // ── книга из двух мест записи ──
    { name: 'peer_keys.json выпадает из книги (контакты Desktop невидимы)',
      pattern: '    book.extend(stored.iter().map(|k| OwnedPeerKey {',
      replacement: '    book.extend(stored.iter().take(0).map(|k| OwnedPeerKey {' },
    { name: 'contacts.json выпадает из книги (ключи онбординга бота невидимы)',
      pattern: '    let mut book: Vec<OwnedPeerKey> = contacts\n        .all()\n        .iter()',
      replacement: '    let mut book: Vec<OwnedPeerKey> = contacts\n        .all()\n        .iter()\n        .take(0)' },
    { name: 'книга не добавляется к подсказке (Дефект 31.10: решает только строка From)',
      pattern: '    candidates.extend(book.iter().cloned());',
      replacement: '    candidates.extend(book.iter().take(0).cloned());' },

    // ── подсказка вызывающего ──
    { name: 'подсказка не пробывается (обычный путь без книги требует диск)',
      // Инверсия гварда: непустой ключ отбрасывается, пустой проталкивается —
      // ядро пустую подсказку отсекает, значит письмо нечем открыть.
      pattern: '        if !h.public_key.trim().is_empty() {',
      replacement: '        if h.public_key.trim().is_empty() {' },

    // ── итог для вызывающего ──
    { name: 'адрес победившего ключа теряется — второй ящик не виден, ренейм не запускается',
      pattern: '            Some(key) => Ok(OpenedLetter {\n                plain: value,\n                key_address,',
      replacement: '            Some(key) => Ok(OpenedLetter {\n                plain: value,\n                key_address: String::new(),' },
  ],
};
