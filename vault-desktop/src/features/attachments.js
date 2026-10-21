// Feature module: вложения (файлы/аудио/изображения + download-on-demand).
// Этап 5 декомпозиции App.vue — изоляция фич-доменов.
// Пилот ADR-001: первый вынос inline-логики App.vue в отдельный домен.
//
// ADR-005 W2 (`t_bcb8927a`): модуль больше НЕ читает экземпляр компонента
// (`ctx`), хотя был его крупнейшим потребителем (103 ссылки). Замена — не
// механическая, а по ВЛАДЕЛЬЦАМ состояния (ADR-004): открытый чат, ключи,
// адрес аккаунта и список писем читаются у тех, кто ими владеет; эффекты
// (история, конверт, заметки, UI-флаги) приходят явным `deps`.
// Что осталось в `deps` и почему — в комментарии у каждого входа.
//
// Срезы домена:
//  - downloadAttachment/downloadDodAttachment/openImageViewer: отдача и
//    DoD-докачка файла (клик по карточке → data-письмо по Message-ID).
//  - fetchDodAttachment: расшифровка DoD-тела (групповой/пир-ключ), кэш
//    dodCache, персист истории.
//  - toggleVoiceNote: фоновый плеер голосовых (Android native MediaPlayer).
//  - sendAudioMessage: голосовое = вложение audio/webm в конверте (или
//    локально в «Заметки для себя»).
//  - handleFileSelect: выбор файлов, лимиты провайдера/заметок, сжатие
//    картинок, DoD-разбиение крупных файлов, отправка (группа/1:1/заметки).
//
// Инвариант: контент шифруется как обычное сообщение (AAD="VAULT") —
// БЕЗ шифрования получатель не расшифрует и письмо молча отбросится.

import { uiStore } from "./session-store.js";
import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';
import { downloadBase64 } from '../chatExport.js';
import { getAttachmentLimitMb } from '../mailProviders.js';
import { isTextMime, parseEnvelope, senderEmail } from '../message-format.js';
import { mediaQuality } from '../message-store.js';
import * as EnvelopeId from './envelope-id.js';
import { chatStore as chatState, sessionStore } from './session-store.js';
import { identityStore } from './identity-store.js';
import { mailboxState } from './mailbox-store.js';

// ── Владельцы состояния вместо ctx (ADR-005 R3, W2) ───────────────────────
// `chatUi` — алиас на state владельца открытого чата. Алиас безопасен:
// владелец заменяет ПОЛЯ (setActiveChat), а не сам объект state, поэтому
// ссылка не протухает, а значение читается живым — ровно как читал
// `ctx.activeChat` (тоже computed-прокси во владельца).
const chatUi = chatState.state;

// Почта аккаунта — ФУНКЦИЕЙ, а не снимком: вход/выход могут случиться посреди
// длинной операции (чтение файла, докачка тела), и прежний код читал живое
// значение в каждой точке, а не один раз на входе.
const myEmail = () => sessionStore.getCurrentEmail();

// ── Отдача / просмотр ──────────────────────────────────────────
// ADR-001: зависимостей нет — файл просто отдаётся на скачивание.
export function downloadAttachment(attachment) {
  if (!attachment || !attachment.data) return;
  downloadBase64(attachment.data, attachment.name, attachment.type);
}

// Download attachment via Tauri native bridge (t_e66389bd).
// Saves base64 data to the OS downloads directory; falls back to
// browser download if the Tauri command is unavailable.
export async function downloadAttachmentFile(attachment) {
  if (!attachment || !attachment.data) return;
  try {
    const result = await invoke('vault_save_file', {
      base64Data: attachment.data,
      filename: attachment.name,
      mimeType: attachment.type || 'application/octet-stream',
    });
    if (result) {
      uiStore.toast(
        // Ключ с плейсхолдером: tr теперь прокидывает params в t().
        // Фолбэк — на случай, если гейт locale-keys пропустит ключ в новой локали.
        uiStore.tr('download_complete', { name: attachment.name }) ||
        `Сохранено: ${attachment.name}`,
        2000
      );
    }
    return result;
  } catch (e) {
    console.warn('[attachment] native save failed, fallback to browser:', e);
    downloadBase64(attachment.data, attachment.name, attachment.type);
  }
}

