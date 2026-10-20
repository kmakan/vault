// Набор мутаций: channels-tokens-mut
//
// ПРИМЕЧАНИЕ. Две мутации («ключ не обрезается» и «в Rust уходит необрезанный
// ключ») были УБРАНЫ как эквивалентные: Rust-сторона (channels.rs:
// channel_tokens_cmd) тоже обрезает ключ, поэтому поведение не меняется —
// ловить их = врать о покрытии. Обрезка в JS остаётся как «свойства кэша»:
// без неё кэш раздваивается по пробелам.
// Цель: убедиться, что смоук channels-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'channels-tokens-mut',
  file: 'src/channels-tokens.js',
  smoke: 'channels-smoke.mjs',
  mutations: [
    { name: "кэш токенов не работает (токен пересчитывается и может смениться)",
      pattern: "  const hit = _chanTokCache.get(key);",
      replacement: "  const hit = null;" },
    { name: "токены не замораживаются (вызывающий может подменить адрес очереди)",
      pattern: "  const out = Object.freeze({ read, write });",
      replacement: "  const out = { read, write };" },
  ],
};
