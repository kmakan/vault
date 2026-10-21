// Набор мутаций: rust-media
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-media',
  file: 'vault-client/src/vault/media.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "mime-тип картинки меняется (браузер не покажет вложение)",
      pattern: "            Self::Jpeg => \"image/jpeg\",",
      replacement: "            Self::Jpeg => \"image/jpg-unknown\"," },
    { name: "неизвестный формат считается картинкой",
      pattern: "        !matches!(self, Self::Unknown(_))",
      replacement: "        true" },
    { name: "размер превью Large меняется (галерея показывает кадр не того размера)",
      pattern: "            Self::Large => (512, 512),",
      replacement: "            Self::Large => (256, 256)," },
    { name: "суффикс файла превью для Medium меняется (файлы Medium и Large слипаются)",
      pattern: "            Self::Medium => \"m\",",
      replacement: "            Self::Medium => \"l\"," },
  ],
};
