# ECO-FIX 0.1.176 — тихий foreground-сервис в eco-режиме

## Диагноз (уже подтверждён на устройстве)
Сейчас в eco-режиме `VaultForegroundService.ecoStop()` вызывает
`context.stopService(...)` и выставляет флаг `ecoStoppedByUser = true`.
Из-за этого:
1. `onDestroy()` видит флаг и НЕ вызывает `scheduleRestart()` — сервис не воскрешается.
2. Процесс приложения остаётся без foreground-приоритета, система убивает его во сне.
3. Входящие звонки (WebRTC-сигнализация через relay) отваливаются, пока
   пользователь не откроет приложение вручную.

Лог со смартфона (PID 25312) это подтверждает:
```
VaultRust: eco: foreground service stopped
VaultRust: pushMode off: eco mode — service stopped (no classic restart)
VaultRust: eco: service stopped by user, no restart
```

## Решение
В eco-режиме сервис **не убивается**, а переводится в «тихий» режим:
- процесс жив (START_STICKY), система его не убивает во сне → звонки доходят;
- уведомление «тихое»: канал IMPORTANCE_LOW, PRIORITY_MIN, `setSilent(true)`,
  без звука и вибрации → батарею экономим именно на тишине, а не на убийстве;
- БЕЗ wakeLock/wifiLock (основная экономия батареи eco-режима);
- БЕЗ ntfy-стрима и БЕЗ IMAP-монитора: фоновую доставку сообщений в eco
  по-прежнему несёт UnifiedPush (ntfy-клиент, отдельное приложение),
  поэтому Rust/JS-логику НЕ трогаем.

Меняем ТОЛЬКО Kotlin-файл `VaultForegroundService.kt`
(MainActivity.kt уже исправлен: сервис стартует всегда).

## Файл
vault-desktop/src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultForegroundService.kt

## Конкретные правки

### 1. Companion-object: добавить состояние eco
Рядом с `pushMode` добавить:
```kotlin
@Volatile var ecoMode: Boolean = false
```

### 2. buildNotification — сделать тихую версию
Текущий `buildNotification()` уже тихой (PRIORITY_MIN), но нужен отдельный
канал `IMPORTANCE_LOW`. Добавить метод:
```kotlin
private fun buildQuietNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pi: PendingIntent? = launchIntent?.let {
        PendingIntent.getActivity(this, 0, it,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
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
```
И константу `private const val CHANNEL_ID_QUIET = "vault_service_quiet"`.
В `createChannel()` создать ОБА канала: существующий (`CHANNEL_ID`) и
`CHANNEL_ID_QUIET` с `NotificationManager.IMPORTANCE_LOW`.

### 3. onStartCommand — ветка eco
Сейчас логика: `if (pushMode && pushTopic != null) startNtfyStream() else nativeStartMonitor(...)`.
Добавить первой веткой:
```kotlin
if (ecoMode) {
    // ECO: процесс жив (звонки), но всё остальное выключено —
    // ни IMAP-монитора, ни ntfy-стрима, ни wakeLock.
    Log.i("VaultRust", "eco: quiet service started (live process, no locks)")
    return START_STICKY
}
```
Тихую нотификацию для eco надо ставить в `startForeground` — см. пункт 4.

### 4. startForeground по режиму
В начале `onStartCommand` выбираем нотификацию:
```kotlin
val notification = if (ecoMode) buildQuietNotification() else buildNotification()
```

### 5. ecoStop — НЕ убивать сервис, а переводить в тихий режим
Заменить тело `ecoStop(context)`:
```kotlin
@JvmStatic
fun ecoStop(context: Context) {
    ecoMode = true
    context.getSharedPreferences("vault_prefs", Context.MODE_PRIVATE)
        .edit().putBoolean("eco_mode", true).apply()
    val inst = instance
    if (inst != null) {
        // Сервис уже жив: снимаем locks, глушим ntfy-стрим,
        // меняем нотификацию на тихую — БЕЗ stopService.
        try { inst.stopNtfyStream() } catch (_: Throwable) {}
        try { inst.releaseLocks() } catch (_: Throwable) {}
        try {
            val nm = inst.getSystemService(NotificationManager::class.java)
            nm?.notify(NOTIF_ID, inst.buildQuietNotification())
        } catch (_: Throwable) {}
        Log.i("VaultRust", "eco: switched to quiet mode (service live)")
    } else {
        // Сервиса нет — поднимаем его, он стартанет тихим (ecoMode=true).
        try {
            val svc = Intent(context, VaultForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svc)
            } else {
                context.startService(svc)
            }
            Log.i("VaultRust", "eco: quiet service started (was not running)")
        } catch (e: Throwable) {
            Log.w("VaultRust", "eco quiet start failed: " + e.message)
        }
    }
}
```
Замечание: `ecoStoppedByUser` больше не выставляем и не читаем (см. п. 6).
Если на `ecoStoppedByUser` ссылаются другие места — оставь переменную,
но всегда `false`; не удаляй, если не уверен.

