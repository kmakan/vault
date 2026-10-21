// Блокировка отправителя (E2E) из разных мест UI — ADR-005 W3.
//
// Логика вынесена из App.vue: «скрыть отправителя» — это правило, а не
// поведение компонента. Пять входных точек (меню чата, баннер открытого чата,
// меню сообщения, карточка участника группы) делают одно и то же, и разница
// между ними — только то, КАКОЙ адрес берут и что перерисовывают.
//
// СМЫСЛ БЛОКИРОВКИ: она честная E2E — скрывает новые сообщения, звонки и
// уведомления У ПОЛУЧАТЕЛЯ, серверу невидима. После разблока прошлое НЕ
// возвращается: его не было в истории (фильтр до расшифровки), возвращать
// нечего.
//
// deps (ADR-001 R3): всё, что нужно снаружи, — явными параметрами:
//   isIgnored / ignoreUser / unignoreUser — правила ignore-листа
//     (features/ignored-users.js, приходят через контракт);
//   activeChat / activeChatType / currentGroup — что открыто;
//   msgSenderEmail(msg) — автор сообщения (1:1 — адрес чата, группа — автор);
//   loadMessages(chat) — перерисовка открытого чата;
//   toast(msg) / tr(key) — обратная связь;
//   closeChatMenu() — закрыть меню.

// Переключить блокировку собеседника из меню чата.
export async function toggleIgnoreContact(deps) {
  const email = deps.chatMenuTarget();
  if (!email) return;
  const wasIgnored = deps.isIgnored(email);
  if (wasIgnored) {
    await deps.unignoreUser(email);
    deps.toast(deps.tr('ignore_off_toast') || 'Разблокирован');
  } else {
    await deps.ignoreUser(email);
    // Открытый чат с ним: чистим экран от НОВЫХ (старые остаются),
    // иначе выглядело бы, что блок не работает.
    if (deps.activeChatType() === 'chat' && deps.activeChat() === email) {
      await deps.loadMessages(deps.activeChat());
    }
    deps.toast(deps.tr('ignore_on_toast') || 'Заблокирован');
  }
  deps.closeChatMenu();
}

// Разблок из баннера открытого чата: новые сообщения снова показываются.
export async function unblockActiveChat(deps) {
  if (deps.activeChatType() !== 'chat' || !deps.activeChat()) return;
  await deps.unignoreUser(deps.activeChat());
  deps.toast(deps.tr('ignore_off_toast') || 'Разблокирован');
  // Подтягиваем письма, пришедшие за время блока? НЕТ — их не было в
  // истории (фильтр до расшифровки), возвращать их нечем. Просто
  // перерисовываем: баннер уходит, новые сообщения начинают приходить.
  await deps.loadMessages(deps.activeChat());
}

// Блокировка из меню сообщения: 1:1 — адрес чата, группа — автор сообщения.
// Тост объясняет, что именно произошло.
export async function blockSenderOfMessage(deps, msg) {
  if (!msg || msg.from === 'me') return;
  const sender = deps.msgSenderEmail(msg)
    || (deps.activeChatType() === 'chat' ? deps.activeChat() : '');
  if (!sender) return;
  if (deps.isIgnored(sender)) {
    await deps.unignoreUser(sender);
    deps.toast(deps.tr('ignore_off_toast') || 'Разблокирован');
  } else {
    await deps.ignoreUser(sender);
    // Перестраиваем чат, если открыт с ним (1:1) — новые уже скрыты.
    if (deps.activeChatType() === 'chat' && deps.activeChat() === sender) {
      await deps.loadMessages(deps.activeChat());
    }
    deps.toast(deps.tr('ignore_on_toast') || 'Заблокирован');
  }
}

// Блокировка участника группы (карточка участника).
export async function blockUser(deps, email) {
  if (!deps.currentGroup() || !email) return;
  await deps.ignoreUser(email);
  deps.toast(deps.tr('ignore_on_toast') || 'Заблокирован: новые сообщения и звонки скрыты');
}

// Снятие блокировки участника группы.
export async function unblockUser(deps, email) {
  if (!email) return;
  await deps.unignoreUser(email);
  deps.toast(deps.tr('ignore_off_toast') || 'Разблокирован');
}
