// Восстановление сессии: разбор причины отказа (ADR-003 Этап 3, партия 16).
//
// Человек, которого выбросило из сессии, смотрит на эту форму. Значит проверяется
// не «правильно ли выбрана ветка», а получит ли он ОБЪЯСНЕНИЕ. Хуже всего
// пустое поле ошибки: форма выглядит как обычный вход, и человек не понимает,
// что произошло.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/restore-failure-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
// mailProviders.js — единственная реальная зависимость, и она чистая, поэтому
// подменять нечего: используем как есть.
let src = readFileSync(path.join(ROOT, 'src', 'features', 'restore-failure.js'), 'utf8');
src = src.replace("from '../mailProviders.js'", `from "${ROOT}/src/mailProviders.js"`);
writeFileSync(MOCKS + '/rf.mjs', src, 'utf8');
const R = await import(MOCKS + '/rf.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const t = (k) => ({ restore_failed_auth: 'AUTH', restore_failed_network: 'NET' }[k]);

console.log('\nADR-003 Этап 3, партия 16 · восстановление сессии');

// ── Причина → сообщение ────────────────────────────────────────────────
ok('auth → ключ auth', R.restoreErrorMessage('auth', t) === 'AUTH');
ok('ключ локали и запасной текст лежат в одной записи — развести их нельзя',
  R.RESTORE_ERRORS.auth.key === 'restore_failed_auth'
  && typeof R.RESTORE_ERRORS.auth.fallback === 'string'
  && R.RESTORE_ERRORS.auth.fallback !== R.RESTORE_ERRORS.generic.fallback);
ok('network → ключ network', R.restoreErrorMessage('network', t) === 'NET');

// Всё остальное — «не знаю», и обязано давать объяснение, а не пустоту.
for (const reason of [undefined, null, '', 'unknown-reason', 0, 'AUTH']) {
  const m = R.restoreErrorMessage(reason, t);
  ok('причина ' + JSON.stringify(reason) + ' → непустое объяснение',
    typeof m === 'string' && m.length > 0);
}
ok('неизвестная причина даёт ИМЕННО общий текст, а не auth',
  R.restoreErrorMessage('что-то ещё', t) === R.RESTORE_ERRORS.generic.fallback);

// Переводчик, у которого часть ключей неизвестна, — как настоящий t().
ok('неизвестный ключ → запасной русский текст',
  R.restoreErrorMessage('auth', () => undefined) === R.RESTORE_ERRORS.auth.fallback);
ok('переводчик вернул пустое → тоже запасной, а не пустая ошибка',
  R.restoreErrorMessage('auth', () => '') === R.RESTORE_ERRORS.auth.fallback);
ok('запасные тексты непустые — иначе поле ошибки окажется пустым',
  Object.values(R.RESTORE_ERRORS).map((e) => e.fallback).every((x) => typeof x === 'string' && x.length > 20));

// ── Конфигурация → поля формы ───────────────────────────────────────────
let f = R.restoreConfigFields({ imap_server: 'imap.gmail.com', imap_port: 993, smtp_server: 'smtp.gmail.com', smtp_port: 465 });
ok('хосты на месте', f.imapServer === 'imap.gmail.com' && f.smtpServer === 'smtp.gmail.com');

// ПОРТЫ ПРИВОДЯТСЯ К СТРОКЕ. Поля привязаны к текстовым <input> через v-model,
// и число в value означало бы, что дальше по коду сравнение с сохранённой
// конфигурацией расходилось бы молча.
ok('порт приходит строкой, не числом', f.imapPort === '993' && typeof f.imapPort === 'string');
ok('то же для smtp', f.smtpPort === '465' && typeof f.smtpPort === 'string');

f = R.restoreConfigFields({ imap_port: 0, smtp_port: 0 });
ok('порт 0 → пусто (нулевым портом не бывает)', f.imapPort === '' && f.smtpPort === '');

f = R.restoreConfigFields({});
ok('пустая конфигурация не падает, поля пустые',
  f.imapServer === '' && f.imapPort === '' && f.smtpServer === '' && f.smtpPort === '');

f = R.restoreConfigFields(null);
ok('null вместо конфигурации — тоже пустые поля, без исключения', f.imapServer === '');

// ── Показ секции настроек ──────────────────────────────────────────────
// Показывать её, когда исправлять нечего, — значит показать человеку две пустые
// строки и потребовать что-то исправить.
let st = R.buildRestoreFailureState('auth', { imap_server: 'imap.yandex.com', imap_port: 993 }, t);
ok('есть что показывать → секция настроек открыта', st.showServerSettings === true);
ok('провайдер восстановлен по IMAP-хосту', st.mailProvider === 'yandex');

st = R.buildRestoreFailureState('auth', {}, t);
ok('нечего показывать → секция настроек закрыта', st.showServerSettings === false);
ok('и селект провайдера пуст, а не выдуман', st.mailProvider === '');

st = R.buildRestoreFailureState('auth', { smtp_server: 'smtp.mail.ru' }, t);
ok('достаточно одного SMTP-хоста, чтобы открыть секцию', st.showServerSettings === true);
ok('но IMAP-хост пуст — значит и провайдера по нему нет', st.mailProvider === '');

// Неизвестный хост → кастомный провайдер, а не пустота: человек должен увидеть,
// что настройки свои.
st = R.buildRestoreFailureState('network', { imap_server: 'imap.мой-сервер.local' }, t);
ok('неизвестный хост → кастомный провайдер, а не пустой селект',
  st.mailProvider !== '' && st.imapServer === 'imap.мой-сервер.local');

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);