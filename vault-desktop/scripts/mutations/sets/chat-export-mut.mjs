// Набор мутаций: chat-export-mut
// Цель: убедиться, что смоук chat-export-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'chat-export-mut',
  file: 'src/chatExport.js',
  smoke: 'chat-export-smoke.mjs',
  mutations: [
    { name: "счётчик сообщений в JSON неверный (пользователь видит неверную сводку)",
      pattern: "    messageCount: messages.length,",
      replacement: "    messageCount: 0," },
    { name: "отметка шифрования теряется (зашифрованное выглядит открытым)",
      pattern: "      encrypted: m.encrypted || false,",
      replacement: "      encrypted: false," },
    { name: "реакции теряются (экспорт без отметок реакций)",
      pattern: "      reactions: m.reactions || [],",
      replacement: "      reactions: []," },
    { name: "в TXT все сообщения помечены как «You» (непонятно, кто что писал)",
      pattern: "    const sender = m.from === 'me' ? 'You' : contact",
      replacement: "    const sender = 'You'" },
    { name: "время сообщения без плейсхолдера (в файле «undefined»)",
      pattern: "    txt += `[${m.time || '?'}] ${sender}${encrypted}${reactions}\\n`",
      replacement: "    txt += `[${m.time}] ${sender}${encrypted}${reactions}\\n`" },
    { name: "метка шифрования не пишется в TXT",
      pattern: "    const encrypted = m.encrypted ? ' 🔒' : ''",
      replacement: "    const encrypted = ''" },
    { name: "содержимое сообщения не попадает в экспорт",
      pattern: "    txt += `${m.content}\\n\\n`",
      replacement: "    txt += `\\n`" },
  ],
};