// Полноэкранный просмотр изображения-вложения
// ADR-001: openImageViewer убран как бессмысленная обёртка — он был
// единственным присваиванием `ctx.viewingImage = attachment`. Держать
// ради этого отдельную экспортируемую функцию значит платить лишним
// уровнем перехода за ноль логики. App.vue присваивает прямо.
// Если здесь появится логика (пре-load, проверка формата) — вернём
// функцию, но уже с явными зависимостями.

// ── Фоновый плеер голосовых (t_c1c44344, Android) ──────────────
// ADR-001: зависимости в сигнатуре. Возвращает новое значение
// voicePlayingId — состояние принадлежит компоненту, фича только считает.
// showToast приходит функцией: её нужно передавать связанной с
// компонентом (App.vue оборачивает в стрелку), иначе потеряется this.
export async function toggleVoiceNote({ isAndroidClient, voicePlayingId, showToast, t }, msg, attachment) {
  if (!isAndroidClient) return voicePlayingId;
  if (!attachment || !attachment.data) return voicePlayingId;
  if (voicePlayingId === msg.id) {
    try { await invoke('voicenote_stop'); } catch (e) { console.warn('[voicenote] stop failed:', e); }
    return '';
  }
  try {
    await invoke('voicenote_play', {
      id: String(msg.id),
      data: attachment.data,
      mime: attachment.type || 'audio/webm',
    });
    return String(msg.id);
  } catch (e) {
    console.warn('[voicenote] play failed:', e);
    showToast(t('voice_play_failed') || 'Не удалось воспроизвести', 3000);
    return voicePlayingId;
  }
}

// ── Download-on-demand (M1) ────────────────────────────────────
// decryptDodBody: чистый decrypt DoD-конверта (групповой/пир-ключ).
// Возвращает plain-text или null (когда ключей нет/расшифровка упала).
// crypto — объект {decryptWithGroupKey, decryptVault, setPeerPublicKey}
// (инъецируется, чтобы тестировать без Tauri crypto-бэка).
export async function decryptDodBody(body, { activeChatType, currentGroup, groupKeys, senderEmail, peerKeys, peerPqKeys, crypto }) {
  let plain = null;
  const groupKey = groupKeys[currentGroup && currentGroup.id];
  if (activeChatType === 'group' && groupKey) {
    try { plain = await crypto.decryptWithGroupKey(body, groupKey); } catch { plain = null; }
  }
  if (plain === null) {
    if (senderEmail && peerKeys[senderEmail]) {
      crypto.setPeerPublicKey(peerKeys[senderEmail], peerPqKeys && peerPqKeys[senderEmail]);
      try { plain = await crypto.decryptVault(body); } catch { plain = null; }
    }
  }
  return plain;
}

// isDodReady: уже загружено или сейчас грузится — пропуск fetch.
export function isDodReady(attachment) {
  return !!attachment && (attachment.dodStatus === 'ready' || attachment.dodStatus === 'loading');
}

// findDodLetter: чистый поиск data-письма по Message-ID в списке входящих.
// Вынесен из fetchDodAttachment: получает список писем параметром (список
// принадлежит владельцу mailbox-store), поэтому не знает ни про компонент,
// ни про его состояние.
export function findDodLetter(emails, messageId) {
  const id = String(messageId || '').trim();
  return (emails || []).find(m => (m.message_id || '').trim() === id);
}

