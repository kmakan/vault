// Набор мутаций: rust-call-media — числа протокола медиазвонка.
//
// ЗАЧЕМ. Таймауты ICE, payload-типы кодеков и параметры VP8-клока — это
// протокол соединения. Ошибка выглядит как «звонок не соединяется» или
// «видео дёргается», без внятной ошибки в логе; обе стороны нашего
// приложения должны считать эти числа одинаково.
export default {
  id: 'rust-call-media',
  file: 'vault-client/src/vault/call_media.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'ICE-сбор ждёт 15с (ответ не успевает до таймера гудка)',
      pattern: 'pub const ICE_GATHER_TIMEOUT_SECS: u64 = 4;',
      replacement: 'pub const ICE_GATHER_TIMEOUT_SECS: u64 = 15;' },
    { name: 'disconnected→failed через 5с (доставка answer/offer по почте не переживается)',
      pattern: 'pub const ICE_DISCONNECTED_SECS: u64 = 60;',
      replacement: 'pub const ICE_DISCONNECTED_SECS: u64 = 5;' },
    { name: 'failed-окно 60с вместо 120 (почта не успевает, звонок рвётся)',
      pattern: 'pub const ICE_FAILED_SECS: u64 = 120;',
      replacement: 'pub const ICE_FAILED_SECS: u64 = 60;' },
    { name: 'payload type Opus сдвинут (вторая сторона не разберёт звук)',
      pattern: 'pub const OPUS_PAYLOAD_TYPE: u8 = 120;',
      replacement: 'pub const OPUS_PAYLOAD_TYPE: u8 = 111;' },
    { name: 'VP8 получил PT аудио (видео и звук сливаются в один поток)',
      pattern: 'pub const VP8_PAYLOAD_TYPE: u8 = 96;',
      replacement: 'pub const VP8_PAYLOAD_TYPE: u8 = 120;' },
    { name: 'частота клока VP8 изменена (таймстампы RTP разъезжаются)',
      pattern: 'pub const VP8_CLOCK_RATE: u32 = 90_000;',
      replacement: 'pub const VP8_CLOCK_RATE: u32 = 48_000;' },
    { name: 'кадры 60 fps (инкремент таймстампа не совпадает с захватом)',
      pattern: 'pub const VIDEO_FPS: u32 = 30;',
      replacement: 'pub const VIDEO_FPS: u32 = 60;' },
    { name: 'длительность кадра округлена вниз (2999 тиков вместо 3000)',
      pattern: '    (1_000_000_000u64 * FRAME_TS_INCREMENT as u64).div_ceil(VP8_CLOCK_RATE as u64)',
      replacement: '    (1_000_000_000u64 * FRAME_TS_INCREMENT as u64) / (VP8_CLOCK_RATE as u64)' },
    { name: 'состояние звонка перевёрнуто (ростер показывает Idle при активном звонке)',
      pattern: '    if known_call {',
      replacement: '    if !known_call {' },
  ],
};
