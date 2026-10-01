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
                // ЭКО-НЕЗАВИСИМОСТЬ: в эко push-режим выключен, но сервис
                // ОБЯЗАН подняться — он несёт health-чек релея и переключает
                // доставку на почту, если релей не поднялся вместе с
                // телефоном (иначе после ребута звонки не доходили бы, пока
                // пользователь не откроет приложение руками).
                if (prefs.getBoolean("eco_mode", false)) {
                    Log.i("VaultRust", "boot: eco mode — starting quiet service (relay health + mail fallback)")
                    val svc = Intent(context, VaultForegroundService::class.java)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        context.startForegroundService(svc)
                    } else {
                        context.startService(svc)
                    }
                    VaultForegroundService.enterEcoRelayWatch(context)
                } else {
                    Log.i("VaultRust", "boot: push mode off, eco off, skip")
                }
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
