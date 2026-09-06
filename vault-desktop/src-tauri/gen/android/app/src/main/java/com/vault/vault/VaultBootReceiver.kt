package com.vault.vault

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * M2.3-b: старт push-режима после загрузки телефона.
 * Если пользователь включил эко-режим с релеем (push_mode=true в prefs),
 * сервис поднимается сам в push-режиме — пуши и уведомления о сообщениях
 * работают сразу после перезагрузки, без открытия приложения.
 */
class VaultBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        try {
            val prefs = context.getSharedPreferences("vault_prefs", Context.MODE_PRIVATE)
            if (!prefs.getBoolean("push_mode", false)) {
                Log.i("VaultRust", "boot: push mode off, skip")
                return
            }
            val topic = prefs.getString("push_topic", null) ?: return
            val base = prefs.getString("push_base", "https://ntfy.vault-msg.ru") ?: return
            Log.i("VaultRust", "boot: starting push-mode service")
            VaultForegroundService.pushModeStart(context, topic, base)
        } catch (e: Throwable) {
            Log.w("VaultRust", "boot receiver failed: " + e.message)
        }
    }
}
