// Навигация по чатам и группам — ADR-005 W3.
//
// Открытие чата — это СЦЕПАРИЙ (сброс → кэш → состояние → загрузка), и он
// один: чистить его в двух местах (1:1 и группа) означало бы, что одна из
// копий забывает шаг. Здесь обе ветки живут рядом и видно, чем отличаются:
//  * у 1:1 проверяется НАЛИЧИЕ КЛЮЧА собеседника (без ключа показывать
//    нечего — и вместо пустого чата показывается панель обмена ключами);
//  * у группы дополнительно догружается ключ группы (он может быть ещё не
//    загружен: настройки открыты без чата) — без этого рассылка мета-писем
//    МОЛЧА пропускалась, и участники не видели аватар никогда.
//
// ПОРЯДОК ВАЖЕН. Сначала сбрасываем и показываем кэш (мгновенно), и только
// потом грузим из сети — иначе пользователь видит сообщения ПРЕДЫДУЩЕГО чата
// (одинаковые во всех чатах). Токен загрузки (loadSeq) инкрементится ДО
// смены чата: незавершённая загрузка прошлого чата увидит новый seq и не
// применит свои результаты.
//
// deps (ADR-001 R3) — явный контракт; состояние — у владельцев (ADR-004).
import crypto from '../crypto.js';

export async function selectChat(deps, email) {
  // Vault chat requires a peer key — without it there is nothing (and nothing
  // encrypted) to show. Contacts without keys are already hidden from the list;
  // this is a hard guard on top. Ключ ищем по ЛЮБОЙ форме адреса (contact мог
  // сменить почту): `peerKeys()[email]` голой строкой открывал попап «Добавить
  // контакт» вместо чата, который и так был открыт (живые данные, 24.10).
  const peer = await deps.peerContactFor(email);
  if (!peer.key) {
    // Не молчим: объясняем, что нужно обменяться ключами, и сразу открываем
    // панель 🔗 (QRCodePanel) — ввод id участника или сканирование QR.
    deps.alert(deps.tr('chat_no_key') || 'Нет ключа собеседника — обменяйтесь ключами: нажмите кнопку «Добавить контакт» (кнопка со значком ссылки вверху) и введите id участника или отсканируйте QR-код.');
    deps.setShowQRCode(true);
    return;
  }
  // Сбрасываем чат сразу — иначе при медленной загрузке нового чата
  // пользователь видит сообщения предыдущего (одни и те же во всех чатах).
  deps.saveDraft(); // черновик прошлого чата — до сброса activeChat
  deps.chat.set([]);
  deps.setNewMessage('');
  deps.cancelReply();
  await deps.restoreDraft(email);
  // показываем кэш прошлой сессии, пока идёт
  // загрузка из IMAP. Свежие данные перезапишут кэш по завершении.
  const cachedChat = await deps.loadChatCache(email);
  if (cachedChat && cachedChat.length) {
    cachedChat.sort((a, b) => deps.msgTs(a) - deps.msgTs(b));
    deps.chat.set(cachedChat);
  }
  // Токен загрузки: незавершённый loadMessages прошлого чата увидит
  // новый seq и не применит свои результаты.
  deps.incLoadSeq();
  deps.setActiveChat(email);
  deps.setActiveChatType('chat');
  deps.setShowStarredOnly(false); // избранное — режим, сбрасывается при смене чата
  deps.loadStarredFor(email);
  // TTL исчезающих для 1-на-1 — из kv (как selectGroup для групп): иначе
  // currentEphemeralTtl остаётся от ПРЕДЫДУЩЕГО чата, иконка замка врёт,
  // а старый fallback применял чужой TTL к сообщениям.
  deps.setCurrentEphemeralTtl(await deps.ephemeralTtlOf(email));
  deps.setCurrentView('chats');
  deps.resetUnread(email); // чат открыт — сбрасываем счётчик непрочитанных
  deps.openMobileChat();
  const pk = peer.key;
  if (peer.key) {
    crypto.setPeerPublicKey(peer.key, deps.peerPqKeys() && deps.peerPqKeys()[peer.address]);
  }
  // Если письма ещё не загружены (клик сразу после входа — поллинг идёт
  // раз в 30 сек), загружаем их немедленно, иначе чат выглядит пустым.
  if (deps.emails().length === 0) {
    try {
      await deps.loadEmails(true);
    } catch (e) { /* Not connected — тихий фолбэк */ }
  }
  await deps.loadMessages(email);
  // при открытии чата — сразу к последнему
  // сообщению (вниз).
  deps.scrollToBottom(true);
}

// M2.4: открыть чат по ключу (email) — из ntfy-пуша (vault://open?chat=).
export async function openChatByKey(deps, key) {
  const email = String(key || '').toLowerCase();
  if (!email) return;
  try {
    await deps.selectChat(email);
    if (deps.isMobile()) deps.setMobileChatOpen(true);
    deps.setShowSettings(false);
  } catch (e) { console.warn('[notify] openChatByKey failed:', e); }
}

export async function selectGroup(deps, group) {
  deps.saveDraft(); // черновик прошлого чата
  deps.chat.set([]);
  deps.setNewMessage('');
  deps.cancelReply();
  await deps.restoreDraft('group:' + group.id);
  const cachedGroup = await deps.loadChatCache(`group:${group.id}`);
  if (cachedGroup && cachedGroup.length) {
    cachedGroup.sort((a, b) => deps.msgTs(a) - deps.msgTs(b));
    deps.chat.set(cachedGroup);
  }
  deps.incLoadSeq();
  deps.setActiveChat(`group:${group.id}`);
  deps.setActiveChatType('group');
  deps.setShowStarredOnly(false); // избранное — режим, сбрасывается при смене чата
  deps.loadStarredFor('group:' + group.id);
  // Ленивое заполнение fingerprint участников: старые группы без
  // fingerprint — заполняем из peer_keys при открытии (один раз; Rust
  // сохраняет). Нужно для membership по ключу при смене почты.
  deps.backfillGroupFingerprints(group);
  deps.setShowEphemeralMenu(false);
  deps.setCurrentEphemeralTtl(await deps.ephemeralTtlOf('group:' + group.id));
  deps.setCurrentGroup(group);
  deps.openMobileChat();
  deps.resetUnread('group:' + group.id); // группа открыта — сбрасываем счётчик

  // Load group key if not already in memory
  if (!deps.groupKeys()[group.id] && deps.cryptoReady()) {
    try {
      const keyData = await deps.api.getMyGroupKey(group.id);
      if (keyData && keyData.group_key) {
        // Serverless: group key is stored locally in ~/.vault/groups.json
        // (the same file the CLI reads) — no per-user encryption needed.
        deps.setGroupKey(group.id, keyData.group_key);
      } else if (keyData && keyData.encrypted_key) {
        // Decrypt the group key with our private key
        // The encrypted_key was encrypted with our public key by the group creator
        // We need the group creator's public key to decrypt
        // For now, try to decrypt using the stored peer keys
        const creatorEmail = group.created_by;
        if (deps.peerKeys()[creatorEmail]) {
          const groupKeyHex = await crypto.decryptGroupKey(
            keyData.encrypted_key,
            deps.peerKeys()[creatorEmail]
          );
          deps.setGroupKey(group.id, groupKeyHex);
        }
      }
    } catch (e) {
      console.warn('Could not load group key:', e);
    }
  }

  await deps.loadGroupMessages(group.id, false);
  deps.scrollToBottom(true);
}
