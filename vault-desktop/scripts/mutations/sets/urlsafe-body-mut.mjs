// Набор мутаций: тело handshake-письма в JS-транспорте (src/api.js).
//
// ДО 28.10 здесь была третья копия правила ЧТЕНИЯ тела (folding, QP, алфавит,
// padding, UTF-8) и набор мерил её. Правило сведено в ядро (t_7d2c1bb1):
// чтение теперь — вызов моста через src/body-decode.js, и его мера — общая
// фикстура + rust-crypto / rust-bridge-crypto-mail. В api.js остались две
// вещи, которых в Rust нет и быть не может:
//   · запись тела (urlSafeB64) — продюсер формата, который читает ядро/CLI;
//   · проводка классификации: декодировать ли тело, брать ли из него kind,
//     класть ли parsed в элемент и ждать ли разбор перед кэшированием.
//
// Смоук urlsafe-body-smoke.mjs проверяет обе стороны: алфавит записи и то,
// что классификация реально пользуется результатом моста, а не сырой строкой.
//
// СОЗНАТЕЛЬНО НЕ ПРОВЕРЯЕТСЯ (эквивалентные мутанты, проверено 25.10):
//   * снятие `\s` при чтении — правило уехало в Rust, в JS такого кода нет;
//   * guard `(str || '')` в записи — единственный вход всегда строка (JSON.stringify).
export default {
  id: 'urlsafe-body',
  file: 'src/api.js',
  smoke: 'urlsafe-body-smoke.mjs',
  mutations: [
    // ── запись (продюсер тела: ядро/CLI ждут URL_SAFE_NO_PAD) ──
    { name: 'запись: `+` не переводится в `-` (письмо едет со standard-alphabet)',
      pattern: "    .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');",
      replacement: "    .replace(/\\//g, '_').replace(/=+$/, '');" },
    { name: 'запись: `/` не переводится в `_`',
      pattern: "    .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');",
      replacement: "    .replace(/\\+/g, '-').replace(/=+$/, '');" },
    { name: 'запись: хвостовой `=` не снимается (pad-символ в url-safe теле)',
      pattern: "    .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');",
      replacement: "    .replace(/\\+/g, '-').replace(/\\//g, '_');" },
    { name: 'запись: алфавит не переводится вовсе (текст письма читает только JS)',
      pattern: "    .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');",
      replacement: "    .replace(/=+$/, '');" },
    // ── проводка классификации (правило чтения — в ядре) ──
    { name: 'классификация разбирает СЫРОЕ тело, не спрашивая ядро (folding/url-safe теряются)',
      pattern: "      try { parsed = JSON.parse(await decodeUrlSafeText(body)); } catch (e) { parsed = null; }",
      replacement: "      try { parsed = JSON.parse(body); } catch (e) { parsed = null; }" },
    { name: 'результат моста не ожидается (JSON.parse от Promise → всегда null)',
      pattern: "      try { parsed = JSON.parse(await decodeUrlSafeText(body)); } catch (e) { parsed = null; }",
      replacement: "      try { parsed = JSON.parse(decodeUrlSafeText(body)); } catch (e) { parsed = null; }" },
    { name: 'тело не разбирается вовсе (kind только из темы письма)',
      pattern: "    let parsed = null;\n    if (body) {",
      replacement: "    let parsed = null;\n    if (false) {" },
    { name: 'отказ разбора JSON всплывает наружу (чужое письмо роняет весь скан)',
      pattern: "      try { parsed = JSON.parse(await decodeUrlSafeText(body)); } catch (e) { parsed = null; }",
      replacement: "      try { parsed = JSON.parse(await decodeUrlSafeText(body)); } catch (e) { throw e; }" },
    { name: 'kind из тела игнорируется (письмо без темы теряется)',
      pattern: "    let kind = parsed && parsed.kind || null;",
      replacement: "    let kind = null;" },
    { name: 'разобранные поля тела не кладутся в элемент (gid/name теряются)',
      pattern: "      parsed,\n      kind,",
      replacement: "      parsed: null,\n      kind," },
    { name: 'разбор не ожидается на месте вызова (в кэш уходит Promise)',
      pattern: "this._handshakeParsed.set(keyOf(m), await this._parseHandshakeItem(m, bodies[k] || ''));",
      replacement: "this._handshakeParsed.set(keyOf(m), this._parseHandshakeItem(m, bodies[k] || ''));" },
  ],
};
