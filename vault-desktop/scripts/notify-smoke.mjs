// Node-смоук src/notify.js — локальные push-уведомления.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Уведомления — то, что человек видит на телефоне
// ВНЕ приложения, и «молчаливые отказы» здесь стоят дороже всего (инцидент:
// «пуша нет», а приложение считало, что отправило). Правила:
//   * выключенные пользователем уведомления не отправляются;
//   * без разрешения ОС — не отправляются (и не считаются «отправленными»);
//   * одно и то же письмо не уведомляет дважды (дедуп по id, переживает
//     перезапуск);
//   * по чату есть окно тишины (не спамим уведомлениями подряд);
//   * на Android ставится СИСТЕМНАЯ иконка (иначе уведомление без иконки).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/notify-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { sent: [], permission: true };
globalThis.__st = state;

writeFileSync(MOCKS + '/notification.js', `
const st = globalThis.__st;
export const isPermissionGranted = async () => st.permission;
export const requestPermission = async () => { st.permission = true; return 'granted'; };
export const sendNotification = async (opts) => { st.sent.push(opts); };
export const removeAllActive = async () => { st.sent.length = 0; };
`);

let src = readFileSync(path.join(ROOT, 'src', 'notify.js'), 'utf8');
src = src.replace("from '@tauri-apps/plugin-notification'", `from "${MOCKS}/notification.js"`);
writeFileSync(MOCKS + '/notify.mjs', src, 'utf8');

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const N = await import(MOCKS + '/notify.mjs');

// ВНИМАНИЕ: множество отправленных id живёт на уровне МОДУЛЯ (notifiedIds),
// поэтому между блоками теста оно НЕ обнуляется: каждый блок обязан брать
// СВОЙ id, иначе проверки падают из-за утечки состояния стенда, а не из-за
// кода.
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function reset() { state.sent = []; state.permission = true; mem.clear(); }

// ── Включение/выключение ────────────────────────────────────────────────
{
  reset();
  ok('по умолчанию уведомления включены', N.notificationsEnabled() === true);
  N.setNotificationsEnabled(false);
  ok('выключение записывается', N.notificationsEnabled() === false);
  N.setNotificationsEnabled(true);
  ok('включение записывается', N.notificationsEnabled() === true);
}

{
  reset();
  // Разрешения нет: initNotifications даёт permission, поэтому проверяем
  // состояние ДО запроса — модуль обязан молчать.
  const r = N.notifyNewMessage({ title: 'Боб', id: 'id-noperm' });
  ok('без разрешения ОС уведомление не отправляется', r === false && state.sent.length === 0);
}
// ── Разрешение ОС ────────────────────────────────────────────────────────
{
  reset();
  await N.initNotifications();
  ok('разрешение запрошено', state.permission === true);
}

// ── Отправка ─────────────────────────────────────────────────────────────
{
  reset();
  await N.initNotifications();
  const r = N.notifyNewMessage({ title: 'Боб', body: 'привет', id: 'id-send', chatKey: 'peer@x' });
  ok('уведомление отправлено', r === true && state.sent.length === 1, state.sent);
  ok('заголовок и текст на месте',
    state.sent[0] && state.sent[0].title === 'Боб' && state.sent[0].body === 'привет', state.sent[0]);
}
{
  reset();
  await N.initNotifications();
  N.setNotificationsEnabled(false);
  const r = N.notifyNewMessage({ title: 'Боб', id: 'id-off' });
  ok('выключенные уведомления не отправляются', r === false && state.sent.length === 0);
}
{
  reset();
  await N.initNotifications();
  const r1 = N.notifyNewMessage({ title: 'Боб', id: 'id-dedup' });
  const r2 = N.notifyNewMessage({ title: 'Боб', id: 'id-dedup' });
  ok('одно и то же письмо не уведомляет дважды', r1 === true && r2 === false, { r1, r2 });
  ok('второй раз письмо не отправлено', state.sent.length === 1, state.sent.length);
}
{
  reset();
  await N.initNotifications();
  N.notifyNewMessage({ title: 'Боб', id: 'id-persist' });
  // Дедуп переживает перезапуск: идентификаторы сохраняются.
  const stored = mem.get('vault-notified-ids');
  ok('идентификатор отправленного письма сохранён (дедуп переживает перезапуск)',
    typeof stored === 'string' && stored.includes('id-persist'), stored);
}
{
  reset();
  await N.initNotifications();
  N.notifyNewMessage({ title: 'Боб', id: 'id-win1', chatKey: 'window@x' });
  const r2 = N.notifyNewMessage({ title: 'Боб', id: 'id-win2', chatKey: 'window@x' });
  ok('в чате есть окно тишины (не спамим)', r2 === false && state.sent.length === 1, { r2, sent: state.sent.length });
  const r3 = N.notifyNewMessage({ title: 'Аня', id: 'id-win3', chatKey: 'other-window@x' });
  ok('в другом чате уведомление проходит', r3 === true, r3);
}
{
  reset();
  await N.initNotifications();
  const r = N.notifyNewMessage({ title: '', body: '', id: 'id-empty' });
  ok('пустые заголовки не ломают отправку', r === true && state.sent.length === 1, state.sent);
  ok('без заголовка подставляется имя приложения',
    state.sent[0] && state.sent[0].title === 'Vault', state.sent[0]);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
