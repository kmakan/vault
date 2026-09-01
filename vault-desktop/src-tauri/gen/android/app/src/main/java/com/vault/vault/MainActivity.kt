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
import android.provider.Settings
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

    // Статический мост для нативных кнопок уведомления (0.1.91): ACCEPT /
    // REJECT из шторки дергают JS-функции window.__vaultAcceptCall() /
    // window.__vaultRejectCall() через живой WebView (keep-alive), минуя
    // рестарт UI и рассинхрон state machine.
    @JvmStatic
    fun dispatchCallAction(action: String) {
      val js = when (action) {
        "accept" -> "window.__vaultAcceptCall && window.__vaultAcceptCall()"
        "reject" -> "window.__vaultRejectCall && window.__vaultRejectCall()"
        else -> return
      }
      val wv = liveWebView ?: run {
        Log.w("VaultRust", "dispatchCallAction($action): no live WebView")
        return
      }
      wv.post {
        wv.evaluateJavascript(js, null)
        Log.i("VaultRust", "dispatchCallAction($action): JS dispatched")
      }
    }

    // WebView живёт в activity-процессе (keep-alive 27.08). Статик-ссылка
    // ставится в onWebViewCreate, снимается в onDestroy.
    private var liveWebView: WebView? = null
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

    // Отображение поверх окон (30.08): с этим правом Android разрешает запуск
    // MainActivity из фонового сервиса — экран звонка открывается сам при
    // свёрнутом приложении (иначе heads-up «откройте Vault»).
    try {
      if (!Settings.canDrawOverlays(this)) {
        val intent = Intent(
          Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
          android.net.Uri.parse("package:$packageName")
        )
        startActivity(intent)
        Log.i("VaultRust", "asked overlay permission (screen-over-apps)")
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "overlay permission request failed: " + e.message)
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

    // Замок при холодном старте: если PIN установлен и сессия не разблокирована —
    // сразу LockActivity (например, система убила процесс; юзер снова открыл).
    try {
      val prefs = getSharedPreferences("vault_duress", MODE_PRIVATE)
      if (prefs.getBoolean("lock_enabled", false) &&
          !prefs.getString("pin_hash", null).isNullOrEmpty() &&
          !prefs.getBoolean("unlocked", true)) {
        startActivity(android.content.Intent(this, LockActivity::class.java))
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "lock onCreate failed: " + e.message)
    }

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
    liveWebView = webView
    // Гео для SOS (duress, t_b185e3e2): WebView должен разрешать
    // navigator.geolocation для tauri://localhost (prompt ниже выдаёт грант).
    try {
      val settings = webView.settings
      settings.setGeolocationEnabled(true)
      webView.webChromeClient = object : android.webkit.WebChromeClient() {
        override fun onGeolocationPermissionsShowPrompt(
          origin: String?,
          callback: android.webkit.GeolocationPermissions.Callback?
        ) {
          // Runtime-запрос при первом вызове navigator.geolocation: WebView
          // prompt → мы просим системное разрешение и отвечаем грантом после.
          if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION)
              != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
              this@MainActivity,
              arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
              1003
            )
          }
          callback?.invoke(origin, true, false)
        }
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "geolocation webview setup failed: " + e.message)
    }
    // JS-мост: фронт вызывает window.__vaultRequestGeo() при включении гео-опции SOS —
    // он проксирует в статический requestGeoPermission() (companion), который
    // запрашивает runtime-разрешение у activity.
    webView.evaluateJavascript(
      "window.__vaultRequestGeo = function() { window.__vaultGeoBridge && window.__vaultGeoBridge(); };", null
    )
  }

  override fun onPause() {
    super.onPause()
    // Замок (0.1.117): при уходе из приложения — сброс «разблокирован» и показ
    // LockActivity при следующем возврате (паттерн банковских приложений).
    try {
      val prefs = getSharedPreferences("vault_duress", MODE_PRIVATE)
      prefs.edit().putBoolean("unlocked", false).apply()
      if (prefs.getBoolean("lock_enabled", false) &&
          !prefs.getString("pin_hash", null).isNullOrEmpty()) {
        startActivity(android.content.Intent(this, LockActivity::class.java)
          .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "lock onPause failed: " + e.message)
    }
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
    liveWebView = null
    super.onDestroy()
  }
}
