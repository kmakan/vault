// Feature module: ключи и крипто-инициализация.
//
// ADR-005 W3 (`t_b1bdbb99`), партия 9: логика уехала из App.vue. Ключи пиров
// — у владельца идентичности (identity-store), своя пара и отпечаток — тоже
// там (ADR-004), сама пара ключей — в Rust (crypto.js → Tauri-мост).
import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';
import { resetAccountNamespaceCache, ensureAccountNamespace } from '../identity.js';
import { identityStore } from './identity-store.js';
import { uiStore } from './session-store.js';

// Инициализация своей крипто-пары. Без сохранённого ключа и без
// allowCreate — ничего не создаём: вызывающий обязан показать форму
// входа/восстановления.
//
// deps: { email(), setPublicKey(v), setCryptoReady(v), setFingerprint(v),
//         loadStoredPeerKeys() }
export async function initCrypto(deps, { allowCreate = false } = {}) {
  try {
    const result = await crypto.initFromStorage();
    if (result.loaded) {
      deps.setPublicKey(result.keypair.public_key);
    } else if (allowCreate) {
      const keypair = await crypto.generateKeypair();
      deps.setPublicKey(keypair.public_key);
      await crypto.saveToStorage();
    } else {
      // Ключа нет, а генерировать нельзя: сбрасываем готовность и НЕ
      // создаём пару.
      console.warn('[crypto] нет сохранённого ключа, генерация запрещена (allowCreate=false)');
      deps.setCryptoReady(false);
      deps.setPublicKey(null);
      return false;
    }
    deps.setFingerprint(await crypto.fingerprint());
    // Fire-and-forget: заполняем свой fingerprint у участников групп, которые
    // ещё никто не открывал в UI (там fp заполняется лениво при открытии) —
    // иначе fp-only фильтр «моих групп» их не находит. Вход не блокируем.
    invoke('groups_backfill_my_fingerprint', {
      email: deps.email() || '',
      fingerprint: String(deps.fingerprint() || ''),
    }).catch(() => {});
    deps.setCryptoReady(true);
    await deps.loadStoredPeerKeys();
    // Ключ теперь есть → пересчитываем namespace на fp:<fingerprint> и
    // ОДИН раз переносим накопленные email-строки. Без сброса кэша
    // резолвер остался бы на legacy-емейле (fp закэширован как '' до
    // загрузки ключа), и весь трек fp-идентичности был бы мёртвым.
    resetAccountNamespaceCache();
    if (deps.email()) {
      try { await ensureAccountNamespace(deps.email()); }
      catch (e) { console.warn('[identity] namespace bootstrap failed:', e); }
    }
    return true;
  } catch (error) {
    console.error('Crypto init failed:', error);
    deps.setCryptoReady(false);
    return false;
  }
}

// Загрузка сохранённых ключей пиров в владельца идентичности.
//
// deps: { openChatByKey(key), isMobile }
export async function loadStoredPeerKeys(deps) {
  try {
    // Сбрасываем перед загрузкой: удалённые в Rust ключи должны
    // пропасть из памяти.
    identityStore.clearPeerKeys();
    const stored = await crypto.loadPeerKeys();
    identityStore.loadPeerKeys(stored);
    // M2.4: отложенные ntfy-клики (холодный старт) — ключи загружены,
    // можно открывать чаты. Drain также доступен глобально (__vaultOpenChat).
    try {
      window.__VAULT_DRAIN = () => {
        const q = window.__VAULT_CHAT_QUEUE || [];
        // Холодный старт: Kotlin держит выбранный чат в native-мосте
        // VaultDeepLink.take() (localStorage мог быть недоступен до
        // загрузки страницы). Забираем его оттуда...
        try {
          const native = window.VaultDeepLink && window.VaultDeepLink.take && window.VaultDeepLink.take();
          if (native) q.push(native);
        } catch (e) { /* не Android / моста нет */ }
        // ...и из localStorage (запасной путь).
        try {
          const pending = localStorage.getItem('vault-pending-chat');
          if (pending) {
            localStorage.removeItem('vault-pending-chat');
            q.push(pending);
          }
        } catch (e) { /* ignore */ }
        while (q.length) {
          const chat = q.shift();
          deps.openChatByKey(chat);
          if (deps.isMobile) deps.setMobileChatOpen(true);
        }
      };
      window.__VAULT_DRAIN();
    } catch (e) { /* ignore */ }
  } catch (error) {
    console.error('Failed to load peer keys:', error);
  }
}

