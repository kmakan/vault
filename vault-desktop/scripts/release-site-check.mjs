// ГЕЙТ ЦЕЛОСТНОСТИ СТРАНИЦЫ РЕЛИЗА (23.10).
//
// ЗАЧЕМ. Кнопка «Обновить» в настройках ведёт НЕ на сайт, а на apk_url /
// desktop_url из latest.json (SettingsPage.vue: openDownloadPage). При релизе
// 0.1.258 в latest.json обновили version и changelog, а URL оставить старые —
// и живое кольцо получилось таким: «доступна версия 0.1.258», а по кнопке
// пользователь идёт скачивать 0.1.255. Ровно тот же класс, что «метка указывает
// на чужой коммит» (release-tag-check): релиз технически собран, но публикация
// расходится с самим собой, и заметить это глазами нельзя — файл валидный JSON,
// обе ссылки живые.
//
// ПРОВЕРЯЕТ ТРИ ВЕЩИ:
//   1. ассеты версии лежат в releases/ (иначе ссылка ведёт на 404);
//   2. version, apk_url и desktop_url в latest.json / latest-en.json
//      называют ОДНУ И ТУ ЖЕ версию (главная проверка);
//   3. с --live — то же самое на живом сайте (CDN кэширует по имени файла,
//      поэтому запрос идёт с ?cb=) и sha256 скачанного APK против локального.
//
// ЗАПУСК:
//   node vault-desktop/scripts/release-site-check.mjs 0.1.258
//   node vault-desktop/scripts/release-site-check.mjs 0.1.258 --live
//   node vault-desktop/scripts/release-site-check.mjs --selftest
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const SITE = process.env.VAULT_SITE_DIR || '/home/maksim/vault-site';
const args = process.argv.slice(2);
const live = args.includes('--live');
const runSelftest = args.includes('--selftest');
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));

const failures = [];
const ok = [];
const fail = (msg) => failures.push(msg);
const pass = (msg) => ok.push(msg);

// Имя ассета по версии — единый источник, чтобы проверка и сайт не разъезжались.
const assetNames = (v) => ({
  apk: `vault-${v}.apk`,
  apkArm: `vault-${v}-arm64.apk`,
  desktop: `vault-desktop-${v}-linux-x86_64.tar.gz`,
});

function readManifest(dir, file) {
  const p = path.join(dir, file);
  if (!existsSync(p)) { fail(`нет файла ${file}`); return null; }
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { fail(`${file}: битый JSON (${e.message})`); return null; }
}

