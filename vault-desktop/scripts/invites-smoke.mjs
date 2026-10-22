// Node-смоук features/invites.js — очередь инвайтов/запросов контакта и попапы.
//
// Модуль не читает компонент (ADR-005 W2 партия 4): состояние у владельцев
// (`invites` — per-app экземпляр invites-store; флаги попапа — uiStore),
// эффекты — явный deps. Смоук собирает тот же контракт, что App.vue.
//
// ЧТО ПРОВЕРЯЕТСЯ (не «вызвалось», а «что получилось»):
//   · очередь наполняется из письма, попап поднимается, индекс 0;
//   · пока попап показан — очередь НЕ перезаписывается (иначе сбивается
//     разбор по очереди);
//   · уже обработанные (handled-ключи) не показываются повторно;
//   · accept-инвайта: письмо принято, аватар записан В ВЛАДЕЛЬЦА groups-store,
//     очередь сокращена, ключ помечен «в обработке»;
//   · РЕГРЕСС: аватар писался через `groups().setGroupAvatar(...)`, а groups —
//     это СПИСОК групп: вызов падал TypeError, и accept уходил в catch
//     (ошибка + откат инвайта). Кейс с аватаром обязателен;
//   · ошибка accept → инвайт возвращается в очередь, метка снимается;
//   · decline → письмо отклонено, очередь сокращена;
//   · showNextInvite → таймер 1200мс и правило приоритета (групповой попап
//     раньше контактного).
import { writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { createInvitesStore } from '../src/features/invites-store.js';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/invites-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Моки ───────────────────────────────────────────────────────────────────
const apiMock = {
  _handshakeCache: {},
  pendingAccepts: [],
  pendingContactAccepts: [],
  pendingInvites: [],
  pendingContactInvites: [],
  calls: [],
  sweepStaleHandshake: async () => { apiMock.calls.push(['sweep']); },
  fetchPendingAccepts: async () => apiMock.pendingAccepts,
  fetchPendingContactAccepts: async () => apiMock.pendingContactAccepts,
  fetchPendingInvites: async () => apiMock.pendingInvites,
  fetchPendingContactInvites: async () => apiMock.pendingContactInvites,
  acceptGroupInvite: async (id, inv) => { apiMock.calls.push(['accept', id, inv]); },
  declineGroupInvite: async (id, uid, sender) => { apiMock.calls.push(['decline', id, uid, sender]); },
};
writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api;');
globalThis.__apiMock = apiMock;

// uiStore (флаги попапа и индекс) + chatStore (currentGroup) — владельцы.
// Объекты кладутся на globalThis: смоуку нужен доступ к их состоянию
// (сброс между кейсами, currentGroup).
writeFileSync(MOCKS + '/session-store.js', [
  'export const uiStore = globalThis.__uiMock = {',
  '  _modals: {},',
  '  _form: { invitePopupIndex: 0, contactPopupIndex: 0 },',
  '  getModal(n) { return !!this._modals[n]; },',
  '  setModal(n, v) { this._modals[n] = !!v; return this._modals[n]; },',
  '  getFormField(k) { return this._form[k]; },',
  '  setFormField(k, v) { this._form[k] = v ?? \'\'; return this._form[k]; },',
  '};',
  'export const chatStore = globalThis.__chatMock = { state: { currentGroup: null } };',
  '',
].join('\n'));

prepareModuleCopy(
  ROOT + '/src/features/invites.js',
  MOCKS + '/invites.mjs',
  {
    '../api.js': 'api.js',
    './session-store.js': 'session-store.js',
  },
  MOCKS,
);
const { processInvites, acceptInvite, declineInvite, showNextInvite } =
  await import(MOCKS + '/invites.mjs');

// ── Стенд ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Модалки/индексы живут в моке uiStore — он один на файл, поэтому сброс
// делаем руками (иначе счётчик кейса доказывал бы следующий).
const ui = globalThis.__uiMock;
const state = { calls: [], invites: createInvitesStore(), timers: [], alerts: [], toasts: [] };
// alert — примитив браузера, в Node его нет. Модуль зовёт его при ошибке
// принятия инвайта (поведение 1:1, менять на тост — это смена UX).
globalThis.alert = (msg) => { state.alerts.push(String(msg)); };

function resetWorld(over = {}) {
  apiMock.pendingAccepts = [];
  apiMock.pendingContactAccepts = [];
  apiMock.pendingInvites = [];
  apiMock.pendingContactInvites = [];
  apiMock.calls = [];
  state.calls = [];
  state.timers = [];
  state.alerts = [];
  state.toasts = [];
  state.invites = createInvitesStore();
  Object.assign(state, over);
  ui._modals = {};
  ui._form = { invitePopupIndex: 0, contactPopupIndex: 0 };
}

function makeDeps(over = {}) {
  return {
    invites: state.invites,
    loadGroups: async () => { state.calls.push('loadGroups'); },
    loadChannels: async () => { state.calls.push('loadChannels'); },
    loadGroupMessages: async (id) => { state.calls.push('loadGroupMessages:' + id); },
    refreshGroupMembers: async () => { state.calls.push('refreshGroupMembers'); },
    loadStoredPeerKeys: async () => { state.calls.push('loadStoredPeerKeys'); },
    loadContacts: async () => { state.calls.push('loadContacts'); },
    loadProfiles: () => { state.calls.push('loadProfiles'); },
    decryptGroupKey: async () => 'DECRYPTED_GROUP_KEY',
    kvSet: async (ns, k, v) => { state.calls.push('kvSet:' + k); },
    showToast: (msg) => { state.toasts.push(msg); },
    t: (k) => k,
    isCryptoReady: () => true,
    groups: () => state.groups || [],
    setGroupAvatar: (id, av) => { state.calls.push('setGroupAvatar:' + id); },
    clearNextTimer: () => { state.timers.push(['clear']); },
    setNextTimer: (fn, delay) => { state.timers.push(['set', delay, fn]); },
    showNextInvite: () => { state.calls.push('showNextInvite'); },
    ...over,
  };
}

// ── 1. Пусто → очередь ОЧИЩАЕТСЯ (призрачные инвайты) ───────────────────
console.log('1. пусто — очередь очищается, попап скрыт');
{
  resetWorld();
  // Старая очередь НЕ пуста: иначе «очистилась» нечего было проверять —
  // именно так ловятся мутации вида «очередь не очищается».
  state.invites.setPendingInvites([{ group_id: 'G-OLD', uid: '9' }]);
  await processInvites(makeDeps());
  check('очередь инвайтов очищена, попап скрыт',
    state.invites.getPendingInvites().length === 0 && ui.getModal('showInvitePopup') === false,
    state.invites.getPendingInvites());
  check('loadProfiles вызван (профили обновляются каждый проход)',
    state.calls.includes('loadProfiles'), state.calls);
}

// ── 2. Есть инвайты → очередь заполняется, попап поднимается ─────────────
console.log('2. инвайты → очередь заполнена, попап показан, индекс 0');
{
  resetWorld();
  apiMock.pendingInvites = [{ group_id: 'G1', uid: 1, sender: 'a@x' }];
  await processInvites(makeDeps());
  check('очередь инвайтов заполнена', state.invites.getPendingInvites().length === 1,
    state.invites.getPendingInvites());
  check('попап показан', ui.getModal('showInvitePopup') === true);
  check('индекс 0', ui.getFormField('invitePopupIndex') === 0);
}

// ── 3. Попап уже показан → очередь НЕ перезаписывается ───────────────────
console.log('3. попап показан → очередь не перезаписана (иначе сбивается разбор)');
{
  resetWorld();
  apiMock.pendingInvites = [{ group_id: 'G2', uid: 2, sender: 'b@x' }];
  ui.setModal('showInvitePopup', true);
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1 }]);
  await processInvites(makeDeps());
  check('очередь не перезаписана', state.invites.getPendingInvites()[0].group_id === 'G1',
    state.invites.getPendingInvites());
}

