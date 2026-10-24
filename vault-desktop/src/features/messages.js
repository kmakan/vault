// Feature module: 1:1 чат — загрузка/расшифровка/классификация/мерж сообщений.
// ADR-001 домен 2 (под-домен «загрузка сообщений 1:1»). Поведение — как было.
//
// ADR-005 W2 (`t_bcb8927a`), партия 3: модуль больше НЕ читает компонент.
// Данные берутся у владельцев (ADR-004): открытый чат — `chatStore`, почта —
// `sessionStore`, ключи — `identityStore`, письма и кэш тел — `mailboxState`,
// алиасы контактов — `contactsStore`; per-app стор `chat` и sending приходят
// в `deps` вместе с эффектами других доменов: `loadMessages(deps, email)`.
//
// ЧТО ОСТАЛОСЬ В deps И ПОЧЕМУ (домен загрузки — точка сборки многих фич):
//   · `chat`/`sending` — per-app экземпляры владельцев (создаются в setup);
//   · `getLoadSeq` — токен загрузки: читается ВНУТРИ `stale()`, то есть живьём;
//   · `profiles` — снимок состояния профилей (геттер: профили грузятся в
//     том же проходе, а не хранятся у владельца);
//   · `mergeHistory`/`applyReactions`/`applyEdits`/`applyPollVotes`/
//     `filterDeleted`/`mergePending`/`loadProfiles`/`scheduleEphemeral`/
//     `sendReadReceipts`/`showHistoryFirst`/`saveChatCache`/`saveCurrentHistory`/
//     `cacheBody`/`noteSeen`/`setPeerKey`/`isIgnored`/`isOwnSender`/`aliasesOf`/
//     `parseCallSignal`/`parsePollEnvelope`/`migratePeerGroups`/
//     `migrateChatHistoryChain` — эффекты и решения соседних доменов.
//     `noteSeen` — связанная функция отметки: её получает presence.js
//     (ADR-005 R3), компонент модулю не виден.
import { expireAt } from '../ephemeral-rule.js';
import { uiStore } from "./session-store.js";
import api, { db } from '../api.js';
import crypto from '../crypto.js';
import { peerContactFor } from '../identity.js';
import * as PresenceFeature from './presence.js';
import * as MsgFormat from '../message-format.js';
import * as WireSignalRule from '../wire-signal-rule.js';
// ADR-004: владельцы состояния — прямые импорты, БЕЗ deps.
import { identityStore } from './identity-store.js';
import { chatStore as chatState, sessionStore } from './session-store.js';
import { mailboxState } from './mailbox-store.js';
import { contactsStore } from './contacts-store.js';

// chatUi — алиас на state владельца открытого чата (владелец меняет поля, а не
// объект). Почта — функцией: вход/выход могут случиться посреди загрузки.
const chatUi = chatState.state;
const myEmail = () => sessionStore.getCurrentEmail();

