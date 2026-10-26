// Набор мутаций: rust-bridge-video — видеопуть звонка в мосте.
//
// ЗАЧЕМ (t_043d6a21, последняя слепая зона моста с тестами на хосте).
// `src-tauri/src/video.rs` — 723 строки, семь бегущих тестов, НИ ОДНОЙ
// закреплённой мутации. Числа VP8-клока переехали в ядро и меряются наборами
// `rust-call-media` / `rust-bridge-opus-numbers`, но в мосте остались решения,
// которые видны только здесь: политика перегрузки очереди кадров (лучше
// потерять кадр, чем накопить задержку), «закрытый writer — это ошибка звонка»,
// чей захват освобождает drop handle'а, и переупаковка YUYV → I420 с чужим
// stride от драйвера.
//
// Цена ошибки: видео встаёт на ровном месте (кадр вместо дропа считается
// сбоем), второй звонок не получает камеру (первый не отпущен), или картинка
// состоит из padding-строк драйвера.
//
// ЧЕСТНАЯ ГРАНИЦА. Вне набора, и это не забывание, а решение:
//   • всё, что требует /dev/video0 (`capture::start`: формат, размеры, битрейт,
//     KEYFRAME_EVERY, DEVICE_INDEX) — на хосте без камеры тест либо падает,
//     либо молча ничего не проверяет; живой прогон — `capture_live_delivers_vp8_frames`
//     (`--ignored`), и он остаётся ручным;
//   • содержимое зашифрованного кадра, который writer отдаёт в трек: без
//     живого пира байты из `write_sample` не извлечь (слой шифрования меряется
//     отдельно — `camera_frame_uses_the_same_e2e_layer_as_audio`);
//   • периодичность логов (`frames % 150`) — наблюдима только в stderr.
export default {
  id: 'rust-bridge-video',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/video.rs',
  smoke: 'cargo test -p vault-desktop --lib video',
  timeoutMs: 900_000,
  mutations: [
    // ── А. Очередь кадров: политика перегрузки ──
    { name: 'очередь кадров стала глубже (8): задержка звонка растёт вместо дропа кадра',
      pattern: 'const FRAME_CHANNEL_DEPTH: usize = 4;',
      replacement: 'const FRAME_CHANNEL_DEPTH: usize = 8;' },
    { name: 'переполнение очереди стало ошибкой звонка: потеря кадра рвёт видео',
      pattern: '            Err(mpsc::error::TrySendError::Full(_)) => {\n                // Канал переполнен (4 кадра) — дропаем кадр, как нативный\n                // захват; лучше потерять fps, чем копить задержку.\n                Ok(())\n            }',
      replacement: '            Err(mpsc::error::TrySendError::Full(_)) => {\n                Err("video queue full".to_string())\n            }' },
    { name: 'закрытый writer перестал быть ошибкой: кадр «принят», хотя писать некому',
      pattern: '            Err(mpsc::error::TrySendError::Closed(_)) => Err("video writer closed".to_string()),',
      replacement: '            Err(mpsc::error::TrySendError::Closed(_)) => Ok(()),' },

    // ── Б. Кто владеет захватом ──
    { name: 'drop handle’а гасит ЛЮБОЙ активный захват, а не только свой',
      pattern: '    if capturing().as_deref() == Some(call_id) {',
      replacement: '    if capturing().is_some() {' },
    { name: 'stop_camera не освобождает маркер: следующий звонок не получает камеру',
      pattern: '    let active = capturing().take();',
      replacement: '    let active = capturing().clone();' },

    // ── В. Writer: чем кончается поток ──
    { name: 'длительность кадра округлена вниз: таймстампы плывут на 1 тик с кадра',
      pattern: 'const FRAME_DURATION: Duration = Duration::from_nanos(frame_duration_nanos());',
      replacement: 'const FRAME_DURATION: Duration = Duration::from_nanos(33_333_333);' },
    { name: 'закрытие источника кадров не завершает writer: таска висит до конца процесса',
      pattern: '                let Some(frame) = frame else { break };',
      replacement: '                let Some(frame) = frame else { continue };' },
    { name: 'стоп звонка не завершает writer: кадры пишутся в мёртвый трек',
      pattern: '            _ = stop_rx.changed() => break,',
      replacement: '            _ = stop_rx.changed() => continue,' },

    // ── Г. Переупаковка YUYV → I420 ──
    { name: 'плоскость V не выделена: кадр обрезан, декодер получает мусор',
      pattern: '        dst.resize(y_size + 2 * uv_size, 128);',
      replacement: '        dst.resize(y_size + uv_size, 128);' },
    { name: 'stride драйвера проигнорирован: строки читаются со смещением, картинка из padding',
      pattern: '            let start = row * stride;',
      replacement: '            let start = row * w * 2;' },
    { name: 'граница строки стала исключительной: последняя строка кадра теряется',
      pattern: '            if start + w * 2 > src.len() {',
      replacement: '            if start + w * 2 >= src.len() {' },
    { name: 'U/V берутся из нечётных строк: цвет съезжает на кадр',
      pattern: '                if row % 2 == 0 {',
      replacement: '                if row % 2 == 1 {' },
    { name: 'индекс UV-плоскости считает по пикселям, а не по парам: выход за плоскость',
      pattern: '                    let uv = y_size + (row / 2) * (w / 2) + col / 2;',
      replacement: '                    let uv = y_size + (row / 2) * (w / 2) + col;' },
  ],
};
