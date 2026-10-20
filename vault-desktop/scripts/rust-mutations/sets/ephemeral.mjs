// Набор мутаций: правило времени жизни сообщения (Rust-ядро).
//
// Это первое правило, перенесённое в Rust по ADR-005 (W4), и на нём стоит
// проверять сам метод: если «время жизни сообщения» — протокол, то его
// тесты должны ловить поломку правила, а не просто иметь зелёную галочку.
export default {
  id: 'ephemeral',
  file: 'vault-client/src/vault/ephemeral.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'TTL = 0 больше не значит «не исчезает» (сообщение гаснет сразу)',
      pattern: '    if ttl_secs <= 0 {\n        return 0;\n    }',
      replacement: '    if ttl_secs < 0 {\n        return 0;\n    }' },
    { name: 'миллисекунды посчитаны как секунды (TTL в 1000 раз меньше)',
      pattern: '    base_ms.saturating_add(ttl_secs.saturating_mul(1000))',
      replacement: '    base_ms.saturating_add(ttl_secs.saturating_mul(1))' },
    { name: 'переполнение не насыщается (огромный TTL переливается в минус)',
      pattern: 'ttl_secs.saturating_mul(1000)',
      replacement: 'ttl_secs * 1000' },
    { name: 'истёкшим считается только строгое превышение (ровно в срок ещё живо)',
      pattern: '    expires_at > 0 && now_ms >= expires_at',
      replacement: '    expires_at > 0 && now_ms > expires_at' },
    { name: 'сообщение без срока (expires_at = 0) считается истёкшим',
      pattern: '    expires_at > 0 && now_ms >= expires_at',
      replacement: '    now_ms >= expires_at' },
    { name: 'остаток не обрезается в ноль (у истёкшего — отрицательный)',
      pattern: '    (expires_at - now_ms).max(0)',
      replacement: '    expires_at - now_ms' },
  ],
};
