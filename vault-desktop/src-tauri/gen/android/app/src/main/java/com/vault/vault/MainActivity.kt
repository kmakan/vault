package com.vault.vault

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
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
  }
}
