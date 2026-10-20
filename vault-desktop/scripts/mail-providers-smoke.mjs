// Node-смоук src/mailProviders.js — каталог настроек IMAP/SMTP.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Каталог — это то, чем заполняются поля входа:
// выбрал провайдера → получил imap/smtp хост и порт. Ошибка здесь = невозможно
// войти (или письма уходят не туда). Плюс три правила определения:
//   * по сохранённому IMAP-хосту (после перезапуска селект должен показать
//     выбранного провайдера, а не «Другой»);
//   * по домену email (kmakan@zoho.com → zoho);
//   * консервативный лимит вложений (лимит ФАЙЛА, а не письма).
import {
  MAIL_PROVIDERS, CUSTOM_PROVIDER_ID, findProvider,
  detectProviderByServer, detectProviderByEmail, getAttachmentLimitMb,
} from '../src/mailProviders.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

// ── Целостность каталога ────────────────────────────────────────────────
ok('каталог не пуст', Array.isArray(MAIL_PROVIDERS) && MAIL_PROVIDERS.length >= 5, MAIL_PROVIDERS.length);
ok('id провайдеров уникальны',
  new Set(MAIL_PROVIDERS.map((p) => p.id)).size === MAIL_PROVIDERS.length);
ok('у каждого провайдера есть imap/smtp хост и порты',
  MAIL_PROVIDERS.every((p) => p.imap_server && p.imap_port && p.smtp_server && p.smtp_port),
  MAIL_PROVIDERS.filter((p) => !(p.imap_server && p.imap_port && p.smtp_server && p.smtp_port)).map((p) => p.id));
ok('IMAP-порт — 993 у всех (TLS)', MAIL_PROVIDERS.every((p) => p.imap_port === 993),
  MAIL_PROVIDERS.filter((p) => p.imap_port !== 993).map((p) => p.id));
ok('у каждого провайдера есть список доменов', MAIL_PROVIDERS.every((p) => Array.isArray(p.domains) && p.domains.length));
ok('домены уникальны между провайдерами',
  (() => {
    const all = MAIL_PROVIDERS.flatMap((p) => p.domains);
    return new Set(all).size === all.length;
  })(), MAIL_PROVIDERS.flatMap((p) => p.domains));
ok('лимит вложений у всех положительный',
  MAIL_PROVIDERS.every((p) => typeof p.max_attachment_mb === 'number' && p.max_attachment_mb > 0));

// ── Поиск по id ──────────────────────────────────────────────────────────
ok('findProvider("gmail") найден', findProvider('gmail')?.id === 'gmail');
ok('findProvider("нет") → null (не подмена)', findProvider('нет') === null);
ok('findProvider(undefined) → null', findProvider(undefined) === null);
ok('CUSTOM_PROVIDER_ID = custom', CUSTOM_PROVIDER_ID === 'custom');

// ── Определение по IMAP-хосту ───────────────────────────────────────────
ok('по imap.gmail.com → gmail', detectProviderByServer('imap.gmail.com') === 'gmail');
ok('регистр хоста не важен', detectProviderByServer('IMAP.Gmail.COM') === 'gmail');
ok('пробелы обрезаются', detectProviderByServer('  imap.gmail.com  ') === 'gmail');
ok('неизвестный хост → custom', detectProviderByServer('imap.example.org') === 'custom');
ok('пустой хост → пустая строка (не custom: хоста нет вовсе)',
  detectProviderByServer('') === '', detectProviderByServer(''));

// ── Определение по домену ───────────────────────────────────────────────
ok('zoho.com → zoho', detectProviderByEmail('kmakan@zoho.com') === 'zoho');
ok('zoho.eu → zoho (домен из списка)', detectProviderByEmail('a@zoho.eu') === 'zoho');
ok('gmail.com → gmail', detectProviderByEmail('a@gmail.com') === 'gmail');
ok('неизвестный домен → пустая строка', detectProviderByEmail('a@example.org') === '');
ok('пустой email → пустая строка', detectProviderByEmail('') === '');
ok('адрес без @ → пустая строка', detectProviderByEmail('nonsense') === '');
ok('регистр домена не важен', detectProviderByEmail('A@ZOHO.COM') === 'zoho');

// ── Лимит вложений по email ──────────────────────────────────────────────
ok('для gmail — лимит каталога (25 МБ)', getAttachmentLimitMb('a@gmail.com') === 25, getAttachmentLimitMb('a@gmail.com'));
ok('для yandex — 30 МБ', getAttachmentLimitMb('a@yandex.ru') === 30);
ok('для неизвестного домена — консервативные 25 МБ', getAttachmentLimitMb('a@example.org') === 25);
ok('для пустого адреса — 25 МБ', getAttachmentLimitMb('') === 25);

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
