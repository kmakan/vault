//! VP8-декодер через системную libvpx (FFI).
//! Заменяет JS VideoDecoder — WebKitGTK не рисует VideoFrame в canvas.
//! На входе: VP8-битстрим (кадр). На выходе: RGBA-буфер для canvas.

use std::ffi::{c_char, c_int, c_uint, c_void};
use std::ptr;

// libc::malloc/free — для vpx_codec_ctx (libvpx выделяет внутри себя,
// но контекст создаём мы; libc есть в дереве через cpal/webrtc).
// Не `extern crate libc` — это требует rustc_private (unstable).
// Используем std::alloc (stable) для выделения памяти.

// FFI к libvpx (минимальный набор для VP8-декодера)
#[repr(C)]
struct vpx_codec_ctx {
    // Opaque — libvpx выделяет внутри. Не [u8; 0] — это zero-size UB.
    // Достаточно для vpx_codec_ctx_t (~512 байт на 1.17).
    _private: [u8; 1024],
}

// vpx_codec_dec_cfg_t: в системном /usr/include/vpx/vpx_decoder.h
// ровно ТРИ поля (threads, w, h). Поле allow_lowbitdepth — из старой
// модификации; оставленное лишнее поле ломало бы ABI-совместимость cfg.
#[repr(C)]
struct vpx_codec_dec_cfg {
    threads: c_uint,
    w: c_uint,
    h: c_uint,
}

#[repr(C)]
struct vpx_image {
    fmt: c_uint,
    cs: c_uint,
    range: c_uint,
    w: c_uint,
    h: c_uint,
    bit_depth: c_uint,
    d_w: c_uint,
    d_h: c_uint,
    r_w: c_uint,
    r_h: c_uint,
    x_chroma_shift: c_uint,
    y_chroma_shift: c_uint,
    planes: [*mut u8; 4],
    stride: [c_int; 4],
    bps: c_int,
    user_priv: *mut c_void,
    img_data: *mut u8,
    img_data_owner: c_int,
    self_allocd: c_int,
    fb_priv: *mut c_void,
}

#[link(name = "vpx")]
extern "C" {
    fn vpx_codec_vp8_dx() -> *const c_void;
    fn vpx_codec_dec_init_ver(
        ctx: *mut vpx_codec_ctx,
        iface: *const c_void,
        cfg: *const vpx_codec_dec_cfg,
        flags: c_uint,
        ver: c_int,
    ) -> c_int;
    fn vpx_codec_decode(
        ctx: *mut vpx_codec_ctx,
        data: *const u8,
        data_sz: c_uint,
        user_priv: *mut c_void,
        deadline: c_int,
    ) -> c_int;
    fn vpx_codec_get_frame(ctx: *mut vpx_codec_ctx, iter: *mut *mut c_void) -> *mut vpx_image;
    fn vpx_codec_destroy(ctx: *mut vpx_codec_ctx) -> c_int;
    // Возвращает `const char*` — c_char (i8 на x86), а НЕ u8:
    // иначе CStr::from_ptr получает *const i8 и падает компиляция.
    fn vpx_codec_error(ctx: *mut vpx_codec_ctx) -> *const i8;
}

const VPX_DECODER_ABI_VERSION: c_int = 12;

/// VP8-декодер (один на звонок).
pub struct Vp8Decoder {
    ctx: *mut vpx_codec_ctx,
}

impl Vp8Decoder {
    pub fn new() -> Result<Self, String> {
        let cfg = vpx_codec_dec_cfg {
            threads: 4,
            w: 0,
            h: 0,
        };
        let ctx = unsafe {
            std::alloc::alloc_zeroed(std::alloc::Layout::new::<vpx_codec_ctx>())
                as *mut vpx_codec_ctx
        };
        if ctx.is_null() {
            return Err("alloc failed".to_string());
        }
        let rc = unsafe {
            vpx_codec_dec_init_ver(ctx, vpx_codec_vp8_dx(), &cfg, 0, VPX_DECODER_ABI_VERSION)
        };
        if rc != 0 {
            let err = unsafe { std::ffi::CStr::from_ptr(vpx_codec_error(ctx)) }
                .to_string_lossy()
                .into_owned();
            unsafe {
                std::alloc::dealloc(ctx as *mut u8, std::alloc::Layout::new::<vpx_codec_ctx>())
            };
            return Err(format!("vpx_codec_dec_init: {err}"));
        }
        Ok(Self { ctx })
    }

