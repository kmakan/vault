// Загрузка контактов со склейкой адресов по одному ключу.
//
// ADR-003 Этап 3, партия 3. Жил методом App.vue, но логика в нём самостоятельная
// и проверяемая: правило «один ключ — несколько адресов, показываем последний,
// остальные — алиасы» описано в трёх местах тела и нигде не проверено тестом.
//
// ВАЖНО О ПУСТОМ КЛЮЧЕ. Контакт без public_key нельзя склеивать по ключу, иначе
// он молча схлопнется с чужим. Поэтому он идёт в byKey под своим адресом —
// это не «оптимизация», а условие корректности.
//
// ЧИСТОСТЬ ФУНКЦИИ. Возвращает {contacts, contactAliases} и НЕ трогает ctx.
// Раньше метод мутировал поля компонента, и это делало его нетестируемым без
// подделки компонента. Поведение при ошибке сохранено буквально: contacts = [],
// а contactAliases остаётся ПРЕЖНИМ (ошибка не должна затирать уже известные
// алиасы — иначе потеряется привязка истории чата).
import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';

// «Свой или нет» решает ядро (vault::identity через contacts_drop_own):
// Contacts — общий peer-store на машину, и прежний фильтр `c.email !== email`
// сравнивал СТРОКИ: регистрозависимо, без алиасов и без ключа. Собственный
// аккаунт (тот же публичный ключ под другим адресом) оставался в списке
// «контактом», а клик по нему открывал попап «Добавить контакт».
async function dropOwnContacts(list, email) {
  const pairs = (list || []).map(c => [c.email || '', c.public_key || '']);
  try {
    const ourKey = String(crypto.publicKey || '');
    const aliases = (list || [])
      .filter(c => c.public_key && ourKey
        && String(c.public_key).toLowerCase() === ourKey.toLowerCase())
      .map(c => c.email);
    const fingerprint = crypto.publicKey ? String((await crypto.fingerprint()) || '') : '';
    const kept = await invoke('contacts_drop_own', {
      email: email || '',
      fingerprint,
      aliases,
      contacts: pairs,
    });
    if (!Array.isArray(kept)) throw new Error('contacts_drop_own: не список');
    const keep = new Set(kept.map(([e]) => String(e).toLowerCase()));
    return (list || []).filter(c => keep.has(String(c.email || '').toLowerCase()));
  } catch (e) {
    // Мост не ответил — прежнее поведение (строка против строки), список
    // не теряется.
    return (list || []).filter(c => c.email !== email);
  }
}

export async function loadContacts(email) {
  try {
    const all = await api.getContacts();
    // Контакты — общий peer-key store на машину; себя не показываем.
    let list = await dropOwnContacts(all, email);
    // Смена почты: один ключ может быть привязан к НЕСКОЛЬКИМ
    // адресам (старый + новый). Показываем только ПОСЛЕДНИЙ адрес —
    // старый становится псевдонимом (история чата переносится на новый).
    // Алиасы запоминаем для переноса истории (chat-cache).
    const byKey = new Map(); // key -> {contact, added_at}
    const aliasOf = {};      // newEmail -> [oldEmails]
    for (const c of list) {
      const k = c.public_key;
      if (!k) { byKey.set(c.email, { contact: c, added_at: c.added_at || '' }); continue; }
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, { contact: c, added_at: c.added_at || '' }); continue; }
      // Тот же ключ — выбираем более новый адрес (по added_at), старый — алиас.
      if ((c.added_at || '') >= (prev.added_at || '')) {
        // c — бОльший/равный added_at (новый или текущий). Старый предшественник
        // становится алиасом к c.email.
        (aliasOf[c.email] = aliasOf[c.email] || []).push(prev.contact.email);
        byKey.set(k, { contact: c, added_at: c.added_at || '' });
      } else {
        // c — меньший added_at (пришёл позже по позиции, но старейший). Алгоритм
        // хранит только НЕПРЕРЫВНОГО предшественника; c.email становится алиасом
        // к уже известному предшественнику prev.contact.email. byKey НЕ перезаписывается.
        (aliasOf[prev.contact.email] = aliasOf[prev.contact.email] || []).push(c.email);
      }
    }
    list = [...byKey.values()].map(x => x.contact);
    return { contacts: list, contactAliases: aliasOf };
  } catch (error) {
    // /api/contacts may not exist yet
    return { contacts: [], contactAliases: null };
  }
}
