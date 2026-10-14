// Feature module: загрузка/мерж/персист списка писем (инкрементальный фетч).
// Этап 5 декомпозиции App.vue — изоляция фич-доменов (ctx-паттерн).
// ADR-001 домен 2 (под-домен «загрузка писем»): loadEmails — вне критического
// пути ОТПРАВКИ, downstream-обработчики (processIncoming/processInvites/
// syncGroupAvatarsFromMeta/sendDeliveredReceipts) остаются в App.vue и
// вызываются через ctx. Курсоры (loadCursors/saveCursors) — тоже ctx.
//
// Инварианты:
//  - this.emails НЕ сбрасывается в начале (пока фетч идёт — старый список в UI);
//  - инкрементальный фетч по per-folder UID-курсорам (первый запуск — частичный
//    скан, не полный: полный ломал INBOX на больших ящиках, imap 2.4.1);
//  - мерж с дедупом по uid+папка; кросс-папочные копии «оживляются» по
//    message_id (не плодим дубли); cap 2000; сортировка по date desc;
//  - ПЕРСИСТ в sqlite (db.emailsLoad/Save) — восстановление без полного скана;
//  - «Not connected» пробрасывается наверх (mounted() переспросит пароль).

import api, { db } from '../api.js';

export async function loadEmails(ctx, silent = false) {
  if (!silent) {
    ctx.emailsLoading = true;
    ctx.emailError = '';
  }
  try {
    const accounts = await api.getEmailAccounts();
    // Не сбрасываем ctx.emails в начале: пока фетч идёт (или падает),
    // старый список остаётся в UI — клик по чату не видит пустоту.
    // ПЕРСИСТ: ctx.emails восстанавливается из sqlite при входе
    // (первый вызов в сессии) — иначе письма ниже курсоров терялись при
    // перезапуске и чаты без истории были пустыми.
    if (!silent && ctx.emails.length === 0) {
      try {
        const stored = await db.emailsLoad(accounts[0] ? accounts[0].id : (ctx.email || 'anon'));
        if (Array.isArray(stored) && stored.length) {
          ctx.emails = stored.map(e => ({
            uid: e.uid,
            id: e.uid,
            from: e.from,
            to: e.to,
            subject: e.subject,
            date: e.date,
            is_read: e.is_read,
            folder: e.folder,
            message_id: e.message_id || '',
          }));
        }
      } catch (e) {
        console.warn('loadEmails: sqlite restore failed:', e);
      }
    }
    const fetched = [];
    for (const account of accounts) {
      try {
        // Инкрементальный фетч (M1): только письма новее per-folder
        // UID-курсоров. Первый запуск (нет курсоров) — полный скан
        // последних писем + инициализация курсоров.
        // ВАЖНО: больше НЕ делаем полный скан при входе — курсоры в
        // sqlite надёжны, история в sqlite — источник чатов.
        // Принудительный полный скан с пустыми курсорами ломал INBOX
        // на больших ящиках (UID SEARCH ALL падал в imap 2.4.1).
        const cursors = ctx.loadCursors(account.id);
        const res = await api.fetchEmailsIncremental(account.id, cursors);
        fetched.push(...(res.messages || []));
        ctx.saveCursors(account.id, res.cursors);
      } catch (e) {
        console.error('Failed to fetch emails for account:', e);
        if (!silent) ctx.emailError = 'fetch: ' + (e && e.message || e);
        // Re-throw "Not connected" so mounted() can ask for the password again
        if (String(e && e.message || e).toLowerCase().includes('not connected')) {
          throw e;
        }
      }
    }
    // Мержим новые письма со старым списком (полный рескан больше не
    // делается — старые остаются в памяти, новые добавляются сверху).
    // Дедуп по uid+папка; cap 2000 — старые конверты уходят.
    const merged = [...ctx.emails];
    const seen = new Set(merged.map(m => m.uid + '|' + (m.folder || 'INBOX')));
    // Кросс-папочные копии: письмо могло быть проиндексировано из INBOX,
    // а потом провайдер перенёс его в Спам — старая ссылка (INBOX, uid)
    // стала мёртвой (тела больше нет). Если в батче пришла копия с тем
    // же message_id из другой папки — «оживляем» существующую запись:
    // подставляем живые folder/uid, не плодя дублей в списке.
    const byMid = new Map();
    for (const m of merged) {
      if (m.message_id) byMid.set(m.message_id, m);
    }
    for (const m of fetched) {
      const k = m.uid + '|' + (m.folder || 'INBOX');
      if (seen.has(k)) continue;
      if (m.message_id && byMid.has(m.message_id)) {
        const old = byMid.get(m.message_id);
        if ((old.folder || 'INBOX') !== (m.folder || 'INBOX')) {
          old.folder = m.folder;
          old.uid = m.uid;
          if (m.id !== undefined) old.id = m.id;
          old.message_id = m.message_id;
          seen.add(k);
        }
        continue;
      }
      seen.add(k);
      byMid.set(m.message_id, m);
      merged.push(m);
    }
    merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    if (merged.length > 2000) merged.length = 2000;
    ctx.emails = merged;
    // Источник метаданных для fetchAllHandshake (в памяти: без гонки
    // на fire-and-forget emailsSave ниже).
    api.setEmailsSource(ctx.emails);
    // ПЕРСИСТ: envelope cache в sqlite — при перезапуске письма
    // восстанавливаются без полного IMAP-скана (курсоры согласованы).
    try {
      const acc = accounts[0] ? accounts[0].id : (ctx.email || 'anon');
      db.emailsSave(acc, JSON.stringify(ctx.emails.map(m => ({
        uid: String(m.uid ?? m.id ?? ''),
        folder: m.folder || 'INBOX',
        from: m.from || '',
        to: m.to || '',
        subject: m.subject || '',
        date: m.date || '',
        is_read: !!m.is_read,
        message_id: m.message_id || '',
      }))));
    } catch (e) {
      console.warn('loadEmails: sqlite save failed:', e);
    }
    console.log(`[Emails] loaded ${ctx.emails.length} messages (${fetched.length} new)`);
    // Непрочитанные + PUSH-уведомления: каждый fetched-батч
    // классифицируем (счётчики непрочитанных — всегда; уведомления —
    // только при silent=true, и только для свежих писем).
    if (fetched.length) await ctx.processIncoming(fetched, { notify: silent });
    // После поллинга разбираем инвайты/подтверждения групп (попап согласия).
    await ctx.processInvites();
    // Аватары групп: meta-письма (VaultGroupMeta) разбираем здесь же, а не
    // только при открытии группы — иначе участник, не открывавший группу,
    // новый аватар админа не увидит никогда.
    await ctx.syncGroupAvatarsFromMeta();
    // Квитанции «доставлено»: шлём {delivered:1} сразу при получении писем.
    await ctx.sendDeliveredReceipts(fetched);
  } catch (error) {
    // let "Not connected" propagate to the caller (app restart re-login)
    if (String(error && error.message || error).toLowerCase().includes('not connected')) {
      throw error;
    }
    console.error('Failed to load emails:', error);
    if (!silent) ctx.emailError = 'load: ' + (error && error.message || error);
  } finally {
    if (!silent) ctx.emailsLoading = false;
  }
}
