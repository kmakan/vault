package com.vault.vault

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Нативные кнопки уведомления входящего звонка (29.08): «Отклонить» и
 * «Принять» в шторке. Смахивание CATEGORY_CALL-уведомления не создаёт
 * НИКАКОГО события — звонящий продолжал гудеть до таймаута (жалоба 29.08:
 * «после отклонения на телефоне десктоп не отключается»).
 *
 * Кнопки не могут вызвать JS напрямую (WebView может быть мёртв/свёрнут):
 * Отклонить → Kotlin пишет call_reject-конверт через почтовый мост.
 * Принять  → поднимает MainActivity (там живой JS покажет экран звонка и
 *            отправит call_accept по существующей машине состояний).
 *
 * Конверт отправляет нативный Postman: CallActionReceiver делегирует
 * VaultForegroundService.sendCallRejectEmail(callerEmail), который кладёт
 * письмо через Rust-мост (JNI emailSendMessage).
 */
class CallActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_REJECT = "com.vault.vault.call.ACTION_REJECT"
        const val ACTION_ACCEPT = "com.vault.vault.call.ACTION_ACCEPT"
        const val REQ_REJECT = 31001
        const val REQ_ACCEPT = 31002

        // Email звонящего, поставленный при showIncomingCall (last caller).
        var currentCallerEmail: String? = null
        // call_id текущего показанного звонка (для call_reject конверта).
        var currentCallId: String = ""
        // WebView жив? Ставится VaultForegroundService в onCreate FGS.
        var jsAlive: Boolean = false
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_REJECT -> {
                Log.i("VaultRust", "call action: REJECT tapped")
                // Гасим нативный звонок (рингтон+уведомление) немедленно.
                try { VaultForegroundService.dismissIncomingCall(context) } catch (_: Throwable) {}
                // call_reject уходит почтой через Rust-мост (не зависит от WebView).
                try {
                    VaultForegroundService.sendCallRejectFromAction()
                } catch (e: Throwable) {
                    Log.w("VaultRust", "call reject email failed: " + e.message)
                }
            }
            ACTION_ACCEPT -> {
                Log.i("VaultRust", "call action: ACCEPT tapped — opening activity")
                try {
                    val open = context.packageManager
                        .getLaunchIntentForPackage(context.packageName)
                    open?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    context.startActivity(open)
                    // call_accept уйдёт из JS при accept на экране звонка.
                } catch (e: Throwable) {
                    Log.w("VaultRust", "call accept open activity failed: " + e.message)
                }
            }
        }
    }
}
