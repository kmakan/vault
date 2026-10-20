// Node-смоук features/notes.js — заметки для себя (открытие, перетаскивание).
//
// ADR-005 W3 (`t_b1bdbb99`), партия 6: логика уехала из App.vue. Хранилище —
// у владельца заметок (notes-store), чат — у чат-владельца, drag-состояние —
// у владельца форм (uiStore).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/notes-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

prepareModuleCopy(
  ROOT + '/src/features/notes.js',
  MOCKS + '/notes.mjs',
  {},
  MOCKS,
);
const N = await import(MOCKS + '/notes.mjs');
const { uiStore, chatStore } = await import(ROOT + '/src/features/session-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Стенд ────────────────────────────────────────────────────────────────
const state = { notes: [], saved: null, seq: 0, mobile: 0, scrolled: null };
const chat = {
  state: { messages: [] },
  set(list) { chat.state.messages = list; },
};
const deps = {
  chat,
  loadNotes: () => state.notes.map((n) => ({ ...n })),
  saveNotes: (list) => { state.saved = list; return true; },
  bumpLoadSeq: () => { state.seq++; },
  openMobileChat: () => { state.mobile++; },
  scrollToBottom: (v) => { state.scrolled = v; },
  draggedNoteId: () => uiStore.getFormField('draggedNoteId'),
  setDraggedNoteId: (v) => { uiStore.setFormField('draggedNoteId', v); },
  dragOverNoteId: () => uiStore.getFormField('dragOverNoteId'),
  setDragOverNoteId: (v) => { uiStore.setFormField('dragOverNoteId', v); },
  dragOverPos: () => uiStore.getFormField('dragOverPos'),
  setDragOverPos: (v) => { uiStore.setFormField('dragOverPos', v); },
};
function reset(notes = []) {
  state.notes = notes;
  state.saved = null; state.seq = 0; state.mobile = 0; state.scrolled = null;
  chat.state.messages = [];
  uiStore.setFormField('draggedNoteId', null);
  uiStore.setFormField('dragOverNoteId', null);
  uiStore.setFormField('dragOverPos', null);
  chatStore.setActiveChat(null);
  chatStore.setActiveChatType('chat');
  // Группа НЕ null: иначе «при открытии заметок группа сброшена» нечего
  // проверять (значение уже нулевое) — проверка, отложенная от своих данных.
  chatStore.setCurrentGroup({ id: 'g1', name: 'Группа' });
}

// Событие перетаскивания — минимальный stand-in DOM.
function dragEvent(over = {}) {
  return {
    preventDefault() { over.prevented = true; },
    dataTransfer: { effectAllowed: '', dropEffect: '', data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] || ''; } },
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
    clientY: 0,
  };
}

// 1. selectNotes: чат заметок открыт
console.log('1. selectNotes: чат заметок открыт');
{
  reset([{ id: 'n1', content: 'первая' }, { id: 'n2', content: 'вторая' }]);
  N.selectNotes(deps);
  check('сообщения — заметки', chat.state.messages.length === 2, chat.state.messages);
  check('активный чат = __notes__', chatStore.state.activeChat === '__notes__', chatStore.state);
  check('тип чата = chat', chatStore.state.activeChatType === 'chat');
  check('группа сброшена', chatStore.state.currentGroup === null);
  check('мобильный чат открыт, прокрутка вниз', state.mobile === 1 && state.scrolled === true);
}

// 2. onNoteDragStart: draggedNoteId выставлен, данные в dataTransfer
console.log('2. onNoteDragStart');
{
  reset();
  const e = dragEvent();
  N.onNoteDragStart(deps, e, { id: 'n1' });
  check('draggedNoteId выставлен', uiStore.getFormField('draggedNoteId') === 'n1');
  check('effectAllowed=move', e.dataTransfer.effectAllowed === 'move');
  check('id в dataTransfer', e.dataTransfer.getData('text/plain') === 'n1');
}

// 3. onNoteDragOver: позиция «до»/«после» по половине элемента
console.log('3. onNoteDragOver: позиция вставки');
{
  reset();
  uiStore.setFormField('draggedNoteId', 'n1');
  const e1 = dragEvent(); e1.clientY = 10;  // верхняя половина (высота 100)
  N.onNoteDragOver(deps, e1, { id: 'n2' });
  check('верхняя половина → before', uiStore.getFormField('dragOverPos') === 'before', uiStore.getFormField('dragOverPos'));
  check('цель подсвечена', uiStore.getFormField('dragOverNoteId') === 'n2');
  const e2 = dragEvent(); e2.clientY = 90;  // нижняя половина
  N.onNoteDragOver(deps, e2, { id: 'n2' });
  check('нижняя половина → after', uiStore.getFormField('dragOverPos') === 'after', uiStore.getFormField('dragOverPos'));
}

