// Feature module: релей-доставка + режимы приёма (IDLE/поллинг/эко).
// Этап 5 декомпозиции App.vue — изоляция фич-доменов (ctx-паттерн).
//
// Четыре среза домена:
//  - relayConsume: приём конвертов с push-релея → виртуальные письма;
//  - режимы: idleLoop (IMAP IDLE), startPolling/stopPolling (30с-тики),
//    loadEmailsFast (отдельный IMAP-клиент для звонков);
//  - эко (M2.3): onEcoMode — IDLE погашен, релей-тикер 5с + поллинг 60с;
//  - relay-resilience: health-чек 60с, 3 фейла в эко → автономный режим
//    (служба + IDLE + поллинг 30с), оживание релея → тихий возврат в эко.
//
// Инвариант: ошибки релея НЕ влияют на почту — доставка продолжается.

import api, { db } from '../api.js';
import * as relay from '../relay-client.js';

// M2.1: забрать конверты с релея и влить их в почтовый конвейер как
// виртуальные письма. uid 'rl-<envId>' (стабильный — повторный поллинг
// не задвоит, дедуп в mergePending/mergeHistory по env.id тоже страхует).
// from приходит от отправителя (поле from) — дальше обычная расшифровка
// пир-ключом в processIncoming. Ошибки релея НЕ влияют на почту.
export async function relayConsume(ctx) {
  const list = await relay.relayPoll(ctx.email);
  // Каналы (M2 channels-3): подписчики пуллят общую очередь каждого канала
  // его read-токеном (fan-out, серверный peek+курсор). Конверты-посты идут
  // в тот же конвейер виртуальных писем — роутер классифицирует по ключу.
  const chanEnvelopes = [];
  for (const ch of (ctx.channels || [])) {
    const posts = await relay.relayChannelPoll(ch, ctx.email).catch(() => []);
    for (const env of posts) {
      // from = канал: владельческий эхо-фильтр и классификация в роутере
      // идут по ключу, адрес отправителя здесь не нужен (privacy-модель).
      env.from = env.from || ('channel:' + ch.id);
      chanEnvelopes.push(env);
    }
  }
  const all = [...list, ...chanEnvelopes];
  if (!all.length) return;
  const merged = [...ctx.emails];
  const seen = new Set(merged.map(m => m.uid + '|' + (m.folder || 'INBOX')));
  const fresh = [];
  for (const env of all) {
    const uid = 'rl-' + env.id;
    if (seen.has(uid + '|RELAY')) continue;
    seen.add(uid + '|RELAY');
    fresh.push({
      uid,
      folder: 'RELAY',
      from: (env.from || '').toLowerCase(),
      to: ctx.email,
      date: new Date((env.ts || 0) * 1000).toISOString(),
      subject: '',
      message_id: 'relay-' + env.id,
      body: env.body, // тело уже декодировано в relay-client
      is_read: false,
    });
  }
  if (!fresh.length) return;
  merged.push(...fresh);
  merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  if (merged.length > 2000) merged.length = 2000;
  ctx.emails = merged;
  // Тело кладём в кэш сразу (fetchEmailBodies по папке RELAY не сработает).
  for (const f of fresh) {
    ctx.cacheBody('RELAY:' + f.uid, f.body);
  }
  await ctx.processIncoming(fresh, { notify: true });
  console.log('[relay] consumed envelopes: ' + fresh.length);
}