// ── 4. accept-письма → перезагрузка групп и сообщений ────────────────────
console.log('4. accept-письма → loadGroups + loadGroupMessages + refreshGroupMembers');
{
  resetWorld();
  apiMock.pendingAccepts = [{ group_id: 'G1' }];
  // currentGroup — владелец chatStore (в моке он один на файл).
  globalThis.__chatMock.state.currentGroup = { id: 'G1' };
  await processInvites(makeDeps());
  check('вызваны loadGroups/loadGroupMessages/refreshGroupMembers',
    state.calls.includes('loadGroups') && state.calls.includes('loadGroupMessages:G1')
    && state.calls.includes('refreshGroupMembers'), state.calls);
  globalThis.__chatMock.state.currentGroup = null;
}

// ── 5. contact-accepts → перечитать ключи и контакты ─────────────────────
console.log('5. contact-accepts → loadStoredPeerKeys + loadContacts + loadGroups');
{
  resetWorld();
  apiMock.pendingContactAccepts = [{ sender: 'c@x' }];
  await processInvites(makeDeps());
  check('вызваны loadStoredPeerKeys/loadContacts/loadGroups',
    state.calls.includes('loadStoredPeerKeys') && state.calls.includes('loadContacts')
    && state.calls.includes('loadGroups'), state.calls);
}

