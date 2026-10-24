// Загрузка своих групп и подпитка контактов из участников.
//
// ADR-003 Этап 3, партия 5. Здесь впервые понадобилась ЯВНАЯ СИГНАТУРА вместо
// механической замены `this`: у метода было 9 зависимостей (aliasesOf, contacts,
// email, fingerprint, groupAvatars, groupIconMap, groups, requestGroupAvatarHeal).
// Для девяти таких замена `this` на параметры дала бы подпись на девять позиций
// и всё равно не сделала бы функцию проверяемой. Поэтому функция СОБИРАЕТ
// результат и возвращает его, а компонент применяет — и тест может позвать её
// без подделки компонента.
//
// ЧАСТИЧНЫЙ РЕЗУЛЬТАТ — НЕ ОПЕЧАТКА, А ТРЕБОВАНИЕ. Оригинал присваивал
// this.groups сразу после invoke, а аватары и контакты — по ходу цикла. Если
// db.kvGet падает на третьей группе, оригинал УЖЕ имел this.groups и аватары
// первых двух. Если бы мы вернули null, потеряли бы это — а потеря groups здесь
// означает пустой экран списка. Поэтому catch возвращает всё, что накоплено, а
// groups остаётся null, если не отработал invoke: в этом случае оригинал тоже
// не трогал бы поле.
//
// ПРАВИЛО «УЧАСТНИК ГРУППЫ = КОНТАКТ». Участники добираются в список контактов
// (кроме себя и уже известных), и это не утечка: модель почтового мессенджера,
// удаление контакта группы НЕ трогает — иначе при удалении контакта из группы
// пропадала бы история переписки.
//
// «КРОМЕ СЕБЯ» РЕШАЕТ КЛЮЧ, А НЕ СТРОКА АДРЕСА (24.10, X50). Сравнивать
// m.email с email текущей сессии — вторая копия правила формы адреса, и она
// слепнет там, где идентичность = отпечаток: свой же аккаунт koanmak@gmail.com
// под сессией koanmak@ya.ru становился «контактом», а клик по нему открывал
// попап «Добавить контакт».
//
// ВТОРАЯ ПОЛОВИНА ТОГО ЖЕ ПРАВИЛА: участник, чья идентичность УЖЕ стоит в
// списке другим адресом, — тоже не новый контакт. На X50 в составе висел
// koanmak@gmail.com со следом ключа 9cadcd4d…, а тот же ключ лежал в peer_keys
// под vault-msg@ya.ru (пир сменил почту, группы остались со старым адресом).
// Фронт добавлял второй строкой адрес БЕЗ ключа: та же аватарка дважды, а тап
// по дублю — попап «Добавить контакт». Решение (свой / известный адрес / та же
// идентичность) — в Rust `groups::contacts_to_pad`, одним вопросом на всю
// добивку; здесь — только вызов и сборка строк.

import { invoke } from '@tauri-apps/api/core';
import { db } from '../api.js';

export async function loadGroups({ email, fingerprint, aliasesOf, contacts, requestGroupAvatarHeal }) {
  let groups = null;
  const avatars = {};
  const icons = {};
  const newContacts = [];
  try {
    // groups.json — общий файл на машину для всех аккаунтов. Показываем
    // только свои группы. Фильтр — Rust-команда groups_load_own:
    // идентичность = fingerprint (не меняется при смене почты), адрес и
    // алиасы — fallback. Логика и тесты — groups::filter_own_groups.
    let aliases = [];
    try { aliases = (aliasesOf && aliasesOf(email)) || []; }
    catch (e) { /* алиасы недоступны — фильтр сработает по email+fp */ }
    groups = await invoke('groups_load_own', {
      email: email || '',
      fingerprint: String(fingerprint || ''),
      aliases,
    });
    // Участники групп — тоже контакты (кроме себя и уже известных): так под
    // приглашённым аккаунтом виден отправитель инвайта (A → B и наоборот).
    const seen = new Set((contacts || []).map(c => c.email));
    // Кого звать в список — решает ядро одним вызовом. Пустой ответ — тоже
    // решение (добавлять некого); ошибка моста — прежнее адресное правило,
    // список не теряется.
    let pad = null;
    try {
      pad = await invoke('groups_contacts_to_pad', {
        email: email || '',
        fingerprint: String(fingerprint || ''),
        aliases,
        members: (groups || []).flatMap(g => (g.members || []).map(m => [m.email || '', m.fingerprint || ''])),
        contacts: (contacts || []).map(c => [c.email || '', c.public_key || '']),
      });
    } catch (e) { /* мост не ответил — см. fail-open ниже */ }
    const wanted = Array.isArray(pad)
      ? new Set(pad.map(e => String(e).toLowerCase()))
      : null;
    for (const g of groups) {
      // Аватар/иконка группы: sqlite kv_store — аватар устанавливает
      // админ, участникам он приходит письмами (см. конверт).
      const av = await db.kvGet('anon', 'group-avatar:' + g.id);
      if (av) avatars[g.id] = av;
      // Устройство без аватарки запрашивает его у участников (hav,
      // rate-limit 24ч внутри метода) — самовосстановление после
      // сброса/смены устройства. Не блокируем загрузку списка.
      else if (requestGroupAvatarHeal) requestGroupAvatarHeal(g.id).catch(() => {});
      const ic = await db.kvGet('anon', 'group-icon:' + g.id);
      if (ic) icons[g.id] = ic;
      for (const m of g.members || []) {
        if (m.email === email || seen.has(m.email)) continue;
        if (wanted && !wanted.has(String(m.email || '').toLowerCase())) continue;
        // Модель почтовый мессенджер: удаление контакта НЕ трогает группы —
        // участник остаётся полноценным контактом в списке.
        seen.add(m.email);
        newContacts.push({ id: m.email, email: m.email, name: m.email, online: false });
      }
    }
  } catch (error) {
    console.error('Failed to load groups:', error);
  }
  return { groups, avatars, icons, newContacts };
}