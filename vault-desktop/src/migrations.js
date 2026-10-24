// Перенос данных при смене почты. Раньше — два метода App.vue, которые шли
// вразнобой с ensureAccountNamespace из identity.js.
//
// ADR-003 Этап 3, партия 2. Слой ВЫШЕ транспорта и identity: обе функции
// используют и api, и identity, поэтому лежать должны выше обоих. Положим их
// в identity.js — получится цикл (identity → api → identity), который вчера
// разбирали именно ради этого.
//
// ЗАМЕЧАНИЕ, КОТОРОЕ НЕ ЗАКАЧЕНО. db_account_migrate вызывается из ДВУХ мест:
// здесь и в ensureAccountNamespace. Они не дублируют друг друга: здесь
// fromAccount приходит явным аргументом (перенос при смене почты), там берётся
// текущий адрес и есть защита _nsMigrated. Слияние меняет семантику вызова, а
// это уже рефакторинг поведения, а не его перенос. Помечено в ADR-003 §5.

import { invoke } from '@tauri-apps/api/core';
import { db } from './api.js';
import { accountNamespace } from './identity.js';
import { mergeHistoryLists, normalizeHistoryList } from './history.js';

export async function migrateAccountData(oldEmail, newEmail) {
  try {
    if (!oldEmail || !newEmail) return;
    // ns = fp:<fingerprint> (ключ стабилен при смене почты) либо legacy-емейл.
    const ns = await accountNamespace(newEmail);
    if (!ns || ns === oldEmail) {
      console.log('[identity] namespace unchanged, nothing to migrate');
      return;
    }
    const report = await invoke('db_account_migrate', { fromAccount: oldEmail, toAccount: ns });
    const moved = report && typeof report.total === 'number' ? report.total : 0;
    console.log(`[identity] account data migrated: ${oldEmail} → ${ns} (moved ${moved})`);
  } catch (e) {
    console.warn('[identity] migrateAccountData failed:', e);
  }
}

// ПЕРЕИМЕНОВАТЬ НАШ СТАРЫЙ АДРЕС в группах, где мы создатель или участник.
//
// Общая операция для двух вызовов (ADR-003 §5 решил НЕ сливать сами вызовы:
// семантика разная — «сменил почту я» и «сменил почту пир»), но ПЕРЕБОР и
// ПЕРЕИМЕНОВАНИЕ — одна и та же операция, и две копии правила расходились: в
// одной был guard «старый == новый», в другой — нет. Правило должно быть одно.
//
// Перебор групп и вопрос «мой ли этот адрес» — в мосте
// (`groups_rename_address`): сравнение адресов — форма, у которой один
// носитель (`identity` ядра). Прежний перебор жил здесь и сравнивал
// `toLowerCase()`: обрамление не срезалось, и группа с « me@old.com » в
// составе под переименование не попадала.
async function renameMeInGroups(oldEmail, newEmail) {
  return await invoke('groups_rename_address', { oldEmail, newEmail });
}

export async function migrateOwnGroups(oldEmail, newEmail) {
  if (!oldEmail || !newEmail || oldEmail === newEmail) return;
  try {
    const n = await renameMeInGroups(oldEmail, newEmail);
    console.log('[identity] own groups renamed:', oldEmail, '→', newEmail, '(' + n + ')');
  } catch (e) {
    console.warn('[identity] migrateOwnGroups failed:', e);
  }
}

// ── Переносы при смене почты (ADR-003 Этап 3, партия 9) ───────────────
// Все три переехали сюда по одной причине: это миграции идентичности, и лежать
// им надолго в компоненте не место. Побочный эффект переноса — ВИДИМОЕ
// дублирование: migratePeerGroups и migrateOwnGroups (выше) зовут одну и ту же
// команду моста (`groups_rename_address`). Разница только в возврате (счётчик
// против ничего) и перезагрузке списка. НЕ СЛИТО: слияние меняет семантику
// вызова (migrateOwnGroups не перечитывает список), а это не перемещение.
// Решение вынесено в ADR-003 §5.

