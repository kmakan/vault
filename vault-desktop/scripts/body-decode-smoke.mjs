// smoke: body-decode-smoke.mjs
// Проводка JS-адаптера разбора тела письма (src/body-decode.js).
//
// САМО ПРАВИЛО ЗДЕСЬ НЕ ЖИВЁТ и здесь не меряется: с 28.10 оно одно — в ядре
// (vault-client/src/crypto.rs), его мера — общая фикстура
// vault-client/tests/fixtures/body-decode-contract.json (Rust-тесты ядра и
// моста) + мутации ядра. Здесь проверяется только ТРАНСПОРТ (ADR-005 R1):
//   · какая команда зовётся и с какими ИМЕНАМИ аргументов (body / token —
//     snake_case команды Tauri v2, смоук читает ровно эти поля);
//   · тело возвращается как текст, а неразбираемое — null БЕЗ исключения
//     (иначе чужая почта роняла бы весь скан handshake);
//   · kid канала приходит строкой как есть (ядро уже дало hex).
//
// Двойник моста — scripts/lib/body-decode-mock.mjs: прод зовёт Rust, смоук
// зовёт двойник, поэтому расхождение имени команды здесь — это дефект
// проводки, а не «правило в JS».
import { writeFileSync, mkdirSync } from 'node:fs';
import { bodyDecodeHandler, writeBodyDecodeAdapter } from './lib/body-decode-mock.mjs';

const MOCKS = '/tmp/body-decode-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const calls = [];
globalThis.__INVOKE__ = async (cmd, args) => {
  calls.push({ cmd, args });
  const v = bodyDecodeHandler(cmd, args);
  if (v === undefined) throw new Error('No such command: ' + cmd);
  return v;
};
writeBodyDecodeAdapter(MOCKS, 'const invoke = (...a) => globalThis.__INVOKE__(...a);');

const { decodeUrlSafeText, channelKidHex } = await import('file://' + MOCKS + '/body-decode.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

const JSON_A = { kind: 'group-invite', gid: 'g-10', name: 'Тестовая группа' };
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const b64url = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const fold76 = (s) => s.replace(/(.{76})/g, '$1\r\n');

console.log('\nРазбор тела: команда, аргумент, возвращаемый текст:');
const body = b64(JSON_A);
{
  calls.length = 0;
  const got = await decodeUrlSafeText(body);
  check('тело вернулось текстом', got === JSON.stringify(JSON_A), got);
  check('позвана команда vault_decode_url_safe_body',
    calls.length === 1 && calls[0].cmd === 'vault_decode_url_safe_body', calls);
  check('аргумент называется body (имя команды моста, а не text/content)',
    calls[0].args && calls[0].args.body === body, calls[0].args);
}
{
  const got = await decodeUrlSafeText(fold76(body));
  check('фолдинг письма (переносы ≤76) не мешает', got === JSON.stringify(JSON_A), got);
}
{
  const u = b64url(JSON_A);
  check('фикстура содержит url-safe символ (иначе проверка алфавита — декорация)',
    /[-_]/.test(u), u);
  const got = await decodeUrlSafeText(u);
  check('url-safe тело (без padding) разобрано', got === JSON.stringify(JSON_A), got);
}
{
  // Fixture for QP: payload whose base64 ENDS with padding — иначе QP-мутация
  // («`=` не раскодирован») не меняет тело и проверка была бы декорацией.
  const QP_JSON = { kind: 'group-invite', gid: 'g-11', name: 'Группа' };
  const qpBody = b64(QP_JSON);
  check('фикстура QP: base64 оканчивается padding (`=`)', qpBody.endsWith('='), qpBody);
  const qp = qpBody.replace(/=/g, '=3D');
  check('фикстура QP-кодирует padding (иначе проверка QP — декорация)', qp.includes('=3D'), qp);
  const got = await decodeUrlSafeText(qp);
  check('QP-кодированное padding разобрано', got === JSON.stringify(QP_JSON), got);
}

console.log('\nНечитаемое тело и пустой вход:');
{
  calls.length = 0;
  check('мусор → null (БЕЗ исключения: чужая почта не роняет скан)',
    await decodeUrlSafeText('это вообще не base64: @@ @@') === null);
  calls.length = 0;
  check('пустая строка → null без вызова моста',
    await decodeUrlSafeText('') === null && calls.length === 0, calls);
  check('null → null без вызова моста',
    await decodeUrlSafeText(null) === null && calls.length === 0, calls);
  check('не-строка → null без вызова моста',
    await decodeUrlSafeText({ body: 'x' }) === null && calls.length === 0, calls);
}

console.log('\nkid канала: команда token, HEX-строка как есть:');
{
  const tok = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).toString('base64url');
  calls.length = 0;
  const kid = await channelKidHex(tok);
  check('kid вернулся HEX-строкой', kid === '0102030405060708', kid);
  check('позвана команда channel_kid_hex',
    calls.length === 1 && calls[0].cmd === 'channel_kid_hex', calls);
  check('аргумент называется token', calls[0].args && calls[0].args.token === tok, calls[0].args);
  check('typeof kid — строка (u64 после 2^53 в JSON-числе теряет точность)',
    typeof kid === 'string');
}
{
  const short = Buffer.from([1, 2, 3]).toString('base64url');
  let threw = false;
  try { await channelKidHex(short); } catch { threw = true; }
  check('токен короче 8 байт — отказ моста виден вызывающему (не тихий null)', threw);
}

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
