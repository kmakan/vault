# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see:
#   http://developer.android.com/guide/developing/tools/proguard.html

# JNI-вызываемые статические методы (29.08): R8-shrinker удаляет методы
# без Java-колеров — headless-монитор упал в NoSuchMethodError showMessage
# (уведомление о сообщении при убитом activity). Показ/снятие звонка тоже
# зовутся только из Rust — держим всё JNI-API сервиса.
-keepclassmembers class com.vault.vault.VaultForegroundService {
    public static void showMessage(android.content.Context, java.lang.String, java.lang.String);
    public static void showIncomingCall(android.content.Context, java.lang.String);
    public static void dismissIncomingCall(android.content.Context);
}

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# ── Vault: JNI-мост звонков (28.08) ──────────────────────────────────────
# Rust (audio_android.rs) вызывает эти методы по имени через JNI
# (find_class + call_static_method). R8/minify переименовывает их
# (showIncomingCall → U) → NoSuchMethodError в рантайме. Сохраняем.
-keep class com.vault.vault.VaultForegroundService {
    public static void showIncomingCall(android.content.Context, java.lang.String);
    public static void dismissIncomingCall(android.content.Context);
}
-keep class com.vault.vault.MainActivity { *; }
