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
        // ECO-ФИКС 0.1.176: сервис поднимают из нового процесса (AlarmManager-
        // рестарт, BootReceiver, MainActivity) — in-memory ecoMode обнулён.
        // Единственный источник правды — персистентный prefs «eco_mode».
        // Иначе сервис молча «вырос бы громким»: wakeLock + IMAP-монитор
        // вопреки включённому eco.
        ecoMode = ecoModeEnabled(this)
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
        if (!pushMode && !ecoMode) {
            // PUSH-РЕЖИМ (эко): без wakeLock/wifiLock — стриму хватит системного
            // сокет-таймаута; это и есть экономия батареи эко-режима.
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
    }

    override fun onDestroy() {
        stopNtfyStream()
        // Сервис умер — активного звонка не осталось: снимаем watchdog,
        // чтобы он не сработал на «воскрешённом» сервисе и не погасил
        // уже начатый разговор (задача 5).
        try { cancelCallWatchdog() } catch (_: Throwable) {}
        if (instance === this) instance = null
        try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        wakeLock = null
        wifiLock = null
        // Headless-монитор: глушим Rust-задачу вместе с сервисом.
        try { nativeStopMonitor() } catch (_: Throwable) {}
        // 0.1.181: eco (релей жив) — сервис НЕ воскрешается: доставка через
        // нtfy-клиент, иконки нет. Классика (eco выключен / релей мёртв)
        // — воскрешаем (OEM-экономия батареи не должна гасить приём).
        if (ecoMode) {
            Log.i("VaultRust", "service destroyed in eco — no resurrection (relay delivery)")
        } else {
            scheduleRestart(this)
            Log.i("VaultRust", "service resurrect scheduled (classic mode keeps process alive)")
        }
        super.onDestroy()
    }

    // Пользователь смахнул приложение из recents: система вызывает
    // onTaskRemoved и вскоре убивает сервис. Перезапускаем его.
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        // 0.1.181: в eco не воскрешаем (см. onDestroy).
        if (!ecoMode) {
            Log.i("VaultRust", "onTaskRemoved: scheduling service restart")
            scheduleRestart(this)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 0.1.181: eco (релей жив) — startForeground НЕ вызываем вовсе
        // (иконка не мигает) и сервис сразу останавливаем: доставка через
        // релей + отдельный нtfy-клиент, без FGS = без иконки в шторке
        // (Android API31+ прицеливает ЛЮБОЕ FGS-уведомление до LOW — тихую
        // иконку 0.1.176 скрыть нельзя, только убрав FGS). Если система
        // перезапустила сервис (START_STICKY из классики) — тоже самостоп.
        if (ecoMode) {
            cancelScheduledRestart(this)
            try {
                val nm = getSystemService(NotificationManager::class.java)
                nm?.cancel(NOTIF_ID)
            } catch (_: Throwable) {}
            // S5-BAL: если сервис запущен startForegroundService (холодный
            // FCM-пуш звонка), startForeground() ОБЯЗАТЕЛЕН — иначе Android
            // 12+ убивает процесс (RemoteServiceException), а вместе с ним
            // живой звонок и кнопки шторки. Иконка в шторке живёт только до
            // конца звонка (dismissIncomingCall в eco-режиме сам остановит
            // сервис) — это осознанный компромисс: без phoneCall FGS экран
            // звонка из фона не откроется вообще (BAL).
            if (intent?.getBooleanExtra(EXTRA_CALL_MODE_KEY, false) == true) {
                enterCallMode(this)
                // enterCallMode на API < 30 НЕ вызывает startForeground —
                // а контракт startForegroundService требует его в 5с
                // (иначе RemoteServiceException убивает процесс). Догонялка
                // для старых API: обычный startForeground (dataSync).
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            startForeground(
                                NOTIF_ID, buildNotification(),
                                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                            )
                        } else {
                            startForeground(NOTIF_ID, buildNotification())
                        }
                    } catch (e: Throwable) {
                        Log.w("VaultRust", "eco call-mode startForeground failed: " + e.message)
                    }
                }
                Log.i("VaultRust", "eco: call-mode — FGS phoneCall (icon until call ends)")
                return START_NOT_STICKY
            }
            Log.i("VaultRust", "eco: onStartCommand — stopping service (delivery via relay+ntfy, no icon)")
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            // КЛАССИЧЕСКИЙ режим: FGS с уведомлением. Тип foreground —
            // DATA_SYNC (приём почты/звонков).
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
        // S5-BAL: холодный FCM-пуш запустил сервис с флагом call-режима —
        // переводим FGS в phoneCall ЗДЕСЬ (showIncomingCall был вызван до
        // onStartCommand, когда instance ещё был null). Тип phoneCall даёт
        // исключение из запрета на background activity start → экран звонка
        // реально открывается, а не висит heads-up в шторке.
        try {
            if (intent?.getBooleanExtra(EXTRA_CALL_MODE_KEY, false) == true) {
                enterCallMode(this)
                Log.i("VaultRust", "FGS switched to phoneCall (fcm)")
            }
        } catch (e: Throwable) {
            Log.w("VaultRust", "enterCallMode from onStartCommand failed: " + e.message)
        }
        if (pushMode && pushTopic != null) {
            // M2.3-b PUSH-РЕЖИМ (эко): БЕЗ IMAP-монитора и wakeLock — только
            // тихая подписка на ntfy (один HTTP-стрим, системный сокет-таймаут).
            // Пуш «есть конверты» → системное уведомление «Новое сообщение»
            // → юзер открывает Vault → relayConsume+IMAP забирают всё.
            startNtfyStream()
        } else {
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
        }
        // КЛАССИКА: служба всегда активна — система перезапускает сервис.
        return START_STICKY
    }

    // ── M2.3-b: ntfy-стрим (долгий HTTP GET, построчный JSON) ──────────────
    // Читает /topic/json (stream): сервер держит соединение, каждая строка —
    // событие. При «message» показываем системное уведомление. Разрыв —
    // реконнект через 3с. Поток демон, гасится в pushStop().
    private fun startNtfyStream() {
        val topic = pushTopic ?: return
        val base = pushNtfyBase
        stopNtfyStream()
        pushStop = false
        val th = Thread {
            var attempt = 0
            while (!pushStop) {
                attempt++
                try {
                    val url = java.net.URL("$base/$topic/json")
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 15000
                    // OkHttp (внутри HttpURLConnection) фиксирует readTimeout при
                    // получении заголовков — после этого менять бесполезно.
                    // ntfy шлёт keepalive каждые ~45с → 60с: живой стрим не
                    // таймаутится, мёртвый распознаётся за минуту.
                    conn.readTimeout = 60000
                    conn.setRequestProperty("User-Agent", "VaultPush/1")
                    val code = conn.responseCode
                    Log.i("VaultRust", "ntfy-stream: connect #$attempt code=$code topic=${topic.take(16)}…")
                    if (code == 200) {
                        val reader = java.io.BufferedReader(java.io.InputStreamReader(conn.inputStream))
                        while (!pushStop) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) continue
                            try {
                                val obj = org.json.JSONObject(line)
                                val ev = obj.optString("event")
                                if (ev == "open") {
                                    Log.i("VaultRust", "ntfy-stream: open ok")
                                } else if (ev == "message") {
                                    Log.i("VaultRust", "ntfy-stream: message received -> notify")
                                    showPushNotification()
                                }
                            } catch (e: Throwable) {
                                Log.w("VaultRust", "ntfy-stream: parse: " + e.message)
                            }
                        }
                        Log.i("VaultRust", "ntfy-stream: stream closed (null line), reconnect")
                    } else {
                        Log.w("VaultRust", "ntfy-stream: HTTP $code, reconnect")
                    }
                    conn.disconnect()
                } catch (e: Throwable) {
                    Log.w("VaultRust", "ntfy-stream: error: " + e.javaClass.simpleName + ": " + e.message)
                }
                if (!pushStop) {
                    try { Thread.sleep(3000) } catch (_: InterruptedException) { return@Thread }
                }
            }
        }
        th.isDaemon = true
        th.start()
        pushLoop = th
        Log.i("VaultRust", "pushMode: ntfy stream started")
    }

    private fun stopNtfyStream() {
        pushStop = true
        try { pushLoop?.interrupt() } catch (_: Throwable) {}
        pushLoop = null
    }

    private fun showPushNotification() {
        try {
            val nm = getSystemService(NotificationManager::class.java) ?: return
            Log.i("VaultRust", "push-notify: building notification")
            val ch = NotificationChannel("vault_messages", "Vault сообщения",
                NotificationManager.IMPORTANCE_HIGH)
            nm.createNotificationChannel(ch)
            val launch = packageManager.getLaunchIntentForPackage(packageName)
            val pi = launch?.let {
                PendingIntent.getActivity(this, 1, it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            val n = NotificationCompat.Builder(this, "vault_messages")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Vault")
                .setContentText("Новое сообщение")
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build()
            nm.notify((System.currentTimeMillis() % 100000).toInt(), n)
            Log.i("VaultRust", "pushMode: NEW MESSAGE notification shown")
        } catch (e: Throwable) {
            Log.w("VaultRust", "push notify failed: " + e.message)
        }
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
            // ECO-ФИКС 0.1.176: тихий канал для eco-режима — без звука/вибрации.
            // 0.1.179: IMPORTANCE_MIN, а не LOW — «тихая» иконка LOW-канала
            // всё равно видна в шторке (жалоба: «иконка службы тратит батарею»).
            // MIN-канал: системное уведомление FGS ставится, но в шторке не
            // рендерится — доставка фактов идёт через ntfy-клиент.
            val quietChannel = NotificationChannel(
                CHANNEL_ID_QUIET,
                getString(R.string.fg_channel_name),
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = getString(R.string.fg_channel_desc)
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
            }
            try {
                nm.createNotificationChannel(channel)
                // МИГРАЦИЯ 0.1.179: на уже установленных устройствах канал
                // vault_service_quiet закеширован системой с LOW (0.1.176) —
                // createNotificationChannel его НЕ обновляет (no-op при
                // повторном создании), и иконка остаётся в шторке. Удаляем
                // старый канал и пересоздаём с MIN; тихую нотификацию
                // пере-постим ниже (ecoStop), чтобы FGS остался связан с
                // уведомлением.
                val cachedQuiet = nm.getNotificationChannel(CHANNEL_ID_QUIET)
                if (cachedQuiet != null &&
                    cachedQuiet.importance != NotificationManager.IMPORTANCE_MIN
                ) {
                    nm.deleteNotificationChannel(CHANNEL_ID_QUIET)
                    Log.i("VaultRust", "quiet channel re-created as MIN (was ${cachedQuiet.importance})")
                }
                nm.createNotificationChannel(quietChannel)
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

    // ECO-ФИКС 0.1.176: тихая нотификация для eco-режима. Процесс нужно
    // удерживать foreground-приоритетом, но пользователь не должен слышать
    // звук/вибрацию — экономия батареи eco идёт именно за счёт этого.
    fun buildQuietNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pi: PendingIntent? = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        return NotificationCompat.Builder(this, CHANNEL_ID_QUIET)
            .setContentTitle(getString(R.string.fg_notif_title))
            .setContentText(getString(R.string.fg_notif_text))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setSilent(true)
            .build()
    }

    // ECO-ФИКС 0.1.176: снимает locks — вызывается из ecoStop при переводе
    // живого сервиса в тихий режим и из onDestroy.
    fun releaseLocks() {
        try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        wakeLock = null
        wifiLock = null
    }

    companion object {
        // M2.3: эко-режим — форс-стоп сервиса пользователем (без авторестарта)
        // ECO-ФИКС 0.1.176: флаг больше не используется — eco больше НЕ убивает
        // сервис. Оставлен для совместимости со ссылками в коде, всегда false.
        @Volatile var ecoStoppedByUser: Boolean = false

        // ECO-ФИКС 0.1.176: сервис ЖИВЁТ в eco, но в «тихом» режиме —
        // процесс не убивается системой во сне (звонки доходят),
        // при этом БЕЗ wakeLock/wifiLock, ntfy-стрима и IMAP-монитора.
        // Персистится в prefs «eco_mode» — единственный источник правды
        // для нового процесса сервиса (in-memory ecoMode обнуляется).
        @Volatile var ecoMode: Boolean = false

        // M2.3-b: ntfy push-режим — сервис держит ntfy-стрим вместо IMAP.
        @Volatile var pushTopic: String? = null   // hex-hash read-токена
        @Volatile var pushLoop: Thread? = null
        @Volatile var pushStop = false

        /// Включить push-режим: сервис остаётся жить (виден как тихий
        /// MIN-сервис), но НЕ поднимает IMAP; подписывается на ntfy-topic.
        @JvmStatic
        fun pushModeStart(context: Context, topic: String, ntfyBase: String) {
            pushTopic = topic
            pushNtfyBase = ntfyBase
            pushMode = true
            // Персистим для BootReceiver: после перезагрузки телефона сервис
            // должен сам подняться в push-режиме (пуши работают всегда).
            context.getSharedPreferences("vault_prefs", Context.MODE_PRIVATE)
                .edit().putString("push_topic", topic)
                    .putString("push_base", ntfyBase)
                    .putBoolean("push_mode", true).apply()
            // Сервис уже ЖИВ в push-режиме? Переключаем стрим на новый topic
            // на месте (onStartCommand не придёт — startForegroundService
            // с живым сервисом только доставит Intent если он started).
            instance?.let { svc ->
                svc.startNtfyStream()
                Log.i("VaultRust", "pushMode: live stream re-subscribed to topic")
                return
            }
            try {
                val svc = Intent(context, VaultForegroundService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(svc)
                } else {
                    context.startService(svc)
                }
                Log.i("VaultRust", "pushMode: service (re)started with ntfy topic")
            } catch (e: Throwable) {
                Log.w("VaultRust", "pushMode start failed: " + e.message)
            }
        }

        @Volatile var pushMode: Boolean = false
        @Volatile var pushNtfyBase: String = "https://ntfy.vault-msg.ru"

        @JvmStatic
        fun ecoStop(context: Context) {
            // 0.1.181: eco (релей жив) = сервис Vault ПОЛНОСТЬЮ остановлен —
            // БЕЗ FGS, БЕЗ иконки в шторке. Доставка несёт нtfy-клиент
            // (UnifiedPush, отдельное приложение) + релей-тикер в живом
            // activity. (0.1.176 дёргал сервис в «тихом» режиме для звонков
            // в фоне, но Android API31+ прицеливает ЛЮБОЕ FGS-уведомление до
            // LOW — иконка вешалась вечно; юзерская модель: релей жив →
            // службы нет.)
            ecoMode = true
            ecoStoppedByUser = false
            context.getSharedPreferences("vault_prefs", Context.MODE_PRIVATE)
                .edit().putBoolean("eco_mode", true).apply()
            val inst = instance
            if (inst != null) {
                // Сервис жив: глушим стрим/монитор, снимаем locks и
                // полностью останавливаем (stopForeground + stopSelf).
                try { inst.stopNtfyStream() } catch (_: Throwable) {}
                try { inst.nativeStopMonitor() } catch (_: Throwable) {}
                try { inst.releaseLocks() } catch (_: Throwable) {}
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        inst.stopForeground(Service.STOP_FOREGROUND_REMOVE)
                    } else {
                        @Suppress("DEPRECATION") inst.stopForeground(true)
                    }
                } catch (_: Throwable) {}
                try {
                    val nm = inst.getSystemService(NotificationManager::class.java)
                    nm?.cancel(NOTIF_ID)
                } catch (_: Throwable) {}
                cancelScheduledRestart(context)
                context.stopService(Intent(context, VaultForegroundService::class.java))
                Log.i("VaultRust", "eco: service fully stopped (delivery via relay+ntfy, no icon)")
            } else {
                // Сервиса нет — убедимся, что его не воскресит будильник.
                cancelScheduledRestart(context)
                Log.i("VaultRust", "eco: service already stopped (no icon)")
            }
        }

        /// Push-режим ВЫКЛ. Если аккаунт в эко-режиме — сервис НЕ
        /// воскрешаем: эко-пользователь не должен видеть постоянную
        /// иконку/IMAP-монитор только из-за переключения push-режима.
        /// 0.1.181: в eco полный стоп сервиса (доставка через нtfy).
        /// (Раньше stopService+startForegroundService безусловно поднимал
        /// classic-сервис — это и было «служба висит в шторке при эко».)
        /// Если эко выключено — перезапускаем сервис в классический (IMAP).
        @JvmStatic
        fun pushModeStop(context: Context) {
            pushMode = false
            pushTopic = null
            context.getSharedPreferences("vault_prefs", Context.MODE_PRIVATE)
                .edit().putBoolean("push_mode", false).remove("push_topic").apply()
            if (ecoModeEnabled(context)) {
                // 0.1.181: eco — сервис полностью останавливается (нет FGS,
                // нет иконки), доставка через нtfy-клиент + релей.
                ecoStop(context)
                Log.i("VaultRust", "pushMode off: eco mode — service fully stopped (no icon)")
                return
            }
            try {
                context.stopService(Intent(context, VaultForegroundService::class.java))
                // Авторестарт из onDestroy/onTaskRemoved не должен двоить
                // ручной рестарт: отменим будильник перед перезапуском.
                cancelScheduledRestart(context)
                val svc = Intent(context, VaultForegroundService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(svc)
                } else {
                    context.startService(svc)
                }
                Log.i("VaultRust", "pushMode off: service restarted in classic mode")
            } catch (e: Throwable) {
                Log.w("VaultRust", "pushModeStop failed: " + e.message)
            }
        }

        @JvmStatic
        fun ecoStart(context: Context) {
            ecoStoppedByUser = false
            // ECO-ФИКС 0.1.176: eco выключен — выходим из тихого режима.
            ecoMode = false
            context.getSharedPreferences("vault_prefs", Context.MODE_PRIVATE)
                .edit().putBoolean("eco_mode", false).apply()
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

        /// Eco-режим сохранён? (для MainActivity: не стартовать сервис при эко)
        @JvmStatic
        fun ecoModeEnabled(context: Context): Boolean {
            return try {
                context.getSharedPreferences("vault_prefs", Context.MODE_PRIVATE)
                    .getBoolean("eco_mode", false)
            } catch (e: Throwable) { false }
        }

        init {
            // Сервис-процесс не касается MainActivity/Rust.kt — грузим .so
            // сами (идемпотентно: в activity-процессе библиотека уже
            // загружена). Без этого nativeStartMonitor молча падал бы в
            // UnsatisfiedLinkError, перехваченный try/catch в onStartCommand.
            try { System.loadLibrary("vault_desktop") } catch (_: Throwable) {}
        }

        const val CHANNEL_ID = "vault_foreground"
        // ECO-ФИКС 0.1.176: тихий канал для eco-режима (без звука/вибрации).
        // 0.1.179: НОВЫЙ id «vault_service_quiet_min» — importance канала в
        // Android ИММУТАБЕЛЬНА: на MTK (Cubot) delete+recreate «vault_service_quiet»
        // при живом FGS-уведомлении не обновил importance (остался LOW=2,
        // иконка в шторке не снялась). NMS новый id не видел → канал создастся
        // гарантированно с IMPORTANCE_MIN. Старый «vault_service_quiet» остаётся
        // сиротским в настройках (без активных уведомлений — в шторке не видно).
        const val CHANNEL_ID_QUIET = "vault_service_quiet_min"
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

        /// Дублирование настроек ЗВОНКОВ в prefs `vault_prefs` (вызывается
        /// Rust'ом из sync_call_prefs при смене рингтона/длительности).
        /// Нужно, чтобы нативный FGS-рингтон и таймаут звонка при СМАХНУТОМ
        /// приложении (JS мёртв) использовали пользовательский выбор.
        /// Пустая строка / null-строка = «не менять» (ключ не трогаем).
        /// duration — миллисекунды; нечисловое значение игнорируем.
        @JvmStatic
        fun syncCallPrefs(
            context: android.content.Context, ringIncoming: String,
            ringOutgoing: String, duration: String
        ) {
            try {
                val ed = context
                    .getSharedPreferences("vault_prefs", android.content.Context.MODE_PRIVATE)
                    .edit()
                if (ringIncoming.isNotEmpty()) ed.putString(K_RING_INCOMING, ringIncoming)
                if (ringOutgoing.isNotEmpty()) ed.putString(K_RING_OUTGOING, ringOutgoing)
                duration.toLongOrNull()?.let { ed.putLong(K_RING_DURATION, it) }
                ed.commit()
                Log.i("VaultRust", "call prefs synced: in=" + ringIncoming +
                    " out=" + ringOutgoing + " dur=" + duration)
            } catch (e: Throwable) {
                Log.w("VaultRust", "syncCallPrefs failed: " + e.message)
            }
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

        /// Отменить отложенный авторестарт (будильник из scheduleRestart).
        /// Нужно перед ручным перезапуском сервиса, иначе два будильника
        /// могут поднять сервис дважды (onStartCommand @ START_STICKY).
        @JvmStatic
        fun cancelScheduledRestart(context: Context) {
            try {
                val intent = Intent(context, VaultForegroundService::class.java)
                val pi = PendingIntent.getService(
                    context, 0, intent,
                    PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
                )
                if (pi != null) {
                    val am = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
                    am.cancel(pi)
                    pi.cancel()
                    Log.i("VaultRust", "scheduled restart cancelled")
                }
            } catch (e: Throwable) {
                Log.w("VaultRust", "cancelScheduledRestart failed: " + e.message)
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

        // Фоновый плеер голосовых (t_c1c44344): MediaPlayer в сервисе —
        // WebView <audio> глохнет при сворачивании, рингтон-паттерн уже
        // доказал надёжность нативного воспроизведения.
        @Volatile
        private var voicePlayer: MediaPlayer? = null
        @Volatile
        private var voicePlayingId: String? = null

        /// Запустить воспроизведение голосового вложения. bytes —
        /// расшифрованное тело (без файлов на диске), mime — audio/webm.
        /// FGS переводится в тип mediaPlayback (фон Android разрешает
        /// медиа только сервису с этим типом) + запрашивается аудио-фокус.
        @JvmStatic
        fun startVoicePlayback(context: Context, id: String, bytes: ByteArray, mime: String) {
            stopVoicePlayback(context)
            try {
                // Media-режим: пока играет трек, сервис заявляет тип
                // mediaPlayback — без него Android глушит вывод свёрнутого
                // приложения (а на 14+ это требование к FGS-типу).
                instance?.let { enterMediaMode(it) }
                // Аудио-фокус: голосовое — медиа-контент (USAGE_MEDIA),
                // вежливо уступаем другим плеерам и получаем приоритет
                // над фоновыми звуками. Duck не нужен — короткий трек.
                val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
                try {
                    am.requestAudioFocus(null, android.media.AudioManager.STREAM_MUSIC,
                        android.media.AudioManager.AUDIOFOCUS_GAIN)
                } catch (_: Throwable) {}
                val mp = MediaPlayer().apply {
                    setAudioAttributes(
                        android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                            .setContentType(
                                if (mime.startsWith("audio/")) android.media.AudioAttributes.CONTENT_TYPE_SPEECH
                                else android.media.AudioAttributes.CONTENT_TYPE_MUSIC
                            )
                            .build()
                    )
                    // byte[]-источник: MediaPlayer (API 36) не имеет public
                    // setDataSource(ByteArray) — обёртка MediaDataSource
                    // (API 23+, minSdk 24). Контент-тело уже расшифровано в
                    // памяти, временных файлов и файловых разрешений не нужно.
                    setDataSource(object : android.media.MediaDataSource() {
                        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
                            if (position >= bytes.size) return -1 // EOF
                            val n = minOf(size, (bytes.size - position).toInt())
                            System.arraycopy(bytes, position.toInt(), buffer, offset, n)
                            return n
                        }
                        override fun getSize(): Long = bytes.size.toLong()
                        // API 36: close() стал abstract — data в памяти,
                        // закрывать нечего.
                        override fun close() {}
                    })
                    // Каждое воспроизведение — встряска keep-alive WebView
                    // не нужна: плеер живёт в сервисе, троттлинг фона ему
                    // не страшен.
                    setOnCompletionListener {
                        onVoicePlaybackDone(context, id, true)
                    }
                    setOnErrorListener { _, what, extra ->
                        onVoicePlaybackDone(context, id, false)
                        true
                    }
                    prepare()
                    start()
                }
                voicePlayer = mp
                voicePlayingId = id
                Log.i("VaultRust", "voicenote play: $id (${bytes.size} bytes)")
            } catch (e: Throwable) {
                Log.w("VaultRust", "voicenote play failed: " + e.message)
                onVoicePlaybackDone(context, id, false)
            }
        }

        /// Трек закончился/ошибка/стоп: гасим плеер, возвращаем FGS в
        /// dataSync, отдаём аудио-фокус, уведомляем фронт (кнопка «play»).
        @JvmStatic
        fun stopVoicePlayback(context: Context) {
            val id = voicePlayingId
            try {
                voicePlayer?.let {
                    if (it.isPlaying) it.stop()
                    it.release()
                }
            } catch (_: Throwable) {}
            voicePlayer = null
            voicePlayingId = null
            instance?.let { exitMediaMode(it) }
            try {
                val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
                am.abandonAudioFocus(null)
            } catch (_: Throwable) {}
            if (id != null) notifyVoiceDone(id)
        }

        /// Дедуп завершения: onCompletion ПОСЛЕ stop() не должен снова
        /// дёргать фронт — гасим id до листенеров и уведомляем один раз.
        private fun onVoicePlaybackDone(context: Context, id: String, played: Boolean) {
            if (voicePlayingId == null) return
            voicePlayingId = null
            try {
                voicePlayer?.let {
                    try { if (it.isPlaying) it.stop() } catch (_: Throwable) {}
                    it.release()
                }
            } catch (_: Throwable) {}
            voicePlayer = null
            instance?.let { exitMediaMode(it) }
            try {
                val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
                am.abandonAudioFocus(null)
            } catch (_: Throwable) {}
            notifyVoiceDone(id)
        }

        /// Сообщить фронту о завершении трека: JS-мост через живой
        /// keep-alive WebView (как dispatchCallAction — без рестарта UI).
        private fun notifyVoiceDone(id: String) {
            val wv = MainActivity.liveWebViewPublic() ?: run {
                Log.w("VaultRust", "voicenote done: no live WebView — JS button stays until action")
                return
            }
            val esc = id.replace("\\", "\\\\").replace("'", "\\'")
            wv.post {
                wv.evaluateJavascript(
                    "window.__vaultVoiceNoteDone && window.__vaultVoiceNoteDone('$esc')", null
                )
                Log.i("VaultRust", "voicenote done dispatched: $id")
            }
        }

        /* Перевести FGS в режим mediaPlayback (пока играет голосовое). */
        private fun enterMediaMode(svc: VaultForegroundService) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    svc.startForeground(
                        NOTIF_ID,
                        svc.buildNotification(),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    )
                    Log.i("VaultRust", "FGS switched to mediaPlayback mode")
                }
            } catch (e: Throwable) {
                Log.w("VaultRust", "enterMediaMode failed: " + e.message)
            }
        }

        /** Вернуть FGS в обычный режим dataSync после трека/звонка. */
        private fun exitMediaMode(svc: VaultForegroundService) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    svc.startForeground(
                        NOTIF_ID,
                        svc.buildNotification(),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                    )
                    Log.i("VaultRust", "FGS back to dataSync mode")
                }
            } catch (e: Throwable) {
                Log.w("VaultRust", "exitMediaMode failed: " + e.message)
            }
        }

        // Входящий звонок: отдельный high-importance канал +
        // звонилке. Вызывается из Rust через JNI (audio_android.rs).
        // ВАЖНО: ID канала v2 — старый канал уже
        // создан на устройствах со звуком, а createNotificationChannel НЕ
        // обновляет существующий канал. Новый ID гарантирует применение
        // тихого канала: рингтон теперь играет нативный MediaPlayer.
        const val CALL_CHANNEL_ID = "vault_incoming_call_v2"
        const val CALL_NOTIF_ID = 9002

        // S5-BAL: флаг-экстра для запуска сервиса из холодного FCM-пуша.
        // showIncomingCall вызывается из VaultFirebaseMessagingService, когда
        // FGS ещё не поднят (instance == null) → enterCallMode пропускается,
        // а вместе с ним и BAL-исключение для открытия экрана звонка.
        // Поэтому поднимаем сервис ЯВНО с этим флагом, и уже onStartCommand
        // переводит его в foregroundServiceType=phoneCall.
        const val EXTRA_CALL_MODE_KEY = "com.vault.vault.call.MODE"

        // Ключи настроек звонка в prefs `vault_prefs` (пишет Rust через
        // syncCallPrefs из таури-команды sync_call_prefs).
        private const val K_RING_INCOMING = "call_ringtone_incoming"
        private const val K_RING_OUTGOING = "call_ringtone_outgoing"
        private const val K_RING_DURATION = "call_ring_duration"
        private const val DEFAULT_RING_DURATION_MS = 180000L
        // Запас watchdog'а к таймауту гудка: JS-таймер 180с живёт в WebView
        // и может сработать на пару секунд позже нативного notify-таймаута.
        private const val RING_WATCHDOG_SLACK_MS = 10_000L

        // Watchdog таймаута гудка (общий Handler + текущий Runnable, чтобы его
        // можно было снять на dismiss/answer/hangup — задача 5). Раньше таймер
        // жил 190с анонимно и гасил звонок, даже если пользователь уже
        // ответил и разговор шёл.
        private val callWatchdogHandler =
            android.os.Handler(android.os.Looper.getMainLooper())
        @Volatile
        private var callWatchdogRunnable: Runnable? = null

        // Таймер ДЛИТЕЛЬНОСТИ ГУДКА (без slack): по истечении ringMs
        // звонок гасится нативно. Нужен потому, что в смахнутом состоянии
        // JS-мёртв (callRingTimer в WebView не работает), а длительность
        // звонка — это настройка пользователя, её нельзя терять.
        // Отмена — в cancelCallWatchdog() (иначе сорвёт начатый разговор).
        @Volatile
        private var callRingTimeoutRunnable: Runnable? = null

        /// Поставить таймер окончания гудка на ringMs. По срабатыванию
        /// звонок снимается полностью: рингтон стоп, уведомление снято,
        /// FGS возвращён в dataSync (dismissIncomingCall).
        private fun startCallRingTimeout(context: Context, ringMs: Long) {
            try {
                val r = Runnable {
                    // Ссылку сбрасываем ДО dismiss: cancelCallWatchdog
                    // внутри не должен трогать уже отработавший таймер.
                    callRingTimeoutRunnable = null
                    try {
                        Log.i("VaultRust", "call ring timeout ${ringMs}ms: dismissing")
                        dismissIncomingCall(context)
                    } catch (e: Throwable) {
                        Log.w("VaultRust", "ring timeout dismiss failed: " + e.message)
                    }
                }
                callRingTimeoutRunnable = r
                callWatchdogHandler.postDelayed(r, ringMs)
                Log.i("VaultRust", "call ring timeout scheduled in ${ringMs}ms")
            } catch (e: Throwable) {
                Log.w("VaultRust", "schedule ring timeout failed: " + e.message)
            }
        }

        /// Снять watchdog гудка. Вызывается из dismissIncomingCall (answer /
        /// reject / hangup / таймаут) и в начале showIncomingCall.
        /// Снимает ОБА таймера: watchdog со slack'ом и точный таймер
        /// длительности гудка — иначе таймер переживёт ответ и оборвёт
        /// начатый разговор.
        private fun cancelCallWatchdog() {
            try {
                val r = callWatchdogRunnable
                if (r != null) {
                    callWatchdogHandler.removeCallbacks(r)
                    callWatchdogRunnable = null
                    Log.i("VaultRust", "call watchdog cancelled")
                }
                val t = callRingTimeoutRunnable
                if (t != null) {
                    callWatchdogHandler.removeCallbacks(t)
                    callRingTimeoutRunnable = null
                    Log.i("VaultRust", "call ring timeout cancelled")
                }
            } catch (_: Throwable) {}
        }

        /// Длительность гудка из настроек (мс), с жёстким клампом 15..600с —
        /// битое значение в prefs не должно вешать уведомление навсегда.
        private fun ringDurationMs(context: Context): Long {
            val raw = try {
                context.getSharedPreferences("vault_prefs", Context.MODE_PRIVATE)
                    .getLong(K_RING_DURATION, DEFAULT_RING_DURATION_MS)
            } catch (_: Throwable) { DEFAULT_RING_DURATION_MS }
            return raw.coerceIn(15_000L, 600_000L)
        }

        // Нативный зацикленный рингтон: HTML5 Audio в WebView
        // глохнет при троттлинге фона, а звук канала уведомления играет
        // ОДИН раз — пользователь слышал «сигнал прозвучал и оборвался».
        // MediaPlayer в сервисе крутится надёжно до dismissIncomingCall.
        @Volatile
        private var ringtonePlayer: MediaPlayer? = null

        /// Выбранный пользователем рингтон входящего (key из prefs) → res/raw.
        /// null = дефолт. Имена совпадают с ключами на фронте (calls.js/SettingsPage).
        private fun ringtoneResFor(key: String?): Int = when (key) {
            "incoming_classic" -> R.raw.ring_incoming_classic
            "incoming_pulse" -> R.raw.ring_incoming_pulse
            "incoming" -> R.raw.ring_incoming
            else -> R.raw.ring_incoming
        }

        private fun startRingtone(context: Context) {
            try {
                stopRingtone()
                val key = try {
                    context.getSharedPreferences("vault_prefs", Context.MODE_PRIVATE)
                        .getString(K_RING_INCOMING, null)
                } catch (_: Throwable) { null }
                val resId = ringtoneResFor(key)
                // Ресурс из res/raw: setDataSource(Context, resId) сам открывает
                // ресурс (без AssetFileDescriptor руками). Системный рингтон
                // оставлен как FALLBACK — если WAV не распакован/повреждён,
                // звонок обязан всё равно прозвучать.
                val mp = MediaPlayer().apply {
                    setAudioAttributes(
                        android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    var ok = false
                    // setDataSource(Context, Int) НЕТ в MediaPlayer (только
                    // Uri/AssetFileDescriptor). res/raw открываем через
                    // ContentResolver → FileDescriptor.
                    try {
                        val afd = context.resources.openRawResourceFd(resId)
                        afd.use { setDataSource(it.fileDescriptor, it.startOffset, it.declaredLength) }
                        ok = true
                    } catch (e: Throwable) {
                        Log.w("VaultRust", "raw ringtone failed, system fallback: " + e.message)
                    }
                    if (!ok) {
                        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                        setDataSource(context, uri)
                    }
                    isLooping = true
                    prepare()
                    start()
                }
                ringtonePlayer = mp
                Log.i("VaultRust", "ringtone started (native loop, res=" + resId + ")")
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
            // S5-2 (контракт A): приложение ВИДИМО — нативный звонок не
            // поднимаем, UI = in-app CallOverlay (свайпы + HTML5-рингтон).
            // Закрывает дубль и от FCM, и от JS mediaShowIncomingCall.
            if (MainActivity.appVisible) {
                Log.i("VaultRust", "call: app visible — native notification suppressed (in-app overlay UI)")
                return
            }
            currentCallId = callId
            try {
                // Длительность гудка из настроек пользователя (в try — чтобы
                // ошибка чтения prefs не роняла показ звонка). Дефолт 180с.
                val ringMs = ringDurationMs(context)
                // Watchdog ТОЖЕ отменяем на каждом новом звонке — иначе таймер
                // от ПРЕДЫДУЩЕГО (не снятого) звонка сорвёт новый разговор.
                cancelCallWatchdog()
                // 1) FGS → phoneCall: даёт право поднять activity из фона.
                // S5-BAL: холодный FCM-пуш — сервис ещё не запущен
                // (instance == null), значит enterCallMode выполнить НЕКОМУ и
                // BAL-исключения нет: Android 12+ блокирует старт MainActivity
                // из фона (isBgStartWhitelisted: false) и пользователь видит
                // только шторку. Поднимаем сервис ЯВНО с флагом call-режима —
                // onStartCommand переведёт его в phoneCall до показа уведомления.
                if (instance == null) {
                    try {
                        context.startForegroundService(
                            Intent(context, VaultForegroundService::class.java)
                                .putExtra(EXTRA_CALL_MODE_KEY, true)
                        )
                        Log.i("VaultRust", "call: FGS not running, starting (fcm path)")
                    } catch (e: Throwable) {
                        Log.w("VaultRust", "call: startForegroundService failed: " + e.message)
                    }
                } else {
                    instance?.let { enterCallMode(it) }
                }

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
                // S5-1: кнопки Reject/Accept в шторке. Основной (первой)
                // идёт Reject — большой палец обычно на нижней/дальней
                // кнопке, случайный тап не должен принимать звонок.
                // PendingIntent → BroadcastReceiver CallActionReceiver,
                // который отдаёт решение в Rust (nativeCallDecision).
                // Разные requestCode (REQ_REJECT/REQ_ACCEPT) — иначе
                // PendingIntent'ы схлопнутся в один (одинаковые extras
                // не входят в ключ Matching) и обе кнопки работали бы
                // одинаково.
                fun callAction(action: String, reqCode: Int): PendingIntent {
                    val i = Intent(action).apply {
                        // Явный компонент: доставляем только нашему
                        // receiver'у, минуя разбор action по всем.
                        setClass(context, CallActionReceiver::class.java)
                        // callId в extras — надёжнее статика currentCallId:
                        // после пересоздания процесса статик пуст, extras же
                        // пережили вместе с PendingIntent.
                        putExtra(CallActionReceiver.EXTRA_CALL_ID, callId)
                        putExtra(CallActionReceiver.EXTRA_CALLER, callerName)
                    }
                    return PendingIntent.getBroadcast(
                        context, reqCode, i,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                }

                // Иконки кнопок: android.R.drawable.ic_call / ic_call_end
                // НЕ резолвятся Kotlin-компилятором на compileSdk 36
                // (Unresolved reference), поэтому используем собственные
                // векторы res/drawable/ic_call_reject|ic_call_accept.xml
                // (Material call_end / call).
                val rejectAction = NotificationCompat.Action.Builder(
                    R.drawable.ic_call_reject,
                    context.getString(R.string.call_action_reject),
                    callAction(CallActionReceiver.ACTION_REJECT, CallActionReceiver.REQ_REJECT)
                ).build()
                val acceptAction = NotificationCompat.Action.Builder(
                    R.drawable.ic_call_accept,
                    context.getString(R.string.call_action_accept),
                    callAction(CallActionReceiver.ACTION_ACCEPT, CallActionReceiver.REQ_ACCEPT)
                ).build()

                // Ongoing + FullScreenIntent остаются как были: кнопки
                // ДОБАВЛЯЮТся к шторке, а не заменяют экран звонка.
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
                    .setTimeoutAfter(ringMs) // гудок = таймауту звонка (настройка)
                    .addAction(rejectAction)
                    .addAction(acceptAction)
                    .build()
                nm.notify(CALL_NOTIF_ID, notif)
                Log.i("VaultRust", "incoming-call notification shown for $callerName")
                // S5-BAL диагностика: instance==false → сервис поднят только
                // что (phoneCall ещё применяется), BAL-исключение появится в
                // момент ретрая startActivity; instance==true → phoneCall активен.
                Log.i("VaultRust", "call: instance=" + (instance != null) + " fgsPhoneCall started")

                // НАТИВНЫЙ WATCHDOG: таймер сброса звонка живёт в
                // JS (callRingTimer — та же длительность из настроек). Если
                // WebView заморожен/убит, dismissIncomingCall из JS не придёт → уведомление
                // CATEGORY_CALL и FGS phoneCall зависнут, а на MTK/Cubot
                // висящий «вызов» ломает свайп ответа ОБЫЧного телефонного
                // звонка. Дублируем таймер нативно: через ringMs + 10с (запас
                // к JS-таймауту) гасим себя, если звонок всё ещё не принят.
                try {
                    val watchdog = callWatchdogHandler
                    val wdRunnable = Runnable {
                        // Отпускаем только если звонок так и не был принят
                        // (в активном звонке notif уже отменён/заменён).
                        try {
                            // Сработал — ссылку сбрасываем, чтобы следующая
                            // отмена не трогала уже отработавший таймер.
                            callWatchdogRunnable = null
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
                    callWatchdogRunnable = wdRunnable
                    watchdog.postDelayed(wdRunnable, ringMs + RING_WATCHDOG_SLACK_MS)
                } catch (_: Throwable) {}

                // ТОЧНЫЙ таймер длительности гудка (ringMs, без slack) —
                // это и есть нативный countdown: в смахнутом состоянии JS
                // не работает, а звонок обязан сам завершиться по
                // настройке пользователя. Гасит рингтон, снимает
                // уведомление и возвращает FGS из phoneCall в dataSync.
                // Отменяется в cancelCallWatchdog() — ответ на звонок
                // НЕ трогаем (пост-accept таймеров здесь нет).
                startCallRingTimeout(context, ringMs)

                //    уведомления играет ОДИН раз, а HTML5 Audio в WebView
                //    глохнет в фоне. MediaPlayer в сервисе крутится надёжно
                //    до dismissIncomingCall — «сигнал не обрывается».
                startRingtone(context)

                // S5-2 (контракт B): входящий в ЗАКРЫТОЕ приложение НЕ
                // автоподнимает activity (S5-BAL-ретрай 600/1200/2400 убран).
                // Старый auto-launch → onResume → appVisible=true →
                // dismissIncomingCall в 600мс ронял рингтон/шторку, пока
                // WebView был ещё холодный («звонку быстро кончился,
                // приложение не закрыто» — оно открылось само).
                // Теперь: CATEGORY_CALL + phoneCall-FGS + IMPORTANCE_HIGH
                // сами дают full-screen на локскрине; приложение
                // открывается ТОЛЬКО по тапу «Ответить» (CallActionReceiver
                // запускает activity с BAL-исключением phoneCall-FGS).
                // Рингтон/время/автоотбой — startCallRingTimeout + setTimeoutAfter.
            } catch (e: Throwable) {
                Log.w("VaultRust", "showIncomingCall failed: " + e.message)
            }
        }

        /** Убрать уведомление звонка (принят/отклонён/завершён/таймаут). */
        @JvmStatic
        fun dismissIncomingCall(context: Context) {
            try {
                // СНАЧАЛА снимаем watchdog: иначе таймер, поставленный на
                // таймаут гудка, через N секунд дёрнет dismissIncomingCall
                // ещё раз и оборвёт НАЧАТЫЙ разговор (задача 5).
                cancelCallWatchdog()
                val nm = context.getSystemService(NotificationManager::class.java) ?: return
                nm.cancel(CALL_NOTIF_ID)
                // Остановить нативный рингтон (MediaPlayer из res/raw).
                stopRingtone()
                // Вернуть FGS из phoneCall обратно в dataSync.
                instance?.let { svc ->
                    exitCallMode(svc)
                    // S5-BAL: в эко-режиме сервис поднят только ради звонка
                    // (startForegroundService с call-флагом, иконка — лишь до
                    // его конца). После звонка гасим сервис — иконка не
                    // висит, что и требуется эко-режимом.
                    if (ecoMode) {
                        svc.stopSelf()
                        Log.i("VaultRust", "eco: call ended — service stopped (icon cleared)")
                    }
                }
            } catch (e: Throwable) {
                Log.w("VaultRust", "dismissIncomingCall failed: " + e.message)
            }
        }
    }
}
