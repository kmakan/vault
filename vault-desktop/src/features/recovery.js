// Feature module: восстановление аккаунта из эскроу-письма по 12 словам.
// Изоляция фичи (правило канбан t_7c3929d2): новая фича — отдельный модуль,
// App.vue — только тонкий делегат; ВСЕ зависимости явные (ctx + инъекция
// { api, crypto, invoke }), поэтому модуль импортируется в Node без
// Tauri/Vue и покрывается smoke'ом напрямую. Новых npm-зависимостей нет.
//
// Поиск эскроу-письма среди последних писем ящика + распаковка backup по
// мнемонике. Вызывается ПОСЛЕ логина ДО initCrypto() — иначе создалась бы
// новая пара ключей.
//
// Устойчивость (fix/recovery-resilience): parse/unwrap ОТДЕЛЬНОГО кандидата
// оборачиваются в try/catch — чужое/битое эскроу-письмо НЕ обрывает поиск
// правильного. НО import_backup идёт ВНЕ этого catch: он частично меняет
// дисковое состояние, поэтому его сбой бросается вызывающему (его нельзя
// проглотить как чужое письмо или попытаться импортировать другой кандидат).
//
// recovery-session.js — pure persisted-маркер прерванного восстановления
// (не импортирует api/crypto, поэтому цикла нет): маркер запирает
// durable-авто-вход, пока восстановление не закоммичено.
import * as RecoverySession from './recovery-session.js';

// Reject an incomplete backup BEFORE import_backup can modify disk stores.
// In particular, `{}` used to be accepted as an import and initCrypto could
// then load an unrelated old key and silently call the restore successful.
function recoveryBackupPublicKey(jsonData) {
  const data = JSON.parse(jsonData);
  const kp = data && data.keys && data.keys.keypair;
  const hex64 = /^[0-9a-f]{64}$/i;
  if (!kp || !hex64.test(kp.public_key || '') || !hex64.test(kp.private_key || '') ||
      kp.public_key === kp.private_key || typeof kp.created_at !== 'string') {
    throw new Error('Invalid recovery backup: missing or invalid identity keypair');
  }
  return kp.public_key;
}

