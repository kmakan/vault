// Гейт: звуки звонка — одно имя на пять мест, где оно живёт (#71).
//
// ЗАЧЕМ. Звук звонка существует в пяти деревьях одновременно:
//   1) список имён и аудиоканал — `audio::SOUNDS` (src-tauri/src/audio.rs);
//   2) WAV, вшитые в десктопный бинарь — include_bytes! + src-tauri/sounds/;
//   3) WAV для телефона — src-tauri/gen/android/.../res/raw/ring_<имя>.wav;
//   4) keep.xml — без него resource-shrinking в release вырезает ассет, и на
//      телефоне звонок молчит при полностью зелёных остальных checks;
//   5) таблица имя→ресурс в Kotlin (soundResFor) и имена, которые просит фронт.
// До 27.10 они не были связаны ничем: на Android фронт подставлял имя в URL
// `/sounds/ring_<имя>.wav`, и «ассета нет» выглядело как тишина, а не как
// ошибка. Ровно этот класс: connect/connected/end/missed лежали в
// src-tauri/sounds, но не в res/raw — на телефоне их не было вовсе.
//
// ЧТО ПРОВЕРЯЕТСЯ СТАТИКОЙ (живой прогон — приёмка на устройстве).
//   • SOUNDS ⇄ include_bytes ⇄ sounds/ ⇄ res/raw ⇄ keep.xml ⇄ Kotlin — один
//     набор имён, без лишних и без пропущенных;
//   • плечо Kotlin ведёт на ресурс с ТЕМ ЖЕ именем (`"end" -> R.raw.ring_end`);
//   • фронт не выдумывает имён: литералы playCallSound/previewSound ⊆ SOUNDS;
//   • в src/ не осталось HTML5-пути к `/sounds/` (возврат ветки = молчание
//     при нулевой медиа-громкости, исходный дефект #70).
//
// ЗАПУСК: node scripts/call-sound-assets-gate.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const DESKTOP = path.resolve(HERE, '..');
const RAW_DIR = 'src-tauri/gen/android/app/src/main/res/raw';
const KOTLIN = 'src-tauri/gen/android/app/src/main/java/com/vault/vault/VaultForegroundService.kt';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const read = (rel) => readFileSync(path.join(DESKTOP, rel), 'utf8');
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\S\n]*\/\/.*$/gm, '')
  .replace(/^[^\S\n]*\*.*$/gm, '')
  .replace(/^\s*\/\/\/.*$/gm, '')
  .replace(/\/\/.*$/g, '');

// ── 1. Rust: имя → класс ───────────────────────────────────────
const audio = read('src-tauri/src/audio.rs');
const table = audio.slice(audio.indexOf('pub const SOUNDS'), audio.indexOf('];', audio.indexOf('pub const SOUNDS')));
const sounds = [...table.matchAll(/\("([a-z_]+)",\s*SoundClass::(Ring|Signal)\)/g)]
  .map((m) => ({ name: m[1], cls: m[2] }));
check('список имён прочитан (audio::SOUNDS)', sounds.length > 0, `найдено ${sounds.length}`);
const rustNames = sounds.map((s) => s.name);
check('имена не дублируются', new Set(rustNames).size === rustNames.length);
check('гудков и сигналов меньше, чем строк (класс проставлен у всех)',
  sounds.filter((s) => s.cls === 'Ring' || s.cls === 'Signal').length === rustNames.length);
const ringNames = sounds.filter((s) => s.cls === 'Ring').map((s) => s.name);
check('есть хотя бы один гудок и один сигнал', ringNames.length > 0 && sounds.length > ringNames.length);

// ── 2. Десктоп: include_bytes ⇄ файлы ──────────────────────────
const embedded = [...audio.matchAll(/include_bytes!\("\.\.\/sounds\/ring_([a-z_]+)\.wav"\)/g)].map((m) => m[1]);
check('десктопные include_bytes = список SOUNDS',
  sameSet(embedded, rustNames), diff(embedded, rustNames));
const desktopFiles = wavNames('src-tauri/sounds');
check('в sounds/ лежат ровно те же WAV', sameSet(desktopFiles, rustNames.map((n) => 'ring_' + n)), diff(desktopFiles, rustNames.map((n) => 'ring_' + n)));

// ── 3. Android: res/raw + keep.xml ─────────────────────────────
const rawFiles = wavNames(RAW_DIR);
check('в res/raw лежат ровно те же WAV (иначе на телефоне тихо)',
  sameSet(rawFiles, rustNames.map((n) => 'ring_' + n)), diff(rawFiles, rustNames.map((n) => 'ring_' + n)));
