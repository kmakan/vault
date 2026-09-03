package com.vault.vault

import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

/// Экран блокировки: показывается при возврате в приложение
/// если PIN установлен.
/// WebView недоступен, пока код не введён. Проверка хэша — через
/// VaultForegroundService.verifyPinHash (Rust PBKDF2 через JNI).
/// Биометрия: если bio_enabled и сканер доступен — при открытии замка
/// сразу всплывает BiometricPrompt; отпечаток снимает ТОЛЬКО обычный замок
class LockActivity : AppCompatActivity() {
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

    // Кнопка «По отпечатку»: повторный вызов промпта, если пользователь
    // отменил системный диалог. Показывается только когда биометрия доступна.
    val bioBtn = Button(this).apply {
      text = "👆 По отпечатку"
      visibility = android.view.View.GONE
      setBackgroundColor(0xFF1F2735.toInt())
      setTextColor(0xFFE7ECF5.toInt())
    }
    bioBtn.setOnClickListener { showBiometricPrompt() }

    root.setPadding(pad, pad, pad, pad)
    for (v in listOf(title, sub, pin, err, btn, bioBtn)) root.addView(v)
    (btn.layoutParams as LinearLayout.LayoutParams).topMargin = pad
    (bioBtn.layoutParams as LinearLayout.LayoutParams).topMargin = (pad / 2)
    setContentView(root)

    // Автопоказ промпта при открытии замка.
    val bioOn = getSharedPreferences("vault_duress", MODE_PRIVATE).getBoolean("bio_enabled", false)
    if (bioOn && canBiometric()) {
      bioBtn.visibility = android.view.View.VISIBLE
      showBiometricPrompt()
    }
  }

  // Класс сканера: WEAK|STRONG, а не только STRONG. Cubot X50 (Android 11)
  // имеет сканер Class 3 (WEAK) — с BIOMETRIC_STRONG canAuthenticate возвращал
  // NOT_SUPPORTED и промпт молча не появлялся.
  private val bioAuth: Int
    get() = BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.BIOMETRIC_STRONG

  private fun canBiometric(): Boolean {
    return try {
      val r = BiometricManager.from(this).canAuthenticate(bioAuth)
      android.util.Log.i("VaultRust", "[lock] canBiometric=$r (0=SUCCESS)")
      r == BiometricManager.BIOMETRIC_SUCCESS
    } catch (e: Throwable) {
      android.util.Log.e("VaultRust", "[lock] canBiometric: " + e.message)
      false
    }
  }

  private fun showBiometricPrompt() {
    try {
      val executor = ContextCompat.getMainExecutor(this)
      val prompt = BiometricPrompt(this, executor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            android.util.Log.i("VaultRust", "[lock] biometric OK — unlocking")
            VaultForegroundService.markUnlocked(this@LockActivity)
            finish()
          }
          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            // Не ругаемся: код-фолбэк всегда доступен на экране замка.
            android.util.Log.i("VaultRust", "[lock] biometric err " + errorCode + ": " + errString)
          }
        })
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle("Vault заблокирован")
        .setSubtitle("Приложите палец или введите код")
        .setAllowedAuthenticators(bioAuth)
        .setNegativeButtonText("Ввести код")
        .build()
      prompt.authenticate(info)
    } catch (e: Throwable) {
      android.util.Log.e("VaultRust", "[lock] biometric prompt failed: " + e.message)
    }
  }

  // Кнопка «назад» не закрывает замок.
  @Deprecated("Deprecated in Java")
  override fun onBackPressed() { }
}
