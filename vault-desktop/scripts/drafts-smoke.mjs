// Node-смоук features/drafts.js — черновики сообщений.
//
// Покрытие фичи, которой до 20.10 не было вообще (нашёл гейт покрытия:
// features/drafts.js без смоука). Проверяем контракт: пер-чат хранение в kv,
// пустой текст стирает черновик, гонка save/restore (очередь на модуле).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/drafts-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const _kv = new Map();
globalThis.__dbMock = {
  kvGet: async (ns, k) => (_kv.has(k) ? _kv.get(k) : null),
  kvSet: async (ns, k, v) => { _kv.set(k, v); },
};
writeFileSync(MOCKS + '/api-mock.mjs', 'export const db = globalThis.__dbMock;\nexport default { db };\n');
writeFileSync(MOCKS + '/identity-mock.mjs',
  'export const accountNamespace = async (e) => "ns:" + String(e || "").toLowerCase();\n');

prepareModuleCopy(
  ROOT + '/src/features/drafts.js',
  MOCKS + '/drafts.mjs',
  { '../api.js': 'api-mock.mjs', '../identity.js': 'identity-mock.mjs' },
  MOCKS,
);
const D = await import(MOCKS + '/drafts.mjs');
const { chatStore, sessionStore } = await import(ROOT + '/src/features/session-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

const chat = { state: { newMessage: '' }, setDraft(t) { this.state.newMessage = t; } };
const deps = { chat };
function reset(over = {}) {
  _kv.clear();
  chat.state.newMessage = '';
  sessionStore.setCurrentEmail('me@x.ru');
  chatStore.setActiveChat(null);
  chatStore.setActiveChatType('chat');
  chatStore.setCurrentGroup(null);
  Object.assign(chatStore.state, over);
}

// 1. saveDraft: текст сохраняется per-chat
console.log('1. saveDraft: черновик пишется per-chat');
{
  reset({ activeChat: 'a@x.ru' });
  chat.state.newMessage = 'черновик A';
  D.saveDraft(deps);
  await D.draftRun(() => {});          // очередь модуля: дождаться записи
  const drafts = JSON.parse(_kv.get('drafts') || '{}');
  check('черновик сохранён под чатом', drafts['a@x.ru'] === 'черновик A', drafts);
}

// 2. saveDraft: пустой текст стирает черновик
console.log('2. saveDraft: пустой текст стирает');
{
  reset({ activeChat: 'a@x.ru' });
  _kv.set('drafts', JSON.stringify({ 'a@x.ru': 'старый' }));
  chat.state.newMessage = '   ';
  D.saveDraft(deps);
  await D.draftRun(() => {});
  const drafts = JSON.parse(_kv.get('drafts') || '{}');
  check('черновик удалён', drafts['a@x.ru'] === undefined, drafts);
}

// 3. saveDraft без активного чата — ничего не пишем
console.log('3. saveDraft: без чата — no-op');
{
  reset({ activeChat: null });
  chat.state.newMessage = 'текст';
  D.saveDraft(deps);
  await D.draftRun(() => {});
  check('без чата kv не тронут', !_kv.has('drafts'), _kv.get('drafts'));
}

// 4. saveDraft в ГРУППЕ — ключ 'group:<id>'
console.log('4. saveDraft: ключ группы');
{
  reset({ activeChat: 'group:g1', activeChatType: 'group', currentGroup: { id: 'g1' } });
  chat.state.newMessage = 'групповой черновик';
  D.saveDraft(deps);
  await D.draftRun(() => {});
  const drafts = JSON.parse(_kv.get('drafts') || '{}');
  check('черновик под ключом группы', drafts['group:g1'] === 'групповой черновик', drafts);
}

// 5. restoreDraft: текст возвращается в композер
console.log('5. restoreDraft: восстановление');
{
  reset({ activeChat: 'a@x.ru' });
  _kv.set('drafts', JSON.stringify({ 'a@x.ru': 'возврат' }));
  await D.restoreDraft(deps, 'a@x.ru');
  check('текст в композере', chat.state.newMessage === 'возврат', chat.state.newMessage);
}

// 6. restoreDraft: нет черновика — композер пуст
console.log('6. restoreDraft: нет черновика');
{
  reset({ activeChat: 'b@x.ru' });
  await D.restoreDraft(deps, 'b@x.ru');
  check('композер пуст', chat.state.newMessage === '', chat.state.newMessage);
}

// 7. Очередь модуля: параллельные save/restore не затирают друг друга
console.log('7. draftRun: очередь не теряет операции');
{
  reset({ activeChat: 'c@x.ru' });
  chat.state.newMessage = 'X';
  D.saveDraft(deps);
  await D.draftRun(() => {});
  const drafts = JSON.parse(_kv.get('drafts') || '{}');
  check('запись сохранена после очереди', drafts['c@x.ru'] === 'X', drafts);
  // Ошибка внутри операции: доходит до вызывающего, но ЦЕПОЧКУ НЕ РВЁТ —
  // следующая операция обязана выполниться (иначе один сбой kv навсегда
  // блокирует черновики).
  let ran = false;
  let threw = null;
  try { await D.draftRun(async () => { throw new Error('boom'); }); } catch (e) { threw = e; }
  let nextThrew = null;
  try { await D.draftRun(async () => { ran = true; }); } catch (e) { nextThrew = e; }
  check('ошибка доходит до вызывающего', threw && /boom/.test(threw.message), threw && String(threw.message));
  check('ошибка в очереди не рвёт цепочку', nextThrew === null && ran === true,
    nextThrew ? String(nextThrew.message) : ran);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
