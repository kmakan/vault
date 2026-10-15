// Настройки чата, живущие в kv. Не зависят ни от компонента, ни от его
// состояния — только от модуля db.
//
// ADR-003 Этап 3. Вместе с message-format.js это слой общих утилит: выше
// примитивов (identity/crypto/channels-tokens), ниже фич. Он существует
// потому, что эти функции нужны и компоненту, и features/*, а положить их
// было некуда: в App.vue — значит нельзя использовать вне компонента, в фиче —
// значит фича начинает зависеть от того, что ей не принадлежит.
//
// Все три функции fail-open: ошибка чтения kv не должна ломать отрисовку
// сообщений, поэтому при сбое возвращается значение по умолчанию.
import { db } from './api.js';

export async function readPinned(groupId) {
  try {
    const raw = await db.kvGet('anon', 'pinned:' + groupId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function mediaQuality() {
  try { return (await db.kvGet('anon', 'media-quality')) || 'high'; } catch { return 'high'; }
}

export async function ephemeralTtlOf(chatId) {
  try {
    const v = await db.kvGet('anon', 'ephemeral:' + chatId);
    return Number(v) || 0;
  } catch { return 0; }
}
