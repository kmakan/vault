// Sfera UI: реестр языков. Добавить язык = положить файл в ./ и добавить
// одну строку в BUILTIN. Ключи проверяются тестом tests/ui/locales-themes.mjs:
// пропущенный ключ не должен молча падать к английскому в проде.
import ru from './ru.js';
import en from './en.js';
import zh from './zh.js';

export const BUILTIN = Object.freeze({ ru, en, zh });
export const FALLBACK = 'en';

export function availableLocales() {
  return Object.keys(BUILTIN).map((code) => ({
    code,
    name: BUILTIN[code].language_name,
  }));
}

export function hasLocale(code) {
  return Object.prototype.hasOwnProperty.call(BUILTIN, code);
}

export function translate(code, key, params) {
  const dict = BUILTIN[code] || BUILTIN[FALLBACK];
  let text = dict[key] ?? BUILTIN[FALLBACK][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

export function missingKeys(code, reference = FALLBACK) {
  const dict = BUILTIN[code];
  if (!dict) return Object.keys(BUILTIN[reference]);
  return Object.keys(BUILTIN[reference]).filter((k) => !(k in dict));
}