// Быстрый фетч для звонков: отдельный IMAP-клиент в Rust — не
// конкурирует за lock основного клиента. Используется ИЗ IDLE-цикла:
// входящий call_request доходит, даже когда обычный поллинг пропускается
// из-за занятого lock (троттлинг Gmail / долгие UI-фетчи).
export async function loadEmailsFast(ctx, silent = true) {
  try {
    const accounts = await api.getEmailAccounts();
    const fetched = [];
    for (const account of accounts) {
      try {
        const cursors = ctx.loadCursors(account.id);
        const res = await api.fetchEmailsIncrementalFast(account.id, cursors);
        fetched.push(...(res.messages || []));
        ctx.saveCursors(account.id, res.cursors);
      } catch (e) {
        console.warn('[calls] fast fetch failed:', e);
      }
    }
    if (!fetched.length) return;
    const merged = [...ctx.emails];
    const seen = new Set(merged.map(m => m.uid + '|' + (m.folder || 'INBOX')));
    for (const m of fetched) {
      const k = m.uid + '|' + (m.folder || 'INBOX');
      if (!seen.has(k)) { seen.add(k); merged.push(m); }
    }
    merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    if (merged.length > 2000) merged.length = 2000;
    ctx.emails = merged;
    console.log(`[Emails] fast loaded ${ctx.emails.length} messages (${fetched.length} new)`);
    // Разбор сигналов звонков и уведомлений (как обычный loadEmails).
    await ctx.processIncoming(fetched, { notify: silent });
  } catch (e) {
    console.warn('[calls] fast load failed:', e);
  }
}

// M2.3: релей-тикер — ЕДИНСТВЕННЫЙ канал приёма в эко-режиме (IDLE погашен).
// Живёт независимо от idleLoop: запускается при логине/эко-включении.
// УСТОЙЧИВОСТЬ К БЛОКИРОВКАМ (relay-resilience): каждые 60с health-чек
// активного релея. В эко-режиме мёртвый релей (3 подряд неудачи) →
// АВТОНОМНЫЙ режим: поднимаем foreground-службу + IDLE + поллинг 30с —
// приложение работает как классика, единственная разница — иконка в
// шторке. При оживании релея — тихо возвращаемся в эко.
export function startRelayTicker(ctx) {
  if (ctx._relayTicker) return;
  ctx._relayFails = 0;
  ctx._lastRelayHealth = Date.now();
  ctx._relayTicker = setInterval(async () => {
    if (!ctx.isLoggedIn) {
      clearInterval(ctx._relayTicker);
      ctx._relayTicker = null;
      return;
    }
    try { await relayConsume(ctx); } catch (e) { /* релей опционален */ }
    // Health-чек раз в 60с (не на каждом тике — экономим трафик/батарею).
    if (Date.now() - ctx._lastRelayHealth >= 60000) {
      ctx._lastRelayHealth = Date.now();
      let healthy = false;
      try { healthy = await relay.relayHealth(ctx.email); } catch (e) { healthy = false; }
      if (healthy) {
        ctx._relayFails = 0;
        if (ctx.relayOfflineSince) {
          console.log('[relay] healthy again → leaving offline mode');
          ctx.relayOfflineSince = null;
          if (ctx.ecoMode && !ctx.ecoAutonomous) {
            // релей ожил в эко — возвращаемся в чистое эко (служба глушится)
            ctx.onEcoMode(true, true).catch(() => {});
          }
        }
      } else {
        ctx._relayFails++;
        console.warn(`[relay] health fail #${ctx._relayFails}`);
        // 3 минуты подряд (3 чека × 60с) — считаем релей заблокированным.
        if (ctx._relayFails >= 3 && ctx.ecoMode && !ctx.ecoAutonomous) {
          console.warn('[relay] dead in eco → AUTONOMOUS mode (service+IDLE)');
          enterRelayOfflineRescue(ctx);
        }
      }
    }
  }, 5000);
}

// Автономный режим в эко при мёртвом релее: служба слушает ящик (IDLE),
// уведомления локальные — работа мессенджера НЕ отличается от классики.
// Отличия только: иконка в шторке есть, скорость = почтовая.
export async function enterRelayOfflineRescue(ctx) {
  ctx.ecoAutonomous = true;
  ctx.relayOfflineSince = Date.now();
  ctx.relayDeliveryMode = 'email';
  try {
    // Поднимаем foreground-службу (pushSet(false) затем ecoSet(false)
    // вернёт STICKY-режим с иконкой; права уведомлений уже просили при старте).
    await api.pushSet(false, '', '');
    await api.ecoSet(false);
  } catch (e) { console.warn('[relay-rescue] svc start:', e); }
  // IDLE + обычный поллинг — как в классике.
  ctx._idleStop = false;
  idleLoop(ctx);
  stopPolling(ctx);
  startPolling(ctx);
  ctx.showToast(ctx.t('relay_offline_toast') || 'Релей недоступен — перешли в автономный режим (доставка по почте, без потери сообщений)', 5000);
}

