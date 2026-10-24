/* Шим к системной libvpx: VP8-энкодер для видеозвонков на десктопе.
 *
 * Зачем C, а не FFI-описание структур в Rust: vpx_codec_enc_cfg_t — большая
 * версионнозависимая структура (в 1.17 менялась раскладка полей). Заголовки
 * libvpx на машине сборки дают точную раскладку; Rust видит только три
 * простые функции (init/frame/free) и не зависит от версии ABI.
 *
 * Вход: кадр I420 (YUV420p). Выход: сырой VP8-битстрим (без контейнера) —
 * ровно то, что принимает RTP-writer (`video::CameraFrame`).
 */
#include <stdlib.h>
#include <string.h>

#include <vpx/vpx_encoder.h>
#include <vpx/vp8cx.h> /* VP8E_SET_CPUUSED, VP8E_SET_STATIC_THRESHOLD */

typedef struct {
  vpx_codec_ctx_t codec;
  vpx_image_t img; /* обёртка вокруг входного I420-буфера (без копирования) */
  int inited;
  long frame_index; /* pts в единицах timebase (1 кадр = 1) */
} vault_enc_t;

/* 0 — успех; отрицательные коды — ошибки libvpx/аллокации. */
int vault_vp8_enc_init(vault_enc_t **out, int w, int h, int fps,
                       int bitrate_kbps, int keyint) {
  if (!out || w <= 0 || h <= 0 || fps <= 0) return -1;
  vault_enc_t *e = (vault_enc_t *)calloc(1, sizeof(*e));
  if (!e) return -2;

  vpx_codec_enc_cfg_t cfg;
  if (vpx_codec_enc_config_default(vpx_codec_vp8_cx(), &cfg, 0) != VPX_CODEC_OK) {
    free(e);
    return -3;
  }
  cfg.g_w = (unsigned int)w;
  cfg.g_h = (unsigned int)h;
  cfg.g_timebase.num = 1;
  cfg.g_timebase.den = fps;
  cfg.rc_target_bitrate = (unsigned int)bitrate_kbps;
  cfg.g_threads = 1;
  cfg.g_lag_in_frames = 0; /* realtime: кодек не копит кадры */
  cfg.rc_end_usage = VPX_CBR;
  cfg.kf_mode = VPX_KF_AUTO;
  cfg.kf_max_dist = (unsigned int)keyint;
  cfg.kf_min_dist = 0;

  if (vpx_codec_enc_init(&e->codec, vpx_codec_vp8_cx(), &cfg, 0) != VPX_CODEC_OK) {
    free(e);
    return -4;
  }
  /* cpu-used 8 + realtime deadline: задержка важнее качества (видеозвонок).
   * static-threshold 1 не даёт кодеку «съесть» почти статичный кадр камеры. */
  vpx_codec_control(&e->codec, VP8E_SET_CPUUSED, 8);
  vpx_codec_control(&e->codec, VP8E_SET_STATIC_THRESHOLD, 1);
  e->inited = 1;
  *out = e;
  return 0;
}

/* Закодировать один I420-кадр.
 * Возврат: 1 — есть пакет (*data/*size указывают на буфер libvpx, валиден до
 * следующего вызова encode — Rust копирует сразу), 0 — пакета нет,
 * отрицательное — ошибка кодека. */
int vault_vp8_enc_frame(vault_enc_t *e, const unsigned char *i420, int w,
                        int h, int force_key, const unsigned char **data,
                        size_t *size) {
  if (!e || !e->inited || !i420 || !data || !size) return -1;
  /* 5-й аргумент — ВЫРАВНИВАНИЕ строки, не сама строка: libvpx округляет
   * d_w вверх до него. Наивное значение «строка = w» (640) роняет wrap (NULL)
   * — 640 не степень двойки; 32 даёт ровно упакованные строки I420
   * (640/320), SIMD-выравнивание при этом сохраняется. */
  if (!vpx_img_wrap(&e->img, VPX_IMG_FMT_I420, (unsigned int)w, (unsigned int)h,
                    32, (unsigned char *)i420)) {
    return -2;
  }
  vpx_enc_frame_flags_t flags = force_key ? VPX_EFLAG_FORCE_KF : 0;
  if (vpx_codec_encode(&e->codec, &e->img, e->frame_index++, 1, flags,
                       VPX_DL_REALTIME) != VPX_CODEC_OK) {
    return -3;
  }
  vpx_codec_iter_t it = NULL;
  const vpx_codec_cx_pkt_t *pkt;
  while ((pkt = vpx_codec_get_cx_data(&e->codec, &it)) != NULL) {
    if (pkt->kind != VPX_CODEC_CX_FRAME_PKT) continue;
    *data = (const unsigned char *)pkt->data.frame.buf;
    *size = pkt->data.frame.sz;
    return 1;
  }
  return 0;
}

/* Последняя ошибка кодека строкой (для лога наверх). */
const char *vault_vp8_enc_error(vault_enc_t *e) {
  if (!e) return "no encoder";
  return vpx_codec_error(&e->codec);
}

void vault_vp8_enc_free(vault_enc_t *e) {
  if (!e) return;
  if (e->inited) vpx_codec_destroy(&e->codec);
  free(e);
}
