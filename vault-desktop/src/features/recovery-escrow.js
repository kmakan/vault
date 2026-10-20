// Отправка эскроу-письма с ключом восстановления (ADR-003 Этап 3, партия 15).
//
// ЭТО САМЫЙ ОТВЕТСТВЕННЫЙ ПУТЬ В ПРИЛОЖЕНИИ. Пользователь отправляет сам себе
// мнемонический ключ — единственный способ вернуть доступ. Поэтому здесь
// правило строгое: СООБЩАТЬ ОБ УСПЕХЕ МОЖНО ТОЛЬКО УБЕДИВШИСЬ, что письмо
// ушло.
//
// ПРОВЕРКА РЕЗУЛЬТАТА РАНЬШЕ НИЧЕГО НЕ ЗАЩИЩАЛА. Было `if (res && res.ok ===
// false) throw`. Но Rust email_send возвращает Result<bool, String> и при
// отказе отдаёт Err — то есть invoke БРОСАЕТ, и до этой строки выполнение не
// доходит. Ok бывает только true. Условие res.ok === false было недостижимым:
// мёртвый код, создающий видимость защиты там, где защищал только бросок
// invoke. Если бы sendEmail когда-нибудь стал возвращать пустое значение при
// отказе, этот код сообщил бы пользователю «ключ сохранён» — а ключа нет.
//
// Теперь проверка значит то, что написано: успех есть ровно тогда, когда ok ===
// true. Сегодня поведение не меняется (единственная достижимая ветка — ok true),
// но защита перестаёт быть декоративной.
//
// ПОЧЕМУ ТОСТ ПРО СПАМ — НЕ КОСМЕТИКА. Провайдеры кладут служебные письма в
// спам, а Gmail удаляет спам примерно через 30 дней. Если человек не увидит
// это письмо и не переложит его во «Входящие», через месяц восстановление
// перестанет работать, и у него не останется ни ключа, ни переписки.
//
// Ключ recovery_spam_toast был заведён во всех трёх локалях, но не читался ни
// разу: русский текст был продублирован прямо в методе компонента. Английские
// и китайские пользователи получали самое важное предупреждение приложения
// по-русски. Соседние ключи (recovery_spam_folder, recovery_spam_move) из той же
// тройки в locateEscrow использовались как положено — то есть правило было
// соблюдено рядом и нарушено здесь.

import api from '../api.js';
import crypto from '../crypto.js';

// Ключ тоста берётся аргументом, а не импортируется: он принадлежит слою UI,
// и переводчик живёт в компоненте.
export async function sendEscrowEmail(accountEmail, mnemonic, spamToastKey) {
  const wrappedJson = await crypto.recoveryWrapBackup(mnemonic);
  const body = await crypto.recoveryBuildEscrowEmail(wrappedJson);
  const res = await api.sendEmail(accountEmail, {
    to: accountEmail,
    subject: '',
    body,
  });
  // Успех есть ровно тогда, когда ok === true. Всё остальное — отказ, даже если
  // это «просто» пустой объект: про «просто» здесь известно только из того, что
  // Rust так не делает сегодня.
  if (!res || res.ok !== true) {
    throw new Error('SMTP refused');
  }
  return { wrappedJson, spamToastKey };
}
// ── ADR-005 W3 (партия 12): поиск эскроу-письма в ящике ────────────────
// Эскроу-письмо лежит в спаме у большинства провайдеров, и Gmail удаляет
// спам примерно через 30 дней. Поэтому поиск ПОВТОРЯЕТСЯ (до 4 попыток) и
// находит письмо, даже если оно пришло не сразу.
//
// ПРАВИЛО ОДНО: найденное письмо с salt/nonce/wrapped, совпадающими с нашими,
// — это НАШЕ. Совпадение проверяется по всем трём полям сразу.
//
// ЕСЛИ ПИСЬМО ЛЕЖИТ НЕ В INBOX — копируем его туда (провайдер не удалит) и
// предупреждаем, что письмо нельзя удалять; если копирование не вышло —
// просим пользователя переложить его вручную. Иначе письмо, найденное в
// спаме, было бы «найдено» и через месяц молча пропало бы.
export async function locateEscrowFlow(deps, wrappedJson, attempt = 0) {
  const {
    email, fetchEmails, fetchBodies, parseEscrowEmail, copyToInbox,
    toast, t, warn, sleep, attempts = 4, delayMs = 5000,
  } = deps;
  if (attempt >= attempts) return false;
  await sleep(delayMs);
  try {
    let local = null;
    try { local = JSON.parse(wrappedJson); } catch { return false; }
    const msgs = await fetchEmails(email());
    const candidates = (msgs || []).filter((m) => !(m.subject || '').trim()).slice(0, 80);
    const byFolder = {};
    for (const m of candidates) (byFolder[m.folder] = byFolder[m.folder] || []).push(m);
    for (const [folder, list] of Object.entries(byFolder)) {
      const bodies = await fetchBodies(list.map((m) => String(m.uid)), folder);
      // uid берём ИЗ ПАРЫ тела: в оригинале копировался uid последнего
      // кандидата папки (m из внешнего цикла), а не найденного письма — то
      // есть копировалась НЕ ТА ПИСЬМО. Исправлено: копируем найденное.
      for (const [uid, body] of bodies || []) {
        const w = await parseEscrowEmail(body);
        if (!w) continue;
        let p = null;
        try { p = JSON.parse(w); } catch { continue; }
        if (p && p.salt === local.salt && p.nonce === local.nonce && p.wrapped === local.wrapped) {
          if (folder !== 'INBOX') {
            // Вариант A: автоматически копируем письмо во INBOX, чтобы
            // провайдер не удалил его из спама.
            try {
              await copyToInbox(String(uid), folder);
              toast(t('recovery_moved_toast'), 12000);
            } catch (e) {
              warn('escrow copy to inbox failed:', e);
              toast(t('recovery_spam_folder') + folder + t('recovery_spam_move'), 15000);
            }
          } else {
            toast(t('recovery_keep'), 8000);
          }
          return true;
        }
      }
    }
  } catch (e) {
    warn('escrow locate failed:', e);
  }
  return locateEscrowFlow(deps, wrappedJson, attempt + 1);
}
