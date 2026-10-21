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
