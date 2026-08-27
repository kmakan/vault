package com.vault.vault

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
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
        try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
        wakeLock = null
        wifiLock = null
        super.onDestroy()
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
        const val CHANNEL_ID = "vault_foreground"
        const val NOTIF_ID = 9001
    }
}