    /// Декодировать один VP8-кадр → RGBA-буфер (для canvas).
    /// Возвращает (rgba_data, width, height) или None (нет кадра).
    pub fn decode(&mut self, data: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
        let rc = unsafe {
            vpx_codec_decode(
                self.ctx,
                data.as_ptr(),
                data.len() as c_uint,
                ptr::null_mut(),
                0,
            )
        };
        if rc != 0 {
            let err = unsafe { std::ffi::CStr::from_ptr(vpx_codec_error(self.ctx)) }
                .to_string_lossy()
                .into_owned();
            eprintln!("[vpx] decode error: {err}");
            return None;
        }

        let mut iter: *mut c_void = ptr::null_mut();
        let img = unsafe { vpx_codec_get_frame(self.ctx, &mut iter) };
        if img.is_null() {
            return None;
        }

        let img = unsafe { &*img };
        let w = img.d_w;
        let h = img.d_h;
        let y_plane = img.planes[0];
        let u_plane = img.planes[1];
        let v_plane = img.planes[2];
        let y_stride = img.stride[0] as usize;
        let u_stride = img.stride[1] as usize;
        let v_stride = img.stride[2] as usize;

        // YUV → RGBA (BT.601, упрощённо — для canvas достаточно)
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for j in 0..h as usize {
            for i in 0..w as usize {
                let y = unsafe { *y_plane.add(j * y_stride + i) } as i32;
                let u = unsafe { *u_plane.add((j / 2) * u_stride + (i / 2)) } as i32 - 128;
                let v = unsafe { *v_plane.add((j / 2) * v_stride + (i / 2)) } as i32 - 128;

                let r = (y + ((v * 359) >> 8)).clamp(0, 255) as u8;
                let g = (y - ((u * 88) >> 8) - ((v * 183) >> 8)).clamp(0, 255) as u8;
                let b = (y + ((u * 454) >> 8)).clamp(0, 255) as u8;

                rgba.push(r);
                rgba.push(g);
                rgba.push(b);
                rgba.push(255);
            }
        }

        Some((rgba, w, h))
    }
}

impl Drop for Vp8Decoder {
    fn drop(&mut self) {
        unsafe {
            vpx_codec_destroy(self.ctx);
            std::alloc::dealloc(
                self.ctx as *mut u8,
                std::alloc::Layout::new::<vpx_codec_ctx>(),
            );
        }
    }
}

unsafe impl Send for Vp8Decoder {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Настоящий VP8 key-frame 16x16 (серый Y=128), сгенерирован vpxenc 1.17:
    ///   vpxenc --codec=vp8 -w 16 -h 16 --ivf gray.ivf  →  кадр без IVF-обёртки.
    /// Ручные байты из спецификации декодер libvpx отвергает
    /// («Bitstream not supported by this decoder») — нужен настоящий энтропийный код.
    const VP8_KEYFRAME_16X16: &[u8] = &[
        0xb0, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00, 0x00, 0x47, 0x08, 0x85, 0x85,
        0x88, 0x85, 0x84, 0x88, 0x02, 0x02, 0x00, 0x0e, 0xb2, 0x7f, 0xf2, 0xfa, 0xb9, 0x08, 0x55,
        0x00, 0xfe, 0xf8, 0xa8, 0xe7, 0xfe, 0xaf, 0xff, 0xff, 0x4d, 0xfb, 0xe1, 0x8a, 0x1f, 0xc2,
        0xac, 0xe8, 0x4b, 0x4a, 0xfc, 0x28, 0x3c, 0xee, 0x26, 0x32, 0x3a, 0xa6, 0x9d, 0xa2, 0xa2,
        0xb7, 0x3f, 0xb8, 0xe8, 0x0f, 0x79, 0xb3, 0x43, 0xb4, 0xe6, 0xfa, 0x1f, 0x7b, 0x7a, 0xe9,
        0x26, 0xf0, 0x97, 0xf3, 0x74, 0x30, 0x58, 0x00,
    ];

    #[test]
    fn decodes_vp8_keyframe_to_rgba() {
        let Ok(mut dec) = Vp8Decoder::new() else {
            // libvpx нет в системе — тест не применим, но это не падение.
            eprintln!("[vp8] libvpx unavailable, skipping");
            return;
        };
        let out = dec.decode(VP8_KEYFRAME_16X16);
        let (rgba, w, h) = out.expect("valid key-frame must decode");
        assert_eq!((w, h), (16, 16), "unexpected frame size");
        assert_eq!(rgba.len(), 16 * 16 * 4, "RGBA buffer must be w*h*4");
        // Пиксели серые: R≈G≈B, альфа 255.
        assert_eq!(rgba[3], 255, "alpha must be opaque");
        assert!(
            rgba[0].abs_diff(rgba[1]) <= 2 && rgba[1].abs_diff(rgba[2]) <= 2,
            "grey input must yield near-grey RGB: {:?}",
            &rgba[..3]
        );
    }

    #[test]
    fn rejects_garbage_without_panic() {
        let Ok(mut dec) = Vp8Decoder::new() else {
            return;
        };
        // Мусор не должен паниковать (особенно при abort-профиле) —
        // максимум None.
        assert!(dec.decode(&[0xde, 0xad, 0xbe, 0xef]).is_none());
    }

    #[test]
    fn context_is_not_zero_sized() {
        // Регрессия: zero-size аллокация ctx = heap corruption.
        assert!(
            std::mem::size_of::<vpx_codec_ctx>() >= 512,
            "ctx buffer must cover real vpx_codec_ctx_t"
        );
    }

    #[test]
    fn dec_cfg_matches_c_abi() {
        // В C vpx_codec_dec_cfg_t — ровно 3 × unsigned int = 12 байт.
        assert_eq!(std::mem::size_of::<vpx_codec_dec_cfg>(), 12);
    }
}
