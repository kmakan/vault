// Node-смоук src/providerLimits.js — лимиты вложений по провайдеру.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Модуль определяет, сколько МБ вложения примет
// почтовый сервер. Ошибка здесь не «красивая» — она стоит пользователю
// письма: файл 26 МБ у Gmail (лимит 25) уходит, но сервер его отбивает уже
// после шифрования и отправки; файл 24 МБ у того же Gmail молча отбрасывается
// приложением («слишком большой»), хотя провайдер бы взял.
//
// ПРОВЕРЯЕМ: определение провайдера по домену (включая googlemail/live/
// list.ru), выбор лимита, ФОРМАТИРОВАНИЕ размера, границу «ровно лимит»
// (проходит!) и предупреждение на 80%.
import { providerLimits, detectProvider, getLimit, formatBytes, checkFileSize } from '../src/providerLimits.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

// ── Определение провайдера по домену ────────────────────────────────────
ok('gmail.com → gmail', detectProvider('a@gmail.com') === 'gmail');
ok('googlemail.com → gmail (второй домен Google)', detectProvider('a@googlemail.com') === 'gmail');
ok('hotmail.com → outlook', detectProvider('a@hotmail.com') === 'outlook');
ok('live.com → outlook', detectProvider('a@live.com') === 'outlook');
ok('yandex.ru → yandex', detectProvider('a@yandex.ru') === 'yandex');
ok('mail.ru → mailru', detectProvider('a@mail.ru') === 'mailru');
ok('list.ru → mailru', detectProvider('a@list.ru') === 'mailru');
ok('неизвестный домен → custom', detectProvider('a@example.org') === 'custom');
ok('пустой адрес → custom', detectProvider('') === 'custom');
ok('адрес без @ → custom', detectProvider('nonsense') === 'custom');
ok('регистр домена не важен', detectProvider('A@GMail.COM') === 'gmail');

// ── Лимиты ──────────────────────────────────────────────────────────────
ok('лимит gmail — 25 МБ', getLimit('gmail').maxAttachment === 25 * 1024 * 1024, getLimit('gmail'));
ok('лимит outlook — 20 МБ', getLimit('outlook').maxAttachment === 20 * 1024 * 1024);
ok('неизвестный провайдер → conservative default (custom)', getLimit('nope').id === 'custom' || getLimit('nope').maxAttachment === 10 * 1024 * 1024, getLimit('nope'));
ok('в лимите есть предостережение (текст)', typeof getLimit('gmail').warning === 'string' && getLimit('gmail').warning.length > 0);
ok('у всех провайдеров maxTotal есть', Object.values(providerLimits).every((l) => typeof l.maxTotal === 'number' && l.maxTotal > 0));

// ── Форматирование ──────────────────────────────────────────────────────
ok('байты', formatBytes(512) === '512 B', formatBytes(512));
ok('килобайты с одним знаком', formatBytes(1536) === '1.5 KB', formatBytes(1536));
ok('мегабайты с одним знаком', formatBytes(25 * 1024 * 1024) === '25.0 MB', formatBytes(25 * 1024 * 1024));
ok('ровно 1 КБ → 1.0 KB', formatBytes(1024) === '1.0 KB', formatBytes(1024));

// ── Проверка размера файла ──────────────────────────────────────────────
const gmailLimit = 25 * 1024 * 1024;
ok('файл заметно меньше лимита — ок, без предупреждения',
  checkFileSize(1024, 'gmail').ok === true && !checkFileSize(1024, 'gmail').warning);
ok('РОВНО лимит проходит (проверка строгая на «больше»)',
  checkFileSize(gmailLimit, 'gmail').ok === true, checkFileSize(gmailLimit, 'gmail'));
ok('на байт больше лимита — отказ', checkFileSize(gmailLimit + 1, 'gmail').ok === false);
ok('в отказе есть текст с размером файла и предупреждением провайдера',
  /exceeds limit/.test(checkFileSize(gmailLimit + 1, 'gmail').message || '')
  && checkFileSize(gmailLimit + 1, 'gmail').limit === gmailLimit);
ok('в отказе указан сам лимит', checkFileSize(gmailLimit + 1, 'gmail').limit === gmailLimit);
ok('чуть выше 80% — предупреждение, но файл проходит',
  checkFileSize(Math.floor(gmailLimit * 0.85), 'gmail').ok === true
  && !!checkFileSize(Math.floor(gmailLimit * 0.85), 'gmail').warning,
  checkFileSize(Math.floor(gmailLimit * 0.85), 'gmail'));
ok('чуть ниже 80% — без предупреждения',
  !checkFileSize(Math.floor(gmailLimit * 0.5), 'gmail').warning);
ok('проверка идёт по лимиту ВЫБРАННОГО провайдера (outlook — 20 МБ)',
  checkFileSize(21 * 1024 * 1024, 'outlook').ok === false
  && checkFileSize(21 * 1024 * 1024, 'gmail').ok === true);

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