// ── 6. Запросы контакта → контактный попап ────────────────────────────────
console.log('6. запросы контакта → контактный попап и очередь');
{
  resetWorld();
  apiMock.pendingContactInvites = [{ sender: 'c@x', uid: 5 }];
  await processInvites(makeDeps());
  check('контактный попап показан', ui.getModal('showContactPopup') === true);
  check('очередь контактов заполнена', state.invites.getPendingContacts().length === 1);
}

// ── 7. Уже обработанные не показываются повторно ─────────────────────────
console.log('7. handled-ключи → обработанные фильтруются');
{
  resetWorld();
  apiMock.pendingInvites = [{ group_id: 'G1', uid: 1, sender: 'a@x' }];
  state.invites.markInviteHandled('G1|1');
  await processInvites(makeDeps());
  check('уже обработанный инвайт не попал в очередь',
    state.invites.getPendingInvites().length === 0, state.invites.getPendingInvites());
  check('попап не поднялся', ui.getModal('showInvitePopup') === false);
}

// ── 7b. Обработанный запрос КОНТАКТА тоже не показывается повторно ────────
console.log('7b. обработанный запрос контакта не попадает в очередь');
{
  resetWorld();
  apiMock.pendingContactInvites = [{ sender: 'c@x', uid: 5 }];
  state.invites.markContactHandled('c@x|5');
  await processInvites(makeDeps());
  check('обработанный запрос контакта не попал в очередь',
    state.invites.getPendingContacts().length === 0, state.invites.getPendingContacts());
  check('контактный попап не поднялся', ui.getModal('showContactPopup') === false);
}

// ── 8. accept-инвайта: успешный путь ─────────────────────────────────────
console.log('8. accept-инвайта: письмо принято, очередь сокращена, ключ помечен');
{
  resetWorld();
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1, sender: 'a@x' }]);
  await acceptInvite({ group_id: 'G1', uid: 1, sender: 'a@x', group_key: 'GK' }, makeDeps());
  check('api.acceptGroupInvite вызван',
    apiMock.calls.some(c => c[0] === 'accept' && c[1] === 'G1'), apiMock.calls);
  check('очередь сокращена', state.invites.getPendingInvites().length === 0,
    state.invites.getPendingInvites());
  check('ключ помечен «в обработке»', state.invites.isInviteHandled('G1|1'));
  check('попап закрыт', ui.getModal('showInvitePopup') === false);
  check('showNextInvite вызван', state.calls.includes('showNextInvite'), state.calls);
}

// ── 8b. accept сокращает очередь по ИНДЕКСУ (показанный), а не по началу ─
console.log('8b. accept убирает ИМЕННО показанный инвайт (индекс 1 из двух)');
{
  resetWorld();
  state.invites.setPendingInvites([
    { group_id: 'G0', uid: 0, sender: 'x@x' },
    { group_id: 'G1', uid: 1, sender: 'a@x' },
  ]);
  ui.setFormField('invitePopupIndex', 1);   // показываем ВТОРОЙ
  await acceptInvite({ group_id: 'G1', uid: 1, sender: 'a@x', group_key: 'GK' }, makeDeps());
  const left = state.invites.getPendingInvites();
  check('из очереди убран показанный (второй), первый остался',
    left.length === 1 && left[0].group_id === 'G0', left);
}

