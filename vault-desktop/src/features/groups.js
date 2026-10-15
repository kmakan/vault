// Feature module: групповые сообщения — загрузка/расшифровка/классификация/мерж.
// Этап 5 декомпозиции App.vue (ctx-паттерн). ADR-001 домен 2 (под-домен
// «групповые сообщения»). Вынесено из App.vue механически (this.* -> ctx.*),
// поведение 1:1. Состояние/downstream (readPinned/showHistoryFirst/mergeHistory/
// applyReactions/Edits/PollVotes/filterDeleted/mergePending/parseMessageContent/
// scheduleEphemeral/sendReadReceipts/isIgnored/isOwnSender/loadProfiles/...)
// остаются в App.vue и вызываются через ctx.
//
// STEALTH-группы: тема писем пустая → subject-фильтрации нет; единый проход
// классифицирует реакцию/правку/квитанцию/pin/poll/presence/meta/hav/сообщение.
import api, { db } from '../api.js';
import crypto from '../crypto.js';
import * as PresenceFeature from './presence.js';
import * as PinWire from './group-pin-wire.js';

export async function loadGroupMessages(ctx, groupId, forceRescan = false) {
      // Токен загрузки — см. loadMessages (защита от гонки переключения).
      const seq = ctx.loadSeq;
      const chat = 'group:' + groupId;
      const stale = () => seq !== ctx.loadSeq || ctx.activeChat !== chat;
      // Закреплённое сообщение группы — баннер виден сразу (без ожидания
      // поллинга), потом pin-письма из цикла ниже обновят его по дате.
      if (!stale()) {
        const pin = await ctx.readPinned(groupId);
        ctx.pinnedMsgId = (pin && pin.msg_id) || null;
        ctx.pinnedPreview = (pin && pin.preview) || '';
      }
      // ВАЖНО: await — история должна загрузиться ДО мержа, иначе
      // гонка с loadGroupMessages: merged=[] без истории и saveCurrentHistory
      // затирал сохранённую историю → сообщения «пропадали» (kmakan).
      await ctx.showHistoryFirst(chat, stale);
      try {
        const raw = await api.getGroupMessages(groupId, ctx.emails, !!forceRescan);
        if (stale()) return;
        let groupKey = ctx.groupKeys[groupId];
        // Гонка инициализации: группа могла открыться (или восстановиться
        // из кэша) до того, как crypto завершил initCrypto() — тогда в
        // selectGroup загрузка ключа была пропущена (guard `cryptoReady`),
        // и в памяти ключа нет, хотя группы.json уже содержит его. Догружаем
        // ключ прямо здесь, чтобы групповые сообщения не рендерились
        // шифротекстом.
        if (!groupKey && ctx.cryptoReady) {
          try {
            const kd = await api.getMyGroupKey(groupId);
            if (kd && kd.group_key) {
              ctx.groupKeys[groupId] = kd.group_key;
              groupKey = kd.group_key;
            }
          } catch (e) {
            console.warn('Could not lazily load group key:', e);
          }
        }

        // STEALTH-ГРУППЫ: у групповых писем темы ПУСТЫЕ
        // поэтому subject-фильтрации нет. getGroupMessages вернул ВСЕ письма,
        // чей отправитель — участник группы; здесь — единый проход:
        //   1) расшифровка групповым ключом (не расшифровалось = чужое
        //      письмо/1:1/инвайт — криптография сама отфильтровала);
        //   2) классификация по СОДЕРЖИМОМУ: реакция / правка / квитанция
        //      чтения / meta (аватар) / сообщение (конверт или legacy).
        const wireReactions = {}; // msg_id -> [{emoji, user, action}]
        const wirePollVotes = {}; // poll_id -> [{voter, option}]
        const wireEdits = {}; // msg_id -> [{text, action, date}]
        const wireAcks = {}; // msg_id -> {email участника: true}
        const decrypted = [];
        let metaLatest = null; // {avatar, created_at} — последний по дате
        if (groupKey) {
          for (const msg of raw || []) {
            if (!crypto.isEncrypted(msg.content)) continue; // не наше
            // Ignore-лист: сообщения заблокированного УЧАСТНИКА не
            // расшифровываем и не рендерим в группе (фильтр до расшифровки —
            // по sender_id письма, он приходит из заголовка From).
            if (!ctx.isOwnSender(msg.sender_id) && ctx.isIgnored(msg.sender_id)) continue;
            let plaintext;
            try {
              plaintext = await crypto.decryptWithGroupKey(msg.content, groupKey);
            } catch (e) {
              continue; // расшифровка не прошла — письмо не из этой группы
            }
            let obj = null;
            try { obj = JSON.parse(plaintext); } catch { /* не JSON */ }
            if (obj && obj.react === 1 && obj.msg_id && obj.emoji) {
              (wireReactions[obj.msg_id] = wireReactions[obj.msg_id] || []).push({
                emoji: obj.emoji,
                user: msg.sender_id,
                action: obj.action === 'remove' ? 'remove' : 'add',
              });
              continue; // реакция не рендерится как сообщение
            }
            if (obj && obj.edit === 1 && obj.msg_id) {
              (wireEdits[obj.msg_id] = wireEdits[obj.msg_id] || []).push({
                text: obj.text || '',
                action: obj.action === 'delete' ? 'delete' : 'edit',
                date: obj.ts || msg.created_at || 0,
                sender: obj.sender || msg.sender_id || '',
              });
              continue; // правка не рендерится как сообщение
            }
            if (obj && obj.read === 1 && Array.isArray(obj.msg_ids)) {
              for (const rid of obj.msg_ids) {
                (wireAcks[rid] = wireAcks[rid] || {})[msg.sender_id] = true;
              }
              continue; // квитанция не рендерится как сообщение
            }
            // 1г) Закрепление — форма письма описана в PinWire; здесь она только
            //     разбирается. Последнее по ts авторитетно; не рендерится.
            // Разбор формы — PinWire.parsePinWire, тот же модуль строит её на
            // отправке (ADR-003 партия 13). Раньше форма читалась здесь вручную
            // и писалась в App.vue: опечатка в имени действия тихо превращала
            // открепление в закрепление.
            const pinWire = PinWire.parsePinWire(obj, Date.parse(msg.created_at || 0) || 0);
            if (pinWire) {
              await ctx.applyPinFromWire(groupId, pinWire);
              continue;
            }
            // Голос голосования: {poll:1, poll_id, option} — сигнальное
            // письмо (как реакции). В групповом проходе классификации не
            // было: голоса участников падали в чат сырым JSON.
            if (obj && obj.poll === 1 && obj.poll_id) {
              (wirePollVotes[obj.poll_id] = wirePollVotes[obj.poll_id] || []).push({
                voter: msg.sender_id,
                option: Number(obj.option) || 0,
              });
              continue; // голос не рендерится как сообщение
            }
            // Presence: {presence:1, ts} — heartbeat участника; активность
            // без карточки в чате (группы: peer-ключ есть только у 1:1, но
            // сигнал может прийти и по групповому каналу от старых клиентов).
            if (PresenceFeature.ingestSignal(ctx, obj, msg.sender_id, new Date(msg.created_at || Date.now()).getTime())) {
              continue; // presence не рендерится как сообщение
            }
            if (obj && obj.meta === 1 && obj.avatar) {
              if (!metaLatest || new Date(msg.created_at) >= new Date(metaLatest.created_at)) {
                metaLatest = { avatar: obj.avatar, created_at: msg.created_at };
              }
              continue; // meta (аватар) не рендерится как сообщение
            }
            // hav-запрос аватарки группы {hav:1}: сервис-письмо (шифровано
            // групповым ключом), не рендерится. Отвечаем meta-письмом, если
            // аватар есть у нас (24ч rate-limit + защита от петли внутри).
            if (obj && obj.hav === 1) {
              await ctx.replyGroupAvatarHeal(groupId);
              continue; // hav не рендерится как сообщение
            }
            // Сообщение: конверт {vault:1,id,text,name,avatar} или legacy-текст.
            const env = ctx.parseEnvelope(plaintext);
            if (env) {
              // Самовосстановление аватарки группы: конверт сообщения нёс
              // gavatar — кладём в kv (guard на непустое/изменение внутри).
              if (env.gavatar) await ctx.healGroupAvatarFromMessage(groupId, env.gavatar);
              if ((env.name || env.avatar) && msg.sender_id) {
                api.saveProfile(msg.sender_id, env.name, env.avatar, env.ts || 0);
              }
              // Голосование (poll): карточка вместо текста — как в 1:1.
              // До этого env.poll выбрасывался в `plaintext = env.text`, и
              // poll-конверт рендерился текстом вопроса без карточки/кнопок.
              if (env.type === 'poll') {
                const p = ctx.parsePollEnvelope(env);
                if (p) {
                  const gPollTs = new Date(msg.created_at || msg.date || Date.now()).getTime() || Date.now();
                  decrypted.push({
                    id: p.id || msg.message_id || '',
                    content: p.question,
                    attachment: null,
                    from: ctx.isOwnSender(msg.sender_id) ? 'me' : 'them',
                    time: new Date(msg.created_at).toLocaleTimeString(),
                    status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
                    encrypted: true,
                    mid: msg.message_id || '',
                    sender_id: msg.sender_id,
                    created_at: msg.created_at,
                    poll: p,
                    ttl: (env && env.ttl) || 0,
                    expireAt: env && env.ttl ? gPollTs + env.ttl * 1000 : 0,
                  });
                  continue;
                }
                // p === null (некорректный poll) — падаем ниже, отрисуется как текст.
              }
              plaintext = env.text; // содержимое конверта
              // Download-on-demand: data-письмо — транспорт, не сообщение
              // группы (содержимое подтянется по клику с мета-карточки).
              if (typeof plaintext === 'string' && plaintext.startsWith('{')) {
                try {
                  const dodObj = JSON.parse(plaintext);
                  if (dodObj && dodObj.vault_dod_data === 1) continue;
                } catch (e) { /* не dod */ }
              }
            }
            const { text, attachment } = ctx.parseMessageContent(plaintext);
            if (env && !ctx.isOwnSender(msg.sender_id)) {
              ctx.noteSeen(msg.sender_id, new Date(msg.created_at).getTime());
            }
            const gMailTs = new Date(msg.created_at || msg.date || Date.now()).getTime() || Date.now();
            const gExpireAt = env && env.ttl ? gMailTs + env.ttl * 1000 : 0;
            decrypted.push({
              ...msg,
              content: text,
              attachment,
              from: ctx.isOwnSender(msg.sender_id) ? 'me' : 'them',
              time: new Date(msg.created_at).toLocaleTimeString(),
              status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
              encrypted: true,
              mid: msg.message_id || '',
              ...(env && env.id ? { id: env.id } : {}),
              ttl: (env && env.ttl) || 0,
              expireAt: gExpireAt,
            });
          }
          if (stale()) return;
          // Мета-обновления группы (аватар): последнее по дате — авторитетно.
          if (metaLatest && metaLatest.avatar !== (await db.kvGet('anon', 'group-avatar:' + groupId))) {
            await db.kvSet('anon', 'group-avatar:' + groupId, metaLatest.avatar);
            ctx.groupAvatars[groupId] = metaLatest.avatar;
          }
          ctx.loadProfiles();
          // Дедупликация по id конверта: sendGroupMessage шлёт каждому
          // участнику отдельное письмо, поэтому в Sent отправителя лежит
          // N−1 копий одного сообщения — все расшифровываются в один
          // конверт с одинаковым id. Без дедупликации отправитель видел
          // дубли (у получателя копия одна — дубля не было).
          const dedup = new Map();
          for (const m of decrypted) {
            if (!dedup.has(m.id)) dedup.set(m.id, m);
          }
          const list = [...dedup.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
          // Статусы наших сообщений: письмо уже в ящике = доставлено;
          // квитанции {read:1} от участников = просмотрено.
          for (const m of list) {
            if (m.from !== 'me') continue;
            const acks = wireAcks[m.id];
            m.status = acks && Object.keys(acks).length ? 'read' : 'delivered';
          }
          // pending-записи отправителя (свою копию он не получает — живут
          // только в pendingOutgoing): квитанции {read:1} участников снимают
          // 'failed'/'sent' → 'read'.
          const pb = ctx.pendingOutgoing[chat] || {};
          for (const [pid, pmsg] of Object.entries(pb)) {
            const ack = wireAcks[pid];
            if (ack && Object.keys(ack).length) pmsg.status = 'read';
          }
          // История — основа чата, письма добавляют новое (mergeHistory).
          // Статусы/реакции/правки — к итоговому списку (в истории старые
          // статусы, письмо приносит свежий).
          const hadMessages = ctx.chat.state.messages.length > 0;
          const merged0 = await ctx.mergeHistory(chat, list);
          const statusById = new Map();
          for (const m of list) if (m.id && m.status) statusById.set(m.id, m.status);
          for (const m of merged0) {
            const st = statusById.get(m.id);
            if (st) m.status = st;
          }
          // Квитанции «прочитано» от участников — к СВОИМ сообщениям в истории.
          // У отправителя группы нет самокопии письма (Sent не читается), его
          // сообщения живут только в истории и в `list` из IMAP не попадают,
          // поэтому без этого шага их статус после перезапуска не обновлялся
          // до 'read'.
          for (const m of merged0) {
            if (m.from !== 'me' || !m.id) continue;
            const acks = wireAcks[m.id];
            if (acks && Object.keys(acks).length) m.status = 'read';
          }
          ctx.applyReactions(merged0, chat, wireReactions);
          ctx.applyEdits(merged0, chat, wireEdits);
          ctx.applyPollVotes(merged0, wirePollVotes);
          const merged = ctx.filterDeleted(ctx.mergePending(chat, merged0));
          if (!merged.length && hadMessages && !stale()) {
            return;
          }
          ctx.chat.set(merged);
          for (const m of ctx.chat.state.messages) if (m.expireAt) ctx.scheduleEphemeral(m, chat);
          ctx.saveChatCache(chat, ctx.chat.state.messages);
          // Локальная история (IndexedDB) — полный архив группы.
          ctx.saveCurrentHistory(chat);
          // Открыли группу — шлём участникам квитанции «просмотрено» по входящим.
          const incoming = ctx.chat.state.messages.filter(m => m.from === 'them' && m.id && !m.callEvent).map(m => m.id);
          ctx.sendReadReceipts(incoming);
        } else {
          // No group key — show as-is (unencrypted)
          ctx.chat.set(raw.map(msg => {
            const { text, attachment } = ctx.parseMessageContent(msg.content);
            return {
              ...msg,
              content: text,
              from: ctx.isOwnSender(msg.sender_id) ? 'me' : 'them',
              time: new Date(msg.created_at).toLocaleTimeString(),
              status: msg.is_read ? 'read' : msg.is_sent ? 'delivered' : 'sent',
              encrypted: false,
              attachment,
            };
          }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
        }
      } catch (error) {
        console.error('Failed to load group messages:', error);
        if (!stale()) ctx.chat.clear();
      }
}
