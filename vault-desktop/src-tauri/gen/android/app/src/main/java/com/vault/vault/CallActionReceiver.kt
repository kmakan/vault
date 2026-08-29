package com.vault.vault

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Нативные кнопки уведомления входящего звонка (29.08): «Отклонить» и
 * «Принять» в шторке. Смахивание CATEGORY_CALL-уведомления не создаёт
 * НИКАКОГО события — звонящий продолжал гудеть до таймаута.
 *
 * 0.1.91 (простая схема юзера): кнопки дергают ЖИВОЙ WebView напрямую через
 * MainActivity.dispatchCallAction → window.__vaultAcceptCall/__vaultRejectCall.
 * Экран звонка с таймером открывается штатной JS-машиной (без второго свайпа).
 * WebView мёртв (activity убита) → пуш «Пропущенный звонок» уже был показан
 * монитором, кнопки просто гасят уведомление.
 */
class CallActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_REJECT = "com.vault.vault.call.ACTION_REJECT"
        const val ACTION_ACCEPT = "com.vault.vault.call.ACTION_ACCEPT"
        const val REQ_REJECT = 31001
        const val REQ_ACCEPT = 31002

        // Email звонящего и call_id текущего показанного звонка.
        var currentCallerEmail: String? = null
        var currentCallId: String = ""
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_REJECT -> {
                Log.i("VaultRust", "call action: REJECT tapped")
                // Гасим уведомление + рингтон немедленно.
                try { VaultForegroundService.dismissIncomingCall(context) } catch (_: Throwable) {}
                // call_reject в ЖИВОЙ WebView (JS отправит email-конверт);
                // WebView мёртв → 0.1.91: всё равно шлём call_reject почтой
                // через Rust-мост (nativeSendCallSignal).
                MainActivity.dispatchCallAction("reject")
                try {
                    VaultForegroundService.sendCallRejectFromAction()
                } catch (e: Throwable) {
                    Log.w("VaultRust", "call reject email failed: " + e.message)
                }
            }
            ACTION_ACCEPT -> {
                Log.i("VaultRust", "call action: ACCEPT tapped")
                // Гасим уведомление (кнопки не должны висеть).
                try { VaultForegroundService.dismissIncomingCall(context) } catch (_: Throwable) {}
                // accept в живой WebView: JS-машина сама сделает acceptCall
                // (call_accept + answer почтой) и покажет экран звонка.
                MainActivity.dispatchCallAction("accept")
            }
        }
    }
}