### 6. pushModeStop — убрать глушение сервиса в eco
Сейчас при `ecoModeEnabled(context)` вызывается `ecoStop()` и `return`.
После фикса ecoStop НЕ убивает сервис, поэтому вызов можно оставить,
НО важный момент: ниже по методу идёт `stopService` + `startForegroundService`
для классики. В eco-ветке должен быть только ecoStop (переключение в тихий
режим) — так что оставь структуру `if (ecoModeEnabled) { ecoStop(context); Log.i(...); return }`
без изменений по сути, но обнови текст лога на
`"pushMode off: eco mode — service switched to quiet"`.

### 7. onDestroy / onTaskRemoved — сервис всегда воскрешается
Удалить проверку `ecoStoppedByUser` из `onDestroy()` и `onTaskRemoved()`:
всегда вызывать `scheduleRestart(this)` и логировать
`"service resurrect scheduled (eco keeps process alive)"`.
 eco-режим больше не означает «пользователь остановил сервис».

### 8. Вспомогательный метод releaseLocks()
Вынести освобождение wakeLock/wifiLock в метод:
```kotlin
fun releaseLocks() {
    try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
    try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
    wakeLock = null
    wifiLock = null
}
```
И использовать его в `onDestroy()` и в `ecoStop` (через `instance`).
`onDestroy` по-прежнему должен вызвать `nativeStopMonitor()`.

## НЕ трогать
- `src-tauri/src/lib.rs` (`eco_set` вызывает `ecoStop`/`ecoStart` — сигнатуры
  static-методов `(Landroid/content/Context;)V` должны остаться без изменений).
- `src/features/relay.js` и остальной фронтенд.
- `MainActivity.kt` — там уже нужный фикс (сервис стартует всегда).

## Сборка (обязательно!)
```bash
export ANDROID_HOME=$HOME/Android/Sdk
export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/27.0.12077973
export PATH=/tmp/ndk-bin:$PATH:$ANDROID_HOME/platform-tools
export VAULT_KEYSTORE=$HOME/.local/share/vault/vault-release.keystore
export VAULT_KEYSTORE_PASS=$(cat $HOME/.local/share/vault/keystore-pass.txt)
export CARGO_NET_OFFLINE=true
cd /home/maksim/whisper/vault-desktop
npx tauri android build
```
Важно: НЕ запускать `./gradlew assembleArm64Debug` и НЕ ходить в
`gen/android` через gradlew напрямую — задача `rustBuildArm64Debug` падает с
`failed to build WebSocket client: Connection refused` (таури-обёртка рвётся
к dev-серверу). Используй только `npx tauri android build` — он рабочий.

APK появится в
`vault-desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`

## Установка и проверка на устройстве (adb уже подключён)
```bash
APK=vault-desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
$ANDROID_HOME/build-tools/35.0.0/apksigner sign \
  --ks ~/.android/debug.keystore --ks-pass pass:android \
  --key-pass pass:android --ks-key-alias androiddebugkey \
  --out /tmp/vault-eco-test2.apk "$APK"
adb -s 192.168.1.2:38815 install -r /tmp/vault-eco-test2.apk
adb -s 192.168.1.2:38815 shell am force-stop com.vault.vault
adb -s 192.168.1.2:38815 logcat -c
adb -s 192.168.1.2:38815 shell am start -n com.vault.vault/.MainActivity
sleep 12
PID=$(adb -s 192.168.1.2:38815 shell pidof com.vault.vault | head -1)
adb -s 192.168.1.2:38815 logcat -d -t 1200 | grep " $PID " | grep -iE "eco|foreground|service"
adb -s 192.168.1.2:38815 shell "dumpsys activity services com.vault.vault | grep ServiceRecord"
```

## Критерий готовности
1. `npx tauri android build` завершился успешно (APK свежий).
2. После старта приложения в логах НЕТ строк
   `eco: foreground service stopped` / `service stopped by user, no restart`.
3. В логах ЕСТЬ строка про тихий сервис (`eco: quiet service started` или
   `eco: switched to quiet mode`).
4. `dumpsys activity services com.vault.vault` показывает
   `ServiceRecord ... VaultForegroundService` — сервис ЖИВ.
5. Никаких других прав, кроме `VaultForegroundService.kt`, не внесено
   (проверь `git status`).

## Отчёт
В конце выведи:
- что именно изменено в Kotlin (краткий список методов);
- свежий лог eco-строк со смартфона;
- вывод `dumpsys activity services com.vault.vault`;
- `git status --short`.
