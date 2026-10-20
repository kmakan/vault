// Выход из аккаунта: глушим фоновые циклы, выходим из IMAP, сбрасываем
// состояние сессии к экрану логина.
//
// ADR-005 W3 (партия 13): метод App.vue уехал целиком — компонент остаётся
// источником состояния, но не владельцем ПОРЯДКА шагов.
//
// ПОРЯДОК ЗНАЧИТ. Сначала глушим фоновые циклы (поллинг реле, heartbeat
// присутствия), потом выходим из IMAP, и только потом сбрасываем состояние.
// Обратный порядок опасен: поллинг успевает ещё раз сходить на сервер с
// уже сброшенными учётными данными.
//
// СБРОС ИДЁТ ПО ВЛАДЕЛЬЦАМ (ADR-004). Почти все поля приложения — прокси к
// session-store / chat-store / groups-store / mailbox-store / invites-store /
// uiStore, поэтому «this.x = []» пишет владельцу, а не компоненту. Здесь
// перечислены ШАГИ сброса (что и в каком порядке обнуляется) — это и есть
// логика выхода.
//
// ОШИБКА IMAP НЕ МЕШАЕТ ВЫХОДУ: пользователь нажимает «выйти» — он должен
// выйти, даже если сервер недоступен. Поэтому logoutApi обёрнут в try/catch.
export async function logoutFlow(deps) {
  const {
    stopPolling, stopHeartbeats, logoutApi,
    resetLogin, resetIdentity, resetGroups, resetContacts, resetChat,
    resetUnread, resetMailbox, resetInvites, resetUi, resetProfile,
  } = deps;
  stopPolling();
  stopHeartbeats();
  try { await logoutApi(); } catch (e) { /* ignore — выход всё равно делаем */ }
  resetLogin();
  resetIdentity();
  resetGroups();
  resetContacts();
  resetChat();
  resetUnread();
  resetMailbox();
  resetInvites();
  resetUi();
  resetProfile();
}