// Запись ключа пира: владелец идентичности + Rust-хранилище.
export function setPeerKey(deps, email, key, pq = null) {
  // Запись — через владельца identity (ADR-004 J.6).
  identityStore.setPeerKey(email, key, pq);
  crypto.setPeerPublicKey(key, identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[email]);
  crypto.savePeerKey(email, key, null, pq || undefined).catch(err => {
    console.error('Failed to save peer key:', err);
  });
}

// Ручная вставка ключа из поля ввода.
export function setPeerKeyFromInput(deps) {
  const input = identityStore.state.peerKeyInput;
  if (!input || !deps.activeChat()) return;
  setPeerKey(deps, deps.activeChat(), input);
  identityStore.setPeerKeyInput('');
}

// Добавление ключа из QR/вставки: сохранить, разослать взаимный инвайт.
//
// deps: { email(), activeChat(), publicKey(), loadContacts(), setShowQRCode(v),
//         alert(msg), prompt(msg) }
export async function addPeerKey(deps, payload) {
  try {
    // QRCodePanel шлёт {publicKey, email} (email из QR v2); старый формат —
    // просто hex-строка (ручная вставка ключа без email).
    const publicKeyHex = typeof payload === 'string' ? payload : (payload && payload.publicKey) || '';
    const knownEmail = (typeof payload === 'object' && payload && payload.email) ? String(payload.email).trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
      deps.alert('Invalid public key format');
      return;
    }
    // QR v2 несёт email контакта — ручной ввод не нужен. Для голого ключа
    // (вставка hex) спрашиваем email: peerKeys индексируется по email.
    let email = knownEmail;
    if (!email || !email.includes('@')) {
      email = await deps.prompt('Email контакта?');
    }
    if (!email || !email.includes('@')) {
      deps.alert(uiStore.tr('err_enter_email'));
      return;
    }
    const normalized = email.trim().toLowerCase();
    await crypto.savePeerKey(normalized, publicKeyHex, null);
    // ДЕДУП: тот же ключ уже известен под другим адресом (собеседник
    // сменил почту) — удаляем старую запись, чтобы контакт не
    // продублировался (QR от контакта, сменившего почту: одна запись).
    const peerKeys = identityStore.state.peerKeys || {};
    const oldSame = Object.keys(peerKeys).find(
      k => String(k).toLowerCase() !== normalized && peerKeys[k] === publicKeyHex
    );
    if (oldSame) {
      // Удаление — через владельца identity (ADR-004 J.6).
      identityStore.removePeerKey(oldSame);
      try { await crypto.removePeerKey(oldSame); } catch {}
      api.removeContact(oldSame);
    }
    // Запись — через владельца identity (ADR-004 J.6).
    identityStore.setPeerKey(normalized, publicKeyHex);
    identityStore.markLoaded(normalized);
    // ВЗАИМНОСТЬ: после QR-сканирования/вставки ключа отправляем
    // приглашение обратно — иначе у собеседника контакт не появится
    // (мы сохранили его ключ, а он наш — нет).
    if (normalized !== String(deps.email() || '').toLowerCase()) {
      try {
        await api.sendContactInvite(normalized, deps.publicKey());
        console.log('[contact] mutual invite sent to', normalized);
      } catch (e) {
        console.warn('[contact] mutual invite failed:', e);
      }
    }
    await deps.loadContacts(); // список чатов обновится из load_peer_keys
    deps.setShowQRCode(false);
  } catch (error) {
    deps.alert('Failed to add peer key: ' + error.message);
  }
}

// Ключи изменились (например, восстановлены) — пересчитать отпечаток.
export async function onKeysChanged(deps) {
  if (deps.cryptoReady()) {
    deps.setFingerprint(await crypto.fingerprint());
  }
  await deps.loadStoredPeerKeys();
}

// Канонический адрес по ключу: у контакта могла смениться почта.
export function canonicalOf(deps, email) {
  const peerKeys = identityStore.state.peerKeys || {};
  const key = peerKeys[email || ''] || peerKeys[String(email || '').toLowerCase()];
  if (!key) return email;
  const shown = deps.contacts().find(c => c.public_key === key);
  return shown ? shown.email : email;
}
