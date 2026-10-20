// Набор мутаций: relay-client-mut
// Цель: убедиться, что смоук relay-client-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'relay-client-mut',
  file: 'src/relay-client.js',
  smoke: 'relay-client-smoke.mjs',
  mutations: [
    { name: "http-релей принимается (только https)",
      pattern: "  if (!/^https:\\/\\//.test(u)) return null; // только https",
      replacement: "  if (false) return null;" },
    { name: "keep не отправляется при перерегистрации (адрес очереди меняется)",
      pattern: "        ...(keep ? { keep } : {}),",
      replacement: "        ...(keep ? {} : {})," },
    { name: "fp не отправляется с заявкой",
      pattern: "        fp: fp || '',",
      replacement: "        fp: ''," },
    { name: "рингтон не отправляется (звонок без звука на сервере)",
      pattern: "        ringtone: await preferredRingtoneUrl(account),",
      replacement: "        ringtone: ''," },
    { name: "токен ответа не сохраняется",
      pattern: "    await saveRelays(account, list);",
      replacement: "    void 0;" },
    { name: "старый токен не отправляется (keep всегда пуст)",
      pattern: "    const keep = (ours && ours.myToken) || '';",
      replacement: "    const keep = '';" },
    { name: "наш релей не ставится первым в списке",
      pattern: "    list.unshift({ url: DEFAULT_RELAY_URL, myToken: d.token, label: 'Vault' });",
      replacement: "    list.push({ url: DEFAULT_RELAY_URL, myToken: d.token, label: 'Vault' });" },
  ],
};
