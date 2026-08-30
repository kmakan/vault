package com.vault.vault

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground-сервис (27.08): держит процесс Vault живым в фоне, чтобы
 * WebView/JS не был убит системой и IMAP IDLE-цикл (idleLoop) продолжал
 * доставлять входящие звонки. Без него Android выгружает процесс через
 * несколько минут после сворачивания — и звонки не доходят.
 *
 * Показывает постоянное уведомление минимального приоритета (честный
 * способ удержания процесса). Тап по уведомлению возвращает в приложение.
 */
class VaultForegroundService : Service() {

    // Wake-lock (27.08): без него CPU засыпает при выключенном экране (Doze),
    // и IMAP IDLE-сокет перестаёт читаться — push о новом письме не доходит.
    // PARTIAL_WAKE_LOCK держит CPU, экран остаётся выключенным.
    private var wakeLock: PowerManager.WakeLock? = null
    // Wifi-lock: не даёт Wi-Fi уйти в сон, иначе TCP-соединение IMAP рвётся.
    private var wifiLock: WifiManager.WifiLock? = null

    // Natives из libvault_desktop.so (service_monitor.rs, 29.08): headless
    // IMAP-монитор живёт в Rust-таске внутри ЭТОГО процесса. ОБЯЗАТЕЛЬНО
    // экземплярные методы (не companion!): JNI-символ внешнего метода
    // companion содержит $Companion и не совпадёт с Rust-экспортом.
    private external fun nativeStartMonitor(dataDir: String)
    private external fun nativeStopMonitor()
    // call_reject из нативной кнопки шторки (CallActionReceiver): шифрует
    // конверт peer-ключом и шлёт SMTP — работает при мёртвом WebView.
    private external fun nativeSendCallSignal(callerEmail: String, callId: String, signal: String)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        // ГАРАНТ (29.08, обычный входящий вызов не принимался): если процесс
        // Vault умер при ПОКАЗАННОМ уведомлении звонка, в шторке остаётся
        // CATEGORY_CALL + full-screen-intent уведомление, а FGS — в режиме
        // phoneCall. На MTK/Cubot это ломает свайп ответа системного
        // телефонного приложения (звонки «зависают» в состоянии вызова).
        // Новый экземпляр сервиса = нового процесса → живого звонка Vault
        // точно нет: убираем stale-уведомление сразу при старте.
        try {
            val nm0 = getSystemService(NotificationManager::class.java)
            nm0?.cancel(CALL_NOTIF_ID)
        } catch (_: Throwable) {}
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vault:idle-wake").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Throwable) {
            Log.w("VaultRust", "wakeLock acquire failed: " + e.message)
        }
        try {
            val wm = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "vault:idle-wifi").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Throwable) {
            Log.w("VaultRust", "wifiLock acquire failed: " + e.message)
        }
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        wakeLock = null
        wifiLock = null
        // Headless-монитор (29.08): глушим Rust-задачу вместе с сервисом.
        try { nativeStopMonitor() } catch (_: Throwable) {}
        // Защита от убийства (28.08): OEM-оптимизация батареи (Xiaomi/Huawei/
        // Samsung/Oppo на Android 11) убивает foreground-сервис. Планируем
        // перезапуск через AlarmManager, чтобы сервис воскрес.
        scheduleRestart(this)
        super.onDestroy()
    }

    // Пользователь смахнул приложение из recents (28.08): система вызывает
    // onTaskRemoved и вскоре убивает сервис. Перезапускаем его.
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        Log.i("VaultRust", "onTaskRemoved: scheduling service restart")
        scheduleRestart(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIF_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (e: Throwable) {
            Log.w("VaultRust", "startForeground failed: " + e.message)
        }
        // HEADLESS-МОНИТОР (29.08): процесс без activity не имеет ни WebView,
        // ни Rust-рантайма Tauri — после свайпа приложения из recents система
        // перезапускает ТОЛЬКО этот сервис, и уведомления умирали до открытия
        // приложения. Поднимаем нативный IMAP-монитор (Rust): IDLE → fetch →
        // decrypt → showMessage. При живой MainActivity монитор ставится на
        // паузу (nativePauseMonitor из onResume) — доставляет JS, дубликатов нет.
        try {
            nativeStartMonitor(applicationContext.dataDir.absolutePath)
        } catch (e: Throwable) {
            Log.w("VaultRust", "nativeStartMonitor failed: " + e.message)
        }
        // Пересоздавать сервис, если система его прибьёт.
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java) ?: return
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.fg_channel_name),
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = getString(R.string.fg_channel_desc)
                setShowBadge(false)
            }
            try {
                nm.createNotificationChannel(channel)
            } catch (e: Throwable) {
                Log.w("VaultRust", "createNotificationChannel failed: " + e.message)
            }
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pi: PendingIntent? = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.fg_notif_title))
            .setContentText(getString(R.string.fg_notif_text))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    companion object {
        init {
            // Сервис-процесс не касается MainActivity/Rust.kt — грузим .so
            // сами (идемпотентно: в activity-процессе библиотека уже
            // загружена). Без этого nativeStartMonitor молча падал бы в
            // UnsatisfiedLinkError, перехваченный try/catch в onStartCommand.
            try { System.loadLibrary("vault_desktop") } catch (_: Throwable) {}
        }

        const val CHANNEL_ID = "vault_foreground"
        const val NOTIF_ID = 9001

        // Уведомление о сообщении из headless-монитора (вызывается из Rust
        // через JNI). Отдельный high-importance канал — MONITOR_CHANNEL_ID.
        @JvmStatic
        fun showMessage(context: Context, title: String, text: String) {
            try {
                val nm = context.getSystemService(NotificationManager::class.java) ?: return
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val channel = NotificationChannel(
                        MONITOR_CHANNEL_ID,
                        "Vault сообщения",
                        NotificationManager.IMPORTANCE_HIGH
                    ).apply {
                        description = "Новые сообщения Vault при свёрнутом приложении"
                        enableVibration(true)
                        setShowBadge(true)
                        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    }
                    nm.createNotificationChannel(channel)
                }
                val launchIntent = context.packageManager
                    .getLaunchIntentForPackage(context.packageName)
                val pi: PendingIntent? = launchIntent?.let {
                    PendingIntent.getActivity(
                        context, 2, it,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                }
                val notif = NotificationCompat.Builder(context, MONITOR_CHANNEL_ID)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .build()
                nm.notify(MONITOR_NOTIF_ID, notif)
                Log.i("VaultRust", "monitor message notification shown: $title")
            } catch (e: Throwable) {
                Log.w("VaultRust", "showMessage failed: " + e.message)
            }
        }

        const val MONITOR_CHANNEL_ID = "vault_messages"
        const val MONITOR_NOTIF_ID = 9003

        // Перезапуск сервиса после убийства (28.08): OEM-оптимизация батареи
        // (Xiaomi/Huawei/Samsung/Oppo на Android 11) убивает foreground-сервис.
        // AlarmManager будит PendingIntent через 3с и стартует сервис заново.
        // PendingIntent живёт в системе даже когда процесс убит.
        private fun scheduleRestart(context: Context) {
            try {
                val intent = Intent(context, VaultForegroundService::class.java)
                val pi = PendingIntent.getService(
                    context, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val am = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
                am.set(
                    android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    android.os.SystemClock.elapsedRealtime() + 3000,
                    pi
                )
                Log.i("VaultRust", "service restart scheduled in 3s")
            } catch (e: Throwable) {
                Log.w("VaultRust", "scheduleRestart failed: " + e.message)
            }
        }

        // Живой экземпляр сервиса (28.08): нужен, чтобы из статического
        // JNI-метода переключить FGS в режим phoneCall (BAL-исключение).
        @Volatile
        private var instance: VaultForegroundService? = null

        // call_id текущего показанного звонка (ставится в showIncomingCall,
        // читается CallActionReceiver для nativeCallDecision).
        @JvmStatic
        var currentCallId: String = "" 

        // Входящий звонок (28.08): отдельный high-importance канал +
        // full-screen intent — звонок поверх локскрина как в обычной
        // звонилке. Вызывается из Rust через JNI (audio_android.rs).
        // ВАЖНО (28.08): ID канала v2 — старый канал (0.1.70/0.1.71) уже
        // создан на устройствах со звуком, а createNotificationChannel НЕ
        // обновляет существующий канал. Новый ID гарантирует применение
        // тихого канала: рингтон теперь играет нативный MediaPlayer.
        const val CALL_CHANNEL_ID = "vault_incoming_call_v2"
        const val CALL_NOTIF_ID = 9002

        // Нативный зацикленный рингтон (28.08): HTML5 Audio в WebView
        // глохнет при троттлинге фона, а звук канала уведомления играет
        // ОДИН раз — пользователь слышал «сигнал прозвучал и оборвался».
        // MediaPlayer в сервисе крутится надёжно до dismissIncomingCall.
        @Volatile
        private var ringtonePlayer: MediaPlayer? = null

        private fun startRingtone(context: Context) {
            try {
                stopRingtone()
                val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                val mp = MediaPlayer().apply {
                    setAudioAttributes(
                        android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    setDataSource(context, uri)
                    isLooping = true
                    prepare()
                    start()
                }
                ringtonePlayer = mp
                Log.i("VaultRust", "ringtone started (native loop)")
            } catch (e: Throwable) {
                Log.w("VaultRust", "startRingtone failed: " + e.message)
            }
        }

        private fun stopRingtone() {
            try {
                ringtonePlayer?.let {
                    if (it.isPlaying) it.stop()
                    it.release()
                }
            } catch (_: Throwable) {}
            ringtonePlayer = null
        }

        /**
         * Перевести FGS в режим phoneCall (28.08). На Android 14+ FGS-тип
         * phoneCall даёт исключение из запрета на запуск activity из фона
         * (Background Activity Launch) — без него свернутое приложение НЕ
         * может само открыть экран звонка, и пользователь видит только
         * heads-up в шторке. Вызывается перед показом уведомления звонка.
         */
        private fun enterCallMode(svc: VaultForegroundService) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    svc.startForeground(
                        NOTIF_ID,
                        svc.buildNotification(),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                    )
                    Log.i("VaultRust", "FGS switched to phoneCall mode")
                }
            } catch (e: Throwable) {
                Log.w("VaultRust", "enterCallMode failed: " + e.message)
            }
        }

        /** Вернуть FGS в обычный режим dataSync после завершения звонка. */
        private fun exitCallMode(svc: VaultForegroundService) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    svc.startForeground(
                        NOTIF_ID,
                        svc.buildNotification(),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                    )
                }
            } catch (e: Throwable) {
                Log.w("VaultRust", "exitCallMode failed: " + e.message)
            }
        }

        /**
         * Показать full-screen уведомление входящего звонка И открыть
         * экран приложения (28.08). Вызывается из Rust (JNI) в момент
         * incoming_ringing.
         */
        fun showIncomingCall(context: Context, callerName: String) {
            // Перегрузка для обратной совместимости (JS mediaShowIncomingCall
            // не знает email/call_id): нативный вызов из монитора идёт в
            // расширенную версию — там хранится контекст для кнопок Reject.
            showIncomingCall(context, callerName, "", "")
        }

        /**
         * Расширенная версия (29.08): callerEmail + callId сохраняются в
         * CallActionReceiver для нативной кнопки «Отклонить» (email-сигнал
         * call_reject уходит через Rust-мост nativeSendCallSignal даже при
         * мёртвом WebView).
         */
        @JvmStatic
        fun showIncomingCall(context: Context, callerName: String, callerEmail: String, callId: String) {
            
            currentCallId = callId
            try {
                // 1) FGS → phoneCall: даёт право поднять activity из фона.
                instance?.let { enterCallMode(it) }

                val nm = context.getSystemService(NotificationManager::class.java) ?: return
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val channel = NotificationChannel(
                        CALL_CHANNEL_ID,
                        context.getString(R.string.call_channel_name),
                        NotificationManager.IMPORTANCE_HIGH
                    ).apply {
                        description = context.getString(R.string.call_channel_desc)
                        // Звук канала ОТКЛЮЧЁН (28.08): рингтон играет
                        // нативный зацикленный MediaPlayer (startRingtone).
                        // Звук канала играл ОДИН раз и дублировал MediaPlayer.
                        setSound(null, null)
                        enableVibration(true)
                        vibrationPattern = longArrayOf(0, 600, 300, 600, 300, 600)
                        setShowBadge(true)
                        // Не гасить heads-up сразу — это звонок.
                        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    }
                    nm.createNotificationChannel(channel)
                }
                val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
                val pi: PendingIntent? = launchIntent?.let {
                    PendingIntent.getActivity(
                        context, 1, it,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                }
                // Уведомление БЕЗ кнопок (0.1.94, упрощение по юзеру): экран звонка с
                // свайпом поднимается сразу (startActivity ниже), кнопки в шторке
                // дублировали UI и вносили рассинхрон состояний.
                val notif = NotificationCompat.Builder(context, CALL_CHANNEL_ID)
                    .setContentTitle(callerName)
                    .setContentText(context.getString(R.string.call_notif_text))
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentIntent(pi)
                    .setFullScreenIntent(pi, true) // поверх локскрина
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .setTimeoutAfter(180_000) // гудок 180с = таймауту звонка
                    .build()
                nm.notify(CALL_NOTIF_ID, notif)
                Log.i("VaultRust", "incoming-call notification shown for $callerName")

                // НАТИВНЫЙ WATCHDOG (29.08): таймер сброса звонка живёт в
                // JS (callRingTimer 180с). Если WebView заморожен/убит,
                // dismissIncomingCall из JS никогда не придёт → уведомление
                // CATEGORY_CALL и FGS phoneCall зависнут, а на MTK/Cubot
                // висящий «вызов» ломает свайп ответа ОБЫЧного телефонного
                // звонка. Дублируем таймер нативно: через 190с (с запасом к
                // JS-таймауту) гасим себя, если звонок всё ещё не принят.
                try {
                    val watchdog = android.os.Handler(android.os.Looper.getMainLooper())
                    val wdRunnable = Runnable {
                        // Отпускаем только если звонок так и не был принят
                        // (в активном звонке notif уже отменён/заменён).
                        try {
                            val nmW = context.getSystemService(NotificationManager::class.java)
                            val active = nmW?.activeNotifications?.any { n ->
                                n.id == CALL_NOTIF_ID
                            } ?: false
                            if (active) {
                                Log.i("VaultRust", "call watchdog: dismissing stale call notification")
                                dismissIncomingCall(context)
                            }
                        } catch (_: Throwable) {}
                    }
                    watchdog.postDelayed(wdRunnable, 190_000)
                } catch (_: Throwable) {}

                // 3) Нативный зацикленный рингтон (28.08): звук канала
                //    уведомления играет ОДИН раз, а HTML5 Audio в WebView
                //    глохнет в фоне. MediaPlayer в сервисе крутится надёжно
                //    до dismissIncomingCall — «сигнал не обрывается».
                startRingtone(context)

                // 2) Явно поднять activity (28.08): full-screen intent
                //    срабатывает только при ЗАБЛОКИРОВАННОМ экране; при
                //    разблокированном Android показывает лишь heads-up и
                //    приложение остаётся свёрнутым. Поэтому сами стартуем
                //    MainActivity (BAL-исключение даёт phoneCall-FGS).
                //    ВАЖНО: startForeground(phoneCall) АСИНХРОННЫЙ — если
                //    startActivity вызвать сразу, система ещё не видит
                //    phoneCall-FGS и блокирует запуск (BAL). Даём 400мс
                //    на применение типа сервиса.
                try {
                    // 30.08: Android 14 блокирует bg-start, пока phoneCall-FGS
                    // не «устаканится» (Abort background activity starts).
                    // Ретраим: 600мс / 1.2с / 2.4с — одна из попыток пройдёт.
                    val handler = android.os.Handler(android.os.Looper.getMainLooper())
                    val delays = longArrayOf(600, 1200, 2400)
                    for ((idx, d) in delays.withIndex()) {
                        handler.postDelayed({
                            try {
                                val openIntent = context.packageManager
                                    .getLaunchIntentForPackage(context.packageName)
                                if (openIntent != null) {
                                    openIntent.addFlags(
                                        Intent.FLAG_ACTIVITY_NEW_TASK or
                                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                                    )
                                    context.startActivity(openIntent)
                                    Log.i("VaultRust", "activity launched (attempt ${idx + 1})")
                                }
                            } catch (e: Throwable) {
                                Log.w("VaultRust", "launch activity failed: " + e.message)
                            }
                        }, d)
                    }
                } catch (e: Throwable) {
                    Log.w("VaultRust", "schedule activity launch failed: " + e.message)
                }
            } catch (e: Throwable) {
                Log.w("VaultRust", "showIncomingCall failed: " + e.message)
            }
        }

        /** Убрать уведомление звонка (принят/отклонён/завершён/таймаут). */
        @JvmStatic
        fun dismissIncomingCall(context: Context) {
            try {
                val nm = context.getSystemService(NotificationManager::class.java) ?: return
                nm.cancel(CALL_NOTIF_ID)
                // Остановить нативный рингтон (28.08).
                stopRingtone()
                // Вернуть FGS из phoneCall обратно в dataSync (28.08).
                instance?.let { exitCallMode(it) }
            } catch (e: Throwable) {
                Log.w("VaultRust", "dismissIncomingCall failed: " + e.message)
            }
        }
    }
}
