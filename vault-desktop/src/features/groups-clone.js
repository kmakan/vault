// Клонирование группы: новая группа с тем же аватаром, ключом и составом.
//
// ADR-003 Этап 3, партия 6. Третья партия подхода «явная сигнатура». Здесь
// метод смешивал три разных слоя: собственно оркестрацию (создать, скопировать
// аватар, разослать инвайты), состояние компонента (groups, currentGroup,
// groupKeys, groupAvatars) и UI (prompt, alert, переводы). UI остаётся в
// App.vue — там ему место, и переносить его в модуль значило бы тащить переводы
// в слой, который о них не знает.
//
// ПОРЯДОК НАБЛЮДАЕМ, И ЭТО НЕ КОСМЕТИКА. В оригинале группа попадала в
// this.groups и в this.currentGroup ДО рассылки приглашений. Если применить
// состояние после цикла, пользователь увидит клон позже — на всё время инвайтов.
// Поэтому применение вынесено в колбэк onCreated и вызывается ровно там, где
// было в оригинале. Само рассылание состояние не читает, так что технически
// переставить можно было бы, но «можно» здесь не значит «нужно»: поведение
// пользователя не должно меняться от того, что метод переехал в модуль.
//
// ИНВАЙТ БЕЗ КЛЮЧА ПРОПУСКАЕТСЯ, А НЕ ПАДАЕТ. Участник без peerKey не
// получает инвайт, но и не ломает клонирование: собранные ключи считаются
// рациональным, неполный клон полезнее отказа. Список пропущенных возвращается
// наружу, чтобы UI показал его пользователю.

import api, { db } from '../api.js';
import crypto from '../crypto.js';

export async function cloneGroup({ src, name, email, peerKeys, publicKey, onCreated }) {
  const group = await api.createGroup(name.trim(), '');
  group.members = [{ email, role: 'Admin' }];
  group.blocked = [];
  const avatar = (await db.kvGet('anon', 'group-avatar:' + src.id)) || '';
  if (avatar) await db.kvSet('anon', 'group-avatar:' + group.id, avatar);
  // Применение состояния — здесь, до инвайтов: в оригинале клон появлялся в
  // списке и становился текущим до того, как пошли приглашения.
  if (onCreated) onCreated({ group, avatar });
  // Ключ группы: groups_create уже вернул group_key — без него шифрование
  // инвайтов и отправка в клон невозможны.
  const invited = [];
  const skipped = [];
  for (const m of (src.members || [])) {
    const em = (m.email || '').toLowerCase();
    if (!em || em === (email || '').toLowerCase()) continue;
    const peerPub = peerKeys[m.email] || peerKeys[em] || null;
    if (!peerPub) { skipped.push(m.email); continue; }
    try {
      const enc = await crypto.encryptGroupKeyForUser(group.group_key, peerPub);
      await api.inviteGroupMember(group.id, m.email, enc, publicKey);
      group.members.push({ email: m.email, role: m.role || 'Member', invited: true });
      invited.push(m.email);
    } catch (e) {
      skipped.push(m.email);
    }
  }
  // Группы персистятся на Rust-стороне (groups_create уже сохранил);
  // локальный members-массив — только для отображения invited-статуса.
  return { group, invited, skipped };
}
// ── ADR-005 W3 (партия 11): поток клонирования из UI ────────────────────
// Диалог (prompt имени), применение состояния, отчёт о приглашённых и
// пропущенных — в App.vue остались только вызовы. Клонировать может только
// создатель оригинала — это ответ моста (`groups_access.is_creator`), а не
// сравнение `src.created_by !== email` в JS: адрес сравнивался точно, поэтому
// создатель, чья запись записана в другом регистре, кнопку не получал.
export async function cloneGroupFlow(deps, { src }) {
  const {
    email, peerKeys, publicKey, promptName, closeSettings, applyCreated,
    onDone, onError, refreshGroupAccess,
  } = deps;
  const access = src ? await refreshGroupAccess() : null;
  if (!src || !access || !access.is_creator) return null;
  const base = (src.name || 'Группа').trim();
  const name = promptName(base + ' 2');
  if (!name || !name.trim()) return null;
  closeSettings();
  try {
    const { invited, skipped } = await cloneGroup({
      src, name, email, peerKeys, publicKey,
      onCreated: applyCreated,
    });
    onDone(invited, skipped);
    return { invited, skipped };
  } catch (e) {
    onError(e);
    return null;
  }
}