// 4. onNoteDragOver: та же заметка / нет перетаскиваемой → подсветка снята
console.log('4. onNoteDragOver: сама на себя — подсветка снята');
{
  reset();
  uiStore.setFormField('draggedNoteId', 'n1');
  const e = dragEvent();
  N.onNoteDragOver(deps, e, { id: 'n1' });
  check('на себя — подсветка снята', !uiStore.getFormField('dragOverNoteId') && !uiStore.getFormField('dragOverPos'));
  reset();
  const e2 = dragEvent();
  N.onNoteDragOver(deps, e2, { id: 'n2' });
  check('ничего не перетаскиваем — подсветка снята', !uiStore.getFormField('dragOverNoteId'));
}

// 5. onNoteDragLeave: подсветка снимается только для своей цели
console.log('5. onNoteDragLeave');
{
  reset();
  uiStore.setFormField('dragOverNoteId', 'n2');
  N.onNoteDragLeave(deps, dragEvent(), { id: 'n3' });
  check('уход с чужой цели — подсветка осталась', uiStore.getFormField('dragOverNoteId') === 'n2');
  N.onNoteDragLeave(deps, dragEvent(), { id: 'n2' });
  check('уход со своей цели — подсветка снята', !uiStore.getFormField('dragOverNoteId'));
}

// 6. onNoteDrop: перестановка заметки и сохранение
console.log('6. onNoteDrop: перестановка');
{
  reset([{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]);
  uiStore.setFormField('draggedNoteId', 'n1');
  uiStore.setFormField('dragOverNoteId', 'n2');
  uiStore.setFormField('dragOverPos', 'before');
  const e = dragEvent();
  N.onNoteDrop(deps, e, { id: 'n2' });
  check('порядок: n1 перед n2', state.saved && state.saved.map((n) => n.id).join(',') === 'n1,n2,n3', state.saved && state.saved.map((n) => n.id));
  check('список в чате обновлён', chat.state.messages.map((n) => n.id).join(',') === 'n1,n2,n3', chat.state.messages.map((n) => n.id));
  check('drag-состояние сброшено', !uiStore.getFormField('draggedNoteId') && !uiStore.getFormField('dragOverNoteId') && !uiStore.getFormField('dragOverPos'));
}

// 7. onNoteDrop: позиция «после»
console.log('7. onNoteDrop: вставка после');
{
  reset([{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]);
  uiStore.setFormField('draggedNoteId', 'n1');
  uiStore.setFormField('dragOverNoteId', 'n3');
  uiStore.setFormField('dragOverPos', 'after');
  N.onNoteDrop(deps, dragEvent(), { id: 'n3' });
  check('порядок: n1 после n3', state.saved && state.saved.map((n) => n.id).join(',') === 'n2,n3,n1', state.saved && state.saved.map((n) => n.id));
}

// 8. onNoteDrop: перетаскивание на себя / неизвестная цель → no-op
console.log('8. onNoteDrop: некорректная цель — no-op');
{
  reset([{ id: 'n1' }, { id: 'n2' }]);
  uiStore.setFormField('draggedNoteId', 'n1');
  uiStore.setFormField('dragOverNoteId', 'n1');
  N.onNoteDrop(deps, dragEvent(), { id: 'n1' });
  check('на себя — список не менялся', state.saved === null, state.saved);
  reset([{ id: 'n1' }]);
  uiStore.setFormField('draggedNoteId', 'nX');
  uiStore.setFormField('dragOverNoteId', 'n1');
  N.onNoteDrop(deps, dragEvent(), { id: 'n1' });
  check('несуществующая заметка — список не менялся', state.saved === null, state.saved);

  // 9. ЦЕЛЬ исчезла из списка (её удалили, пока тащили) — заметка не теряется
  reset([{ id: 'n1' }, { id: 'n2' }]);
  uiStore.setFormField('draggedNoteId', 'n1');
  uiStore.setFormField('dragOverNoteId', 'nGONE');
  N.onNoteDrop(deps, dragEvent(), { id: 'nGONE' });
  check('цель исчезла — перетаскиваемая заметка не потеряна',
    state.saved === null && state.notes.length === 2, { saved: state.saved, notes: state.notes });
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
