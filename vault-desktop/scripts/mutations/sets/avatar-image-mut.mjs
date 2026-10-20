// Набор мутаций: avatar-image-mut
// Цель: убедиться, что смоук avatar-image-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'avatar-image-mut',
  file: 'src/avatar-image.js',
  smoke: 'avatar-image-smoke.mjs',
  mutations: [
    { name: "предел размера аватара завышен вдвое",
      pattern: "export const AVATAR_MAX_BYTES = 500 * 1024;",
      replacement: "export const AVATAR_MAX_BYTES = 1024 * 1024;" },
    { name: "ровно предельный файл проходит (проверка не строгая на «больше»)",
      pattern: "  return size > AVATAR_MAX_BYTES;",
      replacement: "  return size >= AVATAR_MAX_BYTES;" },
    { name: "аватар профиля становится JPEG",
      pattern: "export const PROFILE_AVATAR = { size: 256, mime: 'image/png' };",
      replacement: "export const PROFILE_AVATAR = { size: 256, mime: 'image/jpeg' };" },
    { name: "размер аватара группы меняется",
      pattern: "export const GROUP_AVATAR = { size: 128, mime: 'image/jpeg', quality: 0.8 };",
      replacement: "export const GROUP_AVATAR = { size: 256, mime: 'image/jpeg', quality: 0.8 };" },
    { name: "обрезка не центрируется",
      pattern: "  return { sx: (srcW - size) / 2, sy: (srcH - size) / 2, size, dstSize };",
      replacement: "  return { sx: 0, sy: 0, size, dstSize };" },
    { name: "битая картинка не отклоняет промес (зависание)",
      pattern: "      img.onerror = () => reject(new Error('image decode failed'));",
      replacement: "      img.onerror = () => {};" },
  ],
};
