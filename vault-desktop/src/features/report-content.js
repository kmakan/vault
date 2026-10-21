// Жалоба на контент: сборка письма (ADR-003 Этап 3, партия 12).
//
// В App.vue остаётся диалог ввода и открытие ссылки — это UI. Здесь только
// текст жалобы, и он уходит по почте в support@vault-msg.ru, то есть покидает
// устройство, поэтому его форма — тоже контракт, а не черновик.
//
// ТРИ ФАКТА, КОТОРЫЕ ЛЕГКО ПОТЕРЯТЬ ПРИ ПЕРЕНОСЕ:
//
// 1. ВРЕМЯ ИЩЕТСЯ ПО ТРЁМ ПОЛЯМ ПОДРЯД: msg.time, затем msg.created_at, затем
//    msg.date. Это не избыточность, а эволюция хранилища: письма, написанные
//    в разные годы, лежат с разными именами поля. Жалоба без времени («-»)
//    бесполезна сама по себе, поэтому подстановка сделана в момент жалобы, а не
//    в момент сохранения.
//
// 2. ПУСТОЕ ЗНАЧЕНИЕ ТИПА ЖАЛОБЫ → ПРОПУСК: пользователь нажал Enter, не
//    введя ничего, и строка «Тип: -» честнее строки «Тип: » с хвостом.
//
// 3. ПУСТОЙ ИДЕНТИФИКАТОР НЕ ПОДСТАВЛЯЕТСЯ: msg.id || '-'. В идентификаторе
//    прочерк честнее, чем 'undefined'.

// Время сообщения для жалобы: три поля подряд, последнее — прочерк.
export function messageTimeOf(msg) {
  return msg.time || msg.created_at || msg.date || '-';
}

// Строки жалобы. t — переводчик компонента; он может вернуть undefined на
// незнакомый ключ, поэтому у каждой строки есть запасной русский текст: это
// поведение оригинала, и молчаливая подмена на пустую строку сделала бы письмо
// бессмысленным.
export function buildReportLines({ type, msg, sender }, t) {
  const tr = (key, fallback) => (t(key) || fallback);
  return [
    tr('report_content_type', 'Тип') + ': ' + (String(type).trim() || '-'),
    tr('report_content_sender', 'Email отправителя') + ': ' + sender,
    tr('report_content_time', 'Время') + ': ' + messageTimeOf(msg),
    tr('report_content_msg_id', 'ID сообщения') + ': ' + (msg.id || '-'),
  ];
}

// mailto со собранным текстом. Адрес поддержки зашит в коде — он не меняется от
// пользователя и не должен приходить из настроек.
export function buildReportMailto(subject, lines) {
  return 'mailto:support@vault-msg.ru?subject=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(lines.join('\n'));
}

// Поток жалобы на контент: спрашиваем тип, собираем письмо и открываем
// почтовое приложение. Отмена пользователя (null из prompt) — не ошибка.
export async function reportMessageContent(deps, msg) {
  const type = await deps.prompt(
    deps.tr('report_content_prompt') || 'Тип жалобы (спам / оскорбления / другое):',
    'спам');
  if (type === null) return; // отмена
  const sender = deps.msgSenderEmail(msg)
    || (deps.activeChatType() === 'chat' ? deps.activeChat() : '')
    || '-';
  const tr = (k) => deps.tr(k);
  const lines = buildReportLines({ type, msg, sender }, tr);
  const url = buildReportMailto(
    deps.tr('report_content_subject') || 'Жалоба на контент — Vault', lines);
  await deps.openExternalUrl(url);
}
