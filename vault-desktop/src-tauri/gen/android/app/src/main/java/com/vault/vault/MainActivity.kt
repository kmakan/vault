package com.vault.vault

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  // Фоновый приём звонков (27.08): держим ссылку на WebView, чтобы не давать
  // ему замерзать в onPause — иначе JS-таймеры (idleLoop / IMAP IDLE) встают
  // и входящие звонки не доходят, пока приложение свёрнуто.
  private var keepAliveWebView: WebView? = null

  companion object {
    init {
      // Идемпотентно: Rust.kt уже грузит ту же lib, но гарантируем, что
      // native-символы доступны до первого вызова external fun.
      System.loadLibrary("vault_desktop")
    }
  }

  // ndk-context (28.08): tao 0.35 НЕ инициализирует crate ndk-context, из-за
  // чего Rust-звонки падали с «android context was not initialized». Пробрасы-
  // ваем контекст явно; реализация — src-tauri/src/audio/audio_android.rs.
  private external fun nativeInitAndroidContext(context: android.content.Context)

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    try {
      nativeInitAndroidContext(applicationContext)
      Log.i("VaultRust", "ndk-context initialized from Kotlin")
    } catch (e: Throwable) {
      Log.e("VaultRust", "ndk-context init failed: " + e.message)
    }
    // Звонки (27.08): на Android 13+ микрофон требует runtime-разрешения,
    // а не только записи в манифесте. cpal/AAudio без него падает при
    // старте audio-пайплайна после connected → приложение сворачивалось.
    // Запрашиваем один раз при запуске (пользователь видит системный
    // диалог «Разрешить запись аудио?»).
    try {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
          != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(
          this,
          arrayOf(Manifest.permission.RECORD_AUDIO),
          1001
        )
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "RECORD_AUDIO request failed: " + e.message)
    }

    // Android 13+: уведомление foreground-сервиса требует runtime-разрешения.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
          ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
          != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(
          this,
          arrayOf(Manifest.permission.POST_NOTIFICATIONS),
          1002
        )
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "POST_NOTIFICATIONS request failed: " + e.message)
    }

    // Исключение из оптимизации батареи (28.08): без него Doze замораживает
    // foreground-сервис и IMAP IDLE-цикл — входящие звонки не доходят при
    // выключенном экране. ВАЖНО: системный диалог ACTION_REQUEST_IGNORE_...
    // открывается ПОВЕРХ приложения и уводит его в фон. Раньше он вызывался
    // при КАЖДОМ onCreate → «приложение само сворачивается». Теперь запрос
    // ОДНОРАЗОВЫЙ (флаг в SharedPreferences) — больше не дёргаем.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val prefs = getSharedPreferences("vault_prefs", MODE_PRIVATE)
        val asked = prefs.getBoolean("battery_opt_asked", false)
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        if (!asked && !pm.isIgnoringBatteryOptimizations(packageName)) {
          prefs.edit().putBoolean("battery_opt_asked", true).apply()
          val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = android.net.Uri.parse("package:$packageName")
          }
          startActivity(intent)
        }
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "battery-optimization request failed: " + e.message)
    }

    // Full-screen уведомления звонков (28.08): на Android 14+ (API 34)
    // USE_FULL_SCREEN_INTENT стало СПЕЦИАЛЬНЫМ разрешением — оно НЕ
    // выдаётся автоматически, и без него setFullScreenIntent молча
    // деградирует в heads-up («маленькое окно» вместо экрана звонка).
    // Открываем системную страницу, чтобы пользователь включил его.
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        if (!nm.canUseFullScreenIntent()) {
          val intent = Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
            data = android.net.Uri.parse("package:$packageName")
          }
          startActivity(intent)
          Log.i("VaultRust", "opened full-screen-intent settings page")
        }
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "full-screen-intent permission request failed: " + e.message)
    }

    // Headless-монитор (29.08): activity ЖИВА — JS (keep-alive WebView)
    // доставляет сам даже свёрнутым, монитор молчит до onDestroy.
    // ВАЖНО: onCreate основной темы → startForegroundService; сервисный
    // onStartCommand на main-потоке выполнится ПОСЛЕ onResume, т.е. монитор
    // стартует уже с paused=true в activity-процессе (нет дублей с JS).
    try { nativePauseMonitor(true) } catch (_: Throwable) {}

    // Foreground-сервис: держит процесс живым в фоне (приём звонков).
    try {
      val svc = Intent(this, VaultForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        startForegroundService(svc)
      } else {
        startService(svc)
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "startForegroundService failed: " + e.message)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    keepAliveWebView = webView
  }

  override fun onPause() {
    super.onPause()
    // WryActivity.onPause вызывает mWebView.onPause(), что ставит JS на паузу.
    // Сразу возвращаем WebView в resumed-состояние: JS-цикл IMAP IDLE продолжает
    // работать в фоне, входящие call_request доходят без разворачивания приложения.
    try {
      keepAliveWebView?.onResume()
    } catch (e: Throwable) {
      Log.w("VaultRust", "webview keep-alive onResume failed: " + e.message)
    }
    // Headless-монитор: паузу НЕ снимаем — JS keep-alive продолжает доставлять
    // и свёрнутым. Монитор понадобится только если activity уничтожат.
  }

  // Headless-монитор (29.08): Rust-сторона держит монитор на паузе, пока
  // жива MainActivity (JS доставляет всё сам — без дублей уведомлений).
  // Символ в VaultForegroundService — там живёт монитор.
  private external fun nativePauseMonitor(paused: Boolean)

  override fun onResume() {
    super.onResume()
    // Пока открыт UI, доставку ведёт JS — headless-монитор молчит.
    try { nativePauseMonitor(true) } catch (_: Throwable) {}
  }

  override fun onDestroy() {
    // Activity уничтожена (системой или смахиванием): JS с WebView умрёт —
    // снимаем паузу, headless-монитор подхватывает доставку уведомлений,
    // пока процесс (FGS) ещё жив или перезапущен системой без activity.
    try { nativePauseMonitor(false) } catch (_: Throwable) {}
    keepAliveWebView = null
    super.onDestroy()
  }
}
