// ═════════════════════════════════════════════════════════════════════════
// Vault — локальные push-уведомления (принцип поллинга)
//
// Тот же принцип, что и у статусов доставки: поллинг IMAP находит новое
// входящее письмо → локальная реакция на устройстве = системное уведомление.
// Никакого отдельного push-сервера для базового уровня не нужно: контент не
// передаётся через сторонний сервис, уведомление генерируется локально из
// уже полученного (и расшифрованного) письма. Это сохраняет zero-metadata.
//
// FCM/UnifiedPush (если появится) будет лишь «будильником», запускающим этот
// же поллинг, когда приложение закрыто — как в почтовый мессенджер.
// ═════════════════════════════════════════════════════════════════════════
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

// Ключ настройки «показывать уведомления» (переключатель в настройках).
// Хранится в localStorage, читается при каждом вызове — так SettingsPage и
// notify.js не связаны напрямую.
const ENABLED_KEY = 'vault-notif-enabled';
// Персист уже показанных uid — чтобы после перезапуска не уведомлять повторно.
const NOTIFIED_KEY = 'vault-notified-ids';
const MAX_PERSISTED = 500;

let permissionReady = false;
const notifiedIds = new Set();

export function notificationsEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'false';
  } catch (e) {
    return true;
  }
}

export function setNotificationsEnabled(on) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? 'true' : 'false');
  } catch (e) { /* ignore */ }
}

function loadNotified() {
  try {
    const stored = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]');
    for (const id of stored.slice(-MAX_PERSISTED)) notifiedIds.add(id);
  } catch (e) { /* ignore */ }
}

function persistNotified() {
  try {
    const arr = Array.from(notifiedIds).slice(-MAX_PERSISTED);
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(arr));
  } catch (e) { /* ignore */ }
}

// Запросить разрешение ОС на уведомления. Вызывать один раз после входа.
// На Android 13+ это триггерит runtime-диалог POST_NOTIFICATIONS.
export async function initNotifications() {
  loadNotified();
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === 'granted';
    }
    permissionReady = granted;
  } catch (e) {
    console.warn('[notify] permission init failed:', e);
    permissionReady = false;
  }
  return permissionReady;
}

// Показать системное уведомление о новом входящем сообщении.
//   title — имя/email отправителя, body — превью (может быть пустым для
//   зашифрованных сообщений, чтобы не утекал контент), id — uid письма для
//   дедупликации. Возвращает true, если уведомление показано.
export function notifyNewMessage({ title, body, id } = {}) {
  // ДИАГНОСТИКА (29.08): молчаливые отказы — главная причина «пуша нет».
  if (!notificationsEnabled()) { console.log('[notify] SKIP: disabled by setting'); return false; }
  if (!permissionReady) { console.log('[notify] SKIP: permission not ready'); return false; }
  if (id != null && notifiedIds.has(String(id))) { console.log('[notify] SKIP: already notified id=' + id); return false; }
  if (id != null) {
    notifiedIds.add(String(id));
    persistNotified();
  }
  try {
    // Android: системный small icon — те же два полумесяца, что и у фонового
    // уведомления в шторке (VaultForegroundService → R.drawable.ic_notification).
    // Имя ресурса ДОЛЖНО существовать в res/drawable: плагин ищет его через
    // getIdentifier и молча откатывается на «!» (ic_dialog_info), если нет.
    // На десктопе иконку берёт плагин из окна приложения (auto_icon) —
    // передавать имя drawable нельзя (notify-rust ищет файл по имени).
    const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
    const opts = { title: title || 'Vault', body: body || '' };
    if (isAndroid) {
      opts.icon = 'ic_notification';
      opts.iconColor = '#8b5cf6';
    }
    sendNotification(opts);
    return true;
  } catch (e) {
    console.warn('[notify] sendNotification failed:', e);
    return false;
  }
}
