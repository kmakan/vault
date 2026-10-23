//! Разбор WAV-ассетов (рингтоны) — ADR-005 §W4, `t_502b6c90`.
//!
//! Зачем в ядре: заголовок WAV — формат, а не деталь плеера. Ошибка в разборе
//! (порядок полей, выравнивание чанков, битность) даёт «звонок без звука» или
//! шум — и это невозможно увидеть в UI. Плеер (cpal) остаётся в мосту:
//! ядро отдаёт сэмплы и частоту, мост их проигрывает.
//!
//! Поддерживается PCM 16-bit mono/stereo — ровно то, что генерируют наши
//! ассеты. Всё остальное — явная ошибка, а не «как-нибудь проиграем».

/// Разобрать WAV. Возвращает (сэмплы f32 в диапазоне [-1, 1], частота).
pub fn parse_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32), String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut pos = 12usize;
    let (mut rate, mut bits, mut channels) = (0u32, 0u16, 0u16);
    let mut data: Option<&[u8]> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;
        // Размер чанка приходит с провода/из файла: переполнение и выход за
        // границы — ошибка формата, а не паника индексации.
        let end = match body.checked_add(size) {
            Some(e) if e <= bytes.len() => e,
            _ => break,
        };
        if id == b"fmt " {
            if size < 16 {
                return Err("short fmt chunk".into());
            }
            channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().unwrap());
            rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().unwrap());
            bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().unwrap());
        } else if id == b"data" {
            data = Some(&bytes[body..end]);
        }
        // Чанки выравниваются по 2 байта (RIFF): нечётный размер + паддинг.
        pos = end + (size & 1);
    }
    let data = data.ok_or("no data chunk")?;
    if bits != 16 {
        return Err(format!("unsupported bit depth {bits}"));
    }
    let mut samples: Vec<f32> = Vec::with_capacity(data.len() / 2);
    for chunk in data.chunks_exact(2) {
        let v = i16::from_le_bytes([chunk[0], chunk[1]]);
        samples.push(v as f32 / 32768.0);
    }
    if channels == 2 {
        let mut mono = Vec::with_capacity(samples.len() / 2);
        for pair in samples.chunks_exact(2) {
            mono.push((pair[0] + pair[1]) * 0.5);
        }
        samples = mono;
    } else if channels != 1 {
        return Err(format!("unsupported channel count {channels}"));
    }
    if rate == 0 {
        return Err("bad sample rate".into());
    }
    Ok((samples, rate))
}

/// Сколько миллисекунд играть одноразовый звук: длина в секундах + 250 мс
/// запаса, чтобы сэмпл успел доиграть до остановки потока.
pub fn sound_duration_ms(pcm_len: usize, out_rate: u64) -> u64 {
    pcm_len as u64 * 1000 / out_rate.max(1) + 250
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(payload: &[u8], rate: u32, channels: u16, bits: u16, fmt_size: u32) -> Vec<u8> {
        let data_len = payload.len() as u32;
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + fmt_size + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&fmt_size.to_le_bytes());
        let mut fmt = vec![0u8; fmt_size as usize];
        fmt[0..2].copy_from_slice(&1u16.to_le_bytes()); // PCM
        fmt[2..4].copy_from_slice(&channels.to_le_bytes());
        fmt[4..8].copy_from_slice(&rate.to_le_bytes());
        fmt[14..16].copy_from_slice(&bits.to_le_bytes());
        v.extend_from_slice(&fmt);
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn parses_mono_16bit() {
        let payload: Vec<u8> = [0i16, 16384, -16384, 32767]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let (s, rate) = parse_wav(&wav(&payload, 44_100, 1, 16, 16)).expect("parsed");
        assert_eq!(rate, 44_100);
        assert_eq!(s.len(), 4);
        assert!((s[1] - 0.5).abs() < 1e-6);
        assert!((s[2] + 0.5).abs() < 1e-6);
    }

    #[test]
    fn mixes_stereo_to_mono() {
        let payload: Vec<u8> = [32767i16, 0, 0, 32767]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let (s, _) = parse_wav(&wav(&payload, 48_000, 2, 16, 16)).expect("parsed");
        assert_eq!(s.len(), 2);
        assert!((s[0] - 0.5).abs() < 1e-3);
        assert!((s[1] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn skips_odd_sized_chunk_with_padding() {
        let payload: Vec<u8> = [0i16, 0].iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"LIST");
        v.extend_from_slice(&3u32.to_le_bytes());
        v.extend_from_slice(b"abc");
        v.push(0); // паддинг до чётной границы
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        let mut fmt = vec![0u8; 16];
        fmt[2..4].copy_from_slice(&1u16.to_le_bytes());
        fmt[4..8].copy_from_slice(&8_000u32.to_le_bytes());
        fmt[14..16].copy_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(&fmt);
        v.extend_from_slice(b"data");
        v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        v.extend_from_slice(&payload);
        let (s, rate) = parse_wav(&v).expect("parsed");
        assert_eq!(rate, 8_000);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn rejects_malformed_headers_without_panicking() {
        assert!(parse_wav(b"").is_err());
        assert!(parse_wav(b"RIFF....WAVE").is_err());
        // fmt-чанк короче 16 байт: прежний разбор индексировал за границей.
        let mut short_fmt = wav(&[0, 0], 8_000, 1, 16, 16);
        short_fmt[16..20].copy_from_slice(&4u32.to_le_bytes());
        assert!(parse_wav(&short_fmt).is_err());
        // data-чанк выходит за границы файла.
        let mut truncated = wav(&[0, 0], 8_000, 1, 16, 16);
        let data_size_at = truncated.len() - 6;
        truncated[data_size_at..data_size_at + 4].copy_from_slice(&99u32.to_le_bytes());
        assert!(parse_wav(&truncated).is_err());
    }

    #[test]
    fn rejects_unsupported_formats() {
        assert!(parse_wav(&wav(&[0, 0], 8_000, 1, 8, 16)).is_err(), "8-bit");
        assert!(parse_wav(&wav(&[0, 0], 8_000, 3, 16, 16)).is_err(), "3 канала");
        assert!(parse_wav(&wav(&[0, 0], 0, 1, 16, 16)).is_err(), "частота 0");
        assert!(parse_wav(&wav(&[0, 0], 8_000, 1, 16, 16)).is_ok());
    }

    #[test]
    fn duration_has_250ms_tail_and_survives_zero_rate() {
        assert_eq!(sound_duration_ms(8_000, 8_000), 1_250);
        assert_eq!(sound_duration_ms(44_100, 44_100), 1_250);
        assert_eq!(sound_duration_ms(0, 0), 250, "нулевая частота не делит на ноль");
    }
}
