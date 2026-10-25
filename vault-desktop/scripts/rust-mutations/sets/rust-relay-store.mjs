// Набор мутаций: rust-relay-store — очереди конвертов в памяти релея.
//
// ЗАЧЕМ. Это единственный буфер между публикацией и поллингом клиента.
// Правила, которые здесь решаются, а не «так вышло»:
//   * дедуп по envelope id на сервере — письмо, доставленное двумя
//     почтовыми путями, не должно занимать два слота;
//   * направление вытеснения при переполнении: публикация теряет СТАРЕЙШИЙ
//     непрочитанный, возврат не-ack'нутых при обрыве WS — НОВЕЙШИЙ;
//   * TTL фильтруется на месте во всех точках чтения (drain, peek, len);
//   * peek — чтение без изъятия (у канала одна очередь на всех подписчиков)
//     и курсор `ts > since`, иначе каждый поллинг переотдаёт последний пост;
//   * «очереди нет» (None) и «очередь пуста» (Some[]) — разные ответы:
//     по None клиент идёт регистрироваться заново.
export default {
  id: 'rust-relay-store',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'lib',
  file: 'vault-relay/src/store.rs',
  smoke: 'cargo test -p vault-relay --lib store',
  timeoutMs: 600_000,
  mutations: [
    { name: 'дедуп по id снят (почтовый дубль занимает два слота)',
      pattern: '        if deque.iter().any(|e| e.id == env.id) {',
      replacement: '        if false {' },
    { name: 'публикация вытесняет новейший вместо старейшего',
      pattern: '            deque.pop_front();',
      replacement: '            deque.pop_back();' },
    { name: "возврат не-ack'нутых вытесняет старейший вместо новейшего",
      pattern: '            deque.pop_back();',
      replacement: '            deque.pop_front();' },
    { name: 'TTL не фильтруется в drain (просрочка уезжает клиенту)',
      pattern: '        deque.retain(|e| e.exp > now);\n        if deque.is_empty() {',
      replacement: '        if deque.is_empty() {' },
    { name: 'TTL не фильтруется в peek (канал отдаёт историю после срока)',
      pattern: '        deque.retain(|e| e.exp > now);\n        Some(deque.iter().filter(|e| e.ts > since).cloned().collect())',
      replacement: '        Some(deque.iter().filter(|e| e.ts > since).cloned().collect())' },
    { name: 'TTL не фильтруется в len (hello обещает то, чего нет)',
      pattern: '            .map(|d| d.iter().filter(|e| e.exp > now).count())',
      replacement: '            .map(|d| d.len())' },
    { name: 'курсор включает границу (последний пост переотдаётся каждый поллинг)',
      pattern: 'e.ts > since',
      replacement: 'e.ts >= since' },
    { name: 'пустая очередь отдаётся как None (клиент перерегистрирует очередь)',
      pattern: '            return Some(Vec::new());',
      replacement: '            return None;' },
    { name: 'peek изымает конверты (второй подписчик канала ничего не получает)',
      pattern: '        Some(deque.iter().filter(|e| e.ts > since).cloned().collect())',
      replacement: '        Some(deque.drain(..).filter(|e| e.ts > since).cloned().collect())' },
  ],
};
