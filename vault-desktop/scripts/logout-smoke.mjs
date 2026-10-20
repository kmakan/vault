// Node-смоук features/logout.js — выход из аккаунта (ADR-005 W3, партия 13).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Выход — единственное место, где приложение сбрасывает
// ОДНОВРЕМЕННО все владельцы состояния (сессия, группы, контакты, чат,
// непрочитанные, почта, инвайты, модалки, профиль). Ошибка в одном шаге
// оставляет пользователя «наполовину вышедшим»: например, почта очищена, а
// ключи групп — нет (группы продолжат шифроваться под старым ключом), или
// поллинг реле продолжает ходить на сервер после выхода.
//
// ПРОВЕРЯЕМ:
//   * порядок: фоновые циклы глушатся ДО выхода из IMAP, а состояние
//     сбрасывается ПОСЛЕ него (иначе поллинг успеет сходить на сервер);
//   * каждый шаг сброса выполняется (все десять);
//   * ошибка IMAP не мешает выходу: пользователь нажал «выйти» — он выходит.
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

const { logoutFlow } = await import('../src/features/logout.js');

function makeDeps(over = {}) {
  const order = [];
  const dep = (name) => (...args) => { order.push(name); return over[name] ? over[name](...args) : undefined; };
  return {
    order,
    deps: {
      stopPolling: dep('stopPolling'),
      stopHeartbeats: dep('stopHeartbeats'),
      logoutApi: dep('logoutApi'),
      resetLogin: dep('resetLogin'),
      resetIdentity: dep('resetIdentity'),
      resetGroups: dep('resetGroups'),
      resetContacts: dep('resetContacts'),
      resetChat: dep('resetChat'),
      resetUnread: dep('resetUnread'),
      resetMailbox: dep('resetMailbox'),
      resetInvites: dep('resetInvites'),
      resetUi: dep('resetUi'),
      resetProfile: dep('resetProfile'),
    },
  };
}

// ── 1. Полный порядок ───────────────────────────────────────────────────
{
  const { order, deps } = makeDeps();
  await logoutFlow(deps);
  ok('фоновые циклы остановлены', order.includes('stopPolling') && order.includes('stopHeartbeats'), order);
  ok('выход из IMAP выполнен', order.includes('logoutApi'), order);
  ok('сброс состояния выполнен после выхода из IMAP',
    order.indexOf('logoutApi') < order.indexOf('resetLogin'), order);
  ok('поллинг остановлен ДО выхода из IMAP',
    order.indexOf('stopPolling') < order.indexOf('logoutApi'), order);
  const resets = ['resetLogin', 'resetIdentity', 'resetGroups', 'resetContacts', 'resetChat',
    'resetUnread', 'resetMailbox', 'resetInvites', 'resetUi', 'resetProfile'];
  ok('ВСЕ шаги сброса выполнены', resets.every((r) => order.includes(r)),
    resets.filter((r) => !order.includes(r)));
  ok('шагов сброса ровно десять', resets.every((r) => order.filter((x) => x === r).length === 1), order);
}

// ── 2. Ошибка IMAP не мешает выходу ─────────────────────────────────────
{
  const { order, deps } = makeDeps({
    logoutApi: async () => { throw new Error('SMTP недоступен'); },
  });
  let threw = false;
  try { await logoutFlow(deps); } catch (e) { threw = true; }
  ok('ошибка IMAP не выходит наружу', threw === false);
  ok('состояние всё равно сброшено', order.includes('resetProfile') && order.includes('resetLogin'), order);
}

// ── 3. Сброс — строго после выхода (не раньше) ──────────────────────────
{
  const { order, deps } = makeDeps({
    logoutApi: async () => { order.push('logoutApi'); },
  });
  await logoutFlow(deps);
  const firstReset = order.findIndex((x) => x.startsWith('reset'));
  ok('ни один сброс не идёт до выхода из IMAP', firstReset > order.indexOf('logoutApi'), order);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