export async function loadMessages(deps, email) {
  const { isOutboundLetter, resolvePeerSender, resolveEventSender, findKnownPeerByKey } = deps;
      // Токен загрузки: если пользователь уже переключился на другой чат,
      // результаты этого (медленного) фетча применять нельзя — иначе
      // сообщения прошлого чата перезапишут новый.
      const seq = deps.getLoadSeq();
      const chat = email;
      const stale = () => seq !== deps.getLoadSeq() || chatUi.activeChat !== chat;
      // ВАЖНО: await — история должна загрузиться ДО мержа, иначе
      // гонка с loadMessages: merged=[] без истории и saveCurrentHistory([])
      // затирал сохранённую историю → сообщения «пропадали» (kmakan).
      //
      // НО только когда показывать нечего. Раньше история подставлялась на
      // КАЖДОМ поллинге и затирала экран: optimistic-сообщение, которого ещё
      // нет в архиве, исчезало через 2–3 секунды после отправки («отправил —
      // сообщение пропало», 22.10). Экран — живой список, архив — дополнение.
      if (!(deps.chat.state.messages || []).length) {
        await deps.showHistoryFirst(chat, stale);
      }
      // Vault chat: only show mail FOR this contact, and only decrypt if we
      // hold their key (contact must be a Vault peer). Ключ ищем по любой форме
      // адреса пира (он мог сменить почту), а не по голой строке.
      if (!(await peerContactFor(email, identityStore.state.peerKeys, myEmail())).key) {
        deps.chat.set([]);
        return;
      }
      // Смена почты: контакт мог сменить адрес — ищем письма по
      // ВСЕМ адресам с его ключом (алиасы), иначе история старого адреса
      // не видна в чате нового адреса.
      const aliases = deps.aliasesOf(email);
      // Ignore-лист: у заблокированного чат открывается пустым (показываем
      // только локальную историю ДО блокировки, новые письма не расшифровываем
      // и не кэшируем). Старые письма в состоянии переписки (chat-store)
      // остаются после showHistoryFirst — блок скрывает именно НОВОЕ.
      const ignored = deps.isIgnored(email);
      // Письма, уже сохранённые в истории чата (mid = Message-ID), из почты
      // НЕ перефетчивем: история — источник правды из БД, IMAP — только за
      // новыми после последнего курсора (правило 07.10). Реакции/квитанции/
      // правки в историю не пишутся — их mid здесь нет, они обрабатываются
      // как раньше (тела берутся из body_cache, см. fetchBodiesDbFirst).
      const inHist = new Set((deps.chat.state.messages || []).map(m => m && m.mid).filter(Boolean));
      const relatedAll = mailboxState.state.emails
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
      console.log('[loadMessages] email=' + email + ' emailsTotal=' + mailboxState.state.emails.length + ' related=' + related.length);
      if (related.length > 0) {
        crypto.setPeerPublicKey(identityStore.state.peerKeys[email], identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[email]);
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
            const b = mailboxState.state.emailBodyCache[`${folder}:${m.uid || m.id}`];
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
              if (b) deps.cacheBody(`${folder}:${m.uid || m.id}`, b);
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
            const body = mailboxState.state.emailBodyCache[cacheKey] || '';
            // Vault messages carry a raw base64 body — decrypt with AAD="VAULT".
            // Only a message that authenticates as a vault message is shown in
            // the chat; anything else is treated as ordinary/foreign mail.
            if (deps.cryptoReady) {
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
              const callSig = await deps.parseCallSignal(text);
              if (callSig) return null; // не сообщение
              // 1) Реакция: {react:1, msg_id, emoji, action} — в чат не
              //    показываем, накапливаем для applyReactions.
              // РОУТЕР СЕРВИСНЫХ СИГНАЛОВ — В RUST (ADR-005 R1 / W4): «что это за
              // письмо — реакция, правка, квитанция, голос или presence» решает
              // ядро (vault::signals::parse_signal). Раньше JS разбирал это сам,
              // и в личных чатах и в группах — местами разными правилами.
              const sig = await WireSignalRule.parseSignal(text);
              if (sig) {
                // Реакция: {react:1, msg_id, emoji, action?} — в чат не
                // показываем, накапливаем для applyReactions.
                if (sig.kind === 'reaction') {
                  (wireReactions[sig.msg_id] = wireReactions[sig.msg_id] || []).push({
                    emoji: sig.emoji,
                    user: resolvePeerSender(isOut, email, myEmail()),
                    action: sig.action,
                  });
                  return null; // не сообщение
                }
                // Правка: {edit:1, msg_id, text?, action:'edit'|'delete'} —
                // накапливаем для applyEdits, в чат не показываем.
                if (sig.kind === 'edit') {
                  (wireEdits[sig.msg_id] = wireEdits[sig.msg_id] || []).push({
                    text: sig.text,
                    action: sig.action,
                    date: sig.ts || m.date || 0,
                    sender: sig.sender || resolveEventSender(isOut, email, m.from || ''),
                  });
                  return null; // не сообщение
                }
                // Квитанции получателя: {delivered:1|read:1, msg_ids:[...]} —
                // его клиент обработал (доставлено) / открыл (просмотрено)
                // наши сообщения; накапливаем для меток статуса.
                if (sig.kind === 'ack') {
                  for (const rid of sig.msg_ids) {
                    (wireAcks[rid] = wireAcks[rid] || {})[sig.level] = true;
                  }
                  return null; // не сообщение
                }
                // Голос голосования: {poll:1, poll_id, option} — сигнальное
                // письмо (как реакция), агрегируется в карточку опроса.
                if (sig.kind === 'poll_vote') {
                  (wirePollVotes[sig.poll_id] = wirePollVotes[sig.poll_id] || []).push({
                    voter: resolvePeerSender(isOut, email, myEmail()),
                    option: sig.option,
                  });
                  return null; // не сообщение
                }
                // Presence: {presence:1, ts} — heartbeat-сигнал собеседника
                // («я онлайн»); отмечаем активность, в чат не показываем.
                // Тип уже решил Rust — здесь только последствие (связанная
                // функция отметки; компонент модуль не видит).
                if (sig.kind === 'presence') {
                  PresenceFeature.noteHeartbeat(deps.noteSeen, resolvePeerSender(isOut, email, myEmail()), new Date(m.date || Date.now()).getTime());
                  return null; // не сообщение
                }
              }
              // 2) Конверт {vault:1,id,text,name,avatar}: имя/аватар
              //    отправителя и стабильный id (для реакций).
              const env = await MsgFormat.parseEnvelope(text);
              // Download-on-demand: data-письмо — ТРАНСПОРТ, не сообщение.
              // Его содержимое (десятки МБ) подтянется по клику с карточки
              // мета-вложения (fetchDodAttachment по Message-ID из меты).
              if (env && typeof env.text === 'string' && env.text.startsWith('{')) {
                // ФОРМАТ data-письма — В RUST (ADR-005 R1 / W4): «что считается
                // data-письмом» решает ядро (vault::vault::signals).
                if (await WireSignalRule.parseDodData(env.text)) return null;
              }
              // (внутри try), а return ниже был ВНЕ неё → ReferenceError молча
              // ловился catch'ем и сообщение шло без ttl. Выносим в msgTtl.
              var msgTtl = 0;
              var msgExpireAt = 0;
              if (env && env.ttl) {
                const _mailTs = new Date(m.date || Date.now()).getTime() || Date.now();
                msgTtl = env.ttl;
                // Правило времени жизни — из Rust (ADR-005 R1, W4).
                msgExpireAt = await expireAt(_mailTs, env.ttl);
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
                //   входящее (isOut) -> собеседник (email), исходящее -> я (myEmail()).
                // поэтому avatarOf(собеседник) возвращал пусто (асимметрия аватаров).
                const sender = resolvePeerSender(isOut, email, myEmail());
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
                  // Нормализованный адрес отправителя: сравнение в ренейме
                  // идёт по нижнему регистру (иначе «Peer@x» снова попадал бы
                  // в удаление как «старый адрес»).
                  const senderNorm = String(sender).toLowerCase();
                  const oldEmail = findKnownPeerByKey(identityStore.state.peerKeys, env.key, sender);
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
                    await deps.migratePeerGroups(oldEmail, sender);
                    // Переносим историю чата по ВСЕЙ цепочке алиасов: пир мог
                    // менять почту несколько раз, и одного переноса не хватит —
                    // осиротевший ключ означает исчезнувую переписку (ADR-003 §5.1).
                    await deps.migrateChatHistoryChain(sender, myEmail(), contactsStore.state.contactAliases);
                    // Копируем профиль старого адреса на новый (имя/аватар).
                    const oldProf = deps.profiles()[oldEmail];
                    if (oldProf) api.saveProfile(sender, oldProf.name, oldProf.avatar, env.ts || 0);
                    // Смена почты: СТАРЫЙ адрес убираем из всех хранилищ
                    // (диск/память/стабы контактов/профиль) — иначе остаётся
                    // второй контакт с тем же ключом. Порядок: до setPeerKey,
                    // чтобы remove_peer_key вычистил старую запись до
                    // переименования/добавления новой.
                    if (String(oldEmail).toLowerCase() !== senderNorm) {
                      try { await crypto.removePeerKey(oldEmail); } catch (e) {}
                      // Удаление — через владельца identity (ADR-004 J.6), БЕЗ deps.
                      identityStore.removePeerKey(oldEmail);
                      api.removeContact(oldEmail);
                      api.deleteProfile(oldEmail);
                      console.log('[identity] peer renamed: '+oldEmail+' → '+sender);
                    }
                    // Регистрируем ключ под новым email (peer_keys.json).
                    deps.setPeerKey(sender, env.key, env.pq || null);
                    // Порог ренейма = дата этого (свежего) письма.
                    await api.bumpIdentityRenameTs(env.key, _idTs);
                  } else if (!identityStore.state.peerKeys[sender] && env.key !== crypto.publicKey) {
                    // Незнакомый ключ с нового адреса: сохраняем как есть —
                    // контакт появится после обмена ключами (инвайт/QR).
                    deps.setPeerKey(sender, env.key, env.pq || null);
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
                  const p = deps.parsePollEnvelope(env);
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
              expiresAt: msgExpireAt,
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
        deps.loadProfiles();
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
        const pb = deps.sending.state.pendingOutgoing[chat] || {};
        for (const [pid, pmsg] of Object.entries(pb)) {
          const ack = wireAcks[pid];
          if (!ack) continue;
          if (ack.read) pmsg.status = 'read';
          else if (ack.delivered) pmsg.status = 'delivered';
        }
        // ИСТОРИЯ — основа чата, письма — дополнение; статусы/реакции/правки
        // применяются к merged; pending — подмешиваются; удалённые фильтруются.
        const merged0 = await deps.mergeHistory(chat, list);
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
        deps.applyReactions(merged0, chat, wireReactions);
        deps.applyEdits(merged0, chat, wireEdits);
        deps.applyPollVotes(merged0, wirePollVotes);
        const merged = deps.filterDeleted(deps.mergePending(chat, merged0));
        for (const m of merged) if (m.expiresAt) deps.scheduleEphemeral(m, chat).catch(() => {});
        // Экран перезаписывается, только если чат всё ещё открыт. Гард до
        // merge (строка выше) покрывает расшифровку, но переключение чата
        // посреди слияния/статусов иначе показало бы ДРУГОМУ чату сообщения
        // этого — тот же класс «чат изменился сам собой».
        if (stale()) return;
        if (!merged.length) {
          if (merged0.length) {
            // Всё содержимое удалено (томбстоуны/эфемерные) — очистка законна.
            deps.chat.set([]);
            deps.saveChatCache(chat, []);
            return;
          }
          // Пустой результат = «нечего показать СЕЙЧАС», а не «чат пуст»:
          // история могла не загрузиться (гонка открытия чата с поллингом),
          // письма могли не расшифроваться. Пустотой архив и кэш НЕ
          // переписываем — иначе переписка затиралась насовсем (именно так
          // «менялся чат» и исчезало только что отправленное сообщение).
          console.warn('[loadMessages] пустой результат — чат и архив не переписываю');
          return;
        }
        deps.chat.set(merged);
        deps.saveChatCache(chat, deps.chat.state.messages);
        // Локальная история (archive) — дополняется, но не укорачивается
        // (слияние внутри saveHistory).
        deps.saveCurrentHistory(chat);
        // Открыли чат — шлём отправителю квитанции «просмотрено» по входящим.
        const incoming = deps.chat.state.messages.filter(m => m.from === 'them' && m.id && !m.callEvent).map(m => m.id);
        deps.sendReadReceipts(incoming);
        return;
      }

      // Fallback: legacy backend path (groups, peer-key chats)
      // а локальная история чата уже показана (showHistoryFirst) — не
      // затираем её. Иначе после перезапуска чаты «пустели», хотя кэш
      // истории на месте.
      if (deps.chat.state.messages && deps.chat.state.messages.length) return;
      try {
        const raw = await api.getMessages(email);
        if (stale()) return;
        if (deps.cryptoReady && identityStore.state.peerKeys[email]) {
          crypto.setPeerPublicKey(identityStore.state.peerKeys[email], identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[email]);
          const decrypted = await Promise.all(
            raw.map(async (msg) => {
              // SOS (duress): пишется в чат как обычное сообщение с префиксом —
              // тост был эфемерным (8с) и SOS терялся, если его не увидели.
              {
                const envCheck = msg.content && crypto.isEncrypted(msg.content)
                  ? await MsgFormat.parseEnvelope(await crypto.decryptVault(msg.content).catch(() => null)) : null;
                if (envCheck && envCheck.type === 'sos') {
                  uiStore.toast('🚨 ' + (envCheck.name || chatUi.activeChat) + ': ' + envCheck.text, 8000);
                  return {
                    ...msg,
                    content: '🚨 SOS: ' + envCheck.text,
                    from: deps.isOwnSender(msg.sender_id) ? 'me' : 'them',
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
                from: deps.isOwnSender(msg.sender_id) ? 'me' : 'them',
                time: new Date(msg.created_at).toLocaleTimeString(),
                status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
                attachment,
              };
              if (crypto.isEncrypted(msg.content)) {
                try {
                  const text = await crypto.decryptVault(msg.content);
                  const env = await MsgFormat.parseEnvelope(text);
                  if (env && env.type === 'sos') {
                    // SOS (duress): тоже в чат (см. выше) — тост как дубль-уведомление.
                    uiStore.toast('🚨 ' + (env.name || chatUi.activeChat) + ': ' + env.text, 8000);
                    return {
                      ...msg,
                      content: '🚨 SOS: ' + env.text,
                      from: deps.isOwnSender(msg.sender_id) ? 'me' : 'them',
                      time: new Date(msg.created_at).toLocaleTimeString(),
                      status: 'delivered',
                      attachment: null,
                    };
                  }
                  if (env) {
                    // Зелёная точка: письмо от контакта = активность сейчас
                    if (!deps.isOwnSender(msg.sender_id)) {
                      deps.noteSeen(chatUi.activeChat, new Date(msg.created_at).getTime());
                    }
                    const parsed = MsgFormat.parseMessageContent(env.text);
                    // Исчезающие: отсчёт у получателя — от момента доставки
                    // (created_at письма). Точный «от просмотра» потребовал бы
                    // read-receipt-синхронизации; доставка — честный компромисс.
                    // new Date(undefined) давал NaN и таймер не взводился.
                    const mailTs = new Date(msg.created_at || msg.date || Date.now()).getTime() || Date.now();
                    // Правило времени жизни — из Rust (ADR-005 R1, W4).
                    const expiresAt = await expireAt(mailTs, env.ttl);
                    return { ...base, id: env.id || base.id, content: parsed.text, attachment: parsed.attachment, encrypted: true, ttl: env.ttl || 0, expiresAt };
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
          deps.chat.set(decrypted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
          for (const m of deps.chat.state.messages) if (m.expiresAt) deps.scheduleEphemeral(m, chatUi.activeChat).catch(() => {});
        } else {
          deps.chat.set(raw.map(msg => {
            const { text, attachment } = MsgFormat.parseMessageContent(msg.content);
            return {
              ...msg,
              content: text,
              from: deps.isOwnSender(msg.sender_id) ? 'me' : 'them',
              time: new Date(msg.created_at).toLocaleTimeString(),
              status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
              encrypted: false,
              attachment,
            };
          }).filter(Boolean).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
        }
      } catch (error) {
        console.error('Failed to load messages:', error);
        if (!stale()) deps.chat.set([]);
      }
}
