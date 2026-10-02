package com.vault.vault

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
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
                // ЭКО-НЕЗАВИСИМОСТЬ: в eco push-режим выключен, но «нет службы» не
                // значит «нет присмотра за релеем»: будильник ACTION_ECO_HEALTH
                // (PendingIntent в системе) переживает и ребут, поэтому после
                // загрузки достаточно взвести его заново. Если релей не
                // поднимется вместе с телефоном, будильник сам переключит
                // доставку на почту (иначе после ребута звонки не доходили бы,
                // пока пользователь не откроет приложение руками).
                if (prefs.getBoolean("eco_mode", false)) {
                    Log.i("VaultRust", "boot: eco mode — relay health alarm re-armed (no resident service)")
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
