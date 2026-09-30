package com.vault.vault

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * FCM Part B — приём data-only пуша от relay (/relay/fcm) вместо ntfy-моста.
 *
 * Два пути:
 *  - `call_request` → VaultForegroundService.showIncomingCall(): поднимает
 *    FGS с типом phoneCall + полноэкранное уведомление + зацикленный
 *    рингтон. phoneCall-FGS даёт BAL-исключение, поэтому экран звонка
 *    открывается БЕЗ тапа пользователя (приложение свёрнуто/закрыто).
 *  - `message` → тихое локальное уведомление (пользователь видит факт;
 *    содержимое всё равно забирается приложением из relay-очереди).
 *
 * Регистрация: FCM reg_token уходит на relay через POST <relay>/fcm/register,
 * авторизация — тот же read-токен, что у poll («Authorization: VaultRelay
 * <token>», как в relay-client.js). OkHttp в проекте нет →
 * java.net.HttpURLConnection (API 24+).
 */
class VaultFirebaseMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(msg: RemoteMessage) {
        // payload (data-only, от relay /relay/fcm): type, call_id, from, name,
        // total, urgent, ring, click
        val d = msg.data
        Log.i(TAG, "onMessageReceived: type=${d["type"]} from=${d["sender"]}")
        try {
            when (d["type"]) {
                "call_request" -> {
                    // Сервер имени не знает (видит только opaque-токены) →
                    // пустое name откатываем на email отправителя.
                    val name = d["name"]?.takeIf { it.isNotBlank() }
                        ?: d["sender"]?.takeIf { it.isNotBlank() }
                        ?: "Vault"
                    // БЕЗ тапа: FGS phoneCall поднимает activity из фона.
                    VaultForegroundService.showIncomingCall(
                        applicationContext, name,
                        d["sender"] ?: "", d["call_id"] ?: ""
                    )
                    Log.i(TAG, "incoming-call notification shown (call_id=${d["call_id"]})")
                }
                else -> {
                    // message/relay → тихое локальное уведомление. Свой
                    // NotificationManager-канал: private showPushNotification()
                    // у VaultForegroundService не трогаем.
                    showMessageNotification(d["sender"].orEmpty())
                    Log.i(TAG, "message notification shown")
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "onMessageReceived failed: " + e.message)
        }
    }