export async function recoverFromEscrow(ctx, mnemonic, { api, crypto, invoke }) {
  console.log('[recovery] step 1: validate mnemonic');
  if (!(await crypto.recoveryValidateMnemonic(mnemonic))) {
    throw new Error('Неверный формат ключа (нужно 12 слов)');
  }
  console.log('[recovery] step 2: fetch emails');
  const msgs = await api.fetchEmails(ctx.email);
  console.log('[recovery] step 3: got', msgs.length, 'msgs, filtering empty subject');
  const candidates = msgs.filter((m) => !(m.subject || '').trim()).slice(0, 80);
  console.log('[recovery] step 4: candidates', candidates.length, 'byFolder');
  const byFolder = {};
  for (const m of candidates) (byFolder[m.folder] = byFolder[m.folder] || []).push(m);
  for (const [folder, list] of Object.entries(byFolder)) {
    console.log('[recovery] step 5: fetch bodies from', folder, list.length, 'msgs');
    const uids = list.map((m) => m.uid);
    let bodies = [];
    try {
      bodies = await invoke('email_fetch_bodies', { uids: uids.map(String), folder });
    } catch (e) {
      // fetch_bodies по одной папке не критичен — пробуем следующую папку.
      console.warn('[recovery] fetch_bodies failed for a folder; skipping');
      continue;
    }
    console.log('[recovery] step 6: got', bodies.length, 'bodies, parsing');
    for (const [, body] of bodies || []) {
      // parse/unwrap кандидата НЕ бросают наружу: чужое или битое эскроу
      // не должно обрывать поиск правильного письма. Логи НЕ содержат
      // тело письма / wrapped / слова / backup / текст ошибки.
      let wrappedJson;
      try {
        wrappedJson = await crypto.recoveryParseEscrowEmail(body);
      } catch (e) {
        console.warn('[recovery] parse failed for a candidate; skipping');
        continue;
      }
      if (!wrappedJson) {
        console.log('[recovery]   parseEscrowEmail returned null');
        continue;
      }
      console.log('[recovery] step 7: unwrapping…');
      let backupJson;
      try {
        backupJson = await crypto.recoveryUnwrapBackup(wrappedJson, mnemonic);
      } catch (e) {
        console.warn('[recovery] unwrap failed for a candidate; skipping');
        continue;
      }
      // import_backup ВНЕ candidate-catch: частично меняет дисковое
      // состояние — его сбой нельзя проглотить как чужое письмо или
      // попытаться импортировать другой кандидат. Бросаем вызывающему.
      console.log('[recovery] step 8: import_backup');
      await invoke('import_backup', { jsonData: backupJson });
      return true;
    }
  }
  console.log('[recovery] no escrow found');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Полный вход-с-восстановлением (fix/recovery-resilience).
// Изоляция фичи: App.vue — только тонкий делегат, вся логика здесь.
//
// ПОЧЕМУ ТАК (а не «логин → импорт → isLoggedIn», как было):
//  1) Вход идёт ЧЕРЕЗ api.login (нужен ящик с эскроу-письмом), но обычный
//     login пишет durable token/email + credentials + миграцию СРАЗУ. Если
//     приложение закроется между логином и импортом ключа, durable-состояние
//     утвердит «вход выполнен», а ключей на диске нет — следующий старт
//     сгенерирует НОВУЮ пару и аккаунт будет потерян. Поэтому логин идёт с
//     deferPersistence:true, а durable-коммит — только после успеха.
//  2) initCrypto БЕЗ параметра генерировал новую пару, когда ключа нет.
//     После импорта ключ нужно ПЕРЕзагрузить, и генерация должна быть
//     запрещена: allowCreate:false. Нет загруженного ключа → ошибка, а не
//     новая пара.
//  3) Маркер 'vault-recovery-pending' ставится ПОСЛЕ проверки мнемоники и ДО
//     логина, снимается ПОСЛЕДНИМ — после durable commit. Любой провал
//     (сеть, эскроу не найдено, import, нет ключа, save_credentials) оставляет
//     маркер, и следующий старт не сделает молчаливый авто-вход/генерацию.
//  4) Файл резервной копии: ошибка импорта ПРОПАГИРУЕТСЯ в UI и НЕ приводит к
//     фолбэку на эскроу. import_backup частично меняет диск — после его сбоя
//     нельзя пытаться другой backup.
//
// ctx — экземпляр App (initCrypto/initLocalDb/load*/startPolling/toast и т.д.).
// Все зависимости инъектируются: модуль импортируется в Node без Vue/Tauri.
// Логи НЕ содержат пароль/слова/тело письма/backup.
export async function loginWithRecovery(ctx, deps) {
  const { api, crypto, invoke, db, relay, RelayFeature, initNotifications, t } = deps || {};
  const tr = (key, fallback) => {
    const v = typeof t === 'function' ? t(key) : '';
    return v || fallback;
  };
  ctx.loginLoading = true;
  ctx.loginError = '';
  try {
    const words = (ctx.recoveryWordsInput || '').trim();
    // 0) Слова обязательны и должны быть валидны ДО маркера: невалидная
    //    мнемоника не должна запирать экран восстановления.
    if (!(await crypto.recoveryValidateMnemonic(words))) {
      throw new Error(tr('recovery_invalid', 'recovery_invalid'));
    }
    // 1) Маркер ДО попытки логина: с этого момента durable-авто-вход запрещён.
    if (!RecoverySession.markRecoveryPending()) {
      throw new Error(tr('recovery_state_unavailable', 'recovery_state_unavailable'));
    }
    const config = {};
    if ((ctx.imapServer || '').trim()) config.imap_server = ctx.imapServer.trim();
    if ((ctx.imapPort || '').trim()) config.imap_port = parseInt(ctx.imapPort.trim(), 10);
    if ((ctx.smtpServer || '').trim()) config.smtp_server = ctx.smtpServer.trim();
    if ((ctx.smtpPort || '').trim()) config.smtp_port = parseInt(ctx.smtpPort.trim(), 10);
    // 2) Логин БЕЗ durable-персиста (память + IMAP-сессия только).
    const data = await api.login(ctx.email, ctx.password, {
      remember: ctx.rememberMe,
      config,
      deferPersistence: true,
    });
    ctx.userId = data.user_id;

    let expectedPublicKey = null;
    const importInvoke = async (command, args) => {
      if (command === 'import_backup') {
        expectedPublicKey = recoveryBackupPublicKey(args.jsonData);
      }
      return invoke(command, args);
    };

    // 3) Импорт ключа. Файл — приоритетный путь; его ошибка видима и НЕ
    //    откатывается на эскроу (import частично меняет диск).
    let restored = false;
    const fileJson = (ctx.recoveryFileJson || '').trim();
    if (fileJson) {
      // JSON.parse бросает на битом файле — ошибка уходит в UI (молчаливого
      // «не восстановилось, но вход прошёл» быть не должно).
      JSON.parse(fileJson);
      await importInvoke('import_backup', { jsonData: fileJson });
      restored = true;
    }
    if (!restored) {
      restored = await recoverFromEscrow(ctx, words, { api, crypto, invoke: importInvoke });
    }
    if (!restored) {
      throw new Error(tr('recovery_not_found', 'recovery_not_found'));
    }

    // 4) Перезагрузка ВОССТАНОВЛЕННОГО ключа ДО isLoggedIn/commit.
    //    allowCreate:false — генерация новой пары здесь недопустима: import
    //    либо положил ключ, либо это ошибка (recovery_missing_keys).
    const keyLoaded = await ctx.initCrypto({ allowCreate: false });
    if (!keyLoaded || ctx.publicKey !== expectedPublicKey) {
      throw new Error(tr('recovery_missing_keys', 'recovery_missing_keys'));
    }

    // 5) Durable-коммит: только теперь вход становится настоящим.
    //    Маркер снимается внутри, последним шагом.
    await api.commitRecoveryLogin({ remember: ctx.rememberMe });

    // 6) Дальше — обычный пост-логиновый путь (порядок как в login()).
    ctx.isLoggedIn = true;
    initNotifications().catch(() => {}); // push-уведомления (не блокирует вход)
    await ctx.initLocalDb(); // sqlite: tombstones + курсоры для аккаунта
    ctx.loadUnreadCounts();
    ctx.loadLocalProfiles();
    // 0.1.180: инициализация релей/eco (зеркало login/auto-login): дефолт —
    // релей ВКЛ (free-100/день) → eco, foreground-служба не поднимается.
    // Явный выбор юзера (KV '0') уважается навсегда.
    ctx.ecoMode = (await db.kvGet('anon', 'eco-mode')) === '1';
    try {
      const rs = await relay.getSettings(ctx.email);
      ctx.relayEnabled = rs.enabled;
      if (ctx.relayEnabled) {
        await RelayFeature.syncEcoWithRelay(ctx, true).catch(() => {});
        ctx.ecoMode = (await db.kvGet('anon', 'eco-mode')) === '1';
      }
    } catch (e) { /* релей опционален */ }
    await ctx.loadBodyCache();
    await ctx.loadContacts();
    await ctx.loadGroups();
    try { await ctx.loadChannels(); } catch (e) { /* не критично */ }
    if (ctx.ecoMode) { ctx.onEcoMode(true, true).catch(() => {}); }
    ctx.startPolling();
    if (ctx.ecoMode) { ctx.startPolling(60000); ctx.startRelayTicker(); }
    else ctx.idleLoop();
    ctx.loadEmails().catch(() => {});
    ctx.showToast(tr('recovery_ok', 'recovery_ok'));
  } catch (error) {
    // Провал: маркер ОСТАЁТСЯ (его снимает только commitRecoveryLogin), поэтому
    // следующий старт не сделает авто-вход без ключей. Память сессии
    // сбрасываем БЕЗ logout() — logout() вызывает delete_credentials и стёр бы
    // сохранённый пароль пользователя, а провал восстановления не имеет на это
    // права. Durable token/email/credentials/ключи не трогаем.
    ctx.isLoggedIn = false;
    ctx.loginError = (error && error.message) || String(error);
    try { api.abandonSessionMemory(); } catch (e) { /* память и так не persists */ }
  } finally {
    ctx.loginLoading = false;
  }
}
