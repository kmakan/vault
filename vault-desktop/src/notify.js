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
// же поллинг, когда приложение закрыто — как в Delta Chat.
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
  if (!notificationsEnabled()) return false;
  if (!permissionReady) return false;
  if (id != null && notifiedIds.has(String(id))) return false;
  if (id != null) {
    notifiedIds.add(String(id));
    persistNotified();
  }
  try {
    sendNotification({
      title: title || 'Vault',
      body: body || '',
    });
    return true;
  } catch (e) {
    console.warn('[notify] sendNotification failed:', e);
    return false;
  }
}