// Докачка DoD-вложения. `deps` — только эффекты, которые принадлежат
// компоненту: кэш (data-объект), перерисовка, персист истории, ключ чата.
// Состояние чата/ключи/письма — у владельцев (см. шапку модуля).
export async function fetchDodAttachment(deps, msg, attachment) {
  if (!attachment || !attachment.isDod || !attachment.dod) return;
  if (isDodReady(attachment)) return;
  attachment.dodStatus = 'loading';
  const chatKey = deps.resolveChatKey({
    activeChat: chatUi.activeChat, activeChatType: chatUi.activeChatType, currentGroup: chatUi.currentGroup,
  });
  try {
    const cached = deps.dodCache[attachment.dod];
    if (cached) {
      attachment.data = cached;
      attachment.dodStatus = 'ready';
      deps.forceUpdate();
      return;
    }
    const target = findDodLetter(mailboxState.state.emails, attachment.dod);
    if (!target) throw new Error(uiStore.tr('dod_letter_not_found') || 'data-письмо не найдено (оно могло не дойти или быть удалено)');
    const body = await invoke('email_fetch_body', { uid: String(target.uid || target.id), folder: target.folder || 'INBOX' });
    if (!body) throw new Error('empty body');
    // Имя `sender` — не косметика: локальная `const senderEmail` затеняла бы
    // импортированный чистый senderEmail(), а её инициализатор ссылался бы на
    // саму себя (TDZ) — функция падала бы на первом же групповом DoD.
    const sender = chatUi.activeChatType === 'group'
      ? ((msg && msg.sender_id && senderEmail(msg.sender_id)) || '')
      : chatUi.activeChat;
    const plain = await decryptDodBody(body, {
      activeChatType: chatUi.activeChatType, currentGroup: chatUi.currentGroup,
      groupKeys: deps.groupKeys, senderEmail: sender,
      peerKeys: identityStore.state.peerKeys, peerPqKeys: identityStore.state.peerPqKeys, crypto,
    });
    if (plain === null || typeof plain !== 'string') throw new Error('decrypt failed');
    const env = await parseEnvelope(plain);
    const raw = env ? env.text : plain;
    const obj = JSON.parse(raw);
    if (!obj || obj.vault_dod_data !== 1 || !obj.data) throw new Error('not a dod data letter');
    if (String(obj.ref || '') !== attachment.dod.trim()) throw new Error('ref mismatch');
    attachment.data = obj.data;
    deps.dodCache[attachment.dod] = obj.data;
    attachment.dodStatus = 'ready';
    attachment.isImage = !!(attachment.type && attachment.type.startsWith('image/'));
    attachment.isAudio = !!(attachment.type && attachment.type.startsWith('audio/'));
    attachment.isText = false;
    uiStore.toast((uiStore.tr('dod_ready') || 'Файл загружен:') + ' ' + attachment.name, 4000);
  } catch (e) {
    console.warn('[dod] fetch failed:', e);
    attachment.dodStatus = 'error';
    uiStore.toast((uiStore.tr('dod_error') || 'Не удалось загрузить файл:') + ' ' + (e && e.message || e), 8000);
  }
  deps.forceUpdate();
  try { deps.saveCurrentHistory(chatKey); } catch (e) { /* ignore */ }
}

export async function downloadDodAttachment(deps, msg, attachment) {
  if (attachment.dodStatus !== 'ready') {
    await fetchDodAttachment(deps, msg, attachment);
    if (attachment.dodStatus !== 'ready') return;
  }
  if (attachment.data) downloadBase64(attachment.data, attachment.name, attachment.type);
}

// ── Голосовое сообщение (вложение audio/webm или локальная заметка) ──
// buildVoiceOptimisticMsg: чистый factory оптимистичного предпросмотра.
// Совпадает в ветках notes/local и send/peer — вынесен чтобы не дублировать.
export function buildVoiceOptimisticMsg(audioData, { id, timeStr, name, status, encrypted, _pendingAt }) {
  return {
    id,
    content: `🎙️ [Voice ${audioData.duration}s — ${Math.round(audioData.size / 1024)}KB]`,
    from: 'me',
    time: timeStr,
    encrypted,
    status,
    _pendingAt: _pendingAt ?? Date.now(),
    attachment: {
      name,
      type: audioData.mimeType || 'audio/webm',
      size: audioData.size,
      data: audioData.base64,
      isImage: false,
      isAudio: true,
    },
  };
}

