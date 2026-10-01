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
            // S5-2 (контракт C): «Ответить» при ЗАКРЫТОМ/свёрнутом
            // приложении должно открыть UI и перевести звонок в active.
            // showIncomingCall больше НЕ автоподнимает activity (т.к.
            // onResume → appVisible → dismissIncomingCall ронял рингтон в
            // 600мс), поэтому открываем явно здесь — НО до dismissIncomingCall,
            // пока phoneCall-FGS активен (BAL-исключение живо; после
            // exitCallMode на Android 12+ старт из фона будет заблокирован).
            // Только «accept»: «reject» звонок просто завершает — UI не нужен.
            if (decision == "accept") {
                try {
                    val launch = context.packageManager
                        .getLaunchIntentForPackage(context.packageName)
                    launch?.addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    )
                    if (launch != null) {
                        context.startActivity(launch)
                        Log.i("VaultRust", "call action: accept — activity started (closed-app path)")
                    }
                } catch (e: Throwable) {
                    Log.w("VaultRust", "call action: accept startActivity failed: " + e.message)
                }
            }
            nativeCallDecision(callId, decision)
            // S6: НЕ гасим звонок здесь. Кнопок в уведомлении больше нет
            // (приём и отклонение выполняются на ЭКРАНЕ ЗВОНКА приложения),
            // а прежний dismissIncomingCall рвал вызов раньше, чем JS успевал
            // его подхватить. Уведомление/рингтон снимаются дальше по цепочке:
            // reject → dismiss в nativeCallDecision; accept → экран приложения
            // (JS гасит нативное уведомление сам при принятии).
        } catch (e: Throwable) {
            Log.w("VaultRust", "nativeCallDecision failed: " + e.message)
        }
    }
}
