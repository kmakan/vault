// Набор мутаций: geo-mut
// Цель: убедиться, что смоук geo-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'geo-mut',
  file: 'src/geo.js',
  smoke: 'geo-smoke.mjs',
  mutations: [
    { name: "координаты печатаются с двумя знаками",
      pattern: "  return `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;",
      replacement: "  return `${Number(lat).toFixed(2)}, ${Number(lon).toFixed(2)}`;" },
    { name: "зум карты меняется",
      pattern: "export const GEO_ZOOM = 17;",
      replacement: "export const GEO_ZOOM = 10;" },
    { name: "таймаут геолокации меняется",
      pattern: "export const GEO_TIMEOUT_MS = 8000;",
      replacement: "export const GEO_TIMEOUT_MS = 30000;" },
    { name: "срок жизни позиции меняется",
      pattern: "export const GEO_MAX_AGE_MS = 300000;",
      replacement: "export const GEO_MAX_AGE_MS = 30000;" },
    { name: "в метке карты нет координаты",
      pattern: "    + '&mlon=' + lon + '#map=' + GEO_ZOOM + '/' + lat + '/' + lon;",
      replacement: "    + '&mlon=' + lon + '#map=' + GEO_ZOOM;" },
  ],
};
