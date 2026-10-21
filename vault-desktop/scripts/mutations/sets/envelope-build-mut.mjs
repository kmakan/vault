// Набор мутаций: envelope-build-mut
// Цель: убедиться, что смоук envelope-build-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'envelope-build-mut',
  file: 'src/features/envelope-build.js',
  smoke: 'envelope-build-smoke.mjs',
  mutations: [
    { name: "наш email уходит как имя (получатель перезапишет имя почтой)",
      pattern: "  const name = dn && dn !== deps.email() ? dn : '';",
      replacement: "  const name = dn || '';" },
    { name: "актуальный аватар из kv игнорируется (письмо уйдёт со старым аватаром)",
      pattern: "    if (kp && kp.avatar) avatar = kp.avatar;",
      replacement: "    void 0;" },
    // Мутация должна быть ЗНАЧИМОЙ: предыдущая (gavatar и в 1:1) меняла
    // поведение только в невозможном состоянии (чат 1:1 при открытой группе)
    // и потому не ловилась смоуком — а набор, который ничего не проверяет,
    // хуже отсутствующего.
    { name: "аватар группы не прикладывается (участники не видят аватар группы)",
      pattern: "    try { gavatar = (await db.kvGet('anon', 'group-avatar:' + deps.currentGroup().id)) || ''; }",
      replacement: "    try { gavatar = ''; }" },
    { name: "сжатие аватара пропускается (письмо не пройдёт по лимиту)",
      pattern: "  avatar = await deps.shrinkAvatar(avatar);",
      replacement: "  void 0;" },
    { name: "ttl теряется (исчезающие сообщения не исчезнут)",
      pattern: "    ttlSecs: Number(ttl) || 0,",
      replacement: "    ttlSecs: 0," },
    { name: "ключ не попадает в конверт (получатель не сможет ответить)",
      pattern: "    key: crypto.publicKey || '',",
      replacement: "    key: ''," },
  ],
};
