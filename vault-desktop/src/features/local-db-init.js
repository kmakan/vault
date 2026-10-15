// Загрузка локальных кэшей при старте (ADR-003 Этап 3, партия 11).
//
// Здесь важна не длина, а одно правило, которое легко потерять при переносе:
// ПРИ ОТКАЗЕ БД КЭШИ НЕ ОБНУЛЯЮТСЯ. Модуль возвращает null в том поле, которое
// загрузить не удалось, и пустой массив там, где загрузилось и там правда пусто.
// Вызывающий присваивает только ненулевое. Спутать эти два состояния — значит
// при одном отказе Rust стереть то, что было загружено раньше, и сообщения
// перестали бы помечаться удалёнными навсегда (или, наоборот, «удалённые»
// начали бы вычисляться с нуля).

import { db } from '../api.js';
import { accountNamespace } from '../identity.js';

// Разбиение тумбстоунов на два кэша.
//
// Асимметрия ЗДЕСЬ СУЩЕСТВЕННА, а не опечатка: в одном кэше лежат Message-ID
// удалённых писем, в другом — mid (идентификаторы вложений). Запись вида
// ['msg-id', ''] даст непустой первый и пустой второй: она удаляла письмо, но
// не вложение, и второй кэш её не должен видеть. Проверка на истину, а не на
// наличие ключа, — ровно потому и написана так.
//
// Мутабельность: пары не копируются, берутся те же значения, что пришли из БД.
export function splitTombstones(tombs) {
  return {
    tombstones: tombs.filter(t => t[0]).map(t => t[0]),
    midTombstones: tombs.filter(t => t[1]).map(t => t[1]),
  };
}

// Возвращает { tombstones, midTombstones, cursors }; поле равно null, если его
// не удалось загрузить (и тогда вызывающий обязан оставить прежнее значение).
//
// account: для тумбстоунов это namespace аккаунта (fp:<отпечаток> — резолвер
// отдаёт legacy-емейл, пока ключ не загружен; это нормально, строки лежат в
// той же базе, а перенос делает ensureAccountNamespace сразу после). Для
// курсоров — литерал 'local': это id аккаунта, который отдаёт getEmailAccounts,
// и он НЕ связан с почтой, поэтому перенос на отпечаток его не касается.
// Разные пространства имён для одних и тех же строк — не опечатка.
export async function loadLocalCaches(email) {
  const accEmail = email ? await accountNamespace(email) : 'anon';
  const out = { tombstones: null, midTombstones: null, cursors: null };
  try {
    const tombs = await db.tombstonesLoad(accEmail);
    const split = splitTombstones(tombs);
    out.tombstones = split.tombstones;
    out.midTombstones = split.midTombstones;
  } catch (e) {
    console.warn('initLocalDb tombstones failed:', e);
  }
  try {
    out.cursors = await db.cursorsLoad('local');
  } catch (e) {
    console.warn('initLocalDb cursors failed:', e);
  }
  return out;
}