// Общая подключалка мока формата wire-конверта для node-смоуков.
//
// Правила разбора/сборки конверта живут в Rust (ADR-005 R1 / W4), а JS-часть
// ходит в них через мост (invoke). В node-смоуках моста нет — нужен тестовый
// двойник (scripts/lib/envelope-mock.mjs).
//
// Эта подключалка делает одно и то же для любого смоука:
//   1) пишет копию адаптера (src/envelope-rule.js) с подменой Tauri-вызова;
//   2) пишет копию message-format.js с подменой импорта адаптера;
//   3) отдаёт готовые записи для карты моков prepareModuleCopy.
//
// Зачем отдельный файл: правило «формат конверта — в Rust» требует, чтобы
// КАЖДЫЙ смоук, который трогает конверт, проверял ОДНО И ТО ЖЕ правило через
// один и тот же двойник. Расхождение двойников = смоуки проверяют разные
// форматы (и это тихо).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');   // vault-desktop/

// Вызывается из смоука: await installEnvelopeMock(MOCKS)
export async function installEnvelopeMock(mocksDir) {
  mkdirSync(mocksDir, { recursive: true });
  // Мок Tauri-вызова: общий сценарий для всех смоуков.
  globalThis.__invokeMock = (await import('./envelope-mock.mjs'))
    .installEnvelopeMock(globalThis.__invokeMock || (async () => null));
  // Сервисные форматы (сигнал звонка, data-письмо, объект конверта) — тот же
  // приём: двойник правил из Rust (scripts/lib/wire-signal-mock.mjs).
  const wire = (await import('./wire-signal-mock.mjs')).wireSignalHandler;
  const prevInvoke = globalThis.__invokeMock;
  globalThis.__invokeMock = async (cmd, args) => {
    const v = wire(cmd, args);
    return v !== undefined ? v : prevInvoke(cmd, args);
  };
  // Разбор тела письма с 28.10 — тоже правило ядра: двойник общий
  // (scripts/lib/body-decode-mock.mjs), чтобы смоуки, читающие тело, видели
  // одну и ту же форму вызова (body / token).
  const bodyDecode = (await import('./body-decode-mock.mjs')).bodyDecodeHandler;
  const prevBody = globalThis.__invokeMock;
  globalThis.__invokeMock = async (cmd, args) => {
    const v = bodyDecode(cmd, args);
    return v !== undefined ? v : prevBody(cmd, args);
  };
  writeFileSync(
    path.join(mocksDir, 'tauri-core.js'),
    'export const invoke = (...a) => globalThis.__invokeMock(...a);',
  );
  // Адаптер: копия настоящего файла, подменён только Tauri-вызов.
  writeFileSync(
    path.join(mocksDir, 'envelope-rule.js'),
    readFileSync(path.join(ROOT, 'src', 'envelope-rule.js'), 'utf8').replaceAll(
      "from '@tauri-apps/api/core'",
      "from './tauri-core.js'",
    ),
  );
  // Адаптер разбора тела письма — копия настоящего файла с подменённым
  // Tauri-вызовом (общий мост __invokeMock).
  writeFileSync(
    path.join(mocksDir, 'body-decode.js'),
    readFileSync(path.join(ROOT, 'src', 'body-decode.js'), 'utf8').replaceAll(
      "from '@tauri-apps/api/core'",
      "from './tauri-core.js'",
    ),
  );
  // Адаптер сервисных форматов (сигнал звонка, data-письмо, объект конверта).
  // Его Tauri-вызов идёт через ОТДЕЛЬНЫЙ мост (wire-signal-core.js): у разных
  // смоуков свой мост (__invokeMock / __tauri.invoke), и общий не нужен —
  // нужен общий ДВОЙНИК правил.
  writeFileSync(
    path.join(mocksDir, 'wire-signal-core.js'),
    'export const invoke = (...a) => globalThis.__wireSignalInvoke(...a);',
  );
  writeFileSync(
    path.join(mocksDir, 'wire-signal-rule.js'),
    readFileSync(path.join(ROOT, 'src', 'wire-signal-rule.js'), 'utf8').replaceAll(
      "from '@tauri-apps/api/core'",
      "from './wire-signal-core.js'",
    ),
  );
  const wireHandler = (await import('./wire-signal-mock.mjs')).wireSignalHandler;
  globalThis.__wireSignalInvoke = async (cmd, args) => {
    const v = wireHandler(cmd, args);
    if (v !== undefined) return v;
    // Чужой мост смоука ищем В МОМЕНТ ВЫЗОВА: смоук ставит его после
    // подключения моков, и раньше его просто не существует.
    const prev = globalThis.__invokeMock
      || (globalThis.__tauri && globalThis.__tauri.invoke)
      || globalThis.__invoke
      || null;
    return prev ? prev(cmd, args) : null;
  };
  // message-format.js: копия, у которой импорт адаптера — соседний файл.
  writeFileSync(
    path.join(mocksDir, 'message-format.js'),
    readFileSync(path.join(ROOT, 'src', 'message-format.js'), 'utf8').replaceAll(
      "from './envelope-rule.js'",
      "from './envelope-rule.js'",
    ),
  );
  return {
    // Записи для карты моков prepareModuleCopy.
    messageFormatMock: { '../message-format.js': 'message-format.js' },
  };
}