// Имя файла из URL — с отброшенными query и фрагментом. Смотрим на ХВОСТ пути,
// а не на «версия встречается в строке»: 0.1.25 не должен засчитаться за 0.1.258.
function baseName(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function checkManifest(dir, v, file) {
  const m = readManifest(dir, file);
  if (!m) return;
  const before = failures.length;
  if (m.version !== v) fail(`${file}: version=${m.version} ≠ релиз ${v}`);
  const a = assetNames(v);
  if (baseName(m.apk_url) !== a.apk && baseName(m.apk_url) !== a.apkArm) {
    fail(`${file}: apk_url ведёт НЕ на ${a.apk} → ${m.apk_url}`);
  }
  if (baseName(m.desktop_url) !== a.desktop) {
    fail(`${file}: desktop_url ведёт НЕ на ${a.desktop} → ${m.desktop_url}`);
  }
  // «проверен» печатается ТОЛЬКО когда этот файл прошёл целиком: иначе зелёная
  // строка рядом с красной читается как «разобрались», хотя разъезд не пойман.
  if (failures.length === before) pass(`${file}: версия и обе ссылки названы ${v}`);
}

function checkAssets(dir, v) {
  const a = assetNames(v);
  for (const [label, name] of Object.entries(a)) {
    const p = path.join(dir, 'releases', name);
    if (!existsSync(p)) fail(`releases/: нет ассета ${label} (${name})`);
  }
}

async function sha256OfFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function checkLive(v) {
  const get = (urlPath) => {
    const cb = `cb=${Date.now()}`;
    const sep = urlPath.includes('?') ? '&' : '?';
    return execFileSync('curl', ['-s', `https://vault-msg.ru/${urlPath}${sep}${cb}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  };
  let remote;
  try { remote = JSON.parse(get('latest.json')); }
  catch (e) { fail(`live latest.json: не читается (${e.message})`); return; }
  if (remote.version !== v) fail(`live latest.json: version=${remote.version} ≠ ${v}`);
  else pass(`live latest.json: version=${v}`);
  if (baseName(remote.apk_url) !== assetNames(v).apk &&
      baseName(remote.apk_url) !== assetNames(v).apkArm) {
    fail(`live apk_url ведёт не на ${v}: ${remote.apk_url}`);
  }
  // Скачанный APK против локального: CDN мог отдать кэш другого файла под тем же именем.
  const a = assetNames(v);
  const local = path.join(SITE, 'releases', a.apk);
  if (existsSync(local)) {
    const tmp = path.join(os.tmpdir(), `site-check-${v}.apk`);
    execFileSync('curl', ['-s', `https://vault-msg.ru/releases/${a.apk}?cb=${Date.now()}`, '-o', tmp]);
    const remoteSha = await sha256OfFile(tmp);
    rmSync(tmp, { force: true });
    const localSha = await sha256OfFile(local);
    if (remoteSha !== localSha) fail(`live APK ≠ локальный: ${remoteSha.slice(0, 12)} против ${localSha.slice(0, 12)} (CDN отдал другой файл)`);
    else pass(`live APK совпадает с локальным (${localSha.slice(0, 12)}…)`);
  }
}

// ── САМОПРОВЕРКА ────────────────────────────────────────────────────────
// Гейт, который сам себя не проверяет, однажды молча становится декорацией.
// Ловим два класса: «не заметил разъезд» (ложно-зелёный) и «забраковал
// правильный файл» (ложно-красный).
function selftest() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'site-check-selftest-'));
  const V = '9.9.9';
  const A = assetNames(V);
  const good = {
    version: V,
    apk_url: `https://vault-msg.ru/releases/${A.apk}`,
    desktop_url: `https://vault-msg.ru/releases/${A.desktop}`,
  };
  mkdirSync(path.join(dir, 'releases'), { recursive: true });
  for (const n of [A.apk, A.apkArm, A.desktop]) writeFileSync(path.join(dir, 'releases', n), 'x');

  const cases = [
    ['целый релиз проходит', { ...good }, 0],
    ['version обновили, apk_url забыли (болячка 0.1.258)',
      { ...good, apk_url: `https://vault-msg.ru/releases/vault-9.9.8.apk` }, 1],
    ['version отстала от ссылок',
      { ...good, version: '9.9.8' }, 1],
    ['desktop_url ведёт на старую сборку',
      { ...good, desktop_url: `https://vault-msg.ru/releases/vault-desktop-9.9.7-linux-x86_64.tar.gz` }, 1],
    ['«0.1.25» не засчитывается как «0.1.258»: хвост не совпадает',
      { ...good, apk_url: `https://vault-msg.ru/releases/vault-${V}9.apk` }, 1],
    ['битый JSON — не «прошёл, потому что не понял»',
      '{{{', 1],
  ];
  let bad = 0;
  for (const [name, body, wantFail] of cases) {
    const before = failures.length;
    writeFileSync(path.join(dir, 'latest.json'),
      typeof body === 'string' ? body : JSON.stringify(body));
    failures.length = 0; ok.length = 0;
    checkManifest(dir, V, 'latest.json');
    const gotFail = failures.length > 0 ? 1 : 0;
    // Зелёная строка рядом с красной — отдельный класс обмана: «файл разобран,
    // всё понятно», хотя разъезд не пойман. У сломанного манифеста её быть не должно.
    const gotPass = ok.length > 0 ? 1 : 0;
    failures.length = before; ok.length = 0;
    if (gotFail !== wantFail || gotPass !== (wantFail ? 0 : 1)) {
      bad++;
      console.log(`  ✗ ${name} — ожидание fail=${wantFail}/pass=${wantFail ? 0 : 1}, факт fail=${gotFail}/pass=${gotPass}`);
    } else console.log(`  ✓ ${name}`);
  }
  // Отсутствие ассета — отдельный класс (ссылка жива, файла нет).
  failures.length = 0;
  rmSync(path.join(dir, 'releases', A.desktop));
  checkAssets(dir, V);
  if (failures.length === 0) { bad++; console.log('  ✗ отсутствующий ассет не пойман'); }
  else console.log('  ✓ отсутствующий ассет пойман');
  rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `\n=== САМОПРОВЕРКА: ${bad} провалов` : '\n=== САМОПРОВЕРКА: всё поймано');
  process.exit(bad ? 1 : 0);
}

if (runSelftest) selftest();

if (!version) {
  console.error('использование: release-site-check.mjs <версия> [--live] | --selftest');
  process.exit(2);
}
checkAssets(SITE, version);
checkManifest(SITE, version, 'latest.json');
checkManifest(SITE, version, 'latest-en.json');
if (live) await checkLive(version);

for (const m of ok) console.log('  ✓ ' + m);
for (const m of failures) console.log('  ✗ ' + m);
console.log(failures.length
  ? `\n✗ release-site-check: ${failures.length} расхождений — публикация называет НЕ ту версию, что собрана`
  : `\n✓ release-site-check: ассеты, манифесты RU/EN${live ? ' и живой сайт' : ''} — одна версия ${version}`);
process.exit(failures.length ? 1 : 0);
