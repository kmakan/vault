// Набор мутаций: url-safe base64 ТЕЛА handshake-письма в JS-транспорте
// (src/api.js, urlSafeB64 / urlSafeB64Decode) — третья копия правила чтения
// тела. Ядро и мост измерены (crypto.mjs +4, rust-bridge-crypto-mail 19/19),
// эта копия не измерялась вовсе — канбан t_7d2c1bb1, разбор 25.10.
//
// ПОКРЫТО РОВНО ТО, ЧТО ДЕЙСТВИТЕЛЬНО НАГРУЖЕНО (замер на Node и по WHATWG
// «forgiving-base64», которому следует и WebView телефона):
//   · перевод алфавита `-`/`_` → `+`/`/` — atob бросает InvalidCharacterError
//     на любом из этих байтов, поэтому снимается и целиком, и поодиночке;
//   · число доклеенных `=` — недобор atob терпит, перебор бросает; для этого
//     в смоуке есть фикстура с длиной % 4 == 3;
//   · UTF-8-раундtrip (`escape`/`decodeURIComponent`) — без него кириллица
//     превращается в mojibake, оставшись Валидным JSON, поэтому сверяется
//     ЗНАЧЕНИЕ имени группы, а не факт «не упало»;
//   · no-pad на записи — общий wire-контракт с CLI (URL_SAFE_NO_PAD).
//
// СОЗНАТЕЛЬНО НЕ ПРОВЕРЯЕТСЯ (эквивалентные мутанты, проверено 25.10):
//   * снятие `\s` (`clean = (str||'').replace(/\s+/g,'')`) — atob сам выкидывает
//     ASCII-пробелы: atob('QU\r\nJD') = 'ABC'. Строка оставлена как защита на
//     случай смены декодера, но мутаций по ней нет и быть не может;
//   * guard `(str || '')` в той же строке — единственный вызов с пустым телом
//     (`_parseHandshakeItem`) идёт под `if (body)`, так что null туда не приходит.
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
    // ── чтение ──
    { name: 'чтение: алфавит `-`/`_` не переведён (atob падает, инвайт теряется)',
      pattern: "  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/');",
      replacement: '  const b64 = clean;' },
    { name: 'чтение: `-` не переведён в `+`',
      pattern: "  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/');",
      replacement: "  const b64 = clean.replace(/_/g, '/');" },
    { name: 'чтение: `_` не переведён в `/`',
      pattern: "  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/');",
      replacement: "  const b64 = clean.replace(/-/g, '+');" },
    { name: 'чтение: padding доклеивается не по недостающему числу (перебор — atob падает)',
      pattern: "  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';",
      replacement: "  const pad = b64.length % 4 ? '='.repeat(b64.length % 4) : '';" },
    { name: 'чтение: UTF-8-раундtrip снят (кириллица имени группы — mojibake, JSON валиден)',
      pattern: '  return JSON.parse(decodeURIComponent(escape(atob(b64 + pad))));',
      replacement: '  return JSON.parse(atob(b64 + pad));' },
    { name: 'чтение: не наше тело бросает наружу (чужое письмо роняет весь скан)',
      pattern: '      try { parsed = urlSafeB64Decode(body); } catch (e) { parsed = null; }',
      replacement: '      try { parsed = urlSafeB64Decode(body); } catch (e) { throw e; }' },
  ],
};