// buildNoteWithAttachment: чистый optimistic-сообщение-карточка файла в
// «Заметки для себя» (локально, без шифрования/почты). DRY с send.js notes.
export function buildNoteWithAttachment(file, { displayContent, base64, isImage, isAudio, isText, textContent, timeStr }) {
  return {
    id: 'note-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    content: displayContent,
    from: 'me',
    time: timeStr,
    encrypted: false,
    vault: false,
    status: 'sent',
    _notes: true,
    attachment: {
      name: file.name,
      type: file.type,
      size: file.size,
      data: base64,
      isImage,
      isAudio,
      isText,
      textContent,
    },
  };
}

// encryptAttachmentEnvelope: чистый encrypt конверта вложения (group/peer).
// Инъецируем buildEnvelope/crypto/envelopeIdOf — чтобы не дублировать логику
// шифрования между sendAudioMessage и handleFileSelect.
export async function encryptAttachmentEnvelope(payload, {
  activeChatType, activeChat, currentGroup, groupKeys, peerKeys, peerPqKeys, cryptoReady,
  buildEnvelope, crypto, envelopeIdOf,
}) {
  let wire = payload;
  let envelopeId = '';
  if (activeChatType === 'group' && currentGroup) {
    const groupKey = groupKeys[currentGroup.id];
    if (groupKey) {
      const envelope = await buildEnvelope(payload);
      envelopeId = envelopeIdOf(envelope);
      wire = await crypto.encryptWithGroupKey(envelope, groupKey);
    }
  } else if (cryptoReady && peerKeys[activeChat]) {
    wire = await encryptPeerVaultEnvelope(await buildEnvelope(payload), {
      activeChat, peerKeys, peerPqKeys, cryptoReady, crypto,
    });
    envelopeId = ''; // id будет pending в caller
  }
  return { wire, envelopeId };
}

// encryptPeerVaultEnvelope: peer-encrypt уже построенного envelope
// (AAD="VAULT"). Чистая, переиспользуется send.js (1:1) и attachments.
export async function encryptPeerVaultEnvelope(envelope, { activeChat, peerKeys, peerPqKeys, cryptoReady, crypto }) {
  if (!cryptoReady || !peerKeys || !peerKeys[activeChat]) return envelope;
  crypto.setPeerPublicKey(peerKeys[activeChat], peerPqKeys && peerPqKeys[activeChat]);
  return await crypto.encryptVault(envelope);
}

