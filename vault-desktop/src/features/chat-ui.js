// Feature module: навигация по чату — скролл, меню чата и сообщения,
// мобильный чат, видимость чата.
//
// ADR-005 W3 (`t_b1bdbb99`), партия 10: логика уехала из App.vue. Состояние
// UI-flow — у владельца форм (uiStore: chatMenu/messageMenu/mobileChatOpen/
// showJumpToBottom), DOM и окно — через deps.
import { open as openExternal } from '@tauri-apps/plugin-shell';
import * as MsgFormat from '../message-format.js';
import { uiStore } from './session-store.js';

// ── Мобильный чат (список ↔ переписка) ─────────────────────────────────
export function openMobileChat(deps) {
  if (deps.isMobile) deps.setMobileChatOpen(true);
}

export function closeMobileChat(deps) {
  deps.setMobileChatOpen(false);
}

// ── Скролл списка сообщений ────────────────────────────────────────────
export function scrollToBottom(deps, force = false) {
  deps.nextTick(() => {
    const el = deps.getMessageListEl();
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (force || nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

export function onMessagesScroll(deps) {
  const el = deps.getMessageListEl();
  if (!el) return;
  deps.setShowJumpToBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
}

export function jumpToBottom(deps) {
  const el = deps.getMessageListEl();
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  deps.setShowJumpToBottom(false);
}

// ── Меню чата (архив/папка/звёзды/блок) ────────────────────────────────
export function openChatMenu(deps, target, e) {
  e.preventDefault();
  e.stopPropagation();
  const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 200));
  let y = Math.max(8, Math.min(e.clientY, window.innerHeight - 130));
  // На Android WebView долгое нажатие часто присылает contextmenu с
  // clientX/Y=0 — берём координаты элемента, иначе меню липнет к верху
  // экрана и прячется под статус-бар.
  if (!e.clientX && !e.clientY && e.target && e.target.getBoundingClientRect) {
    const r = e.target.closest('.contact-item') || e.target;
    const rr = r.getBoundingClientRect();
    y = Math.max(8, Math.min(rr.bottom + 4, window.innerHeight - 130));
  }
  deps.setChatMenu({ show: true, target, x, y });
  // Финальный клампинг по фактическому размеру меню (оценка выше —
  // статическая, реальных пунктов может быть больше/меньше).
  clampMenuAfterRender(deps, 'chatMenu', x, y);
}

export function closeChatMenu(deps) {
  deps.setChatMenu({ show: false, target: null });
}

// ── Меню сообщения (телефон/ссылка/реакции) ─────────────────────────────
export function openMessageMenu(deps, event, msg) {
  // меню открывается, шаблон прячет неприменимое по msg.callEvent.
  const content = msg.callEvent ? '' : (msg.content || '');
  const { phones, urls } = MsgFormat.extractPhonesAndUrls(content);
  // Android WebView при долгом нажатии иногда присылает clientX/Y=0
  // (как в openChatMenu) — берём координаты пузыря, иначе меню в углу.
  let x = event.clientX, y = event.clientY;
  if (!x && !y && event.target && event.target.getBoundingClientRect) {
    const r = event.target.getBoundingClientRect();
    x = r.left + 12;
    y = r.bottom + 4;
  }
  deps.setMessageMenu({ x, y, msg, phones, urls });
  // Клампинг по фактическому размеру (после рендера): без него меню
  // уходит за нижний/правый край — последнее сообщение при полном
  // экране на десктопе, на телефоне — за оба края.
  clampMenuAfterRender(deps, 'messageMenu', x, y);
}

// Клампинг меню по фактическому размеру (после рендера).
export async function clampMenuAfterRender(deps, key, x, y) {
  await deps.nextTickAsync();
  const mm = deps.getMenuState(key);
  if (!mm || mm.x !== x || mm.y !== y || (key === 'chatMenu' && !mm.show)) return;
  const el = deps.getMessageMenuEl();
  if (!el) return;
  const M = 8;
  const w = el.offsetWidth + 2;  // + границы
  const h = el.offsetHeight + 2;
  const nx = Math.max(M, Math.min(x, window.innerWidth - w - M));
  const ny = Math.max(M, Math.min(y, window.innerHeight - h - M));
  if (nx !== x || ny !== y) deps.setMenuState(key, { ...mm, x: nx, y: ny });
}

// Клик по тексту сообщения: ссылка/телефон.
export function onMessageTextClick(deps, e) {
  const urlEl = e.target.closest('a[data-url]');
  if (urlEl) { e.preventDefault(); openExternal(urlEl.dataset.url).catch(() => {}); return; }
  const phoneEl = e.target.closest('a[data-phone]');
  if (phoneEl) { e.preventDefault(); deps.copyText(phoneEl.dataset.phone); }
}

// ── Видимость чата (мобильная навигация) ───────────────────────────────
// Мобильная навигация: кнопка «назад» возвращает к списку чатов
// (mobileChatOpen=false), но activeChat/activeChatType ещё хранят
// прошлый чат. Без проверки mobileChatOpen для групп новые групповые
// сообщения считались «видимыми» — ни бейджа, ни уведомления.
export function chatVisible(deps, chatKey) {
  if (chatKey.indexOf('group:') === 0) {
    return deps.activeChatType() === 'group' && deps.activeChat() === chatKey &&
      (!deps.isMobile || deps.mobileChatOpen());
  }
  return deps.activeChatType() === 'chat' && deps.activeChat() === chatKey &&
    (!deps.isMobile || deps.mobileChatOpen());
}

// Поиск по сообщениям — ещё не реализован.
export function searchMessages(deps) {
  deps.alert('Search coming soon!');
}
