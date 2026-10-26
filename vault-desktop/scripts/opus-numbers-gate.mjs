// Гейт размещения чисел Opus: протокольные числа обязаны жить в ядре.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ГЕЙТ. Очередь моста `t_61bd5090`, пункт #14 (`t_72d494c1`):
// клок 48000 и «один канал» были вписаны ЛИТЕРАЛАМИ в трёх местах — SDP в
// `media.rs`, энкодер/ресэмплеры в `audio.rs`, тот же набор в
// `audio/audio_android.rs`. Совпадающие числа — самая коварная форма дубля:
// мутация «литерал вместо константы» даёт ТО ЖЕ значение, поэтому тестом её
// не убить (прогон мутаций здесь зелёный ровно потому, что ловит смену
// ЗНАЧЕНИЯ). Отличить «число из ядра» от «числа, вписанного руками» можно
// только статически — этим гейтом.
//
// ПРАВИЛО. В перечисленных файлах в КОДЕ (строки комментариев и doc-комментов
// не считаются) не должно быть протокольных литералов Opus: клок/битрейт,
// варианты `SampleRate::Hz48000`/`Channels::Mono`, размеры фрейма 960/480/5760.
// Всё это берётся из `vault_client::vault::call_media` (`OPUS_*`) и выводится
// через `opus_samples_in`.
//
// НОВЫЕ ИСКЛЮЧЕНИЯ. Только через ALLOW с причиной и только когда число ПРАВДИВО
// не протокольное (например, размер буфера сети). Запись без причины —
// признание дыры, её не добавлять.
//
// Запуск: node scripts/opus-numbers-gate.mjs
// Выход: 0 — числа в одном месте; 1 — вторая копия вернулась в мост.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILES = [
  'src-tauri/src/media.rs',
  'src-tauri/src/audio.rs',
  'src-tauri/src/audio/audio_android.rs',
];

// Что запрещено и почему. Подпись каждого — это дефект, который уже был.
const FORBIDDEN = [
  { re: /\b48_?000\b/, why: 'клок или битрейт Opus числом — взять у ядра (OPUS_CLOCK_RATE / OPUS_BITRATE_BPS)' },
  { re: /Hz48000/, why: 'застывший вариант SampleRate — собирать через opus_codec_params()' },
  { re: /OpusChannels::Mono|Channels::Mono/, why: 'вторая копия числа каналов — взять у ядра (OPUS_CHANNELS)' },
  { re: /(?<![\w.])960\b/, why: 'размер Opus-фрейма числом — вывести (opus_samples_in(OPUS_FRAME_MS))' },
  { re: /(?<![\w.])5760\b/, why: 'буфер декодера числом — вывести (opus_samples_in(DECODE_BUF_MS))' },
  { re: /(?<![\w.])480\b/, why: 'кусок APM числом — вывести (opus_samples_in(APM_FRAME_MS))' },
];

// Исключения: файл + фрагмент строки + ПРИЧИНА. Причина обязательна — запись
// без неё это признание дыры, а не обоснованное исключение, поэтому гейт на
// такое падает, а не молча пропускает.
const ALLOW = [];

function stripComment(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('///') || t.startsWith('/*') || t.startsWith('*')) {
    return '';
  }
  // хвостовой комментарий снимаем целиком
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

const hits = [];
const exempted = new Set();
let scanned = 0;
for (const rel of FILES) {
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((raw, i) => {
    const code = stripComment(raw);
    if (!code.trim()) return;
    scanned++;
    for (const f of FORBIDDEN) {
      if (!f.re.test(code)) continue;
      const exempt = ALLOW.find(
        (a) => a.file === rel && raw.includes(a.needle) && String(a.why).trim().length > 0,
      );
      if (exempt) {
        exempted.add(exempt);
        continue;
      }
      hits.push(`${rel}:${i + 1} — ${f.why}\n      ${raw.trim()}`);
    }
  });
}

for (const a of ALLOW) {
  if (!String(a.why ?? '').trim()) {
    console.log(`✗ opus-numbers-gate: исключение без причины: ${a.file} · ${a.needle}`);
    process.exit(1);
  }
  if (!exempted.has(a)) {
    console.log(
      `✗ opus-numbers-gate: устаревшее исключение (ни одна строка не совпала): ${a.file} · ${a.needle}`,
    );
    process.exit(1);
  }
}

if (hits.length) {
  console.log('✗ opus-numbers-gate: числа Opus вернулись в мост второй копией');
  for (const h of hits) console.log('  • ' + h);
  console.log('\n  Почему это важно: клок и каналы читают три места (SDP, энкодер,');
  console.log('  телефонный путь). Совпадающие литералы расходятся МОЛЧА — ни');
  console.log('  ошибки компиляции, ни строки в логе. На телефоне это «собеседник');
  console.log('  говорит ускоренно» или тишина. Число одно и живёт в');
  console.log('  vault-client/src/vault/call_media.rs.');
  process.exit(1);
}

console.log(
  `✓ opus-numbers-gate: числа Opus в одном месте (ядро), ${FILES.length} файлов моста, ${scanned} кодовых строк без протокольных литералов`,
);
