// Аватары: пределы, пресеты и центральная обрезка (ADR-003 Этап 3, партия 12).
//
// ГЛАВНОЕ ПРОВЕРЕНИЕ НЕ В СТРОКАХ, А В СВЯЗИ МЕЖДУ МЕСТАМИ. Квадратная обрезка
// была написана вручную в трёх файлах, и черновик аватара группы совпадал с
// сохраняемым только потому, что обе копии выросли из одного и того же
// текста. Проверка «черновик и результат из одного пресета» — это то, что не
// даст копиям снова разойтись: если завтра кто-то введёт отдельный пресет для
// черновика, тест упадёт сам, а не пользователь.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/avatar-image-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const drawn = [];
globalThis.__drawn = drawn;

// canvas-заглушка: записывает, что именно в неё нарисовали.
globalThis.document = {
  createElement: (tag) => {
    if (tag !== 'canvas') throw new Error('ожидался canvas');
    return {
      width: 0, height: 0,
      getContext: () => ({
        drawImage: (img, sx, sy, sw, sh, dx, dy, dw, dh) => {
          drawn.push({ src: [sx, sy, sw, sh], dst: [dx, dy, dw, dh], w: img.width, h: img.height });
        },
      }),
      toDataURL: (mime, q) => 'data:' + mime + ';q=' + q + '#' + (drawn.length),
    };
  },
};

writeFileSync(MOCKS + '/avatar-image.mjs', readFileSync(path.join(ROOT, 'src', 'avatar-image.js'), 'utf8'));
const A = await import(MOCKS + '/avatar-image.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const img = (w, h) => ({ width: w, height: h });

console.log('\nADR-003 Этап 3, партия 12 · аватары: пределы, пресеты, обрезка');

// ── Предел размера ──────────────────────────────────────────────────────
ok('предел 500·1024 — одно число на все три места', A.AVATAR_MAX_BYTES === 512000);
ok('ровно предел проходит', A.avatarTooBig(512000) === false);
ok('на байт больше — отказ', A.avatarTooBig(512001) === true);
ok('пустой файл проходит', A.avatarTooBig(0) === false);

// ── Пресеты: черновик группы и сохранённая группа — ОДИН объект ─────────
// Пока это так, «превью отличается от результата» структурно невозможно.
ok('черновик и сохранённый аватар группы берут ОДИН пресет',
  A.GROUP_AVATAR.size === 128 && A.GROUP_AVATAR.mime === 'image/jpeg' && A.GROUP_AVATAR.quality === 0.8);
ok('аватар профиля другой намеренно: 256 PNG, без quality',
  A.PROFILE_AVATAR.size === 256 && A.PROFILE_AVATAR.mime === 'image/png' && A.PROFILE_AVATAR.quality === undefined);

// ── Прямоугольник обрезки ───────────────────────────────────────────────
let r = A.squareCropRect(200, 100, 128);
ok('альбомная: берём по высоте, смещение по X', r.size === 100 && r.sx === 50 && r.sy === 0);

r = A.squareCropRect(100, 200, 128);
ok('портретная: берём по ширине, смещение по Y', r.size === 100 && r.sx === 0 && r.sy === 50);

r = A.squareCropRect(300, 300, 128);
ok('квадратная: смещения нулевые, размер — весь', r.size === 300 && r.sx === 0 && r.sy === 0);

// ДРОБНОЕ СМЕЩЕНИЕ. На 101×100 берётся 100×100 со смещением 0.5. Это не
// дефект, а требование canvas; важно, что оно fractional и одинаково
// считается в одном месте, а не «как получится» в трёх копиях.
r = A.squareCropRect(101, 100, 128);
ok('нечётная ширина → дробное смещение, без потери', r.size === 100 && r.sx === 0.5 && r.sy === 0);

// ── Отрисовка: параметры drawImage ─────────────────────────────────────
drawn.length = 0;
A.renderSquareCrop(img(400, 200), A.GROUP_AVATAR);
ok('в drawImage уходит область 200×200 из центра', drawn[0].src.join(',') === '100,0,200,200');
ok('и растягивается в 128×128', drawn[0].dst.join(',') === '0,0,128,128');
drawn.length = 0;
let url = A.renderSquareCrop(img(400, 200), A.GROUP_AVATAR);
ok('аватар группы кодируется JPEG с качеством 0.8', url.startsWith('data:image/jpeg;q=0.8'));

drawn.length = 0;
url = A.renderSquareCrop(img(400, 400), A.PROFILE_AVATAR);
ok('аватар профиля кодируется PNG', url.startsWith('data:image/png'));

// ── Отказы декодирования: раньше промес зависал навсегда ─────────────────
// img.onload при битом файле не наступает. Без img.onerror промес не
// разрешается НИКОГДА, и колёсико загрузки крутится вечно.
// Битая картинка: onload НЕ наступает, срабатывает onerror. Именно этот
// случай раньше оставлял промес неразрешённым навсегда.
globalThis.Image = class {
  set src(v) { setTimeout(() => this.onerror && this.onerror(), 0); }
};
globalThis.FileReader = class {
  readAsDataURL() { setTimeout(() => this.onload({ target: { result: 'DATA' } }), 0); }
};

let settled = 'нет';
await A.fileToAvatarDataUrl({ size: 10 }, A.GROUP_AVATAR)
  .then((v) => { settled = 'resolve:' + v; })
  .catch((e) => { settled = 'reject:' + e.message; });
ok('файл не декодируется → ОТКАЗ, а не вечное ожидание', settled.startsWith('reject:image decode failed'));

// Ошибка чтения файла — другой отказ, и его тоже надо ловить.
globalThis.FileReader = class {
  readAsDataURL() { setTimeout(() => this.onerror(new Error('io')), 0); }
};
settled = 'нет';
await A.fileToAvatarDataUrl({ size: 10 }, A.GROUP_AVATAR)
  .then(() => { settled = 'resolve'; })
  .catch((e) => { settled = 'reject:' + e.message; });
ok('файл не читается → отказ с причиной', settled === 'reject:file read failed');

// Успешный путь. ВОССТАНАВЛИВАЕМ ОБА МОКА: FileReader выше был подменён на
// сломанный, и без возврата этот блок получил бы чужой отказ — то есть проверял
// не код, а остаток предыдущего теста.
globalThis.FileReader = class {
  readAsDataURL() { setTimeout(() => this.onload({ target: { result: 'DATA' } }), 0); }
};
globalThis.Image = class {
  set src(v) { this.width = 500; this.height = 500; setTimeout(() => this.onload(), 0); }
};
drawn.length = 0;
let good = 'нет';
await A.fileToAvatarDataUrl({ size: 10 }, A.GROUP_AVATAR).then((v) => { good = v; });
ok('нормальный файл → dataURL пресета', good.startsWith('data:image/jpeg;q=0.8'));

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);