const keep = read(path.join(RAW_DIR, 'keep.xml'));
// Сравнение СПИСКОМ, а не `keep.includes(имя)`: подстроку «@raw/ring_missed»
// оставляет и запись «@raw/ring_missedX», и порванный keep.xml выглядел бы
// целым (проба 27.10: мутация keep.xml проходила гейт именно так).
const kept = [...new Set([...keep.matchAll(/@raw\/ring_([a-z_]+)/g)].map((m) => m[1]))];
check('в keep.xml закреплены ровно звуки звонка (release-шринкинг ресурсов)',
  sameSet(kept, rustNames), diff(kept, rustNames));

// ── 4. Kotlin: имя → ресурс тем же именем ──────────────────────
const kt = stripComments(read(KOTLIN));
const fn = kt.slice(kt.indexOf('private fun soundResFor'), kt.indexOf('}', kt.indexOf('private fun soundResFor')));
check('таблица soundResFor найдена в Kotlin', fn.length > 0);
const ktArms = [...fn.matchAll(/"([a-z_]+)"\s*->\s*R\.raw\.ring_([a-z_]+)/g)].map((m) => ({ name: m[1], res: m[2] }));
check('Kotlin знает ровно имена из SOUNDS',
  sameSet(ktArms.map((a) => a.name), rustNames), diff(ktArms.map((a) => a.name), rustNames));
check('плечо Kotlin ведёт на ресурс с тем же именем',
  ktArms.every((a) => a.name === a.res),
  ktArms.filter((a) => a.name !== a.res).map((a) => `${a.name}→ring_${a.res}`).join(', '));
check('звук звонка запускается из моста (JNI-метод существует)',
  /fun playCallSound\(/.test(kt) && /fun stopCallSound\(/.test(kt));
// Рингтон, который ставит сам сервис, обязан читать ТОЙ ЖЕ таблицей:
// своя копия when() — место, где имя расходится молча (их две, и вторая
// никогда не падает — она просто даёт другой WAV).
const ringFn = ktBody(kt, 'private fun ringtoneResFor');
check('кольцо сервиса делегирует общую таблицу (soundResFor)',
  /soundResFor\(/.test(ringFn) && !/when\s*\(/.test(ringFn), ringFn.slice(0, 120));

// ── 5. Фронт: не выдумывает имён и не играет HTML5 ─────────────
const front = ['src/features/calls.js', 'src/App.vue', 'src/components/SettingsPage.vue']
  .map((rel) => ({ rel, src: stripComments(read(rel)) }));
const requested = new Set();
for (const { src } of front) {
  for (const m of src.matchAll(/(?:playCallSound|previewSound)\s*\([^)]*?'([a-z_]+)'/g)) requested.add(m[1]);
}
check('фронт просит только имена из SOUNDS', [...requested].every((n) => rustNames.includes(n)),
  [...requested].filter((n) => !rustNames.includes(n)).join(', '));
for (const { rel, src } of front) {
  check(`${rel}: нет ветки HTML5 Audio для звуков звонка`,
    !/new\s+Audio\(/.test(src) && !/\/sounds\//.test(src));
}
check('публичной копии ассетов в фронте больше нет (2 МБ мёртвого груза в APK)',
  !existsSync(path.join(DESKTOP, 'public/sounds')));

// Тело одной функции Kotlin до следующего объявления: достаточно для
// «есть ли здесь своя таблица ресурсов».
function ktBody(src, header) {
  const from = src.indexOf(header);
  if (from < 0) return '';
  const rest = src.slice(from);
  const stop = rest.search(/\n {8}(private |@JvmStatic|fun |\/\/\/|\/\*)/);
  return stop < 0 ? rest : rest.slice(0, stop);
}
function sameSet(a, b) {
  const A = [...new Set(a)].sort(), B = [...new Set(b)].sort();
  return A.length === B.length && A.every((x, i) => x === B[i]);
}
function diff(a, b) {
  const A = new Set(a), B = new Set(b);
  const only = [...A].filter((x) => !B.has(x)), missed = [...B].filter((x) => !A.has(x));
  return [only.length && 'лишнее: ' + only.join(','), missed.length && 'нет: ' + missed.join(',')].filter(Boolean).join('; ');
}
function wavNames(relDir) {
  const dir = path.join(DESKTOP, relDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4));
}

if (fail) {
  console.error(`\n═══ ГЕЙТ ЗВУКОВ ЗВОНКА: ${fail} нарушение(й) (пройдено ${pass}) ═══`);
  console.error('Имя звука обязано существовать во всех пяти местах сразу —');
  console.error('иначе на одной платформе звонок молчит, а гейты зелёные.');
  process.exit(1);
}
console.log(`✓ call-sound-assets: ${rustNames.length} имён звука совпадают в Rust, sounds/, res/raw, keep.xml, Kotlin и фронте (пройдено ${pass}).`);
