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
    // ── Два разных 429 (т_b8f44bdf → волна 14): ветка на суточный лимит и
    // на вспышку. Смоук 9-11 проверяет их РАЗНЫМИ утверждениями: одна ветка
    // без своего check живёт зелёной, и «любой 429 = лимит» возвращался бы
    // незаметно (пачка сигналов звонка гасила бы ускорение на сутки).
    { name: "любой 429 снова считается суточным лимитом (вспышка глушит релей на сутки)",
      pattern: "        if (rejection.kind !== 'daily') {",
      replacement: "        if (false) {" },
    { name: "суточный лимит не записывается в kv (pub дёргается до полуночи)",
      pattern: "        await invoke('db_kv_set', { account, key: KV_LIMIT_DAY, value: String(today) }).catch(() => {});",
      replacement: "        await Promise.resolve();" },
    { name: "ветка вспышки отдаёт daily-limit (тот же дефект, но с другой стороны)",
      pattern: "          return { ok: false, why: 'rate-limit' };",
      replacement: "          return { ok: false, why: 'daily-limit' };" },
    { name: "тело ответа не читается (ядро не получает, чем был 429)",
      pattern: "    if (res && typeof res.text === 'function') body = await res.text();",
      replacement: "    body = '';" },
    { name: "ответ ядра принимается только как «rate» (daily-ветка недостижима)",
      pattern: "    if (r && (r.kind === 'daily' || r.kind === 'rate' || r.kind === 'other')) return r;",
      replacement: "    if (r && r.kind === 'rate') return r;" },
    { name: "fail-open без команды моста = «лимит дня» (ускорение гаснет на сутки)",
      pattern: "  return { kind: 'rate', retryAfter: null };",
      replacement: "  return { kind: 'daily', retryAfter: null };" },
    // ── Временные TURN-креды (т_18b4d871, смоук 12). Вне одной Wi-Fi без
    // relay-кандидата звонка нет, поэтому проверяются четыре правила: кэш
    // (не жжём суточную квоту), запас на обновление, срок из ответа релея и
    // тихий отказ вместо сорванного звонка.
    { name: "кэш кредов не используется (каждый звонок тратит квоту издателя)",
      pattern: "    if (stale && stale.expiresAt - now > 120) return stale.creds;",
      replacement: "    void 0;" },
    { name: "запас на обновление съеден (пара доезжает до coturn уже протухшей)",
      pattern: "    if (stale && stale.expiresAt - now > 120) return stale.creds;",
      replacement: "    if (stale && stale.expiresAt > now) return stale.creds;" },
    { name: "срок берётся из головы, а не из ответа (короткий ttl не обновляется)",
      pattern: "      expiresAt: now + (Number(body.ttl) || 3600),",
      replacement: "      expiresAt: now + 3600," },
    { name: "отказ релея роняет креды вместо прежней живой пары (звонок с STUN)",
      pattern: "      return stale && stale.expiresAt > now ? stale.creds : null;",
      replacement: "      return null;" },
    { name: "битый ответ принимается как валидные креды (webrtc-rs отвергает TURN без полей)",
      pattern: "    if (!creds.uris.length || !creds.username || !creds.credential) return null;",
      replacement: "    if (false) return null;" },
    { name: "пустой токен всё равно уходит в релей (401 на каждом звонке)",
      pattern: "    if (!url || !token) return null;",
      replacement: "    if (!url) return null;" },
    { name: "токен в заголовке не передаётся (релей не знает, кому выдавать)",
      pattern: "    const token = (relay && relay.myToken) || '';",
      replacement: "    const token = '';" },
  ],
};
