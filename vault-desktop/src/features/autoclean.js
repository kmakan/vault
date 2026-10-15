// Автоочистка старых писем (ADR-003 Этап 3, партия 13).
//
// Три решения, каждое из которых тихо ломает данные при неверной правке, и
// поэтому вынесено отдельно от кода, который эти решения применяет.
//
// ДАТЫ СЧИТАЮТСЯ ЗДЕСЬ. Колонка date — это сырой заголовок Date в формате
// RFC 2822, а не число. В SQL new Date() недоступен, поэтому отсечение
// обязано произойти в JS. Если формат заголовка изменится, отсечение надо
// будет чинить здесь, и только здесь — раньше это правило было размазано по
// двум выражениям в методе компонента.
//
// ПИСЬМА БЕЗ ДАТЫ НЕ ТРОГАЕМ. У них нельзя определить возраст, а «старое»
// при отсутствии даты — это всё подряд. Такие письма исключаются, а не
// трактуются как самые старые.
//
// ПИСЬМА БЕЗ ИДЕНТИФИКАТОРА ИСКЛЮЧАЮТСЯ. Ключ строится как folder + ':' + id.
// Если нет ни uid, ни id, ключ получается 'INBOX:' — и purge с таким ключом
// удалил бы по префиксу, то есть больше, чем задумано. Такие ключи отбрасываются
// явно. Обратите внимание на разницу: `m.uid ?? m.id` при пустой строке uid
// вернёт ПУСТУЮ СТРОКУ, а не перейдёт к id (?? ловит только null/undefined) —
// и такая письмо тоже отсеется, потому что ключ кончается на ':'.

import { db } from '../api.js';

// Период в днях. 'off' и всё неузнанное означают «не чистить».
export const PERIOD_DAYS = { '1d': 1, '7d': 7, '30d': 30, '365d': 365 };
const DAY_MS = 86400000;

export function periodDaysOf(period) {
  return PERIOD_DAYS[period] || 0;
}

export function autocleanCutoff(period, now = Date.now()) {
  return now - periodDaysOf(period) * DAY_MS;
}

// Ключ письма в индексах памяти и в аргументе purge.
export function messageKeyOf(m) {
  return (m.folder || 'INBOX') + ':' + String(m.uid ?? m.id ?? '');
}

// Ключи писем старше cutoff. Письма без даты и без идентификатора отброшены.
export function staleMessageKeys(emails, cutoff) {
  const keys = [];
  for (const m of emails || []) {
    if (!m || !m.date) continue;
    const t = new Date(m.date).getTime();
    if (!(t < cutoff)) continue;
    const k = messageKeyOf(m);
    if (k.endsWith(':')) continue;
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

// Чистка ЗЕРКАЛ ПАМЯТИ тем же списком, что ушёл в purge.
//
// Возвращает НОВЫЕ значения и не мутирует входные. Мутация на месте опасна
// здесь тем, что частичное применение (список обновили, кэш не успели) оставило
// бы память в состоянии, которого не существует: письмо исчезло бы из списка,
// но осталось в кэше тел и навсегда занимало место.
export function applyPurge(state, keys) {
  const staleSet = new Set(keys);
  const emailBodyCache = Object.assign({}, state.emailBodyCache || {});
  for (const k of keys) delete emailBodyCache[k];
  return {
    emails: (state.emails || []).filter((m) => !staleSet.has(messageKeyOf(m))),
    emailBodyCache,
    bodyCacheOrder: (state.bodyCacheOrder || []).filter((k) => !staleSet.has(k)),
  };
}

// Полная очистка: purge в БД и зеркала в памяти.
//
// state — те же зеркала, что у компонента (emails, emailBodyCache,
// bodyCacheOrder). state передаётся ЦЕЛИКОМ: applyPurge пересобирает каждое из
// трёх зеркал, и если передать не всё, недостающие вернутся пустыми и
// вызывающий СОТРЁТ их, подставив вместо пустого массива. Это уже случилось в
// первой версии этой функции — тест на это есть.
export async function runPurge(account, state, cutoff) {
  const keys = staleMessageKeys(state.emails, cutoff);
  if (!keys.length) return { purged: 0, keys, applied: null };
  const purged = await db.autocleanPurge(account, JSON.stringify(keys));
  return { purged, keys, applied: applyPurge(state, keys) };
}