//! Фоновый плеер голосовых сообщений (t_c1c44344, M1-хвост).
//!
//! Проблема: `<audio controls>` в WebView останавливается при сворачивании
//! приложения — JS-плейбек троттлится системой, а WebView не переживает фон.
//! Решение — как с рингтоном входящего звонка: воспроизведение уходит
//! в НАТИВНЫЙ слой (MediaPlayer внутри VaultForegroundService), а Android
//! разрешает медиа в фоне foreground-сервису с типом mediaPlayback.
//!
//! Путь данных: JS (MessageItem) → invoke voicenote_play → base64 → JNI →
//! Kotlin VaultForegroundService.startVoicePlayback (MediaPlayer с
//! AudioAttributes USAGE_MEDIA + аудио-фокус). Событие vault://voicenote
//! (playback-finished) возвращается фронту через tauri Emitter — кнопка
//! плеера возвращается в состояние «play» без таймеров JS.
//!
//! Desktop (WebKitGTK): команды отсутствуют — фронт играет инлайн `<audio>`,
//! свёрнутое окно WebKitGTK воспроизведение не останавливает.

use base64::Engine as _;

/// Запустить воспроизведение голосового вложения в нативном слое.
/// `id` — идентификатор сообщения (возвращается в playback-finished),
/// `data` — base64 тела ( расшифрованный фронтовым конвейером attachment),
/// `mime` — тип вложения (audio/webm;codecs=opus и т.п.).
#[tauri::command]
pub async fn voicenote_play(id: String, data: String, mime: String) -> Result<(), String> {
    // Валидация base64 ДО JNI: битая строка дала бы IllegalArgumentException
    // в setDataSource(byte[]) — гасим его на входе, диагностика в Rust-логе.
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("voicenote base64: {e}"))?;
    if bytes.is_empty() {
        return Err("voicenote: empty data".into());
    }
    #[cfg(target_os = "android")]
    {
        crate::audio::audio_android::voicenote_play(&id, &bytes, &mime)
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("voicenote: desktop plays inline <audio>".into())
    }
}

/// Остановить нативное воспроизведение (пользователь нажал стоп / открыл
/// другое голосовое / ушёл из чата). Повторный вызов безопасен.
#[tauri::command]
pub async fn voicenote_stop() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::audio::audio_android::voicenote_stop()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}
