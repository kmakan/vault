// Сборка данных для wire-конверта — ADR-005 W3 (финальная партия W3).
//
// САМА СБОРКА КОНВЕРТА — В ЯДРЕ (vault::envelope::build, ADR-005 W4). Здесь
// только ДАННЫЕ, которые ядро превратит в конверт.
//
// ПРАВИЛА, КОТОРЫЕ ЛЕГКО ПОТЕРЯТЬ (и из-за которых письма уезжали со старым
// именем или старым аватаром):
//
//  * НЕ СЛАТЬ EMAIL КАК ИМЯ. Получатель считает name==email «нет имени» (см.
//    nameOf) — иначе он перезаписывает настоящее имя почтой.
//  * АКТУАЛЬНЫЙ АВАТАР ИЗ KV. this.profiles в памяти может отставать; иначе
//    сообщение уходит со СТАРЫМ аватаром и получатель перезаписывает новый.
//  * GAVATAR — ТОЛЬКО ДЛЯ ГРУППОВОГО СООБЩЕНИЯ (иначе в конверте лишний
//    аватар группы). Конверт группы шифруется групповым ключом — это не
//    раскрытие членства.
//  * TTL — в секундах от момента ПРОСМОТРА получателем (0 = обычное
//    сообщение).
//  * RELAY-ТОКЕН — адрес моей очереди: получатель молча сохранит его и сможет
//    слать мне мгновенные пуши.
//
// deps (ADR-001 R3): всё, что нужно снаружи, — явными параметрами.
import api, { db } from '../api.js';
import crypto from '../crypto.js';

export async function buildEnvelope(deps, text, ttl = 0) {
  const dn = deps.displayName() || (await api.getDisplayName()) || '';
  // Не слать email как имя: получатель считает name==email «нет имени»
  // (см. nameOf) — иначе он перезаписывает настоящее имя почтой.
  const name = dn && dn !== deps.email() ? dn : '';
  // Актуальный аватар из kv — this.profiles
  // в памяти может отставать; иначе сообщение уходит со СТАРЫМ аватаром
  // и получатель перезаписывает новый.
  let avatar = ((deps.profiles()[deps.email()] || {}).avatar) || '';
  try {
    const kvProfiles = JSON.parse((await db.kvGet('anon', 'profiles')) || '{}');
    const kp = kvProfiles[String(deps.email()).toLowerCase()];
    if (kp && kp.avatar) avatar = kp.avatar;
  } catch (e) { /* ignore */ }
  avatar = await deps.shrinkAvatar(avatar);
  // Самовосстановление аватарки группы: конверт несёт gavatar — аватар
  // ТЕКУЩЕЙ группы (групповое сообщение шлётся только в активной группе).
  // Только для группового чата (иначе gavatar отсутствует). Пустой kv —
  // пустая строка (на приёме пусто игнорируется, guard там). Конверт
  // группы шифруется групповым ключом — это не раскрытие членства.
  let gavatar = '';
  if (deps.activeChatType() === 'group' && deps.currentGroup()) {
    try { gavatar = (await db.kvGet('anon', 'group-avatar:' + deps.currentGroup().id)) || ''; }
    catch (e) { gavatar = ''; }
  }
  // PQ: свой ML-KEM ek — получатель сохранит контакт и сможет
  // ответить гибридом (конверт несёт оба публичных ключа).
  const pqEk = crypto.pqEk || null;
  // M2.4 АВТООБМЕН токенами: конверт несёт мой relay read-токен —
  // адрес моей очереди. Получатель молча сохранит его и сможет
  // слать мне мгновенные пуши. Пользователь ничего не вводит.
  // Гейт this.relayEnabled СНЯТ (как в calls.js sendCallEnvelope):
  // адрес нашей очереди нужен собеседнику независимо от нашего
  // переключателя — иначе выключенный релей у одного ломает обмен.
  let tok = null;
  try {
    const { relays, active } = await (await import('../relay-client.js')).getSettings(deps.email());
    tok = ((relays[active] || relays[0]) || {}).myToken || null;
  } catch (e) { /* релей опционален */ }
  // Исчезающие сообщения: ttl в секундах от момента ПРОСМОТРА
  // получателем. 0 = обычное сообщение. Получатель ставит локальный
  // таймер удаления после показа (expireEphemeral).
  return deps.buildEnvelope({
    id: deps.newMessageId(),
    text,
    name,
    avatar,
    gavatar: gavatar || null,
    key: crypto.publicKey || '',
    pqEk,
    tok,
    ttlSecs: Number(ttl) || 0,
    tsMs: Date.now(),
  });
}