// Голосовое. `deps` здесь шире, чем у DoD: заметки и переписка — per-app
// экземпляры владельцев (создаются в setup, синглтона нет), плюс эффекты
// отправки (конверт, pending, история) и UI-флаг рекордера.
export async function sendAudioMessage(deps, audioData) {
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Заметки для себя: голосовое хранится ЛОКАЛЬНО (localStorage), без
  // шифрования и почты — так же, как текст заметок.
  if (chatUi.activeChat === '__notes__') {
    const now = Date.now();
    const name = `voice-${now}.webm`;
    const msg = buildVoiceOptimisticMsg(audioData, {
      id: 'note-' + now.toString(36) + Math.random().toString(36).substr(2, 5),
      timeStr, name, status: 'sent', encrypted: false,
    });
    msg.vault = false;
    msg._notes = true;
    // Запись ТОЛЬКО через владельца notes-store (ADR-004 A15).
    // НЕ делаем `const list = deps.notes...` и не мутируем list — эвристика
    // поймает alias-мутацию. add() сама load→push→save с защитой от дубля.
    if (!deps.notes.add(myEmail(), msg)) {
      deps.chat.set(deps.notes.load(myEmail()));
      alert(uiStore.tr('err_notes_full_voice'));
      deps.hideAudioRecorder();
      return;
    }
    deps.chat.set(deps.notes.load(myEmail()));
    deps.hideAudioRecorder();
    uiStore.scrollToBottom(true);
    return;
  }
  // Голосовое = вложение audio/webm, зашифрованное как обычное сообщение
  // (конверт {vault:1,...,text:<JSON вложения>} + encryptVault, AAD="VAULT").
  const name = `voice-${Date.now()}.webm`;
  const attachmentPayload = JSON.stringify({
    vault_attachment: true,
    name,
    type: audioData.mimeType || 'audio/webm',
    size: audioData.size,
    data: audioData.base64,
  });

  // Конверт строим ДО оптимистичного показа: его id — ключ слияния с
  // реальным письмом (иначе поллинг не смог бы заменить предпросмотр,
  // и голосовое «появлялось и исчезало»).
  const { wire, envelopeId } = await encryptAttachmentEnvelope(attachmentPayload, {
    activeChatType: chatUi.activeChatType, activeChat: chatUi.activeChat, currentGroup: chatUi.currentGroup,
    groupKeys: deps.groupKeys, peerKeys: identityStore.state.peerKeys, peerPqKeys: identityStore.state.peerPqKeys, cryptoReady: deps.cryptoReady,
    buildEnvelope: (p) => deps.buildEnvelope(p), crypto, envelopeIdOf: EnvelopeId.envelopeIdOf,
  });

  // Оптимистичный предпросмотр у отправителя.
  const now = Date.now();
  const msg = buildVoiceOptimisticMsg(audioData, {
    id: envelopeId || EnvelopeId.pendingIdOf(),
    timeStr, name, status: 'sending', encrypted: deps.cryptoReady, _pendingAt: now,
  });
  msg.ts = now;
  deps.chat.append(msg);
  const chatKey = deps.resolveChatKey({
    activeChat: chatUi.activeChat, activeChatType: chatUi.activeChatType, currentGroup: chatUi.currentGroup,
  });
  deps.markPending(chatKey, msg);
  deps.hideAudioRecorder();
  uiStore.scrollToBottom(true);

  if (chatUi.activeChat) {
    try {
      if (chatUi.activeChatType === 'group' && chatUi.currentGroup) {
        // envelopeObj: релей-дубль участникам (api.sendGroupMessage).
        await api.sendGroupMessage(chatUi.currentGroup.id, wire, envelopeId ? { id: envelopeId } : null);
      } else {
        await api.sendMessage(chatUi.activeChat, wire, audioData.mimeType || 'audio/webm');
      }
      msg.status = 'sent';
    } catch (err) {
      console.error('Failed to send audio:', err);
      msg.status = 'failed';
      alert('Failed to send voice message: ' + (err && err.message || err));
    }
    // Персистим финальный статус в историю (иначе после перезапуска
    deps.saveCurrentHistory(chatKey);
  }
}


