package com.vault.vault

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Нативные кнопки уведомления входящего звонка — ТОНКИЙ транспорт (0.1.92,
 * фаза 2 перепроектирования). Владелец состояния — Rust-монитор
 * (call_state в monitor.db): он знает ringing/accepted/rejected, решает
 * идемпотентность, шлёт call_accept/reject почтой и гасит рингтон.
 *
 * Ресивер только: dismiss + передать решение в nativeCallDecision.
 * Никакой логики email/activity/JS здесь больше нет.
 */
class CallActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_REJECT = "com.vault.vault.call.ACTION_REJECT"
        const val ACTION_ACCEPT = "com.vault.vault.call.ACTION_ACCEPT"
        const val REQ_REJECT = 31001
        const val REQ_ACCEPT = 31002

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
        val callId = VaultForegroundService.currentCallId
        if (callId.isEmpty()) {
            Log.w("VaultRust", "call action: no callId (stale notification?)")
            return
        }
        try {
            nativeCallDecision(callId, decision)
        } catch (e: Throwable) {
            Log.w("VaultRust", "nativeCallDecision failed: " + e.message)
        }
    }
}
