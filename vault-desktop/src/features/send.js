// Feature module: отправка 1:1-сообщения (критический путь доставки).
// ADR-001 домен 2 (под-домен «отправка сообщения»). Инварианты шифрования
// (AAD="VAULT"), оптимистичный предпросмотр + мерж по envelopeId, статусы и
// персист истории — сохранены.
//
// ADR-005 W2 (`t_bcb8927a`), партия 2: модуль больше НЕ читает компонент.
// Состояние чата/адреса/ключей берётся у владельцев (ADR-004), черновик и
// переписка — у per-app стора, остальное (эффекты отправки, история, конверт,
// UI-флаги) — явным `deps` от App.vue: `sendMessage(deps)`.
//
// ЧТО ОСТАЛОСЬ В deps И ПОЧЕМУ:
//   · lastSend / watchdog — состояние ОТПРАВКИ в компоненте (анти-дубль и
//     страховка от зависшего sending), читается и пишется → пара get/set;
//   · editingMessage / replyTo — UI-режим composer'а;
//   · buildEnvelope — сборка конверта (протокол, уедет в Rust в W4);
//   · markPending / saveCurrentHistory / recordLocalEdit / sendEditEmail /
//     saveDraft / scheduleEphemeral / sendChannelPost / isIgnored — эффекты
//     других доменов, вызываемые через компонент.
import { expireAt } from '../ephemeral-rule.js';
import { uiStore } from "./session-store.js";
import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';
import * as relay from '../relay-client.js';
import * as EnvelopeId from './envelope-id.js';
import * as MsgFormat from '../message-format.js';
import { chatStore as chatState, sessionStore } from './session-store.js';
import { identityStore } from './identity-store.js';
import { relayState } from './relay-idle.js';
import { ephemeralTtlOf } from '../message-store.js';

// ── Владельцы состояния вместо ctx (ADR-005 R3, W2) ───────────────────────
// chatUi — алиас на state владельца открытого чата (владелец меняет ПОЛЯ, а не
// объект state, поэтому ссылка живая). Почта — функцией: вход/выход могут
// случиться посреди отправки.
const chatUi = chatState.state;
const myEmail = () => sessionStore.getCurrentEmail();

