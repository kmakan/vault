// Набор мутаций: video-mut
// Цель: убедиться, что смоук video-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'video-mut',
  file: 'src/features/video.js',
  smoke: 'video-smoke.mjs',
  mutations: [
    { name: "переполнение очереди энкодера не дропает кадры (копится задержка)",
      pattern: "    if (!encoder || encoder.encodeQueueSize >= 2) {",
      replacement: "    if (!encoder) {" },
    { name: "VP8-кадр не декодируется (видео на телефоне молчит)",
      pattern: "  if (p.vp8) { decodeVp8Chunk(p.vp8); return; }",
      replacement: "  if (false) { decodeVp8Chunk(p.vp8); return; }" },
    { name: "RGBA-кадр не декодируется (видео на десктопе молчит)",
      pattern: "  if (p.rgba) decodeRgbaFrame(p.rgba, p.width, p.height);",
      replacement: "  void 0;" },
    { name: "кадр не закрывается (утечка кадров WebCodecs)",
      pattern: "    } finally {\n      frame.close();\n    }",
      replacement: "    } finally {\n      void 0;\n    }" },
    { name: "треки камеры не останавливаются (микрофон/камера остаются включены)",
      pattern: "      mediaStream.getTracks().forEach((t) => t.stop());",
      replacement: "      void 0;" },
    { name: "отсутствие VideoDecoder гасит видео на десктопе (RGBA-путь)",
      pattern: "  if (!('VideoDecoder' in window)) {",
      replacement: "  if (false) {" },
  ],
};