// ── Выбор файлов-вложений (лимиты, сжатие, DoD-разбиение, отправка) ──
// `deps`: заметки/переписка (per-app владельцы), эффекты отправки и сжатие
// картинки. Состояние чата/ключи/адрес/письма — у владельцев (см. шапку).
export async function handleFileSelect(deps, event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  for (const file of files) {
    try {
      // Для заметок почтовый лимит провайдера неважен (файл никуда не
      // отправляется), но localStorage ограничен (~5МБ) — не даём выбрать
      // заведомо непомещающийся файл.
      if (chatUi.activeChat === '__notes__' && file.size > 3 * 1024 * 1024) {
        alert(`Файл «${file.name}» — ${(file.size / 1024 / 1024).toFixed(1)} МБ. В «Заметки для себя» вложения хранятся локально (лимит ~5 МБ на весь чат), файлы больше 3 МБ не прикрепляются.`);
        continue;
      }
      // Лимит вложений провайдера (Gmail 25MB, Zoho 25MB, ...): письмо с
      // base64-телом ~на 33% больше файла, поэтому сравниваем с 70% от
      // лимита — предупреждаем ДО отправки, пока провайдер не отклонил.
      const limitMb = getAttachmentLimitMb(myEmail());
      const limitBytes = Math.floor(limitMb * 1024 * 1024 * 0.7);
      if (file.size > limitBytes) {
        alert(
          (uiStore.tr('file_too_large') || 'Файл не пройдёт через почту: лимит вложений вашего провайдера') +
          ` ~${limitMb} МБ, а «${file.name}» — ${(file.size / 1024 / 1024).toFixed(1)} МБ.` +
          (uiStore.tr('file_too_large_hint') || ' Файл не отправлен.')
        );
        continue; // пропускаем файл, остальные отправляем
      }
      const reader = new FileReader();
      reader.onload = async (e) => {
        let base64 = e.target.result.split(',')[1];
        let fileName = file.name;
        let fileSize = file.size;
        let fileType = file.type;
        // Качество медиа: изображения сжимаются по настройке
        // «Качество отправляемых медиафайлов» (kv media-quality).
        // original = без сжатия; high = макс. сторона 1920; low = 1280.
        if (fileType.startsWith('image/') && fileType !== 'image/gif') {
          try {
            const quality = await mediaQuality();
            if (quality !== 'original') {
              const maxSide = quality === 'low' ? 1280 : 1920;
              const compressed = await deps.compressImage(e.target.result, maxSide, 0.82);
              if (compressed && compressed.length < e.target.result.length) {
                base64 = compressed.split(',')[1];
                fileType = 'image/jpeg';
                if (!/\.jpe?g$/i.test(fileName)) fileName = fileName.replace(/\.\w+$/, '') + '.jpg';
                fileSize = Math.floor(base64.length * 0.75);
              }
            }
          } catch (err) { console.warn('image compress failed:', err); }
        }
        const isImage = fileType.startsWith('image/');
        const isAudio = fileType.startsWith('audio/');
        const isText = !isImage && !isAudio && isTextMime(fileType, fileName);
        let textContent = '';
        if (isText) {
          try {
            textContent = atob(base64);
            try { textContent = decodeURIComponent(escape(textContent)); } catch { /* уже utf-8 */ }
          } catch { textContent = ''; }
          if (textContent.length > 8000) textContent = textContent.slice(0, 8000) + '\n…';
        }

        // Encode attachment as structured JSON for server storage.
        // Download-on-demand (M1): файлы крупнее порога уходят ДВУМЯ
        // письмами — мета-конверт (эта карточка, без данных) + data-письмо
        // (полный base64) с нейтральным Message-ID. Получатель качает
        // тело по требованию (клик), а не автоматически при открытии
        // чата. Малые файлы идут как раньше — одним конвертом.
        const DOD_THRESHOLD = 1024 * 1024;
        const useDod = fileSize > DOD_THRESHOLD;
        let dodMid = '';
        if (useDod) dodMid = `<vault-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}@${(myEmail() || 'localhost').split('@')[1] || 'localhost'}>`;
        const attachmentPayload = useDod
          ? JSON.stringify({
              vault_attachment: true,
              name: fileName,
              type: fileType,
              size: fileSize,
              dod: dodMid,
            })
          : JSON.stringify({
              vault_attachment: true,
              name: fileName,
              type: fileType,
              size: fileSize,
              data: base64,
            });

        const displayContent = isImage
          ? `📎 ${fileName}`
          : `📎 ${fileName} (${(fileSize / 1024).toFixed(1)}KB)`;

        // Заметки для себя: файл хранится ЛОКАЛЬНО (localStorage), без
        // шифрования и почты — так же, как текст заметок.
        if (chatUi.activeChat === '__notes__') {
          const noteMsg = buildNoteWithAttachment(file, {
            displayContent, base64, isImage, isAudio, isText, textContent,
            timeStr: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          });
          // Запись ТОЛЬКО через владельца notes-store (ADR-004 A15).
          // add() сама load→push→save с защитой от дубля; при ошибке откатывает.
          if (!deps.notes.add(myEmail(), noteMsg)) {
            deps.chat.set(deps.notes.load(myEmail()));
            alert(uiStore.tr('err_notes_full_file'));
            return;
          }
          deps.chat.set(deps.notes.load(myEmail()));
          uiStore.scrollToBottom(true);
          return;
        }
        // Отправка: вложение — это конверт {vault:1,...,text:<JSON вложения>},
        // зашифрованный как обычное сообщение (AAD="VAULT"). БЕЗ шифрования
        // получатель не сможет расшифровать (AAD не сойдётся) и письмо
        // молча отбросится. Конверт строим ДО предпросмотра: его id — ключ
        // слияния с реальным письмом (иначе поллинг не заменит предпросмотр,
        // и файл «появится и исчезнет» у отправителя).
        const { wire, envelopeId } = await encryptAttachmentEnvelope(attachmentPayload, {
          activeChatType: chatUi.activeChatType, activeChat: chatUi.activeChat, currentGroup: chatUi.currentGroup,
          groupKeys: deps.groupKeys, peerKeys: identityStore.state.peerKeys, peerPqKeys: identityStore.state.peerPqKeys, cryptoReady: deps.cryptoReady,
          buildEnvelope: (p) => deps.buildEnvelope(p), crypto, envelopeIdOf: EnvelopeId.envelopeIdOf,
        });

        // Create preview message
        const msg = {
          id: envelopeId || EnvelopeId.pendingIdOf(),
          content: displayContent,
          from: 'me',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          ts: Date.now(),
          encrypted: deps.cryptoReady,
          status: 'sending',
          _pendingAt: Date.now(),
          attachment: {
            name: file.name,
            type: file.type,
            size: file.size,
            data: base64,
            isImage: isImage,
            isAudio: isAudio,
            isText: isText,
            textContent: textContent,
          },
        };
        deps.chat.append(msg);
        const chatKey = deps.resolveChatKey({
          activeChat: chatUi.activeChat, activeChatType: chatUi.activeChatType, currentGroup: chatUi.currentGroup,
        });
        deps.markPending(chatKey, msg);
        uiStore.scrollToBottom(true);

        if (chatUi.activeChat) {
          // DoD: data-письмо уходит ПЕРВЫМ. Если мета не уйдёт и её
          // переотправят — data-дубль безвреден (один Message-ID
          // дедуплицируется на приёме), а обратный порядок дал бы
          // карточку без данных. Сбой data = мета бесполезна → failed.
          if (useDod) {
            const dataPayload = JSON.stringify({ vault_dod_data: 1, ref: dodMid, data: base64 });
            try {
              if (chatUi.activeChatType === 'group' && chatUi.currentGroup) {
                const groupKey = deps.groupKeys[chatUi.currentGroup.id];
                if (!groupKey) throw new Error('group key unavailable');
                const dataWire = await crypto.encryptWithGroupKey(await deps.buildEnvelope(dataPayload), groupKey);
                const members = await api.getGroupMembers(chatUi.currentGroup.id);
                const failedData = [];
                for (const member of members || []) {
                  if (member.email === myEmail()) continue;
                  try { await api.sendDodEmail(member.email, dataWire, dodMid); }
                  catch (e) { failedData.push(member.email); }
                }
                if (failedData.length) {
                  console.warn('DoD data partial fail:', failedData);
                  uiStore.toast((uiStore.tr('dod_partial_fail') || 'Данные файла не ушли:') + ' ' + failedData.join(', '), 8000);
                }
              } else if (deps.cryptoReady && identityStore.state.peerKeys[chatUi.activeChat]) {
                crypto.setPeerPublicKey(identityStore.state.peerKeys[chatUi.activeChat], identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[chatUi.activeChat]);
                const dataWire = await crypto.encryptVault(await deps.buildEnvelope(dataPayload));
                await api.sendDodEmail(chatUi.activeChat, dataWire, dodMid);
              } else {
                throw new Error('crypto not ready');
              }
            } catch (err) {
              console.error('DoD data send failed:', err);
              msg.status = 'failed';
              deps.saveCurrentHistory(chatKey);
              return;
            }
          }
          try {
            if (chatUi.activeChatType === 'group' && chatUi.currentGroup) {
              // envelopeObj: релей-дубль участникам (api.sendGroupMessage).
              await api.sendGroupMessage(chatUi.currentGroup.id, wire, envelopeId ? { id: envelopeId } : null);
            } else {
              await api.sendMessage(chatUi.activeChat, wire, file.type);
            }
            msg.status = 'sent';
          } catch (err) {
            console.error('Failed to send attachment:', err);
            msg.status = 'failed';
          }
          // Персистим финальный статус в историю (иначе после перезапуска
          deps.saveCurrentHistory(chatKey);
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error('File read error:', err);
    }
  }

  // Reset input
  event.target.value = '';
}