export async function sendMessage(deps) {
  const { resolveChatKey, isRecentDuplicate, buildReplyPayload, buildNoteMessage,
          buildSendingMessage, isPeerEncrypted, encryptPeerVaultEnvelope } = deps;
  // Черновик — состояние chat-store (per-app владелец): читаем ЖИВЫМ, как
  // читал computed newMessage в компоненте.
  const draft = () => deps.chat.state.newMessage;
      if (!draft().trim()) return;
      // Канал (M2): отдельный путь — пост-конверт с broadcast-ключом,
      // composer только владельца (UI-гейт + проверка в sendChannelPost).
      if (chatUi.activeChatType === 'channel') { deps.sendChannelPost(); return; }
      // Ignore-гвард: в чате с заблокированным писать нельзя (E2E-модель
      // блокировки получателя: мы решаем, что показывать и кому отвечать).
      if (chatUi.activeChatType === 'chat' && deps.isIgnored(chatUi.activeChat)) {
        uiStore.toast(uiStore.tr('ignore_cannot_write') || 'Чат заблокирован — сначала разблокируйте');
        return;
      }
      // Анти-дубль: пока идёт отправка (SMTP медленный), повторный Enter/клик
      // игнорируем — иначе уходит 2+ письма с разными id и получатели видят
      // «одно сообщение несколько раз».
      if (deps.sending.getSending()) return;
      // Анти-дубль ПОСЛЕ отправки: двойной Enter с паузой (первая отправка
      // уже завершилась) — тот же текст в тот же чат в течение 30 с
      // (окно isRecentDuplicate) тоже игнорируем: «один раз».
      const chatId = resolveChatKey({
        activeChat: chatUi.activeChat, activeChatType: chatUi.activeChatType, currentGroup: chatUi.currentGroup,
      });
      const text = draft().trim();
      if (isRecentDuplicate({ lastSend: deps.getLastSend(), chatId, text, now: Date.now() })) {
        console.log('[sendMessage] duplicate ignored (same text sent recently)');
        return;
      }
      deps.setLastSend({ chat: chatId, text, ts: Date.now() });

      // Режим редактирования: вместо нового сообщения отправляем правку
      // существующего (edit-письмо), обновляем локально и выходим.
      if (deps.editingMessage) {
        const msg = deps.editingMessage;
        const newText = draft().trim();
        deps.cancelEdit();
        const oldBody = MsgFormat.splitReply(msg.content || '').body;
        if (!newText || newText === oldBody) return;
        // Цитата "> ..." сохраняется: правка заменяет только тело ответа,
        // а в edit-письмо и локальную запись идёт полный content.
        const quote = MsgFormat.splitReply(msg.content || '').quote;
        const fullText = quote ? `> ${quote}\n\n${newText}` : newText;
        msg.content = fullText;
        msg.edited = true;
        const chatKey = resolveChatKey({
          activeChat: chatUi.activeChat, activeChatType: chatUi.activeChatType, currentGroup: chatUi.currentGroup,
        });
        deps.recordLocalEdit(chatKey, msg.id, fullText, 'edit');
        deps.sendEditEmail(msg.id, fullText, 'edit');
        return;
      }

      try {
        deps.sending.setSending(true);
        // таймаут, JS-ошибка вне try), sending должен разблокироваться —
        // иначе кнопка/Enter навсегда блокируются, сообщение «висит» в поле.
        clearTimeout(deps.getWatchdog());
        deps.setWatchdog(setTimeout(() => { deps.sending.setSending(false); }, 60000));
        // If replying, prefix the message with a "> quote" block (kept in plaintext —
        // the whole thing is still enclosed in the vault AAD-encrypted payload below).
        const payload = buildReplyPayload(draft(), {
          replyTo: deps.replyTo, replyPreview: (m) => MsgFormat.replyPreview((m && (m.content || m.text)) || ''),
        });
        // Очищаем поле и ответ СРАЗУ — SMTP медленный (30–60 с), UI не должен
        // ждать завершения отправки, чтобы поле опустело.
        deps.chat.clearDraft();
        deps.cancelReply();
        deps.saveDraft(); // поле пусто — черновик этого чата стираем

        let content = payload;

        // Заметки для себя: локальная запись без почты и шифрования.
        if (chatUi.activeChat === '__notes__') {
          const now = Date.now();
          const note = buildNoteMessage(payload, { now, timeStr: MsgFormat.formatTimeLabel(now) });
          // Запись ТОЛЬКО через владельца notes-store (ADR-004 A15).
          // add() сама load→push→save с защитой от дубля; при ошибке откатывает.
          if (!deps.notes.add(myEmail(), note)) {
            deps.chat.set(deps.notes.load(myEmail()));
            alert(uiStore.tr('err_notes_full'));
            return;
          }
          deps.chat.set(deps.notes.load(myEmail()));
          uiStore.scrollToBottom(true);
          return;
        }

        // Конверт {vault:1,id,text,name,avatar} — метаданные отправителя
        // (имя/аватар) и стабильный id сообщения внутри шифра.
        // ttl — исчезающие сообщения для этого чата (0 = выкл).
        // kv — ЕДИНСТВЕННЫЙ источник ttl при отправке. Fallback на
        // currentEphemeralTtl (UI-переменную) УБРАН: он применял чужой TTL,
        // когда selectChat не загрузил его для 1-на-1 — сообщение-ответ
        // уходило исчезающим без включения пользователем.
        const ttl = await ephemeralTtlOf(chatId);
        if (ttl) console.log('[sendMessage] ephemeral ttl=' + ttl + ' chat=' + chatId);
        const envelope = await deps.buildEnvelope(payload, ttl);
        const envelopeId = EnvelopeId.envelopeIdOf(envelope);

        if (chatUi.activeChatType === 'group') {
          // Group message — encrypt with group key; never send plaintext without it
          let groupKey = deps.groupKeys[chatUi.currentGroup.id];
          // Lazy-backfill: ключ мог не загрузиться (гонка cryptoReady/selectGroup).
          if (!groupKey && deps.cryptoReady) {
            try {
              const kd = await api.getMyGroupKey(chatUi.currentGroup.id);
              if (kd && kd.group_key) {
                deps.setGroupKey(chatUi.currentGroup.id, kd.group_key);
                groupKey = kd.group_key;
              }
            } catch (e) { /* не удалось — alert ниже */ }
          }
          if (!groupKey) {
            alert(uiStore.tr('err_group_key'));
            return;
          }
          content = await crypto.encryptWithGroupKey(envelope, groupKey);
          // Оптимистичный показ: Gmail SMTP отвечает медленно
          // а немедленная перезагрузка чата стирала ещё не доставленное
          // сообщение — выглядело как будто ответ/сообщение не отправилось.
          // Запись регистрируется в pendingOutgoing: поллинг подмешивает её
          // обратно, пока письмо не сделает круг через ящик (mergePending).
          const gNow = Date.now();
          const pendingMsg = buildSendingMessage({
            envelopeId, payload, ttl: 0, now: gNow,
            timeStr: MsgFormat.formatTimeLabel(gNow),
            pendingIdOf: EnvelopeId.pendingIdOf,
          });
          pendingMsg.sender_id = myEmail();
          deps.chat.append(pendingMsg);
          deps.markPending('group:' + chatUi.currentGroup.id, pendingMsg);
          // Своё исходящее ПЕРСИСТИМ сразу (как почтовый мессенджер пишет в msgs при
          // отправке): отображение НЕ зависит от Sent-копии в ящике, которую
          // пользователь может удалить. История = источник своих сообщений.
          deps.saveCurrentHistory('group:' + chatUi.currentGroup.id);
          try {
            // envelopeObj: релей-дубль участникам (api.sendGroupMessage).
            const envObjForRelay = MsgFormat.parseEnvelopeSafe(envelope);
            const res = await api.sendGroupMessage(chatUi.currentGroup.id, content, envObjForRelay);
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
          const gChat = 'group:' + chatUi.currentGroup.id;
          if (deps.sending.getBucket(gChat)[pendingMsg.id]) {
            deps.sending.setPendingOutgoing(gChat, pendingMsg);
          }
          deps.saveCurrentHistory('group:' + chatUi.currentGroup.id);
        } else {
          // Regular chat message
          if (isPeerEncrypted(identityStore.state.peerKeys, deps.cryptoReady, chatUi.activeChat)) {
            // Encrypt as a vault message (AAD="VAULT") so the peer can recognize
            // and authenticate it as ours.
            content = await encryptPeerVaultEnvelope(envelope, {
              activeChat: chatUi.activeChat, peerKeys: identityStore.state.peerKeys, peerPqKeys: identityStore.state.peerPqKeys,
              cryptoReady: deps.cryptoReady, crypto,
            });
          }
          // Оптимистично показываем своё сообщение сразу: SMTP Gmail отвечает
          // медленно (до минуты), ждать отправку в UI не нужно. Запись
          // регистрируется в pendingOutgoing: поллинг подмешивает её обратно,
          // пока письмо не сделает круг через ящик (mergePending).
          const sNow = Date.now();
          const pendingMsg = buildSendingMessage({
            envelopeId, payload, ttl, now: sNow,
            // Правило времени жизни — из Rust (ADR-005 R1, W4).
            expiresAt: await expireAt(sNow, ttl),
            timeStr: MsgFormat.formatTimeLabel(sNow),
            pendingIdOf: EnvelopeId.pendingIdOf,
          });
          deps.chat.append(pendingMsg);
          deps.markPending(chatUi.activeChat, pendingMsg);
          if (ttl) deps.scheduleEphemeral(pendingMsg, chatUi.activeChat).catch(() => {});
          // Своё исходящее ПЕРСИСТИМ сразу (как почтовый мессенджер пишет в msgs при
          // отправке): отображение НЕ зависит от Sent-копии в ящике, которую
          // пользователь может удалить. История = источник своих сообщений.
          deps.saveCurrentHistory(chatUi.activeChat);
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
                const publicKey = identityStore.state.peerKeys[chatUi.activeChat];
                if (publicKey) {
                  peerFp = await relay.fingerprintOf(publicKey);
                }
              } catch (e) {
                // If fingerprint resolution fails, continue with legacy email-only relay
                peerFp = null;
              }
              const pub = relay.relayPublish(myEmail(), chatUi.activeChat, envObj, content, { peerFp });
              // §1: обновляем индикатор доставки по результату pub.
              pub.then(r => {
                if (r && r.why === 'daily-limit') {
                  relayState.setRelayMode('email');
                  // Баннер один раз за день (kv-флаг) — не спамим тостами.
                  invoke('db_kv_get', { account: myEmail(), key: 'relay-limit-banner' }).then(v => {
                    const today = String(Math.floor(Date.now() / 86400000));
                    if (v !== today) {
                      uiStore.toast(uiStore.tr('relay_limit_banner') || 'Бесплатный лимит релея исчерпан до 00:00 UTC — доставка идёт по почте, ничего не теряется', 6000);
                      invoke('db_kv_set', { account: myEmail(), key: 'relay-limit-banner', value: today });
                    }
                  }).catch(() => {});
                } else if (r && r.ok) {
                  relayState.setRelayMode('relay');
                }
              }).catch(() => {});
            } catch (e) { /* envelope не JSON — релей пропускаем */ }
            api.sendMessage(chatUi.activeChat, content).then(() => {
              pendingMsg.status = 'sent';
              if (deps.sending.getBucket(chatUi.activeChat)[pendingMsg.id]) {
                deps.sending.setPendingOutgoing(chatUi.activeChat, pendingMsg);
              }
              deps.saveCurrentHistory(chatUi.activeChat);
            }).catch(e => {
              pendingMsg.status = 'failed';
              pendingMsg.failedTo = [e && e.message || String(e)];
              console.error('Failed to send message:', e);
            });
          } catch (e) {
            // Сбой синхронной части (шифрование/pending): статус failed, иначе
            // поллинг подмешивал бы 'sending', а через 10 минут запись молча исчезала.
            pendingMsg.status = 'failed';
            pendingMsg.failedTo = [e && e.message || String(e)];
            console.error('Failed to send message:', e);
          }
          if (deps.sending.getBucket(chatUi.activeChat)[pendingMsg.id]) {
            deps.sending.setPendingOutgoing(chatUi.activeChat, pendingMsg);
          }
          // Персистим финальный статус в историю (иначе после перезапуска
          // запись осталась бы в 'sending').
          deps.saveCurrentHistory(chatUi.activeChat);
        }

        // Своё сообщение — всегда прокручиваем вниз.
        uiStore.scrollToBottom(true);
      } catch (error) {
        alert('Failed to send message: ' + error.message);
      } finally {
        deps.sending.setSending(false);
      }
}