// Ключ ЧАТА С СОБЕСЕДНИКОМ (chat-cache:<email пира>) переименовывается, когда
// сменил почту ПИР, а не мы. Поэтому account идёт через резолвер (identity =
// fp:<fingerprint>), а пир остаётся почтой: она транспорт, и в ключе чата.
//
// ЗАНЯТАЯ ЦЕЛЬ — НЕ ОТКАЗ. Два адреса одного ключа — это ОДИН собеседник, а
// кэш у каждого свой: на X50 (24.10) переписка жила и под koanmak@gmail.com,
// и под vault-msg@ya.ru. Прежнее правило («цель занята — не трогаем») молча
// оставляло половину разговора под старым адресом, а старый адрес из списка
// контактов к этому моменту уже исчезал. Поэтому списки СЛИВАЮТСЯ тем же
// правилом, что и архив (mergeHistoryLists: свежие выигрывают, остальные
// остаются), и только тогда старый ключ удаляется.
export async function migrateChatHistory(oldEmail, newEmail, myEmail) {
  try {
    const ns = myEmail ? await accountNamespace(myEmail) : 'anon';
    const oldKey = 'chat-cache:' + oldEmail;
    const newKey = 'chat-cache:' + newEmail;
    const oldCache = await db.kvGet(ns, oldKey);
    if (!oldCache) return false;
    const existing = await db.kvGet(ns, newKey);
    let value = oldCache;
    if (existing) {
      const from = parseCache(oldCache), to = parseCache(existing);
      // Нечитаемый кэш — основание ОТКАЗАТЬСЯ, а не писать пустой список:
      // перенос не имеет права уничтожить переписку.
      if (!Array.isArray(from) || !Array.isArray(to)) return false;
      value = JSON.stringify(mergeHistoryLists(from, to));
    }
    await db.kvSet(ns, newKey, value);
    await db.kvDelete(ns, oldKey);
    console.log('[identity] chat history migrated:', oldEmail, '→', newEmail);
    return true;
  } catch (e) {
    console.warn('[identity] migrateChatHistory failed:', e);
    return false;
  }
}

// Кэш чата — JSON-список. Нечитаемый (или не список) — не основание терять
// запись: возвращаем null, вызывающий отказывается от переноса.
function parseCache(raw) {
  try {
    return normalizeHistoryList(JSON.parse(raw));
  } catch (e) {
    return null;
  }
}

// Профиль переносится ТОЛЬКО из пустых полей в существующий целевой: пустой
// avatar не должен затирать уже загруженный. Возвращает ключ и профиль, чтобы
// компонент обновил шапку — иначе логика и отображение снова слиплись бы.
export async function migrateOwnProfile(oldEmail, newEmail) {
  try {
    const profiles = JSON.parse((await db.kvGet('anon', 'profiles')) || '{}');
    const old = String(oldEmail).toLowerCase();
    const neu = String(newEmail).toLowerCase();
    if (!profiles[old] || old === neu) return null;
    if (!profiles[neu]) {
      profiles[neu] = Object.assign({}, profiles[old]); // копия целиком
    } else {
      // Цель есть — заполняем только пустые/отсутствующие поля из
      // старого (пустой avatar не затирает новый).
      const dst = profiles[neu];
      const src = profiles[old];
      for (const k of Object.keys(src || {})) {
        const cur = dst[k];
        const val = src[k];
        if ((cur === undefined || cur === null || cur === '')
          && val !== undefined && val !== null && val !== '') {
          dst[k] = val;
        }
      }
    }
    await db.kvSet('anon', 'profiles', JSON.stringify(profiles));
    console.log('[identity] own profile migrated:', old, '→', neu);
    return { key: neu, profile: profiles[neu] };
  } catch (e) {
    console.warn('[identity] migrateOwnProfile failed:', e);
    return null;
  }
}

