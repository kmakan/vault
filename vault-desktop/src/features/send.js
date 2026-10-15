// Feature module: отправка 1:1-сообщения (критический путь доставки).
// Этап 5 декомпозиции App.vue (ctx-паттерн). ADR-001 домен 2 (под-домен
// «отправка сообщения» — КРИТИЧЕСКИЙ ПУТЬ). Вынесено из App.vue МЕХАНИЧЕСКИ
// (this.* -> ctx.*), поведение 1:1. Инварианты шифрования (AAD="VAULT"),
// оптимистичный предпросмотр + мерж по envelopeId, DoD-разбиение, статусы и
// persist через ctx — сохранены. Downstream/состояние через ctx.
import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';
import * as relay from '../relay-client.js';
import * as EnvelopeId from './envelope-id.js';

export async function sendMessage(ctx) {
      if (!ctx.newMessage.trim()) return;
      // Канал (M2): отдельный путь — пост-конверт с broadcast-ключом,
      // composer только владельца (UI-гейт + проверка в sendChannelPost).
      if (ctx.activeChatType === 'channel') { ctx.sendChannelPost(); return; }
      // Ignore-гвард: в чате с заблокированным писать нельзя (E2E-модель
      // блокировки получателя: мы решаем, что показывать и кому отвечать).
      if (ctx.activeChatType === 'chat' && ctx.isIgnored(ctx.activeChat)) {
        ctx.showToast(ctx.t('ignore_cannot_write') || 'Чат заблокирован — сначала разблокируйте');
        return;
      }
      // Анти-дубль: пока идёт отправка (SMTP медленный), повторный Enter/клик
      // игнорируем — иначе уходит 2+ письма с разными id и получатели видят
      // «одно сообщение несколько раз».
      if (ctx.sending) return;
      // Анти-дубль ПОСЛЕ отправки: двойной Enter с паузой (первая отправка
      // уже завершилась) — тот же текст в тот же чат в течение 30 секунд
      // один раз»).
      const chatId = ctx.activeChatType === 'group' && ctx.currentGroup
        ? 'group:' + ctx.currentGroup.id
        : ctx.activeChat;
      const text = ctx.newMessage.trim();
      if (ctx.lastSend && ctx.lastSend.chat === chatId && ctx.lastSend.text === text
          && Date.now() - ctx.lastSend.ts < 30000) {
        console.log('[sendMessage] duplicate ignored (same text sent recently)');
        return;
      }
      ctx.lastSend = { chat: chatId, text, ts: Date.now() };

      // Режим редактирования: вместо нового сообщения отправляем правку
      // существующего (edit-письмо), обновляем локально и выходим.
      if (ctx.editingMessage) {
        const msg = ctx.editingMessage;
        const newText = ctx.newMessage.trim();
        ctx.cancelEdit();
        const oldBody = ctx.replyBody(msg.content || '');
        if (!newText || newText === oldBody) return;
        // Цитата "> ..." сохраняется: правка заменяет только тело ответа,
        // а в edit-письмо и локальную запись идёт полный content.
        const quote = ctx.replyQuote(msg.content || '');
        const fullText = quote ? `> ${quote}\n\n${newText}` : newText;
        msg.content = fullText;
        msg.edited = true;
        const chatKey = ctx.activeChatType === 'group' && ctx.currentGroup
          ? 'group:' + ctx.currentGroup.id
          : ctx.activeChat;
        ctx.recordLocalEdit(chatKey, msg.id, fullText, 'edit');
        ctx.sendEditEmail(msg.id, fullText, 'edit');
        return;
      }

      try {
        ctx.sending = true;
        // таймаут, JS-ошибка вне try), sending должен разблокироваться —
        // иначе кнопка/Enter навсегда блокируются, сообщение «висит» в поле.
        clearTimeout(ctx._sendingWatchdog);
        ctx._sendingWatchdog = setTimeout(() => { ctx.sending = false; }, 60000);
        // If replying, prefix the message with a "> quote" block (kept in plaintext —
        // the whole thing is still enclosed in the vault AAD-encrypted payload below).
        let payload = ctx.newMessage;
        if (ctx.replyTo) {
          const quote = ctx.replyPreview(ctx.replyTo);
          if (quote) payload = `> ${quote}\n\n${ctx.newMessage}`;
        }
        // Очищаем поле и ответ СРАЗУ — SMTP медленный (30–60 с), UI не должен
        // ждать завершения отправки, чтобы поле опустело.
        ctx.newMessage = '';
        ctx.cancelReply();
        ctx.saveDraft(); // поле пусто — черновик этого чата стираем

        let content = payload;

        // Заметки для себя: локальная запись без почты и шифрования.
        if (ctx.activeChat === '__notes__') {
          const note = {
            id: 'note-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            content: payload,
            from: 'me',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            encrypted: false,
            vault: false,
            status: 'sent',
            _notes: true,
          };
          const list = ctx.loadNotes();
          list.push(note);
          if (!ctx.saveNotes(list)) {
            list.pop();
            ctx.chat.set([...list]);
            alert(ctx.t('err_notes_full'));
            return;
          }
          ctx.chat.set([...list]);
          ctx.scrollToBottom(true);
          return;
        }

        // Конверт {vault:1,id,text,name,avatar} — метаданные отправителя
        // (имя/аватар) и стабильный id сообщения внутри шифра.
        // ttl — исчезающие сообщения для этого чата (0 = выкл).
        // kv — ЕДИНСТВЕННЫЙ источник ttl при отправке. Fallback на
        // currentEphemeralTtl (UI-переменную) УБРАН: он применял чужой TTL,
        // когда selectChat не загрузил его для 1-на-1 — сообщение-ответ
        // уходило исчезающим без включения пользователем.
        const ttl = await ctx.ephemeralTtlOf(chatId);
        if (ttl) console.log('[sendMessage] ephemeral ttl=' + ttl + ' chat=' + chatId);
        const envelope = await ctx.buildEnvelope(payload, ttl);
        const envelopeId = EnvelopeId.envelopeIdOf(envelope);

        if (ctx.activeChatType === 'group') {
          // Group message — encrypt with group key; never send plaintext without it
          let groupKey = ctx.groupKeys[ctx.currentGroup.id];
          // Lazy-backfill: ключ мог не загрузиться (гонка cryptoReady/selectGroup).
          if (!groupKey && ctx.cryptoReady) {
            try {
              const kd = await api.getMyGroupKey(ctx.currentGroup.id);
              if (kd && kd.group_key) {
                ctx.setGroupKey(ctx.currentGroup.id, kd.group_key);
                groupKey = kd.group_key;
              }
            } catch (e) { /* не удалось — alert ниже */ }
          }
          if (!groupKey) {
            alert(ctx.t('err_group_key'));
            return;
          }
          content = await crypto.encryptWithGroupKey(envelope, groupKey);
          // Оптимистичный показ: Gmail SMTP отвечает медленно
          // а немедленная перезагрузка чата стирала ещё не доставленное
          // сообщение — выглядело как будто ответ/сообщение не отправилось.
          // Запись регистрируется в pendingOutgoing: поллинг подмешивает её
          // обратно, пока письмо не сделает круг через ящик (mergePending).
          const pendingMsg = {
            id: envelopeId || EnvelopeId.pendingIdOf(),
            content: payload,
            from: 'me',
            sender_id: ctx.email,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            ts: Date.now(),
            encrypted: true,
            vault: true,
            status: 'sending',
            _pendingAt: Date.now(),
          };
          ctx.chat.append(pendingMsg);
          ctx.markPending('group:' + ctx.currentGroup.id, pendingMsg);
          // Своё исходящее ПЕРСИСТИМ сразу (как почтовый мессенджер пишет в msgs при
          // отправке): отображение НЕ зависит от Sent-копии в ящике, которую
          // пользователь может удалить. История = источник своих сообщений.
          ctx.saveCurrentHistory('group:' + ctx.currentGroup.id);
          try {
            // envelopeObj: релей-дубль участникам (api.sendGroupMessage).
            const envObjForRelay = (() => { try { return JSON.parse(envelope); } catch (e) { return null; } })();
            const res = await api.sendGroupMessage(ctx.currentGroup.id, content, envObjForRelay);
            // Частичный фейл (SMTP одного из участников): статус 'failed'
            // (красный) — сообщение остаётся в чате и НЕ исчезает через
            // 10 минут (mergePending уважает failed-записи). Полный успех —
            // «отправлено» (до «доставлено» ждём квитанции получателей).
            if (res && res.failed && res.failed.length) {
              pendingMsg.status = 'failed';
              pendingMsg.failedTo = res.failed;
              console.error('Group message not delivered to:', res.failed.join(', '));
            } else {
              pendingMsg.status = 'sent';
            }
          } catch (e) {
            pendingMsg.status = 'failed';
            pendingMsg.failedTo = [e && e.message || String(e)];
            console.error('Failed to send group message:', e);
          }
          // Персистим обновлённый статус в pendingOutgoing (иначе поллинг
          // подмешивал бы запись со старым 'sending'). И в историю — иначе
          // у групп нет самокопии письма, которая заменила бы pending).
          const bucket = ctx.pendingOutgoing['group:' + ctx.currentGroup.id];
          if (bucket && bucket[pendingMsg.id]) {
            bucket[pendingMsg.id] = pendingMsg;
            ctx.pendingOutgoing = { ...ctx.pendingOutgoing, ['group:' + ctx.currentGroup.id]: bucket };
          }
          ctx.saveCurrentHistory('group:' + ctx.currentGroup.id);
        } else {
          // Regular chat message
          if (ctx.cryptoReady && ctx.peerKeys[ctx.activeChat]) {
            crypto.setPeerPublicKey(ctx.peerKeys[ctx.activeChat], ctx.peerPqKeys && ctx.peerPqKeys[ctx.activeChat]);
            // Encrypt as a vault message (AAD="VAULT") so the peer can recognize
            // and authenticate it as ours.
            content = await crypto.encryptVault(envelope);
          }
          // Оптимистично показываем своё сообщение сразу: SMTP Gmail отвечает
          // медленно (до минуты), ждать отправку в UI не нужно. Запись
          // регистрируется в pendingOutgoing: поллинг подмешивает её обратно,
          // пока письмо не сделает круг через ящик (mergePending).
          const pendingMsg = {
            id: envelopeId || EnvelopeId.pendingIdOf(),
            content: payload,
            from: 'me',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            ts: Date.now(),
            encrypted: true,
            vault: true,
            status: 'sending',
            _pendingAt: Date.now(),
            ttl: ttl || 0,
            expireAt: ttl ? Date.now() + ttl * 1000 : 0,
          };
          ctx.chat.append(pendingMsg);
          ctx.markPending(ctx.activeChat, pendingMsg);
          if (ttl) ctx.scheduleEphemeral(pendingMsg, ctx.activeChat);
          // Своё исходящее ПЕРСИСТИМ сразу (как почтовый мессенджер пишет в msgs при
          // отправке): отображение НЕ зависит от Sent-копии в ящике, которую
          // пользователь может удалить. История = источник своих сообщений.
          ctx.saveCurrentHistory(ctx.activeChat);
          try {
            // Релей-копия ПЕРВОЙ (мгновенная доставка ~1-2с), SMTP —
            // медленный основной канал: не блокируем статус «отправлено»
            // на Gmail-коннекте (держит до минуты, тротлит) — письмо
            // уходит в фоне, поллинг подтвердит доставку кругом через ящик.
            try {
              const envObj = JSON.parse(envelope);
              // Resolve peer fingerprint from peerKeys for fingerprint-based relay
              let peerFp = null;
              try {
                const publicKey = ctx.peerKeys[ctx.activeChat];
                if (publicKey) {
                  peerFp = await relay.fingerprintOf(publicKey);
                }
              } catch (e) {
                // If fingerprint resolution fails, continue with legacy email-only relay
                peerFp = null;
              }
              const pub = relay.relayPublish(ctx.email, ctx.activeChat, envObj, content, { peerFp });
              // §1: обновляем индикатор доставки по результату pub.
              pub.then(r => {
                if (r && r.why === 'daily-limit') {
                  ctx.relayDeliveryMode = 'email';
                  // Баннер один раз за день (kv-флаг) — не спамим тостами.
                  invoke('db_kv_get', { account: ctx.email, key: 'relay-limit-banner' }).then(v => {
                    const today = String(Math.floor(Date.now() / 86400000));
                    if (v !== today) {
                      ctx.showToast(ctx.t('relay_limit_banner') || 'Бесплатный лимит релея исчерпан до 00:00 UTC — доставка идёт по почте, ничего не теряется', 6000);
                      invoke('db_kv_set', { account: ctx.email, key: 'relay-limit-banner', value: today });
                    }
                  }).catch(() => {});
                } else if (r && r.ok) {
                  ctx.relayDeliveryMode = 'relay';
                }
              }).catch(() => {});
            } catch (e) { /* envelope не JSON — релей пропускаем */ }
            api.sendMessage(ctx.activeChat, content).then(() => {
              pendingMsg.status = 'sent';
              const b = ctx.pendingOutgoing[ctx.activeChat];
              if (b && b[pendingMsg.id]) {
                b[pendingMsg.id] = pendingMsg;
                ctx.pendingOutgoing = { ...ctx.pendingOutgoing, [ctx.activeChat]: b };
              }
              ctx.saveCurrentHistory(ctx.activeChat);
            }).catch(e => {
              pendingMsg.status = 'failed';
              pendingMsg.failedTo = [e && e.message || String(e)];
              console.error('Failed to send message:', e);
            });
          } catch (e) {
            // а через 10 минут запись молча исчезала.
            pendingMsg.status = 'failed';
            pendingMsg.failedTo = [e && e.message || String(e)];
            console.error('Failed to send message:', e);
          }
          const bucket = ctx.pendingOutgoing[ctx.activeChat];
          if (bucket && bucket[pendingMsg.id]) {
            bucket[pendingMsg.id] = pendingMsg;
            ctx.pendingOutgoing = { ...ctx.pendingOutgoing, [ctx.activeChat]: bucket };
          }
          // Персистим финальный статус в историю (иначе после перезапуска
          ctx.saveCurrentHistory(ctx.activeChat);
        }

        // Своё сообщение — всегда прокручиваем вниз.
        ctx.scrollToBottom(true);
      } catch (error) {
        alert('Failed to send message: ' + error.message);
      } finally {
        ctx.sending = false;
      }
}
