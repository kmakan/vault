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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
    // выключенном экране. Запрашиваем системный диалог «Не ограничивать».
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
          val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = android.net.Uri.parse("package:$packageName")
          }
          startActivity(intent)
        }
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "battery-optimization request failed: " + e.message)
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
  }

  override fun onDestroy() {
    keepAliveWebView = null
    super.onDestroy()
  }
}
