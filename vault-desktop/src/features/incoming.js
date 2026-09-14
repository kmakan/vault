// Feature module: входящие конверты (router). Этап 4 декомпозиции App.vue —
// единая точка классификации всех входящих писем/relay-конвертов.
// Чистые функции получают компонент как `ctx` (паттерн Этапа 1), все
// зависимости явные. Семантика перенесена 1:1 из App.vue:processIncoming —
// без изменения логики (три хрупких инварианта: ignore-continue ДО
// расшифровки и ДО дедупа; эхо/профиль — seen, но не уведомление;
// разделение дедупа счётчика и дедупа уведомления, регресс 2fa9103).
//
// Расширение новым типом конверта: добавить ветку в classify() с
// собственным kind и обработать её там же — драйвер не меняется.

import api from '../api.js';
import crypto from '../crypto.js';
import * as relay from '../relay-client.js';
import { notifyNewMessage } from '../notify.js';
import * as PresenceFeature from './presence.js';

const MAX_POOL = 50;          // писем за один прогон (как было)
const FRESH_WINDOW_MS = 15 * 60 * 1000;

// ── Драйвер: батч-доставка тел по папкам + цикл классификации ──────────────
export async function processIncoming(ctx, fetched, { notify = false } = {}) {
  if (!fetched || !fetched.length || !ctx.cryptoReady) return;
  const myEmail = (ctx.email || '').toLowerCase();
  const pool = fetched.slice(0, MAX_POOL);
  await ensureBodies(ctx, pool);
  for (const m of pool) {
    const from = ctx.senderEmail(m.from);
    // Пропускаем исходящие (от себя) и пустые from.
    if (!from || from === myEmail) continue;
    const cls = await classify(ctx, m, from);
    if (cls === null) continue;
    if (cls.kind === 'message') {
      await countAndNotify(ctx, m, cls, { notify });
    }
  }
}

// Тела: добираем недостающие батчем по папкам (как sendDeliveredReceipts).
// Download-on-demand: письма крупнее 2МБ пропускаем — их содержимое
// подтягивается по клику с карточки вложения, а не в фоне поллинга.
async function ensureBodies(ctx, pool) {
  const byFolder = {};
  for (const m of pool) {
    const f = m.folder || 'INBOX';
    (byFolder[f] = byFolder[f] || []).push(m);
  }
  for (const [folder, msgs] of Object.entries(byFolder)) {
    const missing = msgs.filter(m =>
      ctx.emailBodyCache[`${folder}:${m.uid || m.id}`] === undefined
      && (m.size || 0) <= 2 * 1024 * 1024
    );
    if (!missing.length) continue;
    try {
      const bodies = await api.fetchEmailBodies(folder, missing.map(m => m.uid || m.id));
      for (const m of missing) {
        const b = bodies ? bodies[String(m.uid || m.id)] : undefined;
        if (b) ctx.cacheBody(`${folder}:${m.uid || m.id}`, b);
      }
    } catch (e) { /* тела не обязательны — классификация тихо пропустит */ }
  }
}

