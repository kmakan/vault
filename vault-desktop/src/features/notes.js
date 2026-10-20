// Feature module: заметки для себя (открытие чата, перетаскивание).
//
// ADR-005 W3 (`t_b1bdbb99`), партия 6: логика уехала из App.vue. Хранилище —
// у владельца заметок (notes-store), открытый чат — у chatStore, drag-состояние
// — у владельца форм (uiStore).
import { chatStore } from './session-store.js';

// Открыть чат заметок.
export function selectNotes(deps) {
  deps.chat.set(deps.loadNotes());
  deps.bumpLoadSeq();
  chatStore.setActiveChat('__notes__');
  chatStore.setActiveChatType('chat');
  chatStore.setCurrentGroup(null);
  deps.openMobileChat();
  deps.scrollToBottom(true);
}

// Начало перетаскивания заметки.
export function onNoteDragStart(deps, e, msg) {
  deps.setDraggedNoteId(msg.id);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', msg.id);
}

// Поверх другой заметки: вычисляем позицию вставки (до/после).
export function onNoteDragOver(deps, e, msg) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!deps.draggedNoteId() || msg.id === deps.draggedNoteId()) {
    deps.setDragOverNoteId(null);
    deps.setDragOverPos(null);
    return;
  }
  const rect = e.currentTarget.getBoundingClientRect();
  deps.setDragOverNoteId(msg.id);
  deps.setDragOverPos((e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after');
}

// Уход курсора: снимаем подсветку цели.
export function onNoteDragLeave(deps, e, msg) {
  if (deps.dragOverNoteId() === msg.id) {
    deps.setDragOverNoteId(null);
    deps.setDragOverPos(null);
  }
}

// Бросок: переставляем заметку в списке и сохраняем.
export function onNoteDrop(deps, e, msg) {
  e.preventDefault();
  const id = deps.draggedNoteId() || e.dataTransfer.getData('text/plain');
  deps.setDraggedNoteId(null);
  const overId = deps.dragOverNoteId();
  const pos = deps.dragOverPos();
  deps.setDragOverNoteId(null);
  deps.setDragOverPos(null);
  if (!id || !overId || id === overId) return;
  const list = deps.loadNotes();
  const from = list.findIndex(n => n.id === id);
  if (from < 0) return;
  const [moved] = list.splice(from, 1);
  const to = list.findIndex(n => n.id === overId);
  if (to < 0) { list.splice(from, 0, moved); return; }
  list.splice(pos === 'after' ? to + 1 : to, 0, moved);
  if (deps.saveNotes(list)) deps.chat.set(list);
}
