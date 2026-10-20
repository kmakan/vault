// Node-смоук src/features/bounce.js — разбор служебных писем о недоставке.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. По разбору баунса приложение ОТМЕНЯЕТ исходящий
// вызов (calls.js: onMailBounce) — и только если релей не подтвердил
// доставку. Ошибка здесь стоит пользователю звонка:
//
//   * баунс не распознан → вызов висит в гудках все 5 минут и заканчивается
//     «нет ответа», хотя письмо вообще не ушло (инцидент 12.10.2026);
//   * баунс распознан ЛИШНЕ → вызов отменяется, хотя собеседник получил его
//     релеем (тот же инцидент: релей доставил, почту отбило как спам).
//
// ПРОВЕРЯЕМ: признак баунса (отправитель-почтальон ИЛИ говорящая тема),
// извлечение адресата (по убыванию надёжности источников), причину отбоя
// (Diagnostic-Code → SMTP-код → Status), нижний регистр и дедупликацию.
import { isBounceMessage, bounceRecipients, bounceReason } from '../src/features/bounce.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

// Реальное тело баунса (Gmail/Яндекс), как в docs/CALL-MAIL-PATH-DIAGNOSIS.md.
const BODY_YANDEX = [
  'Final-Recipient: rfc822; koanmak@ya.ru',
  'Action: failed',
  'Status: 5.7.1',
  'Diagnostic-Code: smtp; 554 5.7.1 Message rejected under suspicion of SPAM',
].join('\n');

// ── Признак баунса ───────────────────────────────────────────────────────
ok('почтальон mailer-daemon → баунс', isBounceMessage('MAILER-DAEMON@googlemail.com', 'Delivery Status Notification') === true);
ok('почтальон postmaster → баунс', isBounceMessage('postmaster@mail.ru', '') === true);
ok('говорящая тема без почтальона → баунс', isBounceMessage('somebody@example.org', 'Undelivered Mail Returned to Sender') === true);
ok('русская тема о недоставке → баунс', isBounceMessage('somebody@example.org', 'Письмо не доставлено') === true);
ok('обычный отправитель и обычная тема → не баунс',
  isBounceMessage('friend@example.org', 'Привет') === false);
ok('пустые отправитель и тема → не баунс', isBounceMessage('', '') === false);

// ── Адресаты ─────────────────────────────────────────────────────────────
{
  const r = bounceRecipients(BODY_YANDEX);
  ok('Final-Recipient разобран', r.length === 1 && r[0] === 'koanmak@ya.ru', r);
}
{
  const body = 'X-Failed-Recipients: first@x.ru, second@y.ru';
  const r = bounceRecipients(body);
  ok('X-Failed-Recipients разобран (все адреса)', r.length === 2 && r[0] === 'first@x.ru' && r[1] === 'second@y.ru', r);
}
{
  const body = 'Original-Message-ID: <x>\nFor <koanmak@ya.ru>';
  const r = bounceRecipients(body);
  ok('заголовок вложенного оригинала «for <…>» разобран', r.includes('koanmak@ya.ru'), r);
}
{
  const body = 'To: koanmak@ya.ru';
  const r = bounceRecipients(body);
  ok('поле «To:» разобрано', r.includes('koanmak@ya.ru'), r);
}
{
  const r = bounceRecipients('Final-Recipient: rfc822; KoanMak@Ya.RU');
  ok('адрес нормализован в нижний регистр', r.length === 1 && r[0] === 'koanmak@ya.ru', r);
}
{
  const body = 'Final-Recipient: rfc822; dup@x.ru\nFor <dup@x.ru>';
  const r = bounceRecipients(body);
  ok('дубли адресов убраны', r.length === 1 && r[0] === 'dup@x.ru', r);
}
{
  const r = bounceRecipients('Здравствуйте! Письмо не доставилось.');
  ok('в обычном тексте адрес не выдумывается', r.length === 0, r);
}
ok('пустое тело → пустой список', bounceRecipients('').length === 0);
ok('тело без адресов → пустой список', bounceRecipients('Final-Recipient: rfc822; не-адрес').length === 0);

// ── Причина отбоя ────────────────────────────────────────────────────────
{
  const reason = bounceReason(BODY_YANDEX);
  ok('причина взята из Diagnostic-Code', /rejected under suspicion of SPAM/i.test(reason), reason);
  ok('причина не длиннее 300 символов', reason.length <= 300, reason.length);
}
{
  // Тело ТОЛЬКО с Diagnostic-Code: иначе сработает запасной путь (SMTP-код /
  // Status) и проверка не отличит правильный разбор от неправильного.
  const onlyDiag = 'Diagnostic-Code: smtp; 554 5.7.1 Message rejected under suspicion of SPAM';
  const reason = bounceReason(onlyDiag);
  // Тело с Diagnostic-Code, в котором НЕТ SMTP-кода: так различаются
  // источники — по Diagnostic-Code причина = 'mailer-daemon; internal error',
  // а запасной путь (SMTP-код) здесь не срабатывает вовсе. С телом вида
  // '554 5.7.1 …' оба пути дают одинаковый текст, и проверка ничего не
  // различает (класс «два инварианта в одном сценарии»).
  const onlyDiagNoCode = 'Diagnostic-Code: mailer-daemon; internal error';
  const r2 = bounceReason(onlyDiagNoCode);
  ok('причина из Diagnostic-Code, когда больше ничего нет',
    /mailer-daemon; internal error/i.test(r2), r2);
}
{
  const reason = bounceReason('SMTP 550 5.1.1 User unknown in relay recipient table');
  ok('причина найдена по SMTP-коду', /550/.test(reason), reason);
}
{
  const reason = bounceReason('Status: 5.7.1');
  ok('причина найдена по Status', /Status 5\.7\.1/.test(reason), reason);
}
ok('в теле без признаков причина пустая', bounceReason('обычный текст') === '');
ok('пустое тело → причина пустая', bounceReason('') === '');

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
