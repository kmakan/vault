package com.vault.vault

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import android.provider.Settings
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  // Фоновый приём звонков: держим ссылку на WebView, чтобы не давать
  // ему замерзать в onPause — иначе JS-таймеры (idleLoop / IMAP IDLE) встают
  // и входящие звонки не доходят, пока приложение свёрнуто.
  private var keepAliveWebView: WebView? = null

  companion object {
    init {
      // Идемпотентно: Rust.kt уже грузит ту же lib, но гарантируем, что
      // native-символы доступны до первого вызова external fun.
      System.loadLibrary("vault_desktop")
    }

    // Статический мост для нативных кнопок уведомления: ACCEPT /
    // REJECT из шторки дергают JS-функции window.__vaultAcceptCall() /
    // window.__vaultRejectCall() через живой WebView (keep-alive), минуя
    // рестарт UI и рассинхрон state machine.
    @JvmStatic
    fun dispatchCallAction(action: String) {
      val js = when (action) {
        "accept" -> "window.__vaultAcceptCall && window.__vaultAcceptCall()"
        "reject" -> "window.__vaultRejectCall && window.__vaultRejectCall()"
        else -> return
      }
      val wv = liveWebView ?: run {
        // Живого WebView нет — приложение только что поднято из уведомления
        // (кнопка «Ответить» при закрытом приложении). Решение НЕ теряем:
        // запоминаем и отдадим в onWebViewCreate, как только фронт готов.
        // Иначе call_request из очереди реля поднимет звонок в incoming_ringing,
        // а нажатие кнопки молча пропадёт.
        pendingCallAction = action
        Log.i("VaultRust", "dispatchCallAction(): queued (no live WebView) — $action")
        return
      }
      wv.post {
        wv.evaluateJavascript(js, null)
        Log.i("VaultRust", "dispatchCallAction($action): JS dispatched")
      }
    }

    // S6: приложение открыли ради входящего звонка (уведомление, локскрин,
    // автозапуск из сервиса). Отдаём JS call_id, чтобы он показал ЭКРАН
    // ПРИЁМА/ОТКЛОНЕНИЯ этого звонка. Если WebView ещё холодный — запоминаем
    // и отдадим в onWebViewCreate (как pendingCallAction).
    @JvmStatic
    fun dispatchIncomingCall(callId: String) {
      val safe = callId.replace("\\", "\\\\").replace("'", "\\'")
      val js = "window.__vaultIncomingCall && window.__vaultIncomingCall('$safe')"
      val wv = liveWebView
      if (wv == null) {
        pendingIncomingCallId = callId
        Log.i("VaultRust", "dispatchIncomingCall: queued (no live WebView) — $callId")
        return
      }
      wv.post {
        wv.evaluateJavascript(js, null)
        Log.i("VaultRust", "dispatchIncomingCall($callId): JS dispatched")
      }
    }

    // S6: call_id, для которого нужно показать экран звонка, но WebView ещё
    // не создан. Одноразовое значение (забирается в onWebViewCreate).
    @JvmStatic
    var pendingIncomingCallId: String? = null

    // M2.4: ntfy-пуш Click vault://open?chat=<email> → открыть чат.
    // Вызывается из onResume/onNewIntent (activity), JS сам выберет чат.
    @JvmStatic
    fun dispatchOpenChat(chat: String) {
      val esc = chat.replace("\\", "\\\\").replace("'", "\\'")
      val js = "window.__vaultOpenChat && window.__vaultOpenChat('$esc')"
      val wv = liveWebView
      if (wv == null) {
        // WebView ещё не создан (холодный старт) — запомним, dispatch
        // произойдёт в onWebViewCreate.
        pendingOpenChat = chat
        Log.i("VaultRust", "dispatchOpenChat: deferred (no WebView yet)")
        return
      }
      wv.post {
        wv.evaluateJavascript(js, null)
        Log.i("VaultRust", "dispatchOpenChat($chat): JS dispatched")
      }
    }

    @JvmStatic
    var pendingOpenChat: String? = null

    // S5-2 (контракт C): решение, принятое кнопкой уведомления, пока
    // WebView ещё не создан. Действует ОДИН раз: JS заберёт его через
    // __vaultApplyPendingCallDecision при обработке call_request.
    @JvmStatic
    var pendingCallAction: String? = null

    // S5-2 (контракт A/B): видимость приложения. Пока true — входящий
    // звонок обслуживает ТОЛЬКО in-app CallOverlay (свайпы + HTML5-рингтон),
    // нативное уведомление и MediaPlayer-рингтон не поднимаются.
    // Ставится в onResume/onPause MainActivity; читает VaultForegroundService.
    @JvmStatic
    var appVisible: Boolean = false

    // WebView живёт в activity-процессе. Статик-ссылка
    // ставится в onWebViewCreate, снимается в onDestroy.
    private var liveWebView: WebView? = null

    // Геттер для других классов процесса (VaultForegroundService —
    // завершение голосового): R8 видит Java-колера, не переименует.
    @JvmStatic
    fun liveWebViewPublic(): WebView? = liveWebView
  }
  // ndk-context: tao 0.35 НЕ инициализирует crate ndk-context, из-за
  // чего Rust-звонки падали с «android context was not initialized». Пробрасы-
  // ваем контекст явно; реализация — src-tauri/src/audio/audio_android.rs.
  private external fun nativeInitAndroidContext(context: android.content.Context)

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    try {
      nativeInitAndroidContext(applicationContext)
      Log.i("VaultRust", "ndk-context initialized from Kotlin")
    } catch (e: Throwable) {
      Log.e("VaultRust", "ndk-context init failed: " + e.message)
    }
    // Звонки: на Android 13+ микрофон требует runtime-разрешения
    // а не только записи в манифесте. cpal/AAudio без него падает при
    // старте audio-пайплайна после connected → приложение сворачивалось.
    // Запрашиваем один раз при запуске (пользователь видит системный
    // диалог «Разрешить запись аудио?»).
    try {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
          != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(
          this,
          arrayOf(Manifest.permission.RECORD_AUDIO),
          1001
        )
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "RECORD_AUDIO request failed: " + e.message)
    }

    // Android 13+: уведомление foreground-сервиса требует runtime-разрешения.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
          ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
          != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(
          this,
          arrayOf(Manifest.permission.POST_NOTIFICATIONS),
          1002
        )
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "POST_NOTIFICATIONS request failed: " + e.message)
    }

    // FCM Part B: получить reg_token и зарегистрировать его на relay
    // (POST /relay/fcm/register). getToken кэшируется Firebase — запрос
    // дешёвый, но всё равно делаем его в фоне: onCreate не должен ждать сеть.
    // onNewToken (ротация токена) подхватит сам в FCM-сервисе.
    try {
      com.google.firebase.messaging.FirebaseMessaging.getInstance().token
        .addOnSuccessListener { t ->
          try {
            VaultFirebaseMessagingService.saveRegToken(applicationContext, t)
            VaultFirebaseMessagingService.registerDevice(applicationContext)
            Log.i("VaultFCM", "reg_token fetched, registration requested")
          } catch (e: Throwable) {
            Log.w("VaultFCM", "token handling failed: " + e.message)
          }
        }
        .addOnFailureListener { e ->
          Log.w("VaultFCM", "getToken failed: " + e.message)
        }
    } catch (e: Throwable) {
      Log.w("VaultFCM", "getToken unavailable: " + e.message)
    }

    // Исключение из оптимизации батареи: без него Doze замораживает
    // foreground-сервис и IMAP IDLE-цикл — входящие звонки не доходят при
    // выключенном экране. ВАЖНО: системный диалог ACTION_REQUEST_IGNORE_...
    // открывается ПОВЕРХ приложения и уводит его в фон.
    // при КАЖДОМ onCreate → «приложение само сворачивается». Теперь запрос
    // ОДНОРАЗОВЫЙ (флаг в SharedPreferences) — больше не дёргаем.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val prefs = getSharedPreferences("vault_prefs", MODE_PRIVATE)
        val asked = prefs.getBoolean("battery_opt_asked", false)
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        if (!asked && !pm.isIgnoringBatteryOptimizations(packageName)) {
          prefs.edit().putBoolean("battery_opt_asked", true).apply()
          val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = android.net.Uri.parse("package:$packageName")
          }
          startActivity(intent)
        }
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "battery-optimization request failed: " + e.message)
    }

    // Отображение поверх окон: с этим правом Android разрешает запуск
    // MainActivity из фонового сервиса — экран звонка открывается сам при
    // свёрнутом приложении (иначе heads-up «откройте Vault»).
    // ВАЖНО: системный экран ACTION_MANAGE_OVERLAY_PERMISSION — это полный
    // список «все приложения с тумблером». Без флага он открывался ПРИ КАЖДОМ
    // onCreate (каждый холодный старт) и выглядел как «приложение выбора
    // приложений». Теперь запрос ОДНОРАЗОВЫЙ — как у battery-optimization.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
        val prefs = getSharedPreferences("vault_prefs", MODE_PRIVATE)
        if (!prefs.getBoolean("overlay_asked", false)) {
          prefs.edit().putBoolean("overlay_asked", true).apply()
          val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            android.net.Uri.parse("package:$packageName")
          )
          startActivity(intent)
          Log.i("VaultRust", "asked overlay permission (screen-over-apps)")
        } else {
          Log.i("VaultRust", "overlay permission still not granted; not nagging (asked before)")
        }
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "overlay permission request failed: " + e.message)
    }

    // Full-screen уведомления звонков: на Android 14+ (API 34)
    // USE_FULL_SCREEN_INTENT стало СПЕЦИАЛЬНЫМ разрешением — оно НЕ
    // выдаётся автоматически, и без него setFullScreenIntent молча
    // деградирует в heads-up («маленькое окно» вместо экрана звонка).
    // Открываем системную страницу, чтобы пользователь включил его.
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        if (!nm.canUseFullScreenIntent()) {
          val intent = Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
            data = android.net.Uri.parse("package:$packageName")
          }
          startActivity(intent)
          Log.i("VaultRust", "opened full-screen-intent settings page")
        }
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "full-screen-intent permission request failed: " + e.message)
    }

    // Headless-монитор: activity ЖИВА — JS (keep-alive WebView)
    // доставляет сам даже свёрнутым, монитор молчит до onDestroy.
    // ВАЖНО: onCreate основной темы → startForegroundService; сервисный
    // onStartCommand на main-потоке выполнится ПОСЛЕ onResume, т.е. монитор
    // стартует уже с paused=true в activity-процессе (нет дублей с JS).
    try { nativePauseMonitor(true) } catch (_: Throwable) {}

    // Замок при холодном старте: если PIN установлен и сессия не разблокирована —
    // сразу LockActivity (например, система убила процесс; юзер снова открыл).
    try {
      val prefs = getSharedPreferences("vault_duress", MODE_PRIVATE)
      val en = prefs.getBoolean("lock_enabled", false)
      val hasHash = !prefs.getString("pin_hash", null).isNullOrEmpty()
      val unlocked = prefs.getBoolean("unlocked", true)
      Log.i("VaultRust", "[lock] cold-start check: enabled=$en hash=$hasHash unlocked=$unlocked")
      // ничего не стартуем: onCreate→onResume всё равно покажет замок, а
      // два LockActivity в стеке требовали двойного ввода кода.
    } catch (e: Throwable) {
      Log.w("VaultRust", "lock onCreate failed: " + e.message)
    }

    // Foreground-сервис: держит процесс живым в фоне (приём звонков).
    // 0.1.181: в eco (релей жив) сервис НЕ стартуем вовсе — доставка в фоне
    // несёт отдельный ntfy-клиент (UnifiedPush), FGS = иконка в шторке, а
    // Android API31+ прицеливает ЛЮБОЕ FGS-уведомление до LOW. Классический
    // (не-eco) режим — стартуем как раньше.
    val ecoOn = try { VaultForegroundService.ecoModeEnabled(this) } catch (e: Throwable) { false }
    if (ecoOn) {
      // ЭКО-НЕЗАВИСИМОСТЬ: сервис в эко поднимаем В ТИХОМ режиме (quiet FGS,
      // IMPORTANCE_MIN — в шторке не рендерится). Раньше здесь был отказ от
      // старта, и вместе с ним исчезал носитель доставки: при упавшем релее
      // никто (ни эко-тикер в WebView, ни FCM) не мог переключить доставку на
      // почту. Тихий сервис нужен ровно для этого — health-чек релея каждые
      // 60с и переход в классический (IMAP) режим, если релей недоступен.
      try {
        val svc = Intent(this, VaultForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          startForegroundService(svc)
        } else {
          startService(svc)
        }
        VaultForegroundService.enterEcoRelayWatch(this)
        Log.i("VaultRust", "eco mode: quiet service started (relay delivery + mail fallback armed)")
      } catch (e: Throwable) {
        Log.w("VaultRust", "eco quiet startForegroundService failed: " + e.message)
      }
    } else {
      try {
        val svc = Intent(this, VaultForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          startForegroundService(svc)
        } else {
          startService(svc)
        }
      } catch (e: Throwable) {
        Log.w("VaultRust", "startForegroundService failed: " + e.message)
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    keepAliveWebView = webView
    liveWebView = webView
    // S5-2 (контракт C): отдаём решение, накопленное кнопкой уведомления
    // (accept/reject), пока живого WebView ещё не было. Фронт положит его
    // в очередь (setPendingNativeCallDecision) и применит ровно к тому
    // call_request, который придёт из очереди реля.
    pendingCallAction?.let { act ->
      pendingCallAction = null
      webView.post {
        // Страница могла ещё не прогрузить App.vue (окно __vaultApplyPending-
        // CallDecision не определено) — короткий повтор, не чаще 5×100мс.
        var attempt = 0
        val deliver = object : Runnable {
          override fun run() {
            // Вкладываем $act ('accept'/'reject') в JS-вызов. act — строгий
            // бинарный набор (guard setPendingNativeCallDecision), но на
            // всякий случай экранируем кавычки.
            val actJs = act.replace("\\", "\\\\").replace("'", "\\'")
            webView.evaluateJavascript(
              "(function(){ if (window.__vaultApplyPendingCallDecision) {" +
                " window.__vaultApplyPendingCallDecision('$actJs'); return 1; } return 0; })()",
              { res ->
                val ok = res != null && res.contains("1")
                Log.i("VaultRust", "queued call action delivered: $act (ok=$ok)")
                if (!ok && attempt < 5) { attempt++; webView.postDelayed(this, 100) }
              }
            )
          }
        }
        webView.postDelayed(deliver, 100)
      }
    }
    // S6: приложение открыто ради входящего звонка, а WebView был холодным —
    // отдаём JS call_id экрана звонка (тем же ретрай-паттерном, что и решение
    // кнопок уведомления: страница могла ещё не определить window-хук).
    pendingIncomingCallId?.let { cid ->
      pendingIncomingCallId = null
      webView.post {
        var attempt = 0
        val deliver = object : Runnable {
          override fun run() {
            val cidJs = cid.replace("\\", "\\\\").replace("'", "\\'")
            webView.evaluateJavascript(
              "(function(){ if (window.__vaultIncomingCall) {" +
                " window.__vaultIncomingCall('$cidJs'); return 1; } return 0; })()",
              { res ->
                val ok = res != null && res.contains("1")
                Log.i("VaultRust", "queued incoming call delivered: $cid (ok=$ok)")
                if (!ok && attempt < 5) { attempt++; webView.postDelayed(this, 100) }
              }
            )
          }
        }
        webView.postDelayed(deliver, 100)
      }
    }
    // Гео для SOS: WebView должен разрешать
    // navigator.geolocation для tauri://localhost (prompt ниже выдаёт грант).
    try {
      val settings = webView.settings
      settings.setGeolocationEnabled(true)
      webView.webChromeClient = object : android.webkit.WebChromeClient() {
        override fun onGeolocationPermissionsShowPrompt(
          origin: String?,
          callback: android.webkit.GeolocationPermissions.Callback?
        ) {
          // Runtime-запрос при первом вызове navigator.geolocation: WebView
          // prompt → мы просим системное разрешение и отвечаем грантом после.
          if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION)
              != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
              this@MainActivity,
              arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
              1003
            )
          }
          callback?.invoke(origin, true, false)
        }
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "geolocation webview setup failed: " + e.message)
    }
    // M2.4: отложенный ntfy-клик (холодный старт). ГОНКА ФИКС: раньше писали
    // в localStorage прямо здесь — но страница ещё не загружена, LS=null,
    // setItem тихо падал в try-catch. Теперь: (1) пробуем LS (вдруг страница
    // уже готова), (2) регистрируем JS-мост __vaultTakePendingChat() —
    // фронт ВЫЗЫВАЕТ его сам, когда DOM и очередь готовы (главная инициализация
    // App.vue). Мост синхронный через evaluateJavascript-поллинг: кладём
    // значение в window.__vaultPendingChat, фронт читает и чистит.
    pendingOpenChat?.let { chat ->
      webView.evaluateJavascript(
        "try { localStorage.setItem('vault-pending-chat', '" + chat.replace("'", "\\'") + "'); } catch (e) {}", null
      )
      // Мост: фронт дергает __vaultTakePendingChat() — получит chat или null.
      webView.addJavascriptInterface(object {
        @android.webkit.JavascriptInterface
        fun take(): String? {
          val v = pendingOpenChat
          pendingOpenChat = null
          return v
        }
      }, "VaultDeepLink")
    }
    // FCM Part B: мост VaultFcm — фронт отдаёт read-токен и адрес релея
    // (в kv, недоступном нативному слою), нативный слой регистрирует
    // FCM reg_token на relay (POST /relay/fcm/register). Без этого пуши
    // ПРИХОДЯТ, но relay их не отправляет (нет reg_token у темы).
    try {
      webView.addJavascriptInterface(object {
        @android.webkit.JavascriptInterface
        fun register(relayUrl: String?, readToken: String?, fp: String?) {
          VaultFirebaseMessagingService.setRelayCredentials(
            applicationContext, relayUrl, readToken, fp
          )
          VaultFirebaseMessagingService.registerDevice(applicationContext)
          Log.i("VaultFCM", "relay credentials received from JS, registering")
        }
      }, "VaultFcm")
    } catch (e: Throwable) {
      Log.w("VaultFCM", "VaultFcm bridge failed: " + e.message)
    }
    // FCM Part B: повторная регистрация при каждом создании WebView — дёшево
    // (защищено кэшем reg_token+url в prefs) и чинит кейс «токен сменился,
    // пока приложение было убито», а также «креды релея пришли позже».
    try { VaultFirebaseMessagingService.registerDevice(this) } catch (_: Throwable) {}

    // JS-мост: фронт вызывает window.__vaultRequestGeo() при включении гео-опции SOS —
    // он проксирует в статический requestGeoPermission() (companion), который
    // запрашивает runtime-разрешение у activity.
    webView.evaluateJavascript(
      "window.__vaultRequestGeo = function() { window.__vaultGeoBridge && window.__vaultGeoBridge(); };", null
    )
  }

  // M2.4: отложенный ntfy-клик (холодный старт) — открываем чат.
  private fun dispatchPendingOpenChat() {
    pendingOpenChat?.let { chat ->
      pendingOpenChat = null
      dispatchOpenChat(chat)
    }
  }

  override fun onPause() {
    super.onPause()
    // S5-2: приложение ушло в фон → возвращаем нативный путь показа
    // звонка (уведомление + рингтон + кнопки). Keep-alive WebView НЕ трогаем.
    appVisible = false
    // Замок: при уходе из приложения — сброс «разблокирован» и показ
    // LockActivity при следующем возврате.
    try {
      // на миг» — task-механика Android: отдельный task LockActivity оставался
      // позади при возврате). Армирование перенесено в onResume — замок
      // показывается ПОВЕРХ MainActivity в момент возврата.
      val prefs = getSharedPreferences("vault_duress", MODE_PRIVATE)
      prefs.edit().putBoolean("unlocked", false)
        .putLong("last_pause_ms", System.currentTimeMillis())
        .putBoolean("last_pause_started_lock", false)
        .apply()
      Log.i("VaultRust", "[lock] onPause: armed (enabled=" + prefs.getBoolean("lock_enabled", false) +
        " hashLen=" + (prefs.getString("pin_hash", null)?.length ?: 0) + ")")
    } catch (e: Throwable) {
      Log.w("VaultRust", "lock onPause failed: " + e.message)
    }
    // WryActivity.onPause вызывает mWebView.onPause(), что ставит JS на паузу.
    // Сразу возвращаем WebView в resumed-состояние: JS-цикл IMAP IDLE продолжает
    // работать в фоне, входящие call_request доходят без разворачивания приложения.
    try {
      keepAliveWebView?.onResume()
    } catch (e: Throwable) {
      Log.w("VaultRust", "webview keep-alive onResume failed: " + e.message)
    }
    // Headless-монитор: паузу НЕ снимаем здесь — JS keep-alive ещё может
    // доставить, пока активность видима (диалог поверх, кратковременный уход).
    // Снятие паузы — в onStop (приложение реально не видно).
  }

  // ДОСТАВКА БЕЗ РЕЛЕЯ (и без работы JS в фоне): приложение НЕ ВИДНО
  // (Home/другой экран/погашенный экран) — JS-цикл троттлится и письмо-вызов
  // успевает истечь по 10-минутному порогу, а headless-монитор молчал, считая
  // что «JS доставит сам» (флаг paused снимался только в onDestroy). В итоге
  // при недоступном релее звонок не доходил вовсе. Теперь при невидимости
  // активность отдаёт доставку нативному IMAP-монитору (IDLE → decrypt →
  // showMessage/showIncomingCall), а при возврате в UI (onResume) — снова JS.
  override fun onStop() {
    super.onStop()
    try {
      appVisible = false
      nativePauseMonitor(false)
      Log.i("VaultRust", "onStop: headless monitor un-paused (app not visible)")
    } catch (e: Throwable) {
      Log.w("VaultRust", "onStop nativePauseMonitor(false) failed: " + e.message)
    }
  }

  // Headless-монитор: Rust-сторона держит монитор на паузе, пока
  // жива MainActivity (JS доставляет всё сам — без дублей уведомлений).
  // Символ в VaultForegroundService — там живёт монитор.
  private external fun nativePauseMonitor(paused: Boolean)

  override fun onResume() {
    super.onResume()
    // S5-2 (контракт A): приложение видимо — входящий звонок обслуживает
    // ТОЛЬКО in-app CallOverlay. Если нативное уведомление/рингтон уже
    // поднято (пользователь открыл приложение во время гудка) — снимаем
    // его сейчас; безопасный no-op, если показывать было нечего.
    appVisible = true
    // S6 (директива пользователя): выход приложения на передний план НЕ
    // завершает звонок — гасим только НАТИВНЫЙ рингтон (экран звонка в
    // приложении играет свой). Раньше здесь стоял dismissIncomingCall:
    // он рвал вызов раньше, чем JS успевал подхватить его — баг
    // «Ответить → экран не появился, вызов сброшен».
    try { VaultForegroundService.stopCallRingtoneOnly() }
    catch (e: Throwable) { Log.w("VaultRust", "onResume stopCallRingtoneOnly: " + e.message) }
    // S6: приложение открыто ИЗ-ЗА входящего звонка — сразу сообщаем JS,
    // какой call_id показывать (экран приёма/отклонения).
    try {
      intent?.getStringExtra(VaultForegroundService.EXTRA_CALL_NOTIF_ID)
        ?.takeIf { it.isNotEmpty() }
        ?.let { dispatchIncomingCall(it) }
    } catch (_: Throwable) {}
    // M2.4: ntfy Click vault://open?chat=<email> → открыть чат.
    handleVaultDeepLink(intent)
    // Пока открыт UI, доставку ведёт JS — headless-монитор молчит.
    try { nativePauseMonitor(true) } catch (_: Throwable) {}
    // Тихие FCM-уведомления о сообщениях (VaultFirebaseMessagingService,
    // фиксированный MSG_NOTIF_ID) — пользователь открыл приложение, сообщение
    // прочитано. Раньше id был (currentTimeMillis() % 100000) — отменить
    // снаружи было нельзя, «значок службы» висел в шторке.
    try {
      getSystemService(NotificationManager::class.java)
        ?.cancel(VaultFirebaseMessagingService.MSG_NOTIF_ID)
    } catch (_: Throwable) {}
    // Замок: вернулись в приложение — если PIN установлен и сессия
    // не разблокирована, показываем LockActivity ПОВЕРХ (same task, без
    // FLAG_ACTIVITY_NEW_TASK — он ломал видимость «мигнувшим» замком).
    try {
      val prefs = getSharedPreferences("vault_duress", MODE_PRIVATE)
      val en = prefs.getBoolean("lock_enabled", false)
      val hasHash = !prefs.getString("pin_hash", null).isNullOrEmpty()
      val unlocked = prefs.getBoolean("unlocked", true)
      Log.i("VaultRust", "[lock] onResume: enabled=$en hash=$hasHash unlocked=$unlocked")
      if (en && hasHash && !unlocked) {
        Log.i("VaultRust", "[lock] onResume → showing LockActivity over UI")
        startActivity(android.content.Intent(this, LockActivity::class.java))
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "lock onResume failed: " + e.message)
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // S6: activity уже жила — пришёл интент экрана звонка (повторный
    // входящий / раскрытие из уведомления). Отдаём call_id в JS.
    try {
      intent.getStringExtra(VaultForegroundService.EXTRA_CALL_NOTIF_ID)
        ?.takeIf { it.isNotEmpty() }
        ?.let { dispatchIncomingCall(it) }
    } catch (_: Throwable) {}
    handleVaultDeepLink(intent)
  }

  private fun handleVaultDeepLink(intent: Intent?) {
    try {
      val data = intent?.data ?: return
      if (data.scheme != "vault") return
      val chat = data.getQueryParameter("chat") ?: return
      if (chat.isEmpty()) return
      Log.i("VaultRust", "deep link: open chat $chat")
      dispatchOpenChat(chat)
    } catch (e: Throwable) {
      Log.w("VaultRust", "deep link failed: " + e.message)
    }
  }

  override fun onDestroy() {
    // Activity уничтожена (системой или смахиванием): JS с WebView умрёт —
    // снимаем паузу, headless-монитор подхватывает доставку уведомлений,
    // пока процесс (FGS) ещё жив или перезапущен системой без activity.
    try { nativePauseMonitor(false) } catch (_: Throwable) {}
    // ЭКО-НЕЗАВИСИМОСТЬ: activity уничтожена, но эко-служба (тихий FGS +
    // health-чек релея) обязана продолжить следить за релеем — иначе фолбэк
    // на почту не наступит, пока пользователь не откроет приложение.
    try {
      if (VaultForegroundService.ecoModeEnabled(this)) {
        VaultForegroundService.enterEcoRelayWatch(applicationContext)
        Log.i("VaultRust", "MainActivity destroyed (eco): relay health-check re-armed")
      }
    } catch (e: Throwable) {
      Log.w("VaultRust", "eco watch re-arm on destroy failed: " + e.message)
    }
    keepAliveWebView = null
    liveWebView = null
    super.onDestroy()
  }
}