// ── Классификация одного письма ────────────────────────────────────────────
// Возвращает {kind:'message', chatKey, title, envId} для сообщения,
// null — если письмо не должно попасть в счётчик/уведомления (в т.ч. после
// выполнения побочных эффектов: call-сигнал, профиль, миграция).
async function classify(ctx, m, from) {
  // Ignore-лист: сообщения/звонки заблокированного скрыты у получателя
  // целиком — не считаются, не уведомляют, в историю не пишутся
  // (continue ДО расшифровки и ДО дедуп-механики: письмо остаётся
  // «необработанным» и после разблокировки не всплывёт).
  if (ctx.isIgnored(from)) return null;

  const body = ctx.emailBodyCache[`${m.folder || 'INBOX'}:${m.uid || m.id}`] || '';
  if (!body || !crypto.isEncrypted(body)) return null;

  let chatKey = null; // email (1:1) или 'group:<id>'
  let title = '';
  let envId = ''; // id конверта (общий для relay-копии и email-копии)

  // 1:1 — расшифровка пир-ключом.
  if (ctx.peerKeys[from]) {
    try {
      crypto.setPeerPublicKey(ctx.peerKeys[from], ctx.peerPqKeys && ctx.peerPqKeys[from]);
      const plain = await crypto.decryptVault(body);
      // Звонки (M3): call_* конверты — сигналы, НЕ сообщения (не в
      // бейджи, не в уведомления) — уходят в state machine звонка.
      const callSig = ctx.parseCallSignal(plain);
      if (callSig) {
        ctx.handleCallSignal(callSig, from).catch(e => console.warn('[call] signal failed:', e));
        return null;
      }
      // Presence (M2): {presence:1, ts} — heartbeat «я онлайн» от пира.
      // ЖИВОЙ поллинг: точка загорается сразу, без открытия чата.
      // До parseEnvelope: presence — не конверт (env=null → точка бы
      // не загорелась до ручного открытия чата с этим контактом).
      // Канонический адрес — точка на той же карточке, куда упало бы
      // сообщение от этого ключа (смена почты не расщепляет dot).
      try {
        const robj = JSON.parse(plain);
        if (PresenceFeature.ingestSignal(ctx, robj, ctx.canonicalOf(from) || from, new Date(m.date || Date.now()).getTime())) {
          console.log('[presence] heartbeat from', from);
          return null; // не сообщение, не уведомление
        }
      } catch (e) { /* не JSON — продолжаем */ }
      const env = ctx.parseEnvelope(plain);
      if (env) {
        // env.id — ключ кросс-канального дедупа (relay-копия и
        // email-копия одного сообщения несут ОДИН конверт).
        if (env.id) envId = String(env.id);
        // M2.4 АВТООБМЕН токенами: конверт несёт tok отправителя
        // (адрес его relay-очереди) — сохраняем молча, чтобы
        // отвечать ему мгновенными пушами. Ноль ручного ввода.
        if (env.tok && ctx.relayEnabled) {
          try {
            const rs = await relay.getSettings(ctx.email);
            const r = rs.relays[rs.active] || rs.relays[0];
            if (r) {
              const known = (rs.peers[r.url] || {})[String(from).toLowerCase()];
              if (known !== env.tok) {
                await relay.setPeerToken(ctx.email, r.url, from, env.tok);
                console.log('[relay] peer token auto-learned:', from);
              }
            }
          } catch (e) { /* релей опционален */ }
        }
        // ЭХО-ЗАЩИТА: письмо с МОИМ ключом — это я сам
        // (старый адрес после смены почты / копия в свой ящик).
        // Не профиль, не сообщение, не «смена почты» — иначе свой же
        // аватар перезаписывается старым из собственного письма.
        if (env.key && crypto.publicKey && env.key === crypto.publicKey) {
          ctx.processedUnreadIds.add(m.uid + '|' + (m.folder || 'INBOX'));
          return null;
        }
        // Смена почты: письмо могло прийти со старого адреса
        // контакта (алиаса) — чат ведём по каноническому (показываемому).
        chatKey = ctx.canonicalOf(from) || from;
        // Имя для заголовка: локальное переопределение пользователя →
        // свежее из профиля письма (env.name) → nameOf(). НЕ contact.name —
        {
          const lpn = ctx.localProfileOf(from);
          title = (lpn && lpn.name) || env.name || ctx.nameOf(from);
        }
        // Профиль отправителя: имя/аватар/«О себе» — сохраняем
        // СРАЗУ при поллинге, не дожидаясь открытия чата.
        if (env.type === 'profile' || env.name || env.avatar || typeof env.bio === 'string') {
          api.saveProfile(from, env.name, env.avatar, env.ts || 0,
            typeof env.bio === 'string' ? env.bio : undefined);
          if (env.type === 'profile') { ctx.processedUnreadIds.add(m.uid + '|' + (m.folder || 'INBOX')); return null; }
        }
      }
    } catch (e) { /* не наше письмо */ }
  } else if (crypto.isEncrypted(body)) {
    // Смена почты: отправитель сменил адрес, но ключ тот же.
    // Ключ под НОВЫМ email ещё не зарегистрирован — ищем его среди
    // известных peerKeys (fingerprint-матчинг) и привязываем новый адрес.
    try {
      let matched = null;
      for (const [knownEmail, knownKey] of Object.entries(ctx.peerKeys)) {
        if (String(knownEmail).toLowerCase() === from) continue;
        crypto.setPeerPublicKey(knownKey);
        try {
          const plain = await crypto.decryptVault(body);
          const env = ctx.parseEnvelope(plain);
          // Эхо-защита: письмо с моим ключом — от меня (старый адрес),
          // НЕ «смена почты» собеседника.
          if (env && env.key === knownKey && !(crypto.publicKey && env.key === crypto.publicKey)) {
            matched = { knownEmail, plain, env }; break;
          }
        } catch (e) { /* не этим ключом */ }
      }
      if (matched) {
        console.log('[identity] fingerprint match:', matched.knownEmail, '→', from, '— смена почты (poll)');
        // Переносим историю чата со старого адреса на новый.
        await ctx.migrateChatHistory(matched.knownEmail, from);
        ctx.setPeerKey(from, matched.env.key, matched.env.pq || null);
        // Профиль со старого адреса переносим на новый.
        const oldProf = ctx.profiles[matched.knownEmail];
        if (oldProf) api.saveProfile(from, oldProf.name, oldProf.avatar, matched.env.ts || 0);
        if (matched.env.type === 'profile' || matched.env.name || matched.env.avatar || typeof matched.env.bio === 'string') {
          api.saveProfile(from, matched.env.name, matched.env.avatar, matched.env.ts || 0,
            typeof matched.env.bio === 'string' ? matched.env.bio : undefined);
        }
        chatKey = ctx.canonicalOf(from) || from;
        const lp = ctx.localProfileOf(from);
        title = (lp && lp.name) || from;
        if (matched.env.type === 'profile') { ctx.processedUnreadIds.add(m.uid + '|' + (m.folder || 'INBOX')); return null; }
      }
    } catch (e) { /* не наше письмо */ }
  }

  // Группы — ключом группы, где отправитель участник (1:1-ключ не пройдёт).
  // MEMBERSHIP ПО FINGERPRINT: отправитель может быть участником
  // под СТАРЫМ адресом (сменил почту). Если from не найден среди email,
  // но pubkey конверта совпадает с peerKey одного из участников —
  // мигрируем адрес в составе группы (groups_rename_member) и считаем
  // участником. Без этого письмо от сменившего почту молча терялось
  if (!chatKey) {
    for (const g of ctx.groups) {
      let members = (g.members || []).map(x => String(x.email || '').toLowerCase());
      if (!members.includes(from)) {
        const migrated = await ctx.tryMigrateGroupMember(g, from);
        if (!migrated) continue;
        members = (g.members || []).map(x => String(x.email || '').toLowerCase());
      }
      if (!members.includes(from)) continue;
      let gk = ctx.groupKeys[g.id];
      if (!gk && ctx.cryptoReady) {
        try {
          const kd = await api.getMyGroupKey(g.id);
          if (kd && kd.group_key) { ctx.groupKeys[g.id] = kd.group_key; gk = kd.group_key; }
        } catch (e) { /* ключ недоступен */ }
      }
      if (!gk) continue;
      try {
        const env = ctx.parseEnvelope(await crypto.decryptWithGroupKey(body, gk));
        if (env) {
          chatKey = 'group:' + g.id; title = g.name || '';
          // env.id — ключ кросс-канального дедупа (relay-копия и
          // email-копия одного сообщения несут ОДИН конверт).
          if (env.id) envId = String(env.id);
          break;
        }
      } catch (e) { /* не из этой группы */ }
    }
  }

  // Квитанции/инвайты/meta/legacy — не сообщения, не считаем и не шлём.
  if (!chatKey) return null;
  return { kind: 'message', chatKey, title, envId };
}

