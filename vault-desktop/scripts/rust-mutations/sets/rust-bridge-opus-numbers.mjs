// Набор мутаций: rust-bridge-opus-numbers — проводка чисел Opus в мосту.
//
// ЗАЧЕМ (очередь моста `t_61bd5090`, пункт #14, `t_72d494c1`). Клок 48000 и
// «один канал» были вписаны в мосту ВТОРЫМ и ТРЕТЬИМ литералом: SDP в
// `media.rs`, энкодер/декодер и ресэмплеры в `audio.rs`, тот же набор в
// `audio/audio_android.rs`. Совпадающие числа — самая коварная форма дубля:
// правка одного места не даёт ни ошибки компиляции, ни ошибки в логе, а на
// телефоне это «собеседник говорит ускоренно» или тишина. С 26.10 числа живут
// в ядре (`call_media::OPUS_*`), а размеры выводятся из клока; здесь мерится
// именно ПРОВОДКА — откуда мост берёт число.
//
// ЧЕСТНАЯ ГРАНИЦА. Мутацию «литерал вместо константы» (`clock_rate: 48_000`)
// тестом не убить: значение то же, а различить источники можно только правкой
// самого ядра. Поэтому такие места закрыты НЕ тестом, а гейтом
// `gate:opus-numbers` — он запрещает протокольным литералам возвращаться в
// эти файлы. Всё, что меняет ЗНАЧЕНИЕ, ловится пробами
// `audio::encoder_params_come_from_the_core_clock`,
// `audio::frame_sizes_follow_the_clock` и
// `media::sdp_opus_params_and_the_audio_path_share_one_clock`.
//
// Call-site внутри `macro_rules!`/`cfg(android)` (направление ресэмплера,
// `set_sample_rate` у oboe) с хоста НЕ наблюдимы: их проверяет компиляция
// android-таргета и приёмка на телефоне. Их сюда не включаем — молчание
// дешевле ложной зелёной проверки.
export default {
  id: 'rust-bridge-opus-numbers',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/media.rs',
  smoke: 'cargo test -p vault-desktop --lib',
  timeoutMs: 900_000,
  mutations: [
    // ── SDP: чьё число пишет кодек ──
    { name: 'SDP отдаёт видео-клок (аудио-трек описывается 90 кГц)',
      pattern: '        clock_rate: OPUS_CLOCK_RATE,',
      replacement: '        clock_rate: VP8_CLOCK_RATE,' },
    { name: 'SDP объявляет стерео при моно-энкодере (приёмная сторона ждёт два канала)',
      pattern: '        channels: u16::from(OPUS_CHANNELS),',
      replacement: '        channels: 2,' },
    { name: 'SDP объявляет ноль каналов (кодирование звука не договорено вовсе)',
      pattern: '        channels: u16::from(OPUS_CHANNELS),',
      replacement: '        channels: 0,' },
    // ── аудио-путь: размеры, выведенные из ядрового клока ──
    { name: 'Opus-фрейм взят как кусок APM (20 мс кодируется 10 мс буфером)',
      file: 'vault-desktop/src-tauri/src/audio.rs',
      pattern: 'pub(crate) const FRAME_SAMPLES: usize = opus_samples_in(OPUS_FRAME_MS);',
      replacement: 'pub(crate) const FRAME_SAMPLES: usize = opus_samples_in(APM_FRAME_MS);' },
    { name: 'буфер декодера = один фрейм (120 мс речи не помещается, хвосты теряются)',
      file: 'vault-desktop/src-tauri/src/audio.rs',
      pattern: 'const DECODE_BUF: usize = opus_samples_in(DECODE_BUF_MS);',
      replacement: 'const DECODE_BUF: usize = opus_samples_in(OPUS_FRAME_MS);' },
    { name: 'длительность кадра не следует за размером (пишем 10 мс в 20 мс буфер)',
      file: 'vault-desktop/src-tauri/src/audio.rs',
      pattern: 'const FRAME_DURATION: Duration = Duration::from_millis(OPUS_FRAME_MS as u64);',
      replacement: 'const FRAME_DURATION: Duration = Duration::from_millis(APM_FRAME_MS as u64);' },
    // ── проводка в энкодер/декодер ──
    { name: 'частота энкодера вписана руками, а не взята из ядра (16 кГц при 48 кГц в SDP)',
      file: 'vault-desktop/src-tauri/src/audio.rs',
      pattern: '::try_from(OPUS_CLOCK_RATE as i32)',
      replacement: '::try_from(16_000_i32)' },
    { name: 'каналы декодера вписаны руками (стерео при моно-SDP)',
      file: 'vault-desktop/src-tauri/src/audio.rs',
      pattern: '::try_from(OPUS_CHANNELS as i32)',
      replacement: '::try_from(2_i32)' },
  ],
};
