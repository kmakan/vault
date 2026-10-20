// Набор мутаций: receipts-mut
// Цель: убедиться, что смоук receipts-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'receipts-mut',
  file: 'src/features/receipts.js',
  smoke: 'receipts-smoke.mjs',
  mutations: [
    { name: "квитанция не отправляется",
      pattern: "          await api.sendReadReceipt(sender, content);",
      replacement: "          void 0;" },
    { name: "квитанка уходит БЕЗ msg_ids",
      pattern: "          const content = await crypto.encryptVault(JSON.stringify({ delivered: 1, msg_ids: ids }));",
      replacement: "          const content = await crypto.encryptVault(JSON.stringify({ delivered: 1 }));" },
    { name: "тип квитанки теряется (не delivered)",
      pattern: "JSON.stringify({ delivered: 1, msg_ids: ids })",
      replacement: "JSON.stringify({ read: 1, msg_ids: ids })" },
    { name: "дедуп отключён (квитанка шлётся каждый раз)",
      pattern: "            if (sentMap[env.id]) continue;",
      replacement: "            void 0;" },
    { name: "не-vault-письмо получает квитанцию",
      pattern: "            if (!env || !env.id) continue;",
      replacement: "            if (!env) continue;" },
    { name: "своё письмо получает квитанцию",
      pattern: "        if (!sender || sender.includes(myEmail)) return false;",
      replacement: "        if (!sender) return false;" },
    { name: "письмо без ключа отправителя получает квитанцию",
      pattern: "        return !!identityStore.state.peerKeys[sender];",
      replacement: "        return true;" },
    { name: "при падении SMTP метка не снимается (квитанция не повторится)",
      pattern: "          for (const id of ids) delete sentMap[id];",
      replacement: "          void 0;" },
    { name: "cap 500 отключён (карта растёт без границы)",
      pattern: "    sentMap = Object.fromEntries(entries.slice(0, 500));",
      replacement: "    sentMap = Object.fromEntries(entries);" },
  ],
};