// ── 8c. accept перезагружает сообщения ТЕКУЩЕЙ группы ────────────────────
console.log('8c. accept перезагружает сообщения открытой группы');
{
  resetWorld();
  globalThis.__chatMock.state.currentGroup = { id: 'G1' };
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1, sender: 'a@x' }]);
  await acceptInvite({ group_id: 'G1', uid: 1, sender: 'a@x', group_key: 'GK' }, makeDeps());
  check('loadGroupMessages вызван для открытой группы',
    state.calls.includes('loadGroupMessages:G1'), state.calls);
  globalThis.__chatMock.state.currentGroup = null;
}

// ── 9. РЕГРЕСС: аватар группы пишется во ВЛАДЕЛЬЦА ───────────────────────
console.log('9. accept-инвайта с аватаром: аватар пишется в groups-store');
{
  resetWorld();
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1, sender: 'a@x', group_key: 'GK', group_avatar: 'data:image/png;base64,AAA' }]);
  await acceptInvite(
    { group_id: 'G1', uid: 1, sender: 'a@x', group_key: 'GK', group_avatar: 'data:image/png;base64,AAA' },
    makeDeps(),
  );
  check('setGroupAvatar вызван (было: вызов на СПИСОК групп → TypeError → откат)',
    state.calls.includes('setGroupAvatar:G1'), state.calls);
  check('принятие не упало в alert', state.alerts.length === 0, state.alerts);
  check('аватар сохранён в kv', state.calls.some(c => c === 'kvSet:group-avatar:G1'), state.calls);
}

// ── 9b. СЕКРЕТ НОВОГО УЧАСТНИКА: приняли → ключ есть → инвайт зашифрован ──
//
// Риск, зафиксированный в задаче t_c446d61c: можно принять приглашение, не
// создав секрет для нового участника, и остаться в группе, в которую нельзя
// писать. Ошибка тут НЕЗАМЕТНА в обычных тестах и опасна. Поэтому проверяем
// три вещи:
//   1) в принятом письме есть РАСШИФРОВАННЫЙ ключ группы;
//   2) зашифрованный блоб НЕ уходит на сервер (иначе сервер сохранил бы
//      ciphertext вместо секрета, и группа осталась бы без ключа);
//   3) если расшифровка не удалась — принятия НЕТ вовсе.
console.log('9b. секрет нового участника: ключ расшифрован и отправлен');
{
  resetWorld();
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1, sender: 'a@x' }]);
  const deps = makeDeps({
    isCryptoReady: () => true,
    decryptGroupKey: async () => 'DECRYPTED_GROUP_KEY',
  });
  await acceptInvite({
    group_id: 'G1', uid: 1, sender: 'a@x',
    group_key_enc: 'ENCRYPTED_BLOB', sender_public_key: 'PUB',
  }, deps);
  const call = apiMock.calls.find(c => c[0] === 'accept');
  check('принятие выполнено', !!call, apiMock.calls);
  check('в письме есть РАСШИФРОВАННЫЙ ключ группы',
    !!(call && call[2] && call[2].group_key === 'DECRYPTED_GROUP_KEY'), call && call[2]);
  check('зашифрованный блоб НЕ отправлен как ключ',
    !!(call && call[2] && call[2].group_key !== 'ENCRYPTED_BLOB'), call && call[2]);
  check('ошибок нет', state.alerts.length === 0, state.alerts);
}

// ── 9c. Секрет не создался: расшифровка не удалась → принятия нет ───────
console.log('9c. расшифровка не удалась — письмо НЕ принимается (секрета нет)');
{
  resetWorld();
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1, sender: 'a@x' }]);
  const deps = makeDeps({
    isCryptoReady: () => true,
    decryptGroupKey: async () => null,
  });
  await acceptInvite({
    group_id: 'G1', uid: 1, sender: 'a@x',
    group_key_enc: 'ENCRYPTED_BLOB', sender_public_key: 'PUB',
  }, deps);
  check('принятия НЕ было', !apiMock.calls.some(c => c[0] === 'accept'), apiMock.calls);
  check('инвайт вернулся в очередь (пользователь может попробовать снова)',
    state.invites.getPendingInvites().length === 1, state.invites.getPendingInvites());
}

