package com.vault.vault

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/// Экран блокировки (duress, 0.1.117): показывается при возврате в приложение,
/// если PIN установлен. Паттерн банковских приложений: активность поверх всего,
/// WebView недоступен, пока код не введён. Проверка хэша — через
/// VaultForegroundService.verifyPinHash (Rust PBKDF2 через JNI).
class LockActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    android.util.Log.i("VaultRust", "[lock] LockActivity onCreate — lock shown")

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setBackgroundColor(0xFF0B0F17.toInt())
    }
    val pad = (resources.displayMetrics.density * 24).toInt()

    val title = TextView(this).apply {
      text = "🔒 Vault заблокирован"
      textSize = 20f
      setTextColor(0xFFE7ECF5.toInt())
      gravity = Gravity.CENTER
    }
    val sub = TextView(this).apply {
      text = "Введите код доступа"
      textSize = 14f
      setTextColor(0xFF8B93A7.toInt())
      gravity = Gravity.CENTER
    }
    val pin = EditText(this).apply {
      hint = "PIN или пароль"
      setHintTextColor(0xFF8B93A7.toInt())
      setTextColor(0xFFE7ECF5.toInt())
      inputType = android.text.InputType.TYPE_CLASS_TEXT or
                  android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
      )
    }
    val err = TextView(this).apply {
      textSize = 13f
      setTextColor(0xFFF87171.toInt())
      gravity = Gravity.CENTER
    }
    val btn = Button(this).apply {
      text = "Разблокировать"
      setBackgroundColor(0xFFF59E0B.toInt())
      setTextColor(0xFF1A1206.toInt())
    }

    fun tryUnlock() {
      val code = pin.text.toString()
      if (code.isEmpty()) return
      android.util.Log.i("VaultRust", "[lock] tryUnlock: verifying code (len=" + code.length + ")")
      val kind = try {
        VaultForegroundService.handleLockCode(this@LockActivity, code)
      } catch (e: Throwable) {
        android.util.Log.e("VaultRust", "handleLockCode failed: " + e.message)
        "none"
      }
      android.util.Log.i("VaultRust", "[lock] code kind: " + kind)
      when (kind) {
        "lock" -> {
          VaultForegroundService.markUnlocked(this@LockActivity)
          finish()
        }
        "duress" -> {
          // Не выдаём: показываем «обычный вход», но тихо отправляем SOS
          // (WebView-машине придёт событие из Rust — она уже умеет sendDuressSos).
          VaultForegroundService.notifyDuressEntered(this@LockActivity)
          VaultForegroundService.markUnlocked(this@LockActivity)
          finish()
        }
        "panic" -> {
          // Полный вайп (ключи, БД, конфиг) и выход на замок «пустого» приложения.
          VaultForegroundService.panicWipeFromNative()
          VaultForegroundService.markUnlocked(this@LockActivity)
          finish()
        }
        else -> {
          err.text = "Неверный код"
          pin.setText("")
        }
      }
    }
    btn.setOnClickListener { tryUnlock() }
    pin.setOnEditorActionListener { _, actionId, _ ->
      if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) {
        tryUnlock(); true
      } else false
    }

    root.setPadding(pad, pad, pad, pad)
    for (v in listOf(title, sub, pin, err, btn)) root.addView(v)
    (btn.layoutParams as LinearLayout.LayoutParams).topMargin = pad
    setContentView(root)
  }

  // Кнопка «назад» не закрывает замок.
  @Deprecated("Deprecated in Java")
  override fun onBackPressed() { }
}
