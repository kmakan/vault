// Набор мутаций: rust-bridge-call-sound — таблица звуков звонка в мосте.
//
// ЗАЧЕМ (партия 5m, #71). `audio::SOUNDS` — единственное место, где имя звука
// получает АУДИОКАНАЛ. До переезда на нативный MediaPlayer фронта выбор канала
// не существовал как решение: HTML5 Audio в WebView всегда USAGE_MEDIA, и при
// streamVolume(MUSIC)=0 человек не слышал ни гудка, ни соединения (#70 на X50).
// Теперь правило «incoming — гудок, connect — сигнал» живёт здесь, и его
// расхождение молча означает «звонок тише/громче не там, где надо».
//
// ЧЕСТНАЯ ГРАНИЦА. Вне набора:
//  • Android-ветка (`#[cfg(target_os = "android")]` в sound_play и проводка
//    JNI → Kotlin) — на хосте не компилируется и не исполняется; проверяется
//    только приёмкой на устройстве (#40);
//  • сам MediaPlayer и выбор USAGE_* в Kotlin — вне Rust-мутаций, его держит
//    call-sound-assets-gate (имя→ресурс) и живой прогон.
export default {
  id: 'rust-bridge-call-sound',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/audio.rs',
  smoke: 'cargo test -p vault-desktop --lib audio::tests',
  timeoutMs: 900_000,
  mutations: [
    // ── А. Класс звука = аудиоканал ──
    { name: 'гудок входящего ушёл в канал уведомлений (при беззвучной меди он же и молчал)',
      pattern: '    ("incoming", SoundClass::Ring),',
      replacement: '    ("incoming", SoundClass::Signal),' },
    { name: 'гудок исходящего ушёл в канал уведомлений',
      pattern: '    ("outgoing_classic", SoundClass::Ring),',
      replacement: '    ("outgoing_classic", SoundClass::Signal),' },
    { name: 'сигнал «набираем» ушёл в канал рингтона (MediaPlayer крутит его как гудок)',
      pattern: '    ("connect", SoundClass::Signal),',
      replacement: '    ("connect", SoundClass::Ring),' },
    { name: 'сигнал «можно говорить» ушёл в канал рингтона',
      pattern: '    ("connected", SoundClass::Signal),',
      replacement: '    ("connected", SoundClass::Ring),' },

    // ── Б. Целостность списка имён ──
    { name: 'вариант рингтона вычеркнут из списка (выбор пользователя глохнет)',
      pattern: '    ("incoming_pulse", SoundClass::Ring),\n',
      replacement: '' },
    { name: 'дубликат имени в таблице (первый класс побеждает, второй — мёртвый код)',
      pattern: '    ("end", SoundClass::Signal),',
      replacement: '    ("end", SoundClass::Signal),\n    ("end", SoundClass::Ring),' },
    { name: 'поиск имени стал префиксным (missed_call получает канал missed)',
      pattern: '    SOUNDS.iter().find(|(n, _)| *n == name).map(|(_, c)| *c)',
      replacement: '    SOUNDS.iter().find(|(n, _)| name.starts_with(n)).map(|(_, c)| *c)' },

    // ── В. Проводка имя → WAV ──
    { name: 'пульсирующий рингтон вшит соседним WAV (человек слышит не свой выбор)',
      pattern: '        "incoming_pulse" => SND_INCOMING_PULSE,',
      replacement: '        "incoming_pulse" => SND_INCOMING_CLASSIC,' },
    { name: 'сигнал пропущенного играет ассетом конца звонка',
      pattern: '        "missed" => SND_MISSED,',
      replacement: '        "missed" => SND_END,' },
    { name: 'неизвестное имя получило ассет вместо отказа (молчание стало бы успехом)',
      pattern: '        _ => return None,\n    })',
      replacement: '        _ => Some(SND_INCOMING),\n    })' },
  ],
};
