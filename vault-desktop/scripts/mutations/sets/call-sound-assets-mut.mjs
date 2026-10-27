// Набор мутаций: call-sound-assets-mut
// Цель: убедиться, что call-sound-assets-gate.mjs ЛОВИТ расхождение имени
// звука между пятью местами, где оно живёт. Выжившая мутация = гейт
// измеряет мнение (урок ADR-005 §2.3, партия 5m/#71).
//
// ЗАЧЕМ МЕРА ЗДЕСЬ. Звук звонка существует одновременно в Rust-таблице
// имён и каналов, в десктопных include_bytes, в res/raw телефона, в
// keep.xml (release-шринкинг вырезает незакреплённый ассет) и в таблице
// имя→ресурс Kotlin. До 27.10 их не связывало ничего: на Android фронт
// подставлял имя в URL `/sounds/ring_<имя>.wav`, и «ассета нет» было
// неотличимо от «тихо по настройке громкости» — connect/connected/end/missed
// лежали в src-tauri/sounds, но не в res/raw, и на телефоне их не было вовсе.
//
// Файлы тут разные (audio.rs, Kotlin, keep.xml, calls.js, SettingsPage.vue,
// App.vue): набор про ПРАВИЛО «одно имя — пять мест», а не про один файл —
// мутации бьют по своему месту через `file`. В плотность ратчета попадают
// только мутации по `audio.rs` (он `.rs`); Kotlin/XML — вне его области,
// как и `.css`/`.vue` из партии 5l. Задокументировано в ADR-005 §6.
export default {
  id: 'call-sound-assets-mut',
  file: 'src-tauri/src/audio.rs',
  smoke: 'call-sound-assets-gate.mjs',
  mutations: [
    // ── А. Таблица имён в Rust ──
    { name: 'сигнал пропущенного вычеркнут из списка (на телефоне его нет, а фронт зовёт)',
      pattern: '    ("missed", SoundClass::Signal),\n',
      replacement: '' },
    { name: 'имя варианта рингтона опечаткой дальше (ассет не ищется)',
      pattern: '    ("outgoing_classic", SoundClass::Ring),',
      replacement: '    ("outgoing_classicx", SoundClass::Ring),' },
    { name: 'вшивается WAV, которого нет в списке (мёртвый груз в бинаре)',
      pattern: 'const SND_MISSED: &[u8] = include_bytes!("../sounds/ring_missed.wav");',
      replacement: 'const SND_MISSED: &[u8] = include_bytes!("../sounds/ring_ghost.wav");' },

    // ── Б. Kotlin: имя → ресурс ──
    { name: 'плечо Kotlin ведёт на соседний WAV (звук есть, но не тот)',
      file: 'src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultForegroundService.kt',
      pattern: '            "connect" -> R.raw.ring_connect',
      replacement: '            "connect" -> R.raw.ring_connected' },
    { name: 'Kotlin потерял имя, которое знает Rust (на телефоне тихо)',
      file: 'src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultForegroundService.kt',
      pattern: '            "missed" -> R.raw.ring_missed\n',
      replacement: '' },
    { name: 'сервисный гудок завёл вторую таблицу имён (расходится молча)',
      file: 'src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultForegroundService.kt',
      pattern: '        private fun ringtoneResFor(key: String?): Int =\n            soundResFor(key) ?: R.raw.ring_incoming',
      replacement: '        private fun ringtoneResFor(key: String?): Int = when (key) {\n' +
        '            "incoming_classic" -> R.raw.ring_incoming_classic\n' +
        '            "incoming" -> R.raw.ring_incoming\n' +
        '            else -> R.raw.ring_incoming\n' +
        '        }' },

    // ── В. keep.xml: ассет вырезан шринкингом ──
    { name: 'конец звонка вырезан из keep.xml (release-сборка теряет ресурс)',
      file: 'src-tauri/gen/android/app/src/main/res/raw/keep.xml',
      pattern: ',@raw/ring_end',
      replacement: '' },
    { name: 'в keep.xml опечатка в имени ресурса',
      file: 'src-tauri/gen/android/app/src/main/res/raw/keep.xml',
      pattern: '@raw/ring_missed',
      replacement: '@raw/ring_missha' },
    { name: 'в keep.xml лишнее имя (гейт перестаёт быть списком, а не подстрокой)',
      file: 'src-tauri/gen/android/app/src/main/res/raw/keep.xml',
      pattern: '@raw/ring_incoming,',
      replacement: '@raw/ring_incoming,@raw/ring_ghost,' },

    // ── Г. Фронт: имя и способ воспроизведения ──
    { name: 'фронт зовёт звук, которого нет в таблице ядра',
      file: 'src/features/calls.js',
      pattern: "    playCallSound(deps, 'end', false);\n  } else if",
      replacement: "    playCallSound(deps, 'endd', false);\n  } else if" },
    { name: 'в звук звонка вернулась HTML5-ветка (USAGE_MEDIA, молчит при нулевой медиа-громкости)',
      file: 'src/features/calls.js',
      pattern: "    api.mediaSoundPlay(name, !!looped).catch(e => console.warn('[call] sound play failed:', e));",
      replacement: "    const el = new Audio('/sounds/ring_' + name + '.wav');\n" +
        "    el.loop = !!looped;\n    el.play().catch(() => {});" },
    { name: 'превью в настройках снова играет своим Audio() (расхождение с звонком)',
      file: 'src/components/SettingsPage.vue',
      pattern: "        api.mediaSoundPlay(name, !!looped).catch(e => console.warn('[calls] preview failed:', e));",
      replacement: "        const el = new Audio('/sounds/ring_' + name + '.wav');\n" +
        "        el.loop = !!looped;\n        el.play().catch(() => {});" },
    { name: 'композиционный корень зовёт имя вне таблицы',
      file: 'src/App.vue',
      pattern: "this.playCallSound('connected', false);",
      replacement: "this.playCallSound('connectd', false);" },
  ],
};