// ── Хвост: дедуп + счётчик + уведомление ─────────────────────────────────
async function countAndNotify(ctx, m, cls, { notify }) {
  const { chatKey, title, envId } = cls;
  // Дедуп: письмо уже учтено ранее (повторный фетч) — пропускаем,
  // иначе счётчик непрочитанных рос бы на каждом поллинге.
  const mid = m.uid + '|' + (m.folder || 'INBOX');
  // Дедуп по Message-ID: одно и то же письмо
  // приходит с РАЗНЫМИ ключами uid|folder — копия из INBOX и копия из
  // [Gmail]/All Mail имеют разные uid → два уведомления на письмо
  // (монитор + JS-поллинг гонят параллельно). Message-ID глобален.
  const dk = m.message_id ? 'mid:' + m.message_id : mid;
  // Кросс-канальный дедуп: relay-конверт (uid rl-*) и email-копия несут
  // ОДИН конверт с одним env.id. Без этого ключа бейдж группы рос дважды —
  // relay-копия приходила за ~1с, email через 30-60с, и обе считались
  // «новыми письмами» (uid разных каналов не пересекаются).
  const ek = envId ? 'env:' + envId : null;
  // дедуп СЧЁТЧИКА
  // (processedUnreadIds) не имеет права блокировать УВЕДОМЛЕНИЕ.
  // В 2fa9103 здесь стоял `continue` — тихий поллинг (notify=false)
  // первым «съедал» письмо, заносил mid:<Message-ID> в персистный
  // дедуп, и последующее push-событие монитора (notify=true) молча
  // пропускалось: пуш не появлялся НИКОГДА. Теперь счётчик растёт
  // только для новых писем, а уведомление дедупится НЕЗАВИСИМО —
  // персист notifiedIds в notify.js (ключ dk = Message-ID).
  const counted = !(ctx.processedUnreadIds.has(mid) || ctx.processedUnreadIds.has(dk) || (ek && ctx.processedUnreadIds.has(ek)));
  if (counted) {
    ctx.processedUnreadIds.add(mid);
    ctx.processedUnreadIds.add(dk);
    if (ek) ctx.processedUnreadIds.add(ek);
    if (ctx.processedUnreadIds.size > 600) {
      // Держим хвост: выкидываем старые (Set в порядке вставки).
      for (const old of ctx.processedUnreadIds) {
        ctx.processedUnreadIds.delete(old);
        if (ctx.processedUnreadIds.size <= 500) break;
      }
    }
    await ctx.saveUnreadSeen();
  }
  const fresh = Date.now() - new Date(m.date || 0).getTime() < FRESH_WINDOW_MS;
  // Счётчик непрочитанных: для новых писем, кроме видимого сейчас чата.
  if (counted && !ctx.chatVisible(chatKey)) {
    ctx.unreadCounts[chatKey] = (ctx.unreadCounts[chatKey] || 0) + 1;
    await ctx.saveUnreadCounts();
  }
  // Уведомление: только тихий поллинг, только свежие письма (старые
  // задержанные/догоняющие письма спамом не считаем) и только когда
  // чат НЕ виден (на mobile activeChat может хранить прошлый чат, пока
  // пользователь на списке контактов — иначе уведомление теряется).
  // Пара-фикс (0.1.164): гейт `!this.ecoMode` СНЯТ. Локальная нотификация
  // в эко-режиме при живом процессе — единственный путь уведомления
  // (ntfy-клиента может не быть), а дублей нет: серверный last_seen-гейт
  // (relay_pub) не шлёт ntfy-будильник получателю, который сам поллил
  // за последние 90с — эко-тикер поллит каждые 5с. Пара изменений
  // (сервер+клиент) деплоится строго вместе: сервер без клиента = ноль
  // уведомлений в эко+фон, клиент без сервера = дубли в эко+открыто.
  if (notify && fresh && !ctx.chatVisible(chatKey) && !ctx.isMuted(chatKey)) {
    // пуш должен был быть.
    console.log('[notify] FIRE mid=' + (m.message_id || '?').slice(0, 20) + ' chat=' + chatKey);
    notifyNewMessage({
      title,
      body: ctx.t('notif_new_message') || 'New message',
      chatKey,
      // Дедуп уведомления — по ГЛОБАЛЬНОМУ Message-ID (dk), а не
      // uid|folder: копия в INBOX и [Gmail]/All Mail не дадут два
      // пуша, при этом повторная доставка того же письма монитору
      // после тихого поллинга пуш НЕ отменит.
      id: dk,
    });
  } else if (notify) {
    console.log('[notify] SKIP fresh=' + fresh + ' visible=' + ctx.chatVisible(chatKey) + ' muted=' + ctx.isMuted(chatKey) + ' age=' + Math.round((Date.now() - new Date(m.date || 0).getTime()) / 1000) + 's');
  }
}
