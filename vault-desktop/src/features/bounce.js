// Feature module: служебные письма о НЕДОСТАВКЕ (DSN / bounce).
//
// Инцидент 12.10.2026. Яндекс начал отбивать наши письма-вызовы на SMTP
// («554 5.7.1 Message rejected under suspicion of SPAM»), Gmail возвращал их
// отправителю как DSN (From: Mail Delivery Subsystem <mailer-daemon@…>), но
// приложение их не разбирало: classify() отбрасывает всё, что не является
// нашим шифртекстом. Итог — вызов висел в гудках все 5 минут и заканчивался
// «нет ответа», хотя письмо вообще НЕ ушло. Теперь баунс = мгновенная отмена
// исходящего вызова к этому адресату (см. calls.js: onMailBounce).
//
// Чистые функции без побочных эффектов: побочные — в calls.js, которая
// знает state machine звонка.
//
// ВАЖНО про входные данные: клиент получает от Rust `RFC822.TEXT` — тело БЕЗ
// заголовков письма (email.rs: fetch_message_body → session.fetch(RFC822.TEXT)).
// Поэтому X-Failed-Recipients (он в заголовках DSN) здесь недостижим, а
// опираемся мы на поля RFC 3464 внутри тела, которые Gmail/Яндекс пишут
// 7bit-текстом:
//   Final-Recipient: rfc822; koanmak@ya.ru
//   Status: 5.7.1
//   Diagnostic-Code: smtp; 554 5.7.1 Message rejected under suspicion of SPAM
// Проверено на реальных баунсах Gmail (uid 8462/8463, INBOX) — см.
// docs/CALL-MAIL-PATH-DIAGNOSIS.md.

// Отправитель-«почтальон». Gmail: MAILER-DAEMON@googlemail.com,
// Яндекс: MAILER-DAEMON@yandex.ru, Мейл.ру: postmaster@…,
// Exchange: MicrosoftExchange… + mailer-daemon.
const DAEMON_RE =
  /(mailer-daemon|mail-daemon|maildeliverysystem|mail delivery (subsystem|system)|postmaster)/i;

// Тема служебного письма — независимая зацепка: у части провайдеров
// отправитель не mailer-daemon, а тема всё равно говорящая.
const DSN_SUBJECT_RE =
  /(delivery status notification|undelivered mail|undeliverable|delivery failure|delivery has failed|failure notice|returned mail|return to sender|mail delivery failed|delivery report|не доставлено|ошибка доставки|возврат письма|сообщение не доставлено)/i;

// Получатель, которому не доставили. Порядок — от машинных полей RFC 3464
// к заголовку вложенного оригинала. Все — с якорем на начало строки, чтобы
// не поймать случайное совпадение в тексте.
const FINAL_RECIPIENT_RE =
  /^[ \t]*(?:final|original)-recipient:[ \t]*(?:rfc822[ \t]*;[ \t]*)?([^\s;]+@[^\s;]+)/im;
const FAILED_RECIPIENTS_RE = /^[ \t]*x-failed-recipients:[ \t]*(.+)$/im;
const FOR_RE = /\bfor[ \t]+<([^\s<>@]+@[^\s<>]+)>/i;
const BODY_TO_RE = /^[ \t]*(?:to|кому)[ \t]*:[ \t]*([^\s,;<]*@[^\s,;>]+)/im;
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Причина: Diagnostic-Code (RFC 3464) → Status → строка с SMTP-кодом.
const DIAGNOSTIC_RE = /^[ \t]*diagnostic-code:[ \t]*(?:smtp[ \t]*;[ \t]*)?(.+)$/im;
const STATUS_RE = /^[ \t]*status:[ \t]*([245]\.[0-9]+\.[0-9]+)/im;
const SMTP_CODE_RE = /\b(?:[245][0-9]{2})[ -](?:[0-9]+\.[0-9]+\.[0-9]+)[ \t]+[^\n\r]{4,160}/;

function uniqLower(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const v = String(item || '').trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Похоже ли письмо на служебное уведомление о недоставке (DSN). */
export function isBounceMessage(from, subject) {
  const f = String(from || '');
  const s = String(subject || '');
  return DAEMON_RE.test(f) || DSN_SUBJECT_RE.test(s);
}

/**
 * Адреса, которым НЕ доставили (в порядке надёжности источника).
 * Возвращает массив в нижнем регистре; пустой массив = не распознали.
 */
export function bounceRecipients(body) {
  const text = String(body || '');
  const found = [];

  const final = text.match(FINAL_RECIPIENT_RE);
  if (final) found.push(final[1]);

  const failed = text.match(FAILED_RECIPIENTS_RE);
  if (failed) {
    const list = failed[1].match(EMAIL_RE);
    if (list) found.push(...list);
  }

  // Заголовок вложенного оригинала (часть text/rfc822-headers у Gmail:
  // «for <koanmak@ya.ru>» / «To: koanmak@ya.ru»). Фолбэк: срабатывает,
  // когда провайдер не дал машинных полей.
  const forMatch = text.match(FOR_RE);
  if (forMatch) found.push(forMatch[1]);

  const toMatch = text.match(BODY_TO_RE);
  if (toMatch) found.push(toMatch[1]);

  return uniqLower(found);
}

/** Короткая человекочитаемая причина отбоя (для тоста/лога). */
export function bounceReason(body) {
  const text = String(body || '');
  const diag = text.match(DIAGNOSTIC_RE);
  if (diag) return squash(diag[1]);
  const smtp = text.match(SMTP_CODE_RE);
  if (smtp) return squash(smtp[0]);
  const status = text.match(STATUS_RE);
  if (status) return 'Status ' + status[1];
  return '';
}

function squash(line) {
  return String(line || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}
