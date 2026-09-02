# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see:
#   http://developer.android.com/guide/developing/tools/proguard.html

# JNI-вызываемые статические методы (29.08): R8-shrinker удаляет методы
# без Java-колеров — headless-монитор упал в NoSuchMethodError showMessage
# (уведомление о сообщении при убитом activity). Показ/снятие звонка тоже
# зовутся только из Rust — держим всё JNI-API сервиса. 0.1.88: расширенная
# 4-арг showIncomingCall (email + callId для нативных кнопок Reject) тоже
# зовётся ТОЛЬКО из Rust — без keep-правила R8 удалял её (FATAL
# NoSuchMethodError, «в работе приложения произошел сбой»).
-keepclassmembers class com.vault.vault.VaultForegroundService {
    public static void showMessage(android.content.Context, java.lang.String, java.lang.String);
    public static void showIncomingCall(android.content.Context, java.lang.String);
    public static void showIncomingCall(android.content.Context, java.lang.String, java.lang.String, java.lang.String);
    public static void dismissIncomingCall(android.content.Context);
}

# JNI-нативные методы монитора (29.08): Kotlin вызывает их через external —
# без keep R8-оптимизация может ломать связку.
-keep class com.vault.vault.VaultForegroundService {
    public static void showIncomingCall(android.content.Context, java.lang.String);
    public static void showIncomingCall(android.content.Context, java.lang.String, java.lang.String, java.lang.String);
    public static void dismissIncomingCall(android.content.Context);
}
-keep class com.vault.vault.MainActivity { *; }
-keep class com.vault.vault.CallActionReceiver { *; }

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

# Duress-замок + openUrl (01.09, 0.1.123): ВСЕ статик-методы companion FGS,
# вызываемые из Rust через JNI. R8 без этих правил переименовал их в a/b/c/d —
# NoSuchMethodError «Java exception was thrown» на lockPrefsDebug/syncLockPrefs/
# openUrlCompat (замок не армился, кнопка «Обновить» не открывала браузер).
-keepclassmembers class com.vault.vault.VaultForegroundService$Companion {
    public static boolean verifyPinHash(android.content.Context, java.lang.String);
    public static void markUnlocked(android.content.Context);
    public static void syncLockPrefs(android.content.Context, java.lang.String, java.lang.String);
    public static java.lang.String lockPrefsDebug(android.content.Context);
    public static void openUrlCompat(android.content.Context, java.lang.String);
}
# 0.1.129: R8 вырезает генерированные @JvmStatic-делегаты на ВНЕШНЕМ классе
# (вызовы из Rust идут как static на VaultForegroundService!) — NoSuchMethodError
# «no static method» в release. Держим СТАТИКИ на внешнем классе явно:
-keepclassmembers class com.vault.vault.VaultForegroundService {
    public static boolean verifyPinHash(android.content.Context, java.lang.String);
    public static void markUnlocked(android.content.Context);
    public static void syncLockPrefs(android.content.Context, java.lang.String, java.lang.String, java.lang.String, java.lang.String);
    public static java.lang.String lockPrefsDebug(android.content.Context);
    public static void openUrlCompat(android.content.Context, java.lang.String);
    public static java.lang.String handleLockCode(android.content.Context, java.lang.String);
    public static void notifyDuressEntered(android.content.Context);
    public static void clearLockPrefs(android.content.Context);
    public static void showMessage(android.content.Context, java.lang.String, java.lang.String);
    public static void showIncomingCall(android.content.Context, java.lang.String);
    public static void showIncomingCall(android.content.Context, java.lang.String, java.lang.String, java.lang.String);
    public static void dismissIncomingCall(android.content.Context);
}
-keep class com.vault.vault.VaultForegroundService$Companion { *; }
-keep class com.vault.vault.LockActivity { *; }
