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
import api from '../api.js';

export async function loadContacts(email) {
  try {
    const all = await api.getContacts();
    // Контакты — общий peer-key store на машину; себя не показываем.
    let list = (all || []).filter(c => c.email !== email);
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
        (aliasOf[c.email] = aliasOf[c.email] || []).push(prev.contact.email);
        byKey.set(k, { contact: c, added_at: c.added_at || '' });
      } else {
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
