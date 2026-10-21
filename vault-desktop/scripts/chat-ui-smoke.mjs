// Node-смоук features/chat-ui.js — множественное число и эмодзи.
//
// Проверяем ПРАВИЛО, а не строки: русские формы «1 участник / 2 участника /
// 5 участников» переключаются не так, как английские, и ошибка здесь заметна
// глазом, но не падает — текст просто выглядит неграмотно.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/chat-ui-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

prepareModuleCopy(
  ROOT + '/src/features/chat-ui.js',
  MOCKS + '/chat-ui.mjs',
  {},
  MOCKS,
);
const C = await import(MOCKS + '/chat-ui.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Русские формы ──────────────────────────────────────────────────────
{
  check('ru: 1 участник', C.membersLabel('ru', 1) === 'участник', C.membersLabel('ru', 1));
  check('ru: 2 участника', C.membersLabel('ru', 2) === 'участника', C.membersLabel('ru', 2));
  check('ru: 5 участников', C.membersLabel('ru', 5) === 'участников', C.membersLabel('ru', 5));
  check('ru: 11 участников (не «участник»!)', C.membersLabel('ru', 11) === 'участников', C.membersLabel('ru', 11));
  check('ru: 12 участников', C.membersLabel('ru', 12) === 'участников', C.membersLabel('ru', 12));
  check('ru: 21 участник', C.membersLabel('ru', 21) === 'участник', C.membersLabel('ru', 21));
  check('ru: 22 участника', C.membersLabel('ru', 22) === 'участника', C.membersLabel('ru', 22));
  check('ru: 25 участников', C.membersLabel('ru', 25) === 'участников', C.membersLabel('ru', 25));
  check('ru: 0 участников', C.membersLabel('ru', 0) === 'участников', C.membersLabel('ru', 0));
}
// ── Английские формы ───────────────────────────────────────────────────
{
  check('en: 1 member', C.membersLabel('en', 1) === 'member', C.membersLabel('en', 1));
  check('en: 2 members', C.membersLabel('en', 2) === 'members', C.membersLabel('en', 2));
  check('en: 0 members', C.membersLabel('en', 0) === 'members', C.membersLabel('en', 0));
  check('без локали — английская форма', C.membersLabel('', 3) === 'members', C.membersLabel('', 3));
  check('локаль ru-RU распознаётся', C.membersLabel('ru-RU', 2) === 'участника', C.membersLabel('ru-RU', 2));
}

// ── Эмодзи ─────────────────────────────────────────────────────────────
{
  const s = { text: 'привет', picker: true };
  const deps = {
    newMessage: () => s.text,
    setNewMessage: (v) => { s.text = v; },
    setShowEmojiPicker: (v) => { s.picker = v; },
  };
  C.insertEmoji(deps, '🙂');
  check('эмодзи: добавлен в поле', s.text === 'привет🙂', s.text);
  check('эмодзи: выбор закрыт', s.picker === false, s.picker);
  C.insertEmoji(deps, '🎉');
  check('эмодзи: второй добавляется следом', s.text === 'привет🙂🎉', s.text);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