    /**
     * Тихое уведомление о сообщении: IMPORTANCE_DEFAULT, звук/вибрация
     * выключены (рингтоном является только звонок), тап → запуск приложения.
     */
    private fun showMessageNotification(from: String) {
        val ctx = applicationContext
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                MSG_CHANNEL_ID,
                ctx.getString(R.string.msg_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = ctx.getString(R.string.msg_channel_desc)
                setSound(null, null)
                enableVibration(false)
                setShowBadge(true)
            }
            nm.createNotificationChannel(ch)
        }
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val pi: PendingIntent? = launch?.let {
            PendingIntent.getActivity(
                ctx, 1, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        val text = if (from.isNotBlank()) {
            ctx.getString(R.string.msg_notif_text_from, from)
        } else {
            ctx.getString(R.string.msg_notif_text)
        }
        val n: Notification = NotificationCompat.Builder(ctx, MSG_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(ctx.getString(R.string.app_name))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setSilent(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        // Фиксированный id: при старом (System.currentTimeMillis() % 100000)
        // уведомление невозможно отменить снаружи — «значок службы» висел
        // после прочтения сообщения. С MSG_NOTIF_ID его снимает MainActivity
        // в onResume (пользователь открыл приложение = сообщение прочитано).
        nm.notify(MSG_NOTIF_ID, n)
    }

    override fun onNewToken(token: String) {
        // Регистрация на relay: POST /relay/fcm/register {reg_token: token}
        // c read-токеном (тот же, что для poll).
        Log.i(TAG, "onNewToken: reg_token updated")
        try {
            saveRegToken(applicationContext, token)
            registerDevice(applicationContext)
        } catch (e: Throwable) {
            Log.w(TAG, "onNewToken failed: " + e.message)
        }
    }

    companion object {
        private const val TAG = "VaultFCM"

        // Канал тихих уведомлений о сообщениях (не путать с vault_messages
        // у VaultForegroundService и каналом звонка — звонок играет нативно).
        private const val MSG_CHANNEL_ID = "vault_fcm_messages"

        // Фиксированный id тихого уведомления о сообщении. Должен совпадать
        // с MSG_NOTIF_ID в MainActivity (там он отменяется в onResume) —
        // иначе значок службы остаётся после прочтения.
        const val MSG_NOTIF_ID = 91180

        private const val PREFS = "vault_prefs"
        private const val K_REG_TOKEN = "fcm_reg_token"
        private const val K_RELAY_URL = "fcm_relay_url"
        private const val K_RELAY_TOKEN = "fcm_relay_read_token"
        private const val K_FP = "fcm_relay_fp"
        private const val K_REGISTERED_URL = "fcm_registered_url"
        private const val K_REGISTERED_TOKEN = "fcm_registered_token"

        /** Наш релей (prod). Тот же адрес, что DEFAULT_RELAY_URL в relay-client.js. */
        private const val DEFAULT_RELAY_URL = "https://vault-msg.ru/relay"

        private const val REGISTER_TIMEOUT_MS = 10_000

        /** Сохранить FCM reg_token (переживает перезапуск процесса). */
        @JvmStatic
        fun saveRegToken(context: Context, token: String) {
            try {
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(K_REG_TOKEN, token).apply()
            } catch (e: Throwable) {
                Log.w(TAG, "saveRegToken failed: " + e.message)
            }
        }

        @JvmStatic
        fun regToken(context: Context): String? = try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(K_REG_TOKEN, null)
        } catch (_: Throwable) { null }

        /**
         * Креды релея для FCM-регистрации (кладёт их JS-мост VaultFcm).
         * До этого момента пуши ПРИХОДЯТ, а регистрация на relay молча ждёт.
         */
        @JvmStatic
        fun setRelayCredentials(context: Context, relayUrl: String?, readToken: String?, fp: String?) {
            try {
                val url = relayUrl?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
                    ?: DEFAULT_RELAY_URL
                val e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                e.putString(K_RELAY_URL, url)
                if (!readToken.isNullOrEmpty()) e.putString(K_RELAY_TOKEN, readToken)
                if (!fp.isNullOrEmpty()) e.putString(K_FP, fp)
                e.apply()
                Log.i(TAG, "relay credentials stored (url=$url, hasToken=${!readToken.isNullOrEmpty()})")
            } catch (e: Throwable) {
                Log.w(TAG, "setRelayCredentials failed: " + e.message)
            }
        }

        /**
         * Зарегистрировать накопленный reg_token на relay. Идемпотентно
         * (сервер перезаписывает привязку), без сети — тихий no-op.
         */
        @JvmStatic
        fun registerDevice(context: Context) {
            val reg = regToken(context) ?: run {
                Log.i(TAG, "registerDevice: no reg_token yet (waiting for getToken)")
                return
            }
            val app = context.applicationContext
            val prefs = try {
                app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            } catch (e: Throwable) {
                Log.w(TAG, "registerDevice: prefs unavailable: " + e.message)
                return
            }
            val url = prefs.getString(K_RELAY_URL, DEFAULT_RELAY_URL) ?: DEFAULT_RELAY_URL
            val readToken = prefs.getString(K_RELAY_TOKEN, null)
            if (readToken.isNullOrEmpty()) {
                Log.i(TAG, "registerDevice: no relay read-token yet (deferred)")
                return
            }
            // Уже зарегистрированы для этой пары (url + токен) — не долбим сеть.
            if (prefs.getString(K_REGISTERED_TOKEN, null) == reg &&
                prefs.getString(K_REGISTERED_URL, null) == url
            ) return
            val fp = prefs.getString(K_FP, null)
            Thread({
                if (postRegister(url, readToken, reg, fp)) {
                    prefs.edit()
                        .putString(K_REGISTERED_URL, url)
                        .putString(K_REGISTERED_TOKEN, reg)
                        .apply()
                    Log.i(TAG, "registerDevice: registered for push at $url")
                } else {
                    Log.w(TAG, "registerDevice: registration failed (will retry later)")
                }
            }, "vault-fcm-register").apply { isDaemon = true }.start()
        }

        /** POST <relay>/fcm/register {reg_token, fp} → true при 2xx. */
        private fun postRegister(
            relayUrl: String, readToken: String, reg: String, fp: String?
        ): Boolean {
            var conn: HttpURLConnection? = null
            return try {
                val body = StringBuilder("{\"reg_token\":")
                    .append(jsonQuote(reg))
                    .apply { if (!fp.isNullOrEmpty()) append(",\"fp\":").append(jsonQuote(fp)) }
                    .append("}").toString()
                conn = (URL("$relayUrl/fcm/register").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = REGISTER_TIMEOUT_MS
                    readTimeout = REGISTER_TIMEOUT_MS
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    // Формат auth у релея: «Authorization: VaultRelay <read-токен>».
                    setRequestProperty("Authorization", "VaultRelay $readToken")
                }
                val os: OutputStream = conn.outputStream
                os.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                val ok = code in 200..299
                if (!ok) {
                    val err = try {
                        conn.errorStream?.bufferedReader()?.use { it.readText() }?.take(200)
                    } catch (_: Throwable) { null }
                    Log.w(TAG, "registerDevice: HTTP $code ${err ?: ""}")
                }
                ok
            } catch (e: Throwable) {
                Log.w(TAG, "registerDevice: " + e.javaClass.simpleName + ": " + e.message)
                false
            } finally {
                try { conn?.disconnect() } catch (_: Throwable) {}
            }
        }

        /** Мини-экранирование строки в JSON (reg_token = base64url + «:», но подстрахуемся). */
        private fun jsonQuote(s: String): String {
            val sb = StringBuilder("\"")
            for (c in s) {
                when (c) {
                    '"' -> sb.append("\\\"")
                    '\\' -> sb.append("\\\\")
                    '\n' -> sb.append("\\n")
                    '\r' -> sb.append("\\r")
                    '\t' -> sb.append("\\t")
                    else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
                }
            }
            return sb.append("\"").toString()
        }
    }
}

