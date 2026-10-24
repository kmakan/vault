//! VP8-энкодер десктопа через системную libvpx (ADR-005).
//!
//! Зачем Rust, а не WebCodecs в WebView: WebKitGTK не декодирует MediaStream
//! в `<video>` (readyState остаётся 0), поэтому `new VideoFrame(videoEl)` в JS
//! бросает InvalidStateError и камера молча не даёт ни одного кадра — ровно
//! так звонок «с десктопа» уходил без видео (`RTP writer finished frames=0`).
//!
//! Раскладку `vpx_codec_enc_cfg_t` здесь не описываем: она меняется между
//! версиями libvpx. Тонкий C-шим (`src/vp8_enc_shim.c`, собирается в build.rs)
//! включает системные заголовки vpx и отдаёт три простые функции.
//!
//! Вход — I420 (YUV420p) 640x480 от V4L2-захвата, выход — сырой VP8-битстрим
//! для `video::CameraFrame` (E2E-шифр и RTP-пакетизация — в writer'е звонка).

use std::ffi::{c_char, c_int, c_void, CStr};

extern "C" {
    fn vault_vp8_enc_init(
        out: *mut *mut c_void,
        w: c_int,
        h: c_int,
        fps: c_int,
        bitrate_kbps: c_int,
        keyint: c_int,
    ) -> c_int;
    fn vault_vp8_enc_frame(
        enc: *mut c_void,
        i420: *const u8,
        w: c_int,
        h: c_int,
        force_key: c_int,
        data: *mut *const u8,
        size: *mut usize,
    ) -> c_int;
    fn vault_vp8_enc_error(enc: *mut c_void) -> *const c_char;
    fn vault_vp8_enc_free(enc: *mut c_void);
}

/// Живой энкодер одного размера кадра. Не `Sync`: libvpx-контекст
/// используется из одного потока захвата.
pub struct Vp8Encoder {
    ctx: *mut c_void,
    width: u32,
    height: u32,
}

impl Vp8Encoder {
    /// `bitrate_kbps` — целевой CBR-битрейт; `keyint` — максимальный интервал
    /// между ключевыми кадрами в кадрах (NACK/PLI не реализованы, ключевой
    /// кадр раз в 5 с восстанавливает картинку при потерях).
    pub fn new(
        width: u32,
        height: u32,
        fps: u32,
        bitrate_kbps: u32,
        keyint: u32,
    ) -> Result<Self, String> {
        let mut ctx: *mut c_void = std::ptr::null_mut();
        let rc = unsafe {
            vault_vp8_enc_init(
                &mut ctx,
                width as c_int,
                height as c_int,
                fps as c_int,
                bitrate_kbps as c_int,
                keyint as c_int,
            )
        };
        if rc != 0 || ctx.is_null() {
            // Контекст не создан — освобождать нечего (шим сам чистит).
            return Err(format!("libvpx encoder init failed (code {rc})"));
        }
        Ok(Self {
            ctx,
            width,
            height,
        })
    }

    /// Закодировать один I420-кадр. `Ok(None)` — кодек не отдал пакет
    /// (realtime-режим с lag 0 так почти не бывает, но это не ошибка).
    pub fn encode_i420(&mut self, i420: &[u8], force_key: bool) -> Result<Option<Vec<u8>>, String> {
        let need = self.expected_i420_len();
        if i420.len() < need {
            return Err(format!(
                "i420 buffer too small: {} < {}",
                i420.len(),
                need
            ));
        }
        let mut data: *const u8 = std::ptr::null();
        let mut size: usize = 0;
        let rc = unsafe {
            vault_vp8_enc_frame(
                self.ctx,
                i420.as_ptr(),
                self.width as c_int,
                self.height as c_int,
                if force_key { 1 } else { 0 },
                &mut data,
                &mut size,
            )
        };
        match rc {
            1 if !data.is_null() && size > 0 => {
                // Буфер libvpx валиден до следующего encode — копируем сразу.
                Ok(Some(unsafe { std::slice::from_raw_parts(data, size) }.to_vec()))
            }
            0 => Ok(None),
            _ => Err(self.last_error(rc)),
        }
    }

    fn expected_i420_len(&self) -> usize {
        let y = (self.width * self.height) as usize;
        y + y / 2
    }

    fn last_error(&self, code: i32) -> String {
        let msg = unsafe {
            let p = vault_vp8_enc_error(self.ctx);
            if p.is_null() {
                None
            } else {
                Some(CStr::from_ptr(p).to_string_lossy().into_owned())
            }
        };
        format!(
            "libvpx encode failed (code {code}): {}",
            msg.unwrap_or_else(|| "unknown".into())
        )
    }
}

impl Drop for Vp8Encoder {
    fn drop(&mut self) {
        if !self.ctx.is_null() {
            unsafe { vault_vp8_enc_free(self.ctx) };
            self.ctx = std::ptr::null_mut();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Vp8Encoder;

    /// Энкодер обязан выдавать непустые VP8-кадры на одноцветном кадре, и
    /// первый кадр — ключевой (иначе декодер собеседника не начнёт поток).
    #[test]
    fn encodes_i420_frames() {
        let (w, h) = (640u32, 480u32);
        let mut enc = Vp8Encoder::new(w, h, 30, 500, 150).expect("encoder");
        let y = vec![128u8; (w * h) as usize];
        let mut frame = y.clone();
        frame.extend(vec![128u8; (w * h / 4) as usize * 2]);
        let key = enc.encode_i420(&frame, true).expect("encode key");
        assert!(key.is_some(), "первый (ключевой) кадр обязан быть пакетом");
        assert!(!key.unwrap().is_empty());
        let delta = enc.encode_i420(&frame, false).expect("encode delta");
        if let Some(d) = delta {
            assert!(!d.is_empty());
        }
    }

    /// Мелкий буфер — явная ошибка, а не чтение за границей (unsafe-путь).
    #[test]
    fn rejects_short_buffer() {
        let mut enc = Vp8Encoder::new(64, 48, 30, 500, 150).expect("encoder");
        let err = enc.encode_i420(&[0u8; 16], false).expect_err("short i420");
        assert!(err.contains("too small"), "{err}");
    }
}