export async function idleLoop(ctx) {
  if (ctx._idleActive || !ctx.isLoggedIn) return;
  ctx._idleActive = true;
  // M2.2: релей-конверты — быстрый канал (email IDLE ~1с для писем,
  // но relay-очередь иначе ждала бы 30с тика поллинга).
  startRelayTicker(ctx);
  // Rust-монитор: запускаем параллельно с JS-циклом.
  // Идемпотентен на стороне Rust; курсоры берём из кэша активного
  // аккаунта, чтобы первый fetch не тянул старые письма.
  api.idleStart(ctx.loadCursors(ctx.email) || {}).catch(e =>
    console.warn('[idle-monitor] start failed:', e));
  let lastSafety = Date.now();
  let idleFailed = false;
  try {
    while (ctx.isLoggedIn && !ctx._idleStop) {
      let changed = false;
      try {
        const r = await api.idleWait(2000, 'INBOX');
        changed = !!(r && r.changed);
      } catch (e) {
        console.warn('[calls] IMAP IDLE недоступен, фолбэк на поллинг:', e && e.message || e);
        idleFailed = true;
        break;
      }
      const elapsed = Date.now() - lastSafety;
      // Gmail кладёт call_* письма в СПАМ, а IDLE-push приходит только от
      // INBOX: страховочный фетч JUNK делаем чаще (7с), чтобы answer/accept
      // из Спама не ждали 10с и не опаздывали к 90с-таймауту.
      if (changed || elapsed >= 7000) {
        lastSafety = Date.now();
        // Быстрый фетч для звонков: ОТДЕЛЬНЫЙ IMAP-клиент в Rust
        // (email_fetch_incremental_fast) — основной клиент может быть занят
        // зависшими операциями/троттлингом (lock busy → поллинг молча
        // пропускается, call_request невидим часами). Звонки доходят
        // всегда, независимо от состояния основного клиента.
        try { await loadEmailsFast(ctx, true); } catch (e) { /* тихо */ }
      }
    }
  } finally {
    ctx._idleActive = false;
    ctx._idleStop = false;
  }
  // Цикл вышел: звонок ещё идёт — ускоренный поллинг 3с как фолбэк
  // (hangup сам вернёт обычный 30с-поллинг).
  if (ctx.isLoggedIn && ctx.callState !== 'idle') startPolling(ctx, 3000);
  // IDLE умер (провайдер/сеть): обычный поллинг продолжает работать;
  // пробуем вернуть IDLE через 60с (провайдер мог временно отключить).
  if (ctx.isLoggedIn && idleFailed) {
    setTimeout(() => { if (ctx.isLoggedIn) idleLoop(ctx); }, 60000);
  }
}

