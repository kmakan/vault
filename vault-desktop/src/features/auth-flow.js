// Вход и смена почты — ADR-005 W3.
//
// Сценарий входа — длинный (почта → крипто-пара → локальная БД → контакты →
// группы → фоновые загрузки), и в нём есть правила, которые легко потерять
// при переносе:
//
//  * ПРЕРВАННОЕ ВОССТАНОВЛЕНИЕ — обычный вход НЕ МОЖЕТ обойти его: пока
//    стоит маркер 'vault-recovery-pending', api.login + initCrypto создали бы
//    НОВУЮ пару ключей вместо восстановленной и затерли бы личность аккаунта.
//    Маркер снимает только успешный commitRecoveryLogin.
//  * КРИПТО-ПАРА. Обычному входу создание ключа РАЗРЕШЕНО (это не старт и не
//    восстановление). Если не удалось ни загрузить, ни создать ключ — входа
//    нет, и ошибка видна пользователю.
//  * КЭШ ИМЕНИ. Namespace = fp:<fingerprint>. На ручном входе initCrypto из
//    mounted уже отработал, но мог сработать ДО появления email — тогда кэш
//    резолвера остался на legacy-адресе и миграция не запустилась бы. Сбрасываем
//    кэш и переносим накопленные email-строки один раз.
//  * СКОРОСТЬ ВХОДА. UI готов сразу, фетч почты — в фоне (не блокирует вход).
//
// deps (ADR-001 R3): всё, что нужно снаружи, — явными параметрами; модули
// импортируются напрямую (api/crypto/identity/relay — примитивы), а
// ФИЧИ (recovery-session, relay-эко, загрузка писем) — через контракт:
// фича не знает про фичу (ADR-004).
import api, { db } from '../api.js';
import { ensureAccountNamespace, resetAccountNamespaceCache } from '../identity.js';
import * as relay from '../relay-client.js';

export async function login(deps) {
  // Обычный вход НЕ МОЖЕТ обойти прерванное восстановление
  // (fix/recovery-resilience): пока маркер 'vault-recovery-pending' стоит,
  // api.login + initCrypto({allowCreate:true}) создали бы НОВУЮ пару
  // вместо восстановленной и затирали бы личность аккаунта. Оставляем
  // пользователя на форме восстановления с переведённым сообщением.
  // Маркер снимает только успешный commitRecoveryLogin.
  deps.setLoginLoading(true);
  deps.setLoginError('');
  try {
    if (deps.isRecoveryPending()) {
      deps.setShowRecovery(true);
      deps.setLoginError(deps.tr('recovery_interrupted') || 'recovery_interrupted');
      return;
    }
    // Пользовательские настройки серверов (если заполнены) — иначе
    // дефолты Gmail внутри emailConnect.
    const config = {};
    const imapServer = deps.imapServer().trim();
    const imapPort = deps.imapPort().trim();
    const smtpServer = deps.smtpServer().trim();
    const smtpPort = deps.smtpPort().trim();
    if (imapServer) config.imap_server = imapServer;
    if (imapPort) config.imap_port = parseInt(imapPort, 10);
    if (smtpServer) config.smtp_server = smtpServer;
    if (smtpPort) config.smtp_port = parseInt(smtpPort, 10);
    const data = await api.login(deps.email(), deps.password(), { remember: deps.rememberMe(), config });
    deps.setUserId(data.user_id);
    // Новому пользователю нужна крипто-пара — здесь генерация РАЗРЕШЕНА
    // (явный обычный вход, а не старт/восстановление). Если не удалось ни
    // загрузить, ни создать ключ — входа нет (ошибка видна в finally).
    const cryptoReady = await deps.initCrypto({ allowCreate: true });
    if (!cryptoReady) {
      deps.setIsLoggedIn(false);
      deps.setLoginError(deps.tr('recovery_missing_keys') || 'recovery_missing_keys');
      return;
    }
    deps.setIsLoggedIn(true);
    deps.initNotifications().catch(() => {}); // push-уведомления (не блокирует вход)
    // Namespace = fp:<fingerprint>. На ручном входе initCrypto из mounted
    // уже отработал, но мог сработать ДО появления this.email — тогда кэш
    // резолвера остался на legacy-емейле и миграция не запустилась бы.
    // Сбрасываем кэш и переносим накопленные email-строки один раз.
    resetAccountNamespaceCache();
    try { await ensureAccountNamespace(deps.email()); }
    catch (e) { console.warn('[identity] namespace bootstrap failed:', e); }
    await deps.initLocalDb(); // sqlite: tombstones + курсоры для аккаунта
    deps.loadUnreadCounts(); // счётчики непрочитанных из sqlite kv_store (после initLocalDb)
    deps.loadChatFlags(); // архив/mute чатов из sqlite kv_store
    deps.runAutoclean(); // плановая автоочистка при входе
    deps.loadLocalProfiles(); // локальные имена/аватары контактов (per-account)
    // 0.1.180: релей/eco-инициализация при НОВОМ логине (зеркало
    // auto-login пути): релей ВКЛ по умолчанию (free-токен 100/день,
    // без промо-ключа) → eco активируется автоматически, foreground-
    // служба не поднимается (батарея). Явное '0' юзера уважаем.
    deps.setEcoMode((await db.kvGet('anon', 'eco-mode')) === '1');
    try {
      const rs = await relay.getSettings(deps.email());
      deps.setRelayEnabled(rs.enabled);
      if (rs.enabled) {
        await deps.syncEcoWithRelay(true).catch(() => {});
        // syncEcoWithRelay мог изменить ecoMode — перечитаем kv.
        deps.setEcoMode((await db.kvGet('anon', 'eco-mode')) === '1');
      }
    } catch (e) { /* релей опционален — не блокируем почтовый вход */ }
    await deps.loadBodyCache();
    await deps.loadContacts();
    await deps.loadGroups();
    try { await deps.loadChannels(); } catch (e) { /* не критично */ }
    // Скорость входа: UI сразу, фетч почты в фоне (не блокирует вход).
    if (deps.ecoMode()) { deps.onEcoMode(true, true).catch(() => {}); } // eco: служба отключена, доставка через релей
    deps.startPolling();
    if (deps.ecoMode()) { deps.startPolling(60000); deps.startRelayTicker(); } // M2.3: эко — без IDLE, релей-тикер жив
    else deps.idleLoop(); // Rust-монитор IDLE — доставка звонков/писем
    deps.loadEmails().catch((e) => {
      if (String(e && e.message || e).toLowerCase().includes('not connected')) {
        deps.setLoginError(e.message);
      }
    });
  } catch (error) {
    deps.setLoginError(error.message);
  } finally {
    deps.setLoginLoading(false);
  }
}

