// Набор мутаций: ctx-cycles-mut
// Цель: убедиться, что смоук ctx-cycles-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'ctx-cycles-mut',
  file: 'src/features/calls.js',
  smoke: 'ctx-cycles-smoke.mjs',
  mutations: [
    { name: "владелец call-session импортирует фичу calls.js",
      pattern: "export function useSession(",
      replacement: "import './calls.js';\n\nexport function useSession(",
      file: "src/features/call-session.js" },
    { name: "calls.js импортирует фичу relay.js",
      pattern: "import api, { db } from '../api.js';",
      replacement: "import api, { db } from '../api.js';\nimport './relay.js';" },
    { name: "возникает цикл mailbox-store → session-store → mailbox-store",
      pattern: "export function createMailboxStore() {",
      replacement: "import './session-store.js';\n\nexport function createMailboxStore() {",
      file: "src/features/mailbox-store.js" },
    { name: "фича импортирует сама себя",
      pattern: "export const CHAT_SCOPE = { group: 'group', peer: 'peer', channel: 'channel', notes: 'notes', self: 'self' };",
      replacement: "import './chat.js';\n\nexport const CHAT_SCOPE = { group: 'group', peer: 'peer', channel: 'channel', notes: 'notes', self: 'self' };",
      file: "src/features/chat.js" },
  ],
};