// ── 9d. Крипто НЕ готов → инвайт с шифрованным ключом не принимается ────
console.log('9d. крипто не готово — шифрованный инвайт не принимается');
{
  resetWorld();
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1, sender: 'a@x' }]);
  const deps = makeDeps({
    isCryptoReady: () => false,
    decryptGroupKey: async () => { state.calls.push('decrypt'); return 'DECRYPTED_GROUP_KEY'; },
  });
  await acceptInvite({
    group_id: 'G1', uid: 1, sender: 'a@x',
    group_key_enc: 'ENCRYPTED_BLOB', sender_public_key: 'PUB',
  }, deps);
  check('принятия НЕ было (ключ негде взять)', !apiMock.calls.some(c => c[0] === 'accept'),
    apiMock.calls);
  check('расшифровка не вызывалась', !state.calls.includes('decrypt'), state.calls);
}

// ── 10. accept: ошибка → инвайт возвращается в очередь ───────────────────
console.log('10. accept с ошибкой: alert, метка снята, инвайт вернулся в очередь');
{
  resetWorld();
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1, sender: 'a@x' }]);
  const deps = makeDeps({
    isCryptoReady: () => true,
    // Ключа нет и расшифровка не даёт результата → ошибка внутри accept.
    decryptGroupKey: async () => null,
  });
  await acceptInvite({ group_id: 'G1', uid: 1, sender: 'a@x', group_key_enc: 'ENC', sender_public_key: 'PUB' }, deps);
  check('показан alert', state.alerts.length === 1, state.alerts);
  check('метка «в обработке» снята', !state.invites.isInviteHandled('G1|1'));
  check('инвайт вернулся в очередь', state.invites.getPendingInvites().length === 1,
    state.invites.getPendingInvites());
}

// ── 11. accept: мы уже в группе → тост, без принятия ────────────────────
console.log('11. accept «уже в группе» — тост и выход, письмо не принимается');
{
  resetWorld();
  state.groups = [{ id: 'G1' }];
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1, sender: 'a@x' }]);
  await acceptInvite({ group_id: 'G1', uid: 1, sender: 'a@x', group_key: 'GK' }, makeDeps());
  check('тост показан', state.toasts.length === 1, state.toasts);
  check('api.acceptGroupInvite НЕ вызван', !apiMock.calls.some(c => c[0] === 'accept'));
}

// ── 12. decline ───────────────────────────────────────────────────────────
console.log('12. decline: письмо отклонено, очередь сокращена');
{
  resetWorld();
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1, sender: 'a@x' }]);
  await declineInvite({ group_id: 'G1', uid: 1, sender: 'a@x' }, makeDeps());
  check('api.declineGroupInvite вызван',
    apiMock.calls.some(c => c[0] === 'decline' && c[1] === 'G1' && c[2] === 1), apiMock.calls);
  check('очередь сокращена', state.invites.getPendingInvites().length === 0);
  check('ключ помечен «в обработке»', state.invites.isInviteHandled('G1|1'));
}

// ── 13. showNextInvite: таймер и приоритет попапов ────────────────────────
console.log('13. showNextInvite: таймер 1200мс, индекс за границей → 0');
{
  resetWorld();
  state.invites.setPendingInvites([{ group_id: 'G1', uid: 1 }]);
  ui.setFormField('invitePopupIndex', 5);
  showNextInvite(makeDeps());
  const timer = state.timers.find(t => t[0] === 'set');
  check('таймер поставлен на 1200мс', !!timer && timer[1] === 1200, state.timers);
  check('индекс за границей сброшен в 0', ui.getFormField('invitePopupIndex') === 0);
  // Пока попап скрыт — таймер его показывает.
  ui.setModal('showInvitePopup', false);
  timer[2]();
  check('таймер показал попап', ui.getModal('showInvitePopup') === true);
}

console.log('14. showNextInvite: пусто → попап закрыт, контактный идёт следом');
{
  resetWorld();
  state.invites.setPendingContacts([{ sender: 'c@x', uid: 5 }]);
  showNextInvite(makeDeps());
  check('групповой попап закрыт', ui.getModal('showInvitePopup') === false);
  const timer = state.timers.find(t => t[0] === 'set');
  check('таймер на контактный попап', !!timer, state.timers);
  timer[2]();
  check('контактный попап показан', ui.getModal('showContactPopup') === true);
}

console.log('15. showNextInvite: всё пусто — таймера нет');
{
  resetWorld();
  showNextInvite(makeDeps());
  check('таймер не ставился', !state.timers.some(t => t[0] === 'set'), state.timers);
  check('попап закрыт', ui.getModal('showInvitePopup') === false);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