// Открыть форму смены адреса.
export function openChangeEmail(deps) {
  deps.setNewEmail('');
  deps.setNewPassword('');
  deps.setChangeEmailError('');
  deps.setShowChangeEmailServers(false);
  deps.setShowChangeEmail(true);
}

// Смена почты.
//
// Ключи E2E (keypair.json) не привязаны к email: меняем только транспорт.
// Контакты/группы остаются в peer_keys.json/kv_store. Новый адрес уходит
// контактам broadcast-письмом с тем же fingerprint — они обновят адрес
// без новых приглашений (fingerprint-матчинг в processIncoming).
export async function changeEmail(deps) {
  deps.setChangeEmailLoading(true);
  deps.setChangeEmailError('');
  const oldEmail = deps.email();
  try {
    const config = {};
    const imapServer = deps.imapServer().trim();
    const imapPort = deps.imapPort().trim();
    const smtpServer = deps.smtpServer().trim();
    const smtpPort = deps.smtpPort().trim();
    if (imapServer) config.imap_server = imapServer;
    if (imapPort) config.imap_port = parseInt(imapPort, 10);
    if (smtpServer) config.smtp_server = smtpServer;
    if (smtpPort) config.smtp_port = parseInt(smtpPort, 10);
    // Входим на новый ящик (сохраняем креды для автовхода). Ключ E2E не
    // регенерируется — api.login только подключает почту.
    await api.login(deps.newEmail().trim(), deps.newPassword(), { remember: true, config });
    deps.stopPolling();
    // Переключаем сессию на новый email, не сбрасывая ключи/контакты/группы.
    const newEmail = deps.newEmail().trim();
    deps.setEmail(newEmail);
    deps.setPassword(deps.newPassword());
    deps.setUserId(newEmail);
    deps.setIsLoggedIn(true);
    deps.setConnected(true);
    // Кэш имени привязан к аккаунту (namespace = email) — сбрасываем.
    api._displayName = undefined;
    // счётчики, пометки) из namespace старого адреса в новый — иначе
    // переписка «исчезает» после смены адреса.
    await deps.migrateAccountData(oldEmail, newEmail);
    await deps.migrateOwnGroups(oldEmail, newEmail);
    // localStorage-хранилища (заметки/реакции/правки/томбстоуны) и свой
    // профиль в kv keyed по email — ошибка миграции не должна ломать
    // смену почты.
    try {
      await deps.migrateLocalStores(oldEmail, newEmail);
    } catch (e) {
      console.warn('[identity] local stores migrate failed:' + e);
    }
    await deps.initLocalDb(); // курсоры/томбстоуны нового аккаунта
    await deps.loadContacts(); // peer_keys общие — контакты остаются
    await deps.loadGroups();
    try { await deps.loadChannels(); } catch (e) { /* не критично */ }
    deps.startPolling();
    deps.idleLoop();
    deps.loadEmails().catch(() => {});
    // Сообщаем контактам новый адрес: broadcast-письмо несёт name/avatar
    // и key (тот же fingerprint) — получатели обновят адрес контакта.
    try { await deps.broadcastProfile(); } catch (e) { console.error('[change-email] broadcast failed:', e); }
    console.log('[identity] email changed:', oldEmail, '→', newEmail);
    deps.setShowChangeEmail(false);
    deps.setShowSettings(false);
    deps.loadUnreadCounts();
  } catch (error) {
    deps.setChangeEmailError((error && error.message) || String(error));
  } finally {
    deps.setChangeEmailLoading(false);
  }
}
