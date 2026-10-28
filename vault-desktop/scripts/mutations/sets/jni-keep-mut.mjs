// Набор мутаций: jni-keep-mut
// Цель: убедиться, что jni-keep-gate.mjs ЛОВИТ расхождение между тремя местами
// JNI-провода: что зовёт Rust (имя + сигнатура), что держит R8 (keep-правило) и
// что объявлено в Kotlin (companion + @JvmStatic). Выжившая мутация = гейт
// измеряет мнение.
//
// ЗАЧЕМ МЕРА ЗДЕСЬ. 28.10 приёмка 0.1.284 на X50 провалилась по звуку звонка,
// и ни одна хостовая мера этого не видела: cargo check собирает Kotlin как есть,
// гейт ассетов сверяет имена WAV, мутации меряют таблицу каналов. А R8 в
// release-сборке вырезал статик-мост @JvmStatic наружного класса, потому что
// из Java его никто не зовёт, — JNI получил NoSuchMethodError, и гудок молчал.
// Та же грабля в этом файле описана шесть раз (showMessage, ecoStop,
// syncLockPrefs, syncCallPrefs, startVoicePlayback, pushModeStart) — каждый раз
// её находили на телефоне. Мера переводит находку на хост.
//
// Плотностной ратчет считает только `.js`/`.rs`: мутации по `proguard-rules.pro`
// и Kotlin вне его области (как `.css`/`.vue` из партии 5l) — держатся этим
// гейтом. Задокументировано в ADR-005 §6.
export default {
  id: 'jni-keep-mut',
  file: 'src-tauri/gen/android/app/proguard-rules.pro',
  smoke: 'jni-keep-gate.mjs',
  mutations: [
    // ── А. keep-правило: имя, типы, класс ──
    { name: 'строка playCallSound удалена (R8 вырезает мост — ровно дефект 28.10)',
      pattern: '    public static void playCallSound(android.content.Context, java.lang.String, boolean, boolean);\n',
      replacement: '' },
    { name: 'у stopCallSound потерялся аргумент (правило не про тот метод)',
      pattern: '    public static void stopCallSound(android.content.Context);',
      replacement: '    public static void stopCallSound();' },
    { name: 'boolean заменён на int (звук есть в другом канале, а правила — нет)',
      pattern: 'playCallSound(android.content.Context, java.lang.String, boolean, boolean);',
      replacement: 'playCallSound(android.content.Context, java.lang.String, int, int);' },
    { name: 'правило повешено на чужой класс (нужный класс не защищён)',
      pattern: '-keepclassmembers class com.vault.vault.VaultForegroundService {\n    public static void playCallSound',
      replacement: '-keepclassmembers class com.vault.vault.VaultForegroundCall {\n    public static void playCallSound' },
    { name: 'wildcard MainActivity свёрнут в другой метод (dispatchCallAction без защиты)',
      pattern: '-keep class com.vault.vault.MainActivity { *; }',
      replacement: '-keep class com.vault.vault.MainActivity { public static void unrelated(android.content.Context); }' },

    // ── Б. Kotlin: наличие и форма моста ──
    { name: '@JvmStatic снят с playCallSound (наружного статика не существует)',
      file: 'src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultForegroundService.kt',
      pattern: '        @JvmStatic\n        fun playCallSound(context: Context, name: String, looped: Boolean, ringtoneUsage: Boolean) {',
      replacement: '        fun playCallSound(context: Context, name: String, looped: Boolean, ringtoneUsage: Boolean) {' },
    { name: 'имя Kotlin-функции разъехалось с тем, что зовёт Rust',
      file: 'src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultForegroundService.kt',
      pattern: '        fun playCallSound(context: Context, name: String, looped: Boolean, ringtoneUsage: Boolean) {',
      replacement: '        fun playCallSoundAndroid(context: Context, name: String, looped: Boolean, ringtoneUsage: Boolean) {' },
    { name: '@JvmStatic снят с showIncomingCall (уведомление звонка тихо перестаёт показываться)',
      file: 'src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultForegroundService.kt',
      pattern: '        @JvmStatic\n        fun showIncomingCall(context: Context, callerName: String, callerEmail: String, callId: String) {',
      replacement: '        fun showIncomingCall(context: Context, callerName: String, callerEmail: String, callId: String) {' },

    // ── В. Rust: что зовёт мост ──
    { name: 'Rust зовёт имя, которого нет ни в правилах, ни в Kotlin',
      file: 'src-tauri/src/audio/audio_android.rs',
      pattern: '            "playCallSound",\n            "(Landroid/content/Context;Ljava/lang/String;ZZ)V",',
      replacement: '            "playCallSoundX",\n            "(Landroid/content/Context;Ljava/lang/String;ZZ)V",' },
    { name: 'класс в вызове написан с опечаткой (ни keep-правила, ни декларации)',
      file: 'src-tauri/src/audio/audio_android.rs',
      pattern: '"com.vault.vault.VaultForegroundService",\n        )\n        .map_err(|e| format!("find class: {e}"))?;\n        env.call_static_method(\n            &cls,\n            "playCallSound",',
      replacement: '"com.vault.vault.VaultForegroundServise",\n        )\n        .map_err(|e| format!("find class: {e}"))?;\n        env.call_static_method(\n            &cls,\n            "playCallSound",' },
    { name: 'сигнатура Rust потеряла второй boolean (правило перестаёт совпадать)',
      file: 'src-tauri/src/audio/audio_android.rs',
      pattern: '"(Landroid/content/Context;Ljava/lang/String;ZZ)V",',
      replacement: '"(Landroid/content/Context;Ljava/lang/String;Z)V",' },
  ],
};
