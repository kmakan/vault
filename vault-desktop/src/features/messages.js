// Feature module: 1:1 чат — загрузка/расшифровка/классификация/мерж сообщений.
// Этап 5 декомпозиции App.vue (ctx-паттерн). ADR-001 домен 2 (под-домен
// «загрузка сообщений 1:1»). Вынесено из App.vue МЕХАНИЧЕСКИ (this.* -> ctx.*),
// поведение 1:1. Состояние/downstream (showHistoryFirst/mergeHistory/
// applyReactions/Edits/PollVotes/filterDeleted/mergePending/parseMessageContent/
// processCallSignal/scheduleEphemeral/sendReadReceipts/isIgnored/isOwnSender/
// noteSeen/loadProfiles/...) остаются в App.vue и вызываются через ctx.
import { uiStore } from "./session-store.js";
import api, { db } from '../api.js';
import crypto from '../crypto.js';
import * as PresenceFeature from './presence.js';
import * as MsgFormat from '../message-format.js';
// ADR-004 J.6: владелец peer-ключей — прямой импорт, БЕЗ ctx.
import { identityStore } from './identity-store.js';

export async function loadMessages(ctx, email, deps) {
  const { isOutboundLetter, resolvePeerSender, resolveEventSender, findKnownPeerByKey } = deps;
      // Токен загрузки: если пользователь уже переключился на другой чат,
      // результаты этого (медленного) фетча применять нельзя — иначе
      // сообщения прошлого чата перезапишут новый.
      const seq = ctx.loadSeq;
      const chat = email;
      const stale = () => seq !== ctx.loadSeq || ctx.activeChat !== chat;
      // ВАЖНО: await — история должна загрузиться ДО мержа, иначе
      // гонка с loadMessages: merged=[] без истории и saveCurrentHistory([])
      // затирал сохранённую историю → сообщения «пропадали» (kmakan).
      await ctx.showHistoryFirst(chat, stale);
      // Vault chat: only show mail FOR this contact, and only decrypt if we
      // hold their key (contact must be a Vault peer).
      if (!ctx.peerKeys[email]) {
        ctx.chat.set([]);
        return;
      }
      // Смена почты: контакт мог сменить адрес — ищем письма по
      // ВСЕМ адресам с его ключом (алиасы), иначе история старого адреса
      // не видна в чате нового адреса.
      const aliases = ctx.aliasesOf(email);
      // Ignore-лист: у заблокированного чат открывается пустым (показываем
      // только локальную историю ДО блокировки, новые письма не расшифровываем
      // и не кэшируем). Старые письма в состоянии переписки (chat-store)
      // остаются после showHistoryFirst — блок скрывает именно НОВОЕ.
      const ignored = ctx.isIgnored(email);
      // Письма, уже сохранённые в истории чата (mid = Message-ID), из почты
      // НЕ перефетчивем: история — источник правды из БД, IMAP — только за
      // новыми после последнего курсора (правило 07.10). Реакции/квитанции/
      // правки в историю не пишутся — их mid здесь нет, они обрабатываются
      // как раньше (тела берутся из body_cache, см. fetchBodiesDbFirst).
      const inHist = new Set((ctx.chat.state.messages || []).map(m => m && m.mid).filter(Boolean));
      const relatedAll = ctx.emails
        .filter(m => {
          const f = (m.from || '').toLowerCase();
          const t = (m.to || '').toLowerCase();
          if (ignored || !aliases.some(a => f.includes(a) || t.includes(a))) return false;
          if (m.message_id && inHist.has(m.message_id)) return false;
          return true;
        })
        // Свежие сверху. Расшифровываем только последние 30: фетч тела идёт
        // по одному письму (с переключением папки) — на всю переписку это
        // минуты и чат выглядит пустым. Старая история — отдельная задача
        // (локальное хранилище, инкрементальный поиск с последнего письма).
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
        .slice(0, 30);
      // STEALTH: больше НЕ разделяем письма по теме. И сообщения, и реакции
      // 1-на-1 идут с ПУСТОЙ темой (см. api.sendMessage / sendReaction) —
      // провайдер не видит никаких Vault-маркеров. Классификация идёт по
      // расшифрованному содержимому: {react:1,...} = реакция, {vault:1,...}
      // = конверт сообщения, иначе = legacy-текст.
      const related = relatedAll;
      console.log('[loadMessages] email=' + email + ' emailsTotal=' + ctx.emails.length + ' related=' + related.length);
      if (related.length > 0) {
        crypto.setPeerPublicKey(ctx.peerKeys[email], ctx.peerPqKeys && ctx.peerPqKeys[email]);
        // Батч-фетч тел: группируем по папке и запрашиваем все тела одной
        // командой (Rust выбирает папку один раз). Поштучный фетч делал
        const byFolder = {};
        for (const m of related) {
          const f = m.folder || 'INBOX';
          (byFolder[f] = byFolder[f] || []).push(m);
        }
        console.log('[loadMessages] byFolder=' + JSON.stringify(Object.keys(byFolder)));
        for (const [folder, msgs] of Object.entries(byFolder)) {
          // Пустое тело = ошибка фетча (IMAP-сессия вернула пусто при рассинхроне),
          // а НЕ валидный кэш. Такие письма не кэшируем и перефетчиваем каждый
          // поллинг — иначе инвайты/вложения/голосовые «застревают» пустыми
          // навсегда (так пропадали приглашения и аудио после гонки доставки).
          const missing = msgs.filter(m => {
            const b = ctx.emailBodyCache[`${folder}:${m.uid || m.id}`];
            if (b !== undefined && b !== '') return false;
            // Download-on-demand: письма крупнее порога НЕ фетчим телом
            // автоматически — открытие чата не должно качать десятки МБ.
            // Карточка DoD-вложения знает размер из меты, тело подтянется
            // по клику (fetchDodAttachment). size=0 (неизвестен) — фетчим
            // как раньше (провайдер без RFC822.SIZE или старый кэш).
            if ((m.size || 0) > 2 * 1024 * 1024) return false;
            return true;
          });
          if (missing.length) {
            // Ошибка батча (IMAP-рассинхрон, одно пустое тело роняет весь
            // запрос в Rust) НЕ должна обнулять чат: без try/catch падал
            // весь loadMessages и чат застревал на slim-кэше без вложений
            let bodies = {};
            try {
              bodies = await api.fetchBodiesDbFirst(folder, missing.map(m => m.uid || m.id));
            } catch (e) {
              console.log('[loadMessages] fetchBodiesDbFirst failed folder=' + folder + ' n=' + missing.length + ' err=' + (e && e.message || e));
            }
            console.log('[loadMessages] fetched bodies n=' + Object.keys(bodies).length);
            if (stale()) return;
            for (const m of missing) {
              const b = bodies[String(m.uid || m.id)];
              if (b) ctx.cacheBody(`${folder}:${m.uid || m.id}`, b);
            }
          }
        }
        console.log('[loadMessages] folder pass done (DoD-sized letters skipped)');
        // Единый проход: расшифровываем каждое письмо и классифицируем по
        // содержимому (реакция / правка / конверт / legacy-текст).
        const wireReactions = {}; // msg_id -> [{emoji, user, action}]
        const wirePollVotes = {}; // poll_id -> [{voter, option}]
        const wireEdits = {}; // msg_id -> [{text, action, date}]
        // Квитанции получателя: {delivered:1|read:1, msg_ids:[...]} — для
        // меток статуса наших сообщений (🟢 доставлено / 🔵 просмотрено).
        const wireAcks = {}; // msg_id -> {delivered: bool, read: bool}
        const rendered = await Promise.all(related.map(async (m) => {
          const isOut = isOutboundLetter(m, aliases);
          let content = m.subject || '(no subject)';
          let msgId = m.uid || m.id;
          let attachment = null;
          try {
            const cacheKey = (m.folder || 'INBOX') + ':' + (m.uid || m.id);
            const body = ctx.emailBodyCache[cacheKey] || '';
            // Vault messages carry a raw base64 body — decrypt with AAD="VAULT".
            // Only a message that authenticates as a vault message is shown in
            // the chat; anything else is treated as ordinary/foreign mail.
            if (ctx.cryptoReady) {
              let text;
              try {
                text = await crypto.decryptVault(body);
              } catch (de) {
                // Cannot authenticate/decrypt as a vault message — not ours.
                console.log('[decrypt fail] uid=' + (m.uid || m.id) + ' folder=' + (m.folder || 'INBOX') + ' err=' + (de && de.message || de));
                return null;
              }
              // Звонки (M3): call_* конверты — сигналы, НЕ сообщения. В истории
              // чата не рендерятся (как реакции/квитанции). Живая обработка —
              // в processIncoming (handleCallSignal); здесь просто пропуск.
              const callSig = ctx.parseCallSignal(text);
              if (callSig) return null; // не сообщение
              // 1) Реакция: {react:1, msg_id, emoji, action} — в чат не
              //    показываем, накапливаем для applyReactions.
              try {
                const robj = JSON.parse(text);
                if (robj && robj.react === 1 && robj.msg_id && robj.emoji) {
                  (wireReactions[robj.msg_id] = wireReactions[robj.msg_id] || []).push({
                    emoji: robj.emoji,
                    user: resolvePeerSender(isOut, email, ctx.email),
                    action: robj.action === 'remove' ? 'remove' : 'add',
                  });
                  return null; // не сообщение
                }
                // 1б) Правка: {edit:1, msg_id, text?, action:'edit'|'delete'} —
                //     накапливаем для applyEdits, в чат не показываем.
                if (robj && robj.edit === 1 && robj.msg_id) {
                  (wireEdits[robj.msg_id] = wireEdits[robj.msg_id] || []).push({
                    text: robj.text || '',
                    action: robj.action === 'delete' ? 'delete' : 'edit',
                    date: robj.ts || m.date || 0,
                    sender: robj.sender || resolveEventSender(isOut, email, m.from || ''),
                  });
                  return null; // не сообщение
                }
                // 1в) Квитанции получателя: {delivered:1|read:1, msg_ids:[...]} —
                //     его клиент обработал (доставлено) / открыл (просмотрено)
                //     наши сообщения; накапливаем для меток статуса.
                if (robj && (robj.read === 1 || robj.delivered === 1) && Array.isArray(robj.msg_ids)) {
                  const level = robj.read === 1 ? 'read' : 'delivered';
                  for (const rid of robj.msg_ids) {
                    (wireAcks[rid] = wireAcks[rid] || {})[level] = true;
                  }
                  return null; // не сообщение
                }
                // 1г) Голос голосования: {poll:1, poll_id, option} — сигнальное
                //     письмо (как реакция), агрегируется в карточку опроса.
                if (robj && robj.poll === 1 && robj.poll_id) {
                  (wirePollVotes[robj.poll_id] = wirePollVotes[robj.poll_id] || []).push({
                    voter: ContactsFeature.resolvePeerSender(isOut, email, ctx.email),
                    option: Number(robj.option) || 0,
                  });
                  return null; // не сообщение
                }
                // 1д) Presence: {presence:1, ts} — heartbeat-сигнал собеседника
                //     («я онлайн»); отмечаем активность, в чат не показываем.
                if (PresenceFeature.ingestSignal(ctx, robj, resolvePeerSender(isOut, email, ctx.email), new Date(m.date || Date.now()).getTime())) {
                  return null; // не сообщение
                }
              } catch (e) { /* не JSON — продолжаем как сообщение */ }
              // 2) Конверт {vault:1,id,text,name,avatar}: имя/аватар
              //    отправителя и стабильный id (для реакций).
              const env = MsgFormat.parseEnvelope(text);
              // Download-on-demand: data-письмо — ТРАНСПОРТ, не сообщение.
              // Его содержимое (десятки МБ) подтянется по клику с карточки
              // мета-вложения (fetchDodAttachment по Message-ID из меты).
              if (env && typeof env.text === 'string' && env.text.startsWith('{')) {
                try {
                  const dodObj = JSON.parse(env.text);
                  if (dodObj && dodObj.vault_dod_data === 1) return null;
                } catch (e) { /* не dod — продолжаем */ }
              }
              // (внутри try), а return ниже был ВНЕ неё → ReferenceError молча
              // ловился catch'ем и сообщение шло без ttl. Выносим в msgTtl.
              var msgTtl = 0;
              var msgExpireAt = 0;
              if (env && env.ttl) {
                const _mailTs = new Date(m.date || Date.now()).getTime() || Date.now();
                msgTtl = env.ttl;
                msgExpireAt = _mailTs + env.ttl * 1000;
              }
              if (env) {
                content = env.text;
                if (env.id) msgId = env.id;
                // Вложение внутри конверта: text = JSON {vault_attachment,...}
                // (файлы и голосовые идут этим путём).
                const pp = MsgFormat.parseMessageContent(env.text);
                if (pp.attachment) {
                  attachment = pp.attachment;
                  content = pp.text;
                }
                // isOut=true = письмо прислал СОБЕСЕДНИК (см. from: isOut?'them':'me').
                // Аватар/имя в конверте принадлежат отправителю письма:
                //   входящее (isOut) -> собеседник (email), исходящее -> я (ctx.email).
                // поэтому avatarOf(собеседник) возвращал пусто (асимметрия аватаров).
                const sender = resolvePeerSender(isOut, email, ctx.email);
                // ЭХО-ЗАЩИТА: письмо с МОИМ ключом — от меня самого
                // (старый адрес после смены почты / копия в свой ящик). Не
                // матчим как «смену почты», не сохраняем профиль — иначе
                // свой же аватар перезаписывается старым из своего письма.
                if (env.key && crypto.publicKey && env.key === crypto.publicKey) {
                  return null;
                }
                // FINGERPRINT-МАТЧИНГ: конверт несёт
                // публичный ключ отправителя. Если этот ключ уже известен
                // под ДРУГИМ email — собеседник сменил почту: привязываем
                // новый email к тому же контакту (копируем ключ), не требуя
                // нового приглашения.
                if (env.key && !isOut) {
                  const oldEmail = findKnownPeerByKey(ctx.peerKeys, env.key, sender);
                  if (oldEmail) {
                    // ANTI-PING-PONG: старое письмо (ts ≤ порога) не должно
                    // переименовывать назад — пропускаем письмо целиком
                    // (его содержимое уже в истории после миграции чата).
                    const _idTs = new Date(m.date || 0).getTime() || 0;
                    if (!(await api.identityLetterFresh(env.key, _idTs))) {
                      console.log('[identity] stale letter — rename skipped:', sender, '→', oldEmail);
                      return null;
                    }
                    console.log('[identity] fingerprint match:', oldEmail, '→', sender, '— смена почты');
                    // ПОЛНЫЙ РЕНЕЙМ ЛИЧНОСТИ во всех слоях: списки контактов
                    // (accepted/declined/invited), relay-токены, счётчики
                    // непрочитанного, профиль и история чата в sqlite.
                    // Без этого старый адрес остаётся жить рядом с новым →
                    // ВТОРОЙ контакт и расколотая переписка (живые данные 06.10).
                    await api.renamePeerIdentity(oldEmail, sender);
                    // Группы: переименовать адрес во всех, где он участник.
                    // tryMigrateGroupMember срабатывает только на входящем
                    // письме и ищет по peerKeys — который ренейм уже почистил.
                    await ctx.migratePeerGroups(oldEmail, sender);
                    // Переносим историю чата по ВСЕЙ цепочке алиасов: пир мог
                    // менять почту несколько раз, и одного переноса не хватит —
                    // осиротевший ключ означает исчезнувую переписку (ADR-003 §5.1).
                    await ctx.migrateChatHistoryChain(sender, ctx.email, ctx.contactAliases);
                    // Копируем профиль старого адреса на новый (имя/аватар).
                    const oldProf = ctx.profiles[oldEmail];
                    if (oldProf) api.saveProfile(sender, oldProf.name, oldProf.avatar, env.ts || 0);
                    // Смена почты: СТАРЫЙ адрес убираем из всех хранилищ
                    // (диск/память/стабы контактов/профиль) — иначе остаётся
                    // второй контакт с тем же ключом. Порядок: до setPeerKey,
                    // чтобы remove_peer_key вычистил старую запись до
                    // переименования/добавления новой.
                    if (String(oldEmail).toLowerCase() !== senderNorm) {
                      try { await crypto.removePeerKey(oldEmail); } catch (e) {}
                      // Удаление — через владельца identity (ADR-004 J.6), БЕЗ ctx.
                      identityStore.removePeerKey(oldEmail);
                      api.removeContact(oldEmail);
                      api.deleteProfile(oldEmail);
                      console.log('[identity] peer renamed: '+oldEmail+' → '+sender);
                    }
                    // Регистрируем ключ под новым email (peer_keys.json).
                    ctx.setPeerKey(sender, env.key, env.pq || null);
                    // Порог ренейма = дата этого (свежего) письма.
                    await api.bumpIdentityRenameTs(env.key, _idTs);
                  } else if (!ctx.peerKeys[sender] && env.key !== crypto.publicKey) {
                    // Незнакомый ключ с нового адреса: сохраняем как есть —
                    // контакт появится после обмена ключами (инвайт/QR).
                    ctx.setPeerKey(sender, env.key, env.pq || null);
                  }
                }
                if (env.name || env.avatar) {
                  // ts письма (отправки) — чтобы отставшее письмо не
                  // перезаписывало более свежий профиль (см. saveProfile).
                  api.saveProfile(sender, env.name, env.avatar, env.ts || 0, typeof env.bio === 'string' ? env.bio : undefined);
                }
                // Профильное письмо (type:'profile'): name/avatar уже
                // сохранены выше — как сообщение НЕ рендерим (системное).
                if (env.type === 'profile') {
                  return null;
                }
                // SOS (duress): в чате с префиксом — видно и после закрытия.
                if (env.type === 'sos') {
                  content = '🚨 SOS: ' + (env.text || '');
                }
                // Голосование (poll): карточка вместо текста.
                if (env.type === 'poll') {
                  const p = ctx.parsePollEnvelope(env);
                  if (p) return {
                    id: p.id || msgId,
                    content: p.question,
                    attachment: null,
                    from: isOut ? 'them' : 'me',
                    time: m.date ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
                    encrypted: true,
                    vault: true,
                    mid: m.message_id || '',
                    email: m,
                    poll: p,
                  };
                }
              } else {
                // 3) Legacy: простой текст (старые письма без конверта).
                const pp = MsgFormat.parseMessageContent(text);
                content = pp.text || content;
                if (pp.attachment) {
                  attachment = pp.attachment;
                }
              }
            } else {
              // No crypto — not a vault message.
              return null;
            }
            return {
              id: msgId,
              content,
              attachment,
              from: isOut ? 'them' : 'me',
              time: m.date ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
              encrypted: true,
              vault: true,
              mid: m.message_id || '',
              ttl: msgTtl,
              expireAt: msgExpireAt,
              email: m,
            };
          } catch (e) {
            return {
              id: msgId,
              content,
              from: isOut ? 'them' : 'me',
              time: m.date ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
              encrypted: false,
              mid: m.message_id || '',
              email: m,
            };
          }
        }));
        if (stale()) return;
        ctx.loadProfiles();
        // Дедупликация по id конверта: одно письмо может лежать в нескольких
        // папках (Rust дедуплицирует по Message-ID, но письма без заголовка
        // проскакивают дважды; плюс Sent-копии наших исходящих).
        const dedup = new Map();
        for (const r of rendered.filter(r => r && r.vault)) {
          if (!dedup.has(r.id)) dedup.set(r.id, r);
        }
        const list = [...dedup.values()].sort((a, b) => new Date(a.email?.date || 0) - new Date(b.email?.date || 0));
        // Статусы наших сообщений: квитанции получателя (delivered/read);
        // если квитанций нет, но письмо уже в ящике — круг через сервер
        // завершён, считаем доставленным.
        for (const m of list) {
          if (m.from !== 'me') continue;
          const ack = wireAcks[m.id];
          m.status = ack && ack.read ? 'read' : 'delivered';
        }
        // pending-записи отправителя: квитанции {read:1}/{delivered:1} снимают
        // 'failed'/'sent' → 'read'/'delivered'.
        const pb = ctx.pendingOutgoing[chat] || {};
        for (const [pid, pmsg] of Object.entries(pb)) {
          const ack = wireAcks[pid];
          if (!ack) continue;
          if (ack.read) pmsg.status = 'read';
          else if (ack.delivered) pmsg.status = 'delivered';
        }
        // ИСТОРИЯ — основа чата, письма — дополнение; статусы/реакции/правки
        // применяются к merged; pending — подмешиваются; удалённые фильтруются.
        const hadMessages = ctx.chat.state.messages && ctx.chat.state.messages.length > 0;
        const merged0 = await ctx.mergeHistory(chat, list);
        const statusById = new Map();
        for (const m of list) if (m.id && m.status) statusById.set(m.id, m.status);
        for (const m of merged0) {
          const st = statusById.get(m.id);
          if (st) m.status = st;
        }
        // Квитанции получателя — к СВОИМ сообщениям в истории (Sent не
        // читается, свои сообщения в `list` из IMAP не попадают; без этого
        for (const m of merged0) {
          if (m.from !== 'me' || !m.id) continue;
          const ack = wireAcks[m.id];
          if (ack && ack.read) m.status = 'read';
          else if (ack && ack.delivered) m.status = 'delivered';
        }
        ctx.applyReactions(merged0, chat, wireReactions);
        ctx.applyEdits(merged0, chat, wireEdits);
        ctx.applyPollVotes(merged0, wirePollVotes);
        const merged = ctx.filterDeleted(ctx.mergePending(chat, merged0));
        for (const m of merged) if (m.expireAt) ctx.scheduleEphemeral(m, chat);
        if (!merged.length && hadMessages && !stale()) {
          // Письма не пришли, но чат уже показан (кэш/история/оптимистичные)
          // — оставляем его, кэш не переписываем (иначе пустота затёрла бы
          // сохранённую историю чата).
          return;
        }
        ctx.chat.set(merged);
        ctx.saveChatCache(chat, ctx.chat.state.messages);
        // Локальная история (IndexedDB) — полный архив чата.
        ctx.saveCurrentHistory(chat);
        // Открыли чат — шлём отправителю квитанции «просмотрено» по входящим.
        const incoming = ctx.chat.state.messages.filter(m => m.from === 'them' && m.id && !m.callEvent).map(m => m.id);
        ctx.sendReadReceipts(incoming);
        return;
      }

      // Fallback: legacy backend path (groups, peer-key chats)
      // а локальная история чата уже показана (showHistoryFirst) — не
      // затираем её. Иначе после перезапуска чаты «пустели», хотя кэш
      // истории на месте.
      if (ctx.chat.state.messages && ctx.chat.state.messages.length) return;
      try {
        const raw = await api.getMessages(email);
        if (stale()) return;
        if (ctx.cryptoReady && ctx.peerKeys[email]) {
          crypto.setPeerPublicKey(ctx.peerKeys[email], ctx.peerPqKeys && ctx.peerPqKeys[email]);
          const decrypted = await Promise.all(
            raw.map(async (msg) => {
              // SOS (duress): пишется в чат как обычное сообщение с префиксом —
              // тост был эфемерным (8с) и SOS терялся, если его не увидели.
              {
                const envCheck = msg.content && crypto.isEncrypted(msg.content)
                  ? MsgFormat.parseEnvelope(await crypto.decryptVault(msg.content).catch(() => null)) : null;
                if (envCheck && envCheck.type === 'sos') {
                  uiStore.toast('🚨 ' + (envCheck.name || ctx.activeChat) + ': ' + envCheck.text, 8000);
                  return {
                    ...msg,
                    content: '🚨 SOS: ' + envCheck.text,
                    from: ctx.isOwnSender(msg.sender_id) ? 'me' : 'them',
                    time: new Date(msg.created_at).toLocaleTimeString(),
                    status: 'delivered',
                    attachment: null,
                  };
                }
              }
              const { text, attachment } = MsgFormat.parseMessageContent(msg.content);
              const base = {
                ...msg,
                content: text,
                from: ctx.isOwnSender(msg.sender_id) ? 'me' : 'them',
                time: new Date(msg.created_at).toLocaleTimeString(),
                status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
                attachment,
              };
              if (crypto.isEncrypted(msg.content)) {
                try {
                  const text = await crypto.decryptVault(msg.content);
                  const env = MsgFormat.parseEnvelope(text);
                  if (env && env.type === 'sos') {
                    // SOS (duress): тоже в чат (см. выше) — тост как дубль-уведомление.
                    uiStore.toast('🚨 ' + (env.name || ctx.activeChat) + ': ' + env.text, 8000);
                    return {
                      ...msg,
                      content: '🚨 SOS: ' + env.text,
                      from: ctx.isOwnSender(msg.sender_id) ? 'me' : 'them',
                      time: new Date(msg.created_at).toLocaleTimeString(),
                      status: 'delivered',
                      attachment: null,
                    };
                  }
                  if (env) {
                    // Зелёная точка: письмо от контакта = активность сейчас
                    if (!ctx.isOwnSender(msg.sender_id)) {
                      ctx.noteSeen(ctx.activeChat, new Date(msg.created_at).getTime());
                    }
                    const parsed = MsgFormat.parseMessageContent(env.text);
                    // Исчезающие: отсчёт у получателя — от момента доставки
                    // (created_at письма). Точный «от просмотра» потребовал бы
                    // read-receipt-синхронизации; доставка — честный компромисс.
                    // new Date(undefined) давал NaN и таймер не взводился.
                    const mailTs = new Date(msg.created_at || msg.date || Date.now()).getTime() || Date.now();
                    const expireAt = env.ttl ? mailTs + env.ttl * 1000 : 0;
                    return { ...base, id: env.id || base.id, content: parsed.text, attachment: parsed.attachment, encrypted: true, ttl: env.ttl || 0, expireAt };
                  }
                  const parsed = MsgFormat.parseMessageContent(text);
                  return { ...base, content: parsed.text, attachment: parsed.attachment, encrypted: true };
                } catch {
                  return { ...base, encrypted: false };
                }
              }
              return { ...base, encrypted: false };
            })
          );
          if (stale()) return;
          ctx.chat.set(decrypted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
          for (const m of ctx.chat.state.messages) if (m.expireAt) ctx.scheduleEphemeral(m, ctx.activeChat);
        } else {
          ctx.chat.set(raw.map(msg => {
            const { text, attachment } = MsgFormat.parseMessageContent(msg.content);
            return {
              ...msg,
              content: text,
              from: ctx.isOwnSender(msg.sender_id) ? 'me' : 'them',
              time: new Date(msg.created_at).toLocaleTimeString(),
              status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
              encrypted: false,
              attachment,
            };
          }).filter(Boolean).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
        }
      } catch (error) {
        console.error('Failed to load messages:', error);
        if (!stale()) ctx.chat.set([]);
      }
}