// Перебор групп, где мы создатель или участник. Возвращает число переименованных
// и зовёт onRenamed, если что-то поменялось: вызывающий обязан перечитать список,
// иначе он останется со старыми адресами на экране.
export async function migratePeerGroups(oldEmail, newEmail, onRenamed) {
  if (!oldEmail || !newEmail) return 0;
  let n = 0;
  try {
    n = await renameMeInGroups(oldEmail, newEmail);
    if (n) {
      console.log('[identity] peer groups renamed:', oldEmail, '→', newEmail, '(' + n + ')');
      if (onRenamed) { try { await onRenamed(); } catch (e) { /* перечитаем позже */ } }
    }
  } catch (e) {
    console.warn('[identity] migratePeerGroups failed:', e);
  }
  return n;
}

// ── Потребитель contactAliases: перенос истории по ВСЕЙ цепочке ─────────
//
// ЗАЧЕМ. migrateChatHistory переносит РОВНО ОДИН ключ: chat-cache:<старый> →
// chat-cache:<новый>. Этого хватает, пока адрес менялся один раз. Если пир менял
// почту дважды (a → b → c), а приложение не работало в момент первого перехода,
// то при обнаружении c мы перенесём chat-cache:c (пусто) и вернём false, а
// chat-cache:a останется осиротевшим. Человек останется в списке контактов, но
// вся переписка с ним исчезнет из кэша — молча, без единого признака.
//
// ИМЕННО ДЛЯ ЭТОГО и считаются алиасы в contacts-load. Форма там ЦЕПОЧКА
// ({b: [a], c: [b]}), и это не дефект: чтобы найти все прежние адреса, цепочку
// надо обойти. Плоский список дал бы то же самое, но требовал бы хранить
// дубликаты при каждом переименовании.
//
// ПОРЯДОК — В ШИРИНУ, БЛИЖАЙШИЙ ПЕРВЫМ. Если цепочка a → b → c, обход даёт сначала
// b, потом a. Перенос b → c первым кладёт в цель историю последнего адреса, а
// перенос a → c доливает к ней более старые записи тем же mergeHistoryLists:
// при совпадении ключа сообщения выигрывает ЦЕЛЬ (b), то есть более свежий адрес.
// Каждый успешно слитый ключ после этого удаляется, поэтому осиротевших кэшей в
// цепочке не остаётся; в `orphans` попадают только адреса, где кэша не было или
// он нечитаем.
//
// КЛЮЧИ АЛИАСОВ НЕ НОРМАЛИЗОВАНЫ. contacts-load пишет c.email как есть, то есть
// регистр может быть любой. Поэтому индекс строится в нижнем регистре, иначе
// перенос молча не нашёл бы алиас при адресе вида Ann@bk.ru.

export async function migrateChatHistoryChain(newEmail, myEmail, contactAliases) {
  const want = String(newEmail || '').toLowerCase();
  // Индекс алиасов в нижнем регистре: сырые ключи не нормализованы.
  const idx = new Map();
  for (const [k, v] of Object.entries(contactAliases || {})) {
    idx.set(String(k).toLowerCase(), (v || []).map(x => String(x)));
  }
  // Обход в ширину: ближайший предшественник идёт первым.
  const order = [];
  const seen = new Set([want]);
  const queue = [want];
  while (queue.length) {
    const cur = queue.shift();
    for (const old of idx.get(cur) || []) {
      const k = String(old).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      order.push(old);
      queue.push(k);
    }
  }
  const moved = [];
  const orphans = [];
  for (const old of order) {
    // eslint-disable-next-line no-await-in-loop
    if (await migrateChatHistory(old, newEmail, myEmail)) moved.push(old);
    else orphans.push(old);
  }
  if (moved.length) {
    console.log('[identity] chat history migrated along alias chain:',
      moved.join(', '), '→', newEmail);
  }
  if (orphans.length) {
    // Не ошибка: ключа не было или он уже занят. Но адреса названы, чтобы потеря
    // переписки была видна в логе, а не обнаруживалась по отсутствию сообщений.
    console.log('[identity] alias-chain addresses without cache (kept, not deleted):',
      orphans.join(', '));
  }
  return { moved, orphans, order };
}
