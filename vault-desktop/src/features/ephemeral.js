// Feature module: исчезающие (эфемерные) сообщения.
//
// ADR-005 W4 (`t_821261f7`): ПРАВИЛО времени жизни — в Rust. JS не решает,
// «когда истечёт сообщение»: он получает готовый момент отсчёта от ядра
// (`vault_ephemeral_expire_at`) и только исполняет решение (взводит таймер,
// удаляет сообщение). Раньше арифметика `base + ttl*1000` жила в трёх
// местах JS (chat.js/messages.js/groups.js) и в методах App.vue — четыре
// копии одного протокольного правила.
//
// Модель сообщения: `expiresAt` — абсолютный момент истечения (мс Unix),
// 0 — сообщение не исчезает. Имя поля совпадает с полем Rust-моста.
import { db } from '../api.js';
import { uiStore } from './session-store.js';
import { isExpired } from '../ephemeral-rule.js';


export function ephemeralLabel(deps, sec) {
  const opt = deps.ephemeralOptions().find((o) => o.v === Number(sec));
  return opt ? opt.label : sec + ' c';
}

// Включить/выключить исчезающие сообщения в текущем чате.
export async function applyEphemeral(deps, seconds) {
  uiStore.setModal('showEphemeralMenu', false);
  const chatId = deps.activeChatType() === 'group' && deps.currentGroup()
    ? 'group:' + deps.currentGroup().id
    : deps.activeChat();
  if (!chatId || chatId === '__notes__') return;
  try {
    await setEphemeralTtl(deps, chatId, seconds);
    console.log('[ephemeral] set ttl=' + seconds + ' for ' + chatId);
  } catch (e) {
    console.error('[ephemeral] save failed:', e);
  }
  deps.setCurrentEphemeralTtl(Number(seconds) || 0);
  uiStore.toast(
    seconds > 0
      ? 'Исчезающие сообщения: ' + ephemeralLabel(deps, seconds) + ' (новые сообщения в этом чате)'
      : 'Исчезающие сообщения выключены',
  );
}

// TTL в kv + перерисовка индикатора в шапке.
export async function setEphemeralTtl(deps, chatId, seconds) {
  await db.kvSet('anon', 'ephemeral:' + chatId, String(seconds || 0));
  deps.messagesStore.tick(); // перерисовать индикатор в шапке
}

// Вооружить таймер исчезновения сообщения.
//
// Решение «истекло ли» — из Rust (isExpired): JS только исполняет.
export async function scheduleEphemeral(deps, msg, chatId) {
  if (!msg || !msg.expiresAt) return;
  const key = chatId + ':' + msg.id;
  if (deps.messagesStore.hasTimer(key)) return;
  const now = Date.now();
  const left = msg.expiresAt - now;
  console.log('[ephemeral] arm timer id=' + msg.id + ' chat=' + chatId + ' in ' + Math.round(left / 1000) + 's');
  // Истёкшие пока приложение было закрыто: удаляем сразу.
  if (await isExpired(msg.expiresAt, now)) {
    expireEphemeral(deps, chatId, msg.id, msg.mid);
    return;
  }
  deps.messagesStore.setTimer(key, () => {
    expireEphemeral(deps, chatId, msg.id, msg.mid);
    deps.messagesStore.clearTimer(key);
  }, left);
}

// Сообщение истекло: tombstone (персистентен → не воскреснет) + убрать из
// списка + сохранить историю.
export function expireEphemeral(deps, chatId, msgId, mid) {
  // Тот же механизм, что «Удалить у всех» (deleteMessage): tombstone
  // персистентен → сообщение не воскреснет из истории/письма после
  // перезапуска или поллинга.
  deps.addTombstone(msgId);
  if (mid) deps.addMidTombstone(mid);
  const list = deps.chat.state.messages;
  const idx = list.findIndex((m) => m.id === msgId);
  if (idx !== -1) deps.chat.removeById(list[idx].id);
  deps.saveCurrentHistory(chatId);
}