export function startPolling(ctx, intervalMs = 30000) {
  if (ctx.pollTimer) return;
  ctx.pollTimer = setInterval(async () => {
    // Анти-наложение: setInterval запускает новый тик каждые 30с
    // НЕ дожидаясь завершения предыдущего. Если IMAP завис (троттлинг
    // Gmail), предыдущий тик держит Rust-lock клиента до 35с — следующий
    // стартует поверх, lock занят почти всегда, и открытие чата падает с
    // «Timed out waiting for email client lock» (чаты пустые). Пропускаем
    // тик, пока предыдущий ещё выполняется.
    if (!ctx.isLoggedIn || ctx._pollingActive) return;
    ctx._pollingActive = true;
    try {
      // M2.1: приём с push-релея (быстрый HTTP, до IMAP). Конверты
      // мержим в ctx.emails как виртуальные письма (uid: rl-<id>) —
      // дальше их разберёт штатный processIncoming (дедуп по env.id
      // в mergeHistory не даст дубликату email-письма задвоиться).
      try {
        await relayConsume(ctx);
      } catch (e) { /* релей недоступен — почта продолжит доставку */ }
      // Пересборка групп в НАЧАЛЕ тика: участники групп попадают в список
      // контактов (модель почтовый мессенджер — группа тоже источник контактов).
      try { await ctx.loadGroups(); } catch (e) { /* тихо */ }
      // Тихий поллинг: не трогает спиннер/ошибки почты, но разбирает
      // инвайты (попап согласия) и обновляет список писем.
      await ctx.loadEmails(true);
      // Новые письма могли прийти в любой момент — перерисовываем
      // открытый чат, чтобы не приходилось переоткрывать его вручную.
      if (ctx.activeChat === '__notes__') {
        // Заметки для себя — локальные, поллинг их НЕ трогает (иначе
        // перезаписал бы пустым списком из IMAP).
      } else if (ctx.activeChat && ctx.activeChatType === 'chat') {
        await ctx.loadMessages(ctx.activeChat);
        // Не выдёргиваем из чтения истории: прокручиваем только если
        // пользователь уже у низа чата.
        ctx.scrollToBottom(false);
      } else if (ctx.activeChatType === 'group' && ctx.currentGroup) {
        // Группы тоже обновляем поллингом: новые сообщения и реакции
        // (VaultGroupReact) иначе не подхватывались до переоткрытия чата.
        await ctx.loadGroupMessages(ctx.currentGroup.id);
        ctx.scrollToBottom(false);
      }
    } catch (e) {
      // "Not connected" — сессия IMAP умерла; пробуем тихо восстановить её
      // из сохранённых (зашифрованных на устройстве) учётных данных —
      // без релога и остановки поллинга.
      if (String(e && e.message || e).toLowerCase().includes('not connected')) {
        try {
          const ok = await api.restoreSession();
          if (!ok) stopPolling(ctx);
        } catch (_) {
          stopPolling(ctx);
        }
      } else {
        console.error('Polling loadEmails failed:', e);
      }
    } finally {
      ctx._pollingActive = false;
    }
  }, intervalMs);
}

export function stopPolling(ctx) {
  if (ctx.pollTimer) {
    clearInterval(ctx.pollTimer);
    ctx.pollTimer = null;
  }
}

// M2.3: экономный режим — постоянный IMAP IDLE останавливается
// (батарея), доставка едет через релей (5с-тикер остаётся) + редкий
// страховочный поллинг 60с. Звонки: сигналы идут релеем ~1с.
export async function onEcoMode(ctx, on, silent = false) {
  ctx.ecoMode = !!on;
  // Сброс автономного состояния: onEcoMode(true) из rescue-возврата
  // (релей ожил) и ручное выключение эко — оба начинают с чистого листа.
  ctx.ecoAutonomous = false;
  ctx.relayOfflineSince = null;
  try { await db.kvSet('anon', 'eco-mode', on ? '1' : '0'); } catch (e) {}
  if (!ctx.isLoggedIn) return;
  if (ctx.ecoMode) {
    // стоп JS IDLE-цикла
    ctx._idleStop = true;
    try { await api.idleStop(); } catch (e) { /* монитор мог не работать */ }
    // M2.3-b ФИНАЛ: пуши при закрытом приложении несёт ntfy-клиент
    // (UnifiedPush, отдельное приложение). Сервис здесь не нужен —
    // глушим его полностью: иконка исчезает из шторки, батарея целая.
    try { await api.pushSet(false, '', ''); } catch (e) { /* push-mode off */ }
    try { await api.ecoSet(true); } catch (e) { console.warn('[eco] svc stop:', e); }
    // релей-тикер — канал приёма при живом JS (activity открыта)
    startRelayTicker(ctx);
    // редкий поллинг-тик страхует (релей — основной канал)
    stopPolling(ctx);
    startPolling(ctx, 60000);
    if (!silent) ctx.showToast(ctx.t('eco_on_toast') || 'Экономный режим: фоновое соединение остановлено, доставка через релей');
  } else {
    // классика: постоянный IDLE + обычный поллинг
    try { await api.pushSet(false, '', ''); } catch (e) { /* push-mode off */ }
    try { await api.ecoSet(false); } catch (e) { console.warn('[eco] svc start:', e); }
    stopPolling(ctx);
    idleLoop(ctx);
    startPolling(ctx);
    ctx.showToast(ctx.t('eco_off_toast') || 'Классический режим: постоянное соединение включено');
  }
}

export function onRelayEnabled(ctx, on) {
  ctx.relayEnabled = !!on;
}
