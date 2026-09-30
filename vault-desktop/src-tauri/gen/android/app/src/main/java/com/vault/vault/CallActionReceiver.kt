package com.vault.vault

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class CallActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_REJECT = "com.vault.vault.call.ACTION_REJECT"
        const val ACTION_ACCEPT = "com.vault.vault.call.ACTION_ACCEPT"
        const val REQ_REJECT = 31001
        const val REQ_ACCEPT = 31002

        // Ключи extras в PendingIntent кнопок шторки (кладёт
        // VaultForegroundService.showIncomingCall). Основной источник
        // callId: переживает пересоздание процесса, в отличие от статика.
        const val EXTRA_CALL_ID = "call_id"
        const val EXTRA_CALLER = "caller"

        // JNI-мост к монитору (external в этом классе — символ без $Companion).
        init { System.loadLibrary("vault_desktop") }
    }

    private external fun nativeCallDecision(callId: String, decision: String)

    override fun onReceive(context: Context, intent: Intent) {
        val decision = when (intent.action) {
            ACTION_REJECT -> "reject"
            ACTION_ACCEPT -> "accept"
            else -> return
        }
        Log.i("VaultRust", "call action: $decision → nativeCallDecision")
        // callId: сперва extras из PendingIntent кнопки шторки (пережили
        // пересоздание процесса), затем статик (обратная совместимость —
        // старый путь setPendingIntent без extras).
        val callId = intent.getStringExtra(EXTRA_CALL_ID)
            ?.takeIf { it.isNotEmpty() }
            ?: VaultForegroundService.currentCallId
        if (callId.isEmpty()) {
            Log.w("VaultRust", "call action: no callId (stale notification?)")
            return
        }
        try {
            nativeCallDecision(callId, decision)
            // Гасим уведомление и рингтон СРАЗУ: решение уже передано
            // нативному монитору (он сам погасит при ошибке, но ждать
            // JNI- round-trip с шторки не нужно — кнопка должна отработать
            // мгновенно, иначе повторный тап шлёт решение дважды).
            VaultForegroundService.dismissIncomingCall(context)
        } catch (e: Throwable) {
            Log.w("VaultRust", "nativeCallDecision failed: " + e.message)
        }
    }
}
