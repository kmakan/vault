// Набор мутаций: rust-kitty
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).
//
// ПРИМЕЧАНИЕ. Мутации по размерам/суффиксам превью убраны: ThumbnailSize живёт
// в media.rs (набор rust-media), а не в kitty.rs. Мутация «идентификатор
// картинки не растёт» убрана как непроверяемая в юнит-тестах (escape-последова-
// тельность собирается целиком и требует поддержки протокола терминалом).

export default {
  id: 'rust-kitty',
  file: 'vault-client/src/vault/kitty.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "формат PNG отдаёт код неверного формата",
      pattern: "            ImageFormat::PNG => 100, // PNG is default",
      replacement: "            ImageFormat::PNG => 99, // PNG is default" },
    { name: "JPEG отдаёт код PNG (картинка не показывается)",
      pattern: "            ImageFormat::JPEG => 240,",
      replacement: "            ImageFormat::JPEG => 100," },
  ],
};
