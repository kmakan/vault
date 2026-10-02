package com.vault.vault

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
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

    /**
     * Самоисцеление wake-канала (t_44e210b4). Сервис поднимается, когда
     * Firebase SDK живёт в этом процессе (ротация токена, доставка пуша,
     * старт приложения) — дешёвое напоминание «а привязан ли reg_token
     * на РЕЛЕЕ?». Релей при этом мог перезапуститься и забыть привязку.
     * Один POST в фоне, идемпотентно на сервере.
     *
     * VaultForegroundService здесь не трогаем намеренно.
     */
    override fun onCreate() {
        super.onCreate()
        try {
            registerDevice(applicationContext)
        } catch (e: Throwable) {
            Log.w(TAG, "onCreate: re-register failed: " + e.message)
        }
    }

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

        /**
         * Нормализация адреса релея — ТОЛЬКО ДЛЯ СРАВНЕНИЯ и для чтения при
         * обращении к сети. Тот же приём, что в
         * VaultForegroundService.probeRelayHealth (`trim().trimEnd('/')`).
         *
         * ЗАЧЕМ: гейт pushReady сравнивал «сырые» строки (K_REGISTERED_URL vs
         * K_RELAY_URL). Если JS/настройки когда-нибудь сохранят relay url со
         * слэшем в конце (или без), сравнение навсегда даёт «не равны» →
         * pushReady=false навсегда → служба остаётся резидентной в эко, закон
         * «релей жив → службы нет» перестаёт выполняться. Классика при этом
         * работает, поэтому баг был тихим.
         *
         * Ничего в prefs эта функция НЕ пишет — формат хранения не меняем.
         * Сравнение делается регистронезависимо (equals(ignoreCase = true)):
         * хост в URL регистронезависим.
         */
        private fun normalizeRelayUrl(s: String?): String =
            s?.trim()?.trimEnd('/').orEmpty()

        /** Наш релей (prod). Тот же адрес, что DEFAULT_RELAY_URL в relay-client.js. */
        private const val DEFAULT_RELAY_URL = "https://vault-msg.ru/relay"

        private const val REGISTER_TIMEOUT_MS = 10_000

        /**
         * Анти-пачка для [registerDevice]: один запуск приложения дёргает
         * регистрацию из нескольких точек (onCreate → getToken, создание
         * WebView, JS-мост VaultFcm.register) — за секунды. Регистрация
         * копеечная (POST ~200 байт), но и лишних запросов не хочется.
         *
         * ВАЖНО: это НЕ «кэш регистрации». Кэш жил в prefs и переживал
         * рестарт релея, из-за чего клиент молчал, а привязка на релее
         * была потеряна (t_44e210b4). Эта метка живёт только в памяти
         * процесса: перезапуск приложения = свежий POST, то есть клиент
         * чинит wake-канал сам даже без серверного персиста.
         */
        private const val REGISTER_MIN_INTERVAL_MS = 30_000L

        /** Момент последней попытки регистрации (только в памяти процесса). */
        @Volatile
        private var lastRegisterAtMs = 0L

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
                val url = normalizeRelayUrl(relayUrl).ifEmpty { DEFAULT_RELAY_URL }
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
         * Зарегистрировать reg_token на relay (идемпотентно: сервер
         * перезаписывает привязку).
         *
         * ВАЖНО (t_44e210b4): здесь НЕТ «строгого» кэша
         * «уже зарегистрированы для этой пары url+токен → молча выйти».
         * Такой кэш переживал рестарт РЕЛЕЯ, а привязка reg_token к теме
         * жила только в памяти релея: после рестарта клиент думал, что
         * «зарегистрирован», релей — что нет. На проде VAULT_RELAY_NTFY_URL
         * не задан, поэтому запасного канала не было → wake-канал мёртв
         * целиком (не будит ни звонок, ни сообщение при закрытом приложении).
         *
         * Теперь: регистрируемся при каждом вызове (POST ~200 байт, копейки),
         * а [REGISTER_MIN_INTERVAL_MS] гасит только ПАЧКУ вызовов в пределах
         * одного старта приложения (onCreate → getToken → webview → JS-мост
         * дёргают registerDevice несколько раз за секунды).
         */
        @JvmStatic
        @JvmOverloads
        fun registerDevice(context: Context, force: Boolean = false) {
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
            val fp = prefs.getString(K_FP, null)
            // Диагностика кэша: та же пара или нет (в лог, а не в return).
            val samePair = prefs.getString(K_REGISTERED_TOKEN, null) == reg &&
                prefs.getString(K_REGISTERED_URL, null) == url
            // Анти-пачка: не чаще раза в REGISTER_MIN_INTERVAL_MS (кроме force).
            val now = System.currentTimeMillis()
            if (!force) {
                val elapsed = now - lastRegisterAtMs
                if (elapsed < REGISTER_MIN_INTERVAL_MS) {
                    Log.i(
                        TAG,
                        "registerDevice: skip (called ${elapsed}ms after last attempt, " +
                            "min interval ${REGISTER_MIN_INTERVAL_MS}ms; relay re-registers " +
                            "on every app start)"
                    )
                    return
                }
            }
            // Ставим метку ДО похода в сеть: пачка вызовов не должна
            // превратиться в пачку POST'ов. Неудачу метка не отменяет —
            // следующий вызов (смена url/токена, новый запуск) попробует снова.
            lastRegisterAtMs = now
            Thread({
                if (postRegister(url, readToken, reg, fp)) {
                    prefs.edit()
                        .putString(K_REGISTERED_URL, url)
                        .putString(K_REGISTERED_TOKEN, reg)
                        .apply()
                    Log.i(
                        TAG,
                        "registerDevice: registered for push at $url" +
                            if (samePair) " (re-registering unchanged url+token: relay may have restarted)" else ""
                    )
                    // ЭСТАФЕТА: только СЕЙЧАС пуш-канал стал готовым. Если эко
                    // включено, а служба держалась в классике из-за отсутствия
                    // пуша, аккуратно складываем её в эко. ecoStop сам
                    // уважает S6 (@Volatile callActive) и ничего не сделает
                    // во время звонка. Всё в try/catch: эстафета не должна
                    // ломать саму регистрацию.
                    try {
                        VaultForegroundService.ecoHandoffAfterPushReady(context.applicationContext)
                    } catch (e: Throwable) {
                        Log.w(TAG, "eco handoff after registration failed: " + e.message)
                    }
                } else {
                    Log.w(TAG, "registerDevice: registration failed (will retry on next app start)")
                }
            }, "vault-fcm-register").apply { isDaemon = true }.start()
        }

        /**
         * Пакет Google Play Services. На де-гугленных телефонах (Huawei,
         * часть китайских прошивок, эмуляторы) его нет вовсе → Firebase
         * getToken() падает, reg_token не появляется, relay_pub нечего
         * будить. Проверяем через PackageManager, а НЕ через
         * GoogleApiAvailability: новых зависимостей не добавляем
         * (play-services-base есть транзитивно, но не объявлен в
         * app/build.gradle.kts, и опираться на транзитивность нельзя).
         */
        private const val GMS_PACKAGE = "com.google.android.gms"

        /**
         * Есть ли Google Play Services (т.е. может ли FCM вообще работать).
         * Без try/catch наружу: любой сбой = «сервисов нет» (безопасный ответ —
         * не выключать эко, а оставить классическую доставку почтой).
         */
        private fun playServicesAvailable(context: Context): Boolean {
            return try {
                context.packageManager.getPackageInfo(GMS_PACKAGE, 0)
                true
            } catch (_: Throwable) {
                false
            }
        }

        /**
         * ГОТОВ ЛИ ПУШ-КАНАЛ — гейт для эко-режима.
         *
         * ЭКО-ЗАКОН (0.1.201, критично для ПЕРВОГО запуска): нерезидентная
         * эко-схема «релей жив → службы Vault в памяти нет» держится на том,
         * что релей ДОСТАВЛЯЕТ пуш (FCM). Если пуша нет, а служба погашена,
         * то на чистой установке у нового пользователя не приходит НИЧЕГО
         * (звонки и сообщения при закрытом приложении), и он об этом даже
         * не узнает. Поэтому эко разрешаем ТОЛЬКО когда пуш реально работает:
         *
         *   pushReady = (Google Play Services есть)
         *             AND (есть fcm_reg_token)
         *             AND (успешная регистрация на relay)
         *             AND (url регистрации == текущий relay url)
         *             AND (зарегистрированный токен == текущий reg_token)
         *
         * Если false — эко НЕ применяется, доставка идёт классическим путём
         * (FGS + nativeStartMonitor, почта): он работает всегда и без
         * Google-сервисов.
         *
         * Вызовы редкие (старт службы / будильник / boot), кэшировать нечего.
         */
        @JvmStatic
        fun pushReady(context: Context): Boolean = pushNotReadyReason(context).isEmpty()

        /**
         * Причина, по которой пуш-канал НЕ готов ("" = готов). Строкой —
         * её же пишем в лог `eco: push not ready (<причина>) → classic
         * delivery (mail)`, чтобы по логу был виден конкретный обрыв.
         */
        @JvmStatic
        fun pushNotReadyReason(context: Context): String {
            return try {
                if (!playServicesAvailable(context)) {
                    "no Google Play Services ($GMS_PACKAGE not installed)"
                } else {
                    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    val reg = prefs.getString(K_REG_TOKEN, null)
                    when {
                        reg.isNullOrEmpty() ->
                            // Нет сети/аккаунта Play при первом запуске —
                            // Firebase getToken() ещё не отдал токен.
                            "no FCM reg_token yet"
                        else -> {
                            val url = prefs.getString(K_RELAY_URL, DEFAULT_RELAY_URL)
                                ?: DEFAULT_RELAY_URL
                            val regUrl = prefs.getString(K_REGISTERED_URL, null)
                            val regToken = prefs.getString(K_REGISTERED_TOKEN, null)
                            // Сравнение адресов — по нормализованному виду и
                            // регистронезависимо (см. normalizeRelayUrl).
                            // «Сырое» сравнение залипало: url со слэшем в конце
                            // и без давали вечный «registered url != current
                            // relay url» → pushReady=false навсегда → служба
                            // остаётся резидентной при живом релее (тихая потеря
                            // экономии батареи). В лог пишем ИСХОДНЫЕ значения —
                            // так видно, что именно лежит в prefs.
                            val urlNorm = normalizeRelayUrl(url)
                            val regUrlNorm = normalizeRelayUrl(regUrl)
                            when {
                                // Пользователь ещё не залогинился — relay-креды
                                // не приходили, регистрация не выполнялась.
                                regUrl.isNullOrEmpty() ->
                                    "not registered on relay yet (no relay creds)"
                                // Сменился relay (или первый заход на него) —
                                // K_REGISTERED_URL от прошлого, push уйдёт не туда.
                                !regUrlNorm.equals(urlNorm, ignoreCase = true) ->
                                    "registered url != current relay url ($regUrl != $url)"
                                // Токен ротировали, а зарегистрирован (на релее)
                                // старый — привязка битая, пуш не дойдёт.
                                regToken != reg ->
                                    "registered token != current reg_token"
                                else -> ""
                            }
                        }
                    }
                }
            } catch (e: Throwable) {
                // Любой сбой prefs/пакетов = считаем «пуш НЕ готов»: эко
                // отключаем, доставку ведём почтой. Исключение наружу не
                // выпускаем — вызывают из onStartCommand и BootReceiver.
                "push check failed: " + (e.message ?: e.javaClass.simpleName)
            }
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

