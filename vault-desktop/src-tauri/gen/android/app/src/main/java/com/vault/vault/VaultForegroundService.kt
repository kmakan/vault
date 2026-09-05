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

/* Foreground-сервис: держит процесс Vault живым в фоне, чтобы
 * WebView/JS не был убит системой и IMAP IDLE-цикл (idleLoop) продолжал
 * доставлять входящие звонки. Без него Android выгружает процесс через
 * несколько минут после сворачивания — и звонки не доходят.
 * Показывает постоянное уведомление минимального приоритета (честный
 * способ удержания процесса). Тап по уведомлению возвращает в приложение.
 */
class VaultForegroundService : Service() {

    // Wake-lock: без него CPU засыпает при выключенном экране (Doze)
    // и IMAP IDLE-сокет перестаёт читаться — push о новом письме не доходит.
    // PARTIAL_WAKE_LOCK держит CPU, экран остаётся выключенным.
    private var wakeLock: PowerManager.WakeLock? = null
    // Wifi-lock: не даёт Wi-Fi уйти в сон, иначе TCP-соединение IMAP рвётся.
    private var wifiLock: WifiManager.WifiLock? = null

    // Natives из libvault_desktop.so: headless
    // IMAP-монитор живёт в Rust-таске внутри ЭТОГО процесса. ОБЯЗАТЕЛЬНО
    // экземплярные методы (не companion!): JNI-символ внешнего метода
    // companion содержит $Companion и не совпадёт с Rust-экспортом.
    private external fun nativeStartMonitor(dataDir: String)
    private external fun nativeStopMonitor()
    // call_reject из нативной кнопки шторки (CallActionReceiver): шифрует
    private external fun nativeSendCallSignal(callerEmail: String, callId: String, signal: String)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        // ГАРАНТ: если процесс
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
        // Headless-монитор: глушим Rust-задачу вместе с сервисом.
        try { nativeStopMonitor() } catch (_: Throwable) {}
        // ЭКО-РЕЖИМ: сервис остановлен ПОЛЬЗОВАТЕЛЕМ — не воскрешаем.
        if (ecoStoppedByUser) {
            ecoStoppedByUser = false
            Log.i("VaultRust", "eco: service stopped by user, no restart")
        } else {
            // Samsung/Oppo на Android 11) убивает foreground-сервис. Планируем
            // перезапуск через AlarmManager, чтобы сервис воскрес.
            scheduleRestart(this)
        }
        super.onDestroy()
    }

    // Пользователь смахнул приложение из recents: система вызывает
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
        // HEADLESS-МОНИТОР: процесс без activity не имеет ни WebView
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
        // M2.3: эко-режим — форс-стоп сервиса пользователем (без авторестарта)
        @Volatile var ecoStoppedByUser: Boolean = false

        @JvmStatic
        fun ecoStop(context: Context) {
            ecoStoppedByUser = true
            try {
                context.stopService(Intent(context, VaultForegroundService::class.java))
                Log.i("VaultRust", "eco: foreground service stopped")
            } catch (e: Throwable) {
                Log.w("VaultRust", "eco stop failed: " + e.message)
            }
        }

        @JvmStatic
        fun ecoStart(context: Context) {
            ecoStoppedByUser = false
            try {
                val svc = Intent(context, VaultForegroundService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(svc)
                } else {
                    context.startService(svc)
                }
                Log.i("VaultRust", "eco: foreground service started")
            } catch (e: Throwable) {
                Log.w("VaultRust", "eco start failed: " + e.message)
            }
        }

        init {
            // Сервис-процесс не касается MainActivity/Rust.kt — грузим .so
            // сами (идемпотентно: в activity-процессе библиотека уже
            // загружена). Без этого nativeStartMonitor молча падал бы в
            // UnsatisfiedLinkError, перехваченный try/catch в onStartCommand.
            try { System.loadLibrary("vault_desktop") } catch (_: Throwable) {}
        }

        const val CHANNEL_ID = "vault_foreground"
        const val NOTIF_ID = 9001

        // Хэш PIN хранится в SharedPreferences (дублируется Rust при сохранении
        // конфига). LockActivity сверяет код через nativeVerifyPin (Rust PBKDF2).
        // markUnlocked сбрасывает флаг — MainActivity не запускает замок повторно.
        @JvmStatic
        fun verifyPinHash(context: android.content.Context, code: String): Boolean {
            val prefs = context.getSharedPreferences("vault_duress", android.content.Context.MODE_PRIVATE)
            val hash = prefs.getString("pin_hash", null) ?: return false
            return try {
                nativeVerifyPin(code, hash)
            } catch (e: Throwable) {
                android.util.Log.e("VaultRust", "nativeVerifyPin: " + e.message)
                false
            }
        }

        @JvmStatic
        fun markUnlocked(context: android.content.Context) {
            context.getSharedPreferences("vault_duress", android.content.Context.MODE_PRIVATE)
                .edit().putBoolean("unlocked", true).apply()
        }

        @JvmStatic
        fun shouldLock(context: android.content.Context): Boolean {
            val prefs = context.getSharedPreferences("vault_duress", android.content.Context.MODE_PRIVATE)
            val enabled = prefs.getBoolean("lock_enabled", false)
            val hasHash = !prefs.getString("pin_hash", null).isNullOrEmpty()
            val unlocked = prefs.getBoolean("unlocked", true)
            return enabled && hasHash && !unlocked
        }

        /// Дублирование конфига замка в prefs (вызывается Rust'ом при сохранении).
        /// bio: "1" — снимать замок по отпечатку (BiometricPrompt).
        @JvmStatic
        fun syncLockPrefs(
            context: android.content.Context, enabled: String, pinHash: String,
            duressHash: String, panicHash: String, bio: String
        ) {
            context.getSharedPreferences("vault_duress", android.content.Context.MODE_PRIVATE)
                .edit()
                .putBoolean("lock_enabled", enabled == "1")
                .putString("pin_hash", pinHash)
                .putString("duress_hash", duressHash)
                .putString("panic_hash", panicHash)
                .putBoolean("bio_enabled", bio == "1")
                .commit()
        }

        /// Проверка кода по ВСЕМ хэшам замка. Возвращает тип:
        /// "lock" — обычный код (вход), "duress" — тихий SOS, "panic" — wipe, "none".
        @JvmStatic
        fun handleLockCode(context: android.content.Context, code: String): String {
            val prefs = context.getSharedPreferences("vault_duress", android.content.Context.MODE_PRIVATE)
            val lockHash = prefs.getString("pin_hash", null) ?: return "none"
            val duressHash = prefs.getString("duress_hash", null)
            val panicHash = prefs.getString("panic_hash", null)
            return try {
                when {
                    nativeVerifyPin(code, lockHash) -> "lock"
                    duressHash != null && duressHash.isNotEmpty() && nativeVerifyPin(code, duressHash) -> "duress"
                    panicHash != null && panicHash.isNotEmpty() && nativeVerifyPin(code, panicHash) -> "panic"
                    else -> "none"
                }
            } catch (e: Throwable) {
                android.util.Log.e("VaultRust", "handleLockCode: " + e.message)
                "none"
            }
        }

        /// Duress-код введён на нативном замке: headless-SOS (Rust шлёт письма
        /// выбранным контактам; гео-привязка недоступна без живого WebView —
        /// текст SOS уходит как есть).
        @JvmStatic
        fun notifyDuressEntered(context: android.content.Context) {
            try {
                // Координаты из lastKnownLocation (все провайдеры): SOS важнее
                // точности, ожидание фикс-локации задержало бы отправку.
                val geo = try {
                    val lm = context.getSystemService(android.content.Context.LOCATION_SERVICE)
                            as android.location.LocationManager
                    val providers = listOf(
                        android.location.LocationManager.GPS_PROVIDER,
                        android.location.LocationManager.NETWORK_PROVIDER,
                        android.location.LocationManager.PASSIVE_PROVIDER
                    )
                    var best: android.location.Location? = null
                    for (p in providers) {
                        try {
                            val l = lm.getLastKnownLocation(p) ?: continue
                            if (best == null || l.time > best.time) best = l
                        } catch (_: SecurityException) { }
                    }
                    if (best != null) {
                        java.lang.String.format(java.util.Locale.US,
                            "%.5f, %.5f", best.latitude, best.longitude)
                    } else ""
                } catch (e: Throwable) {
                    android.util.Log.w("VaultRust", "duress geo failed: " + e.message)
                    ""
                }
                nativeSendDuressSos(geo)
                android.util.Log.i("VaultRust", "[duress] SOS triggered from native lock (geo=" + geo + ")")
            } catch (e: Throwable) {
                android.util.Log.e("VaultRust", "notifyDuressEntered: " + e.message)
            }
        }

        /// Очистить prefs замка (после panic-wipe из Rust).
        @JvmStatic
        fun clearLockPrefs(context: android.content.Context) {
            context.getSharedPreferences("vault_duress", android.content.Context.MODE_PRIVATE)
                .edit().clear().commit()
        }

        /// Panic-код: полный вайп из Rust (обёртка для LockActivity).
        @JvmStatic
        fun panicWipeFromNative() {
            try {
                nativePanicWipe()
                android.util.Log.i("VaultRust", "[duress] panic wipe executed")
            } catch (e: Throwable) {
                android.util.Log.e("VaultRust", "panicWipe failed: " + e.message)
            }
        }

        /// Rust (JNI): PBKDF2-проверка кода против stored hash.
        private external fun nativeVerifyPin(code: String, hash: String): Boolean
        private external fun nativeSendDuressSos(geo: String)
        private external fun nativePanicWipe()

        // Открыть URL системным браузером: вызывается
        // из Rust android_open_url через тот же JNI-мост, что showMessage.
        // Работает и из activity-, и из сервис-процесса (context может быть
        // application context — потому FLAG_ACTIVITY_NEW_TASK обязателен).
        @JvmStatic
        fun openUrlCompat(context: android.content.Context, url: String) {
            try {
                val intent = android.content.Intent(
                    android.content.Intent.ACTION_VIEW,
                    android.net.Uri.parse(url)
                ).apply {
                    addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                android.util.Log.i("VaultRust", "openUrlCompat: opened $url")
            } catch (e: Throwable) {
                android.util.Log.e("VaultRust", "openUrlCompat failed: " + e.message)
            }
        }

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

        // Перезапуск сервиса после убийства: OEM-оптимизация батареи
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

        // Живой экземпляр сервиса: нужен, чтобы из статического
        // JNI-метода переключить FGS в режим phoneCall (BAL-исключение).
        @Volatile
        private var instance: VaultForegroundService? = null

        // call_id текущего показанного звонка (ставится в showIncomingCall,
        // читается CallActionReceiver для nativeCallDecision).
        @JvmStatic
        var currentCallId: String = "" 

        // Входящий звонок: отдельный high-importance канал +
        // звонилке. Вызывается из Rust через JNI (audio_android.rs).
        // ВАЖНО: ID канала v2 — старый канал уже
        // создан на устройствах со звуком, а createNotificationChannel НЕ
        // обновляет существующий канал. Новый ID гарантирует применение
        // тихого канала: рингтон теперь играет нативный MediaPlayer.
        const val CALL_CHANNEL_ID = "vault_incoming_call_v2"
        const val CALL_NOTIF_ID = 9002

        // Нативный зацикленный рингтон: HTML5 Audio в WebView
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

        /* Перевести FGS в режим phoneCall. На Android 14+ FGS-тип
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

        /* Показать full-screen уведомление входящего звонка И открыть
         * экран приложения. Вызывается из Rust (JNI) в момент
         * incoming_ringing.
         */
        fun showIncomingCall(context: Context, callerName: String) {
            // Перегрузка для обратной совместимости (JS mediaShowIncomingCall
            // не знает email/call_id): нативный вызов из монитора идёт в
            // расширенную версию — там хранится контекст для кнопок Reject.
            showIncomingCall(context, callerName, "", "")
        }

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
                        // Звук канала ОТКЛЮЧЁН: рингтон играет
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
                // Уведомление БЕЗ кнопок: экран звонка с
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

                // НАТИВНЫЙ WATCHDOG: таймер сброса звонка живёт в
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

                //    уведомления играет ОДИН раз, а HTML5 Audio в WebView
                //    глохнет в фоне. MediaPlayer в сервисе крутится надёжно
                //    до dismissIncomingCall — «сигнал не обрывается».
                startRingtone(context)

                //    срабатывает только при ЗАБЛОКИРОВАННОМ экране; при
                //    разблокированном Android показывает лишь heads-up и
                //    приложение остаётся свёрнутым. Поэтому сами стартуем
                //    MainActivity (BAL-исключение даёт phoneCall-FGS).
                //    ВАЖНО: startForeground(phoneCall) АСИНХРОННЫЙ — если
                //    startActivity вызвать сразу, система ещё не видит
                //    phoneCall-FGS и блокирует запуск (BAL). Даём 400мс
                //    на применение типа сервиса.
                try {
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
                // Остановить нативный рингтон.
                stopRingtone()
                // Вернуть FGS из phoneCall обратно в dataSync.
                instance?.let { exitCallMode(it) }
            } catch (e: Throwable) {
                Log.w("VaultRust", "dismissIncomingCall failed: " + e.message)
            }
        }
    }
}
