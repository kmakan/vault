// Тестовый двойник РАЗБОРА/SБОРКИ wire-конверта (Rust) для node-смоуков.
//
// Зачем он, если правило живёт в Rust: смоук проверяет ПРОВОДКУ (что JS ждёт
// разбора и берёт поля), а не сами правила — их проверяют юнит-тесты ядра
// (vault-client/src/vault/envelope.rs, 22 теста).
//
// ТАБЛИЦА ДОЛЖНА СОВПАДАТЬ с Rust. Расхождение здесь не сломает прод (прод
// зовёт Rust), но сделает смоук слепым к изменению правил: при правке Rust
// нужно править и этот файл. Это осознанный размен: мок — источник правды
// для JS-проверок, Rust — для протокола.
//
// Формат: envelope {vault:1, id, text, name, avatar, type?, gavatar?, key, ts,
// pq?, tok?, ttl?, bio?} + poll-подконверт {id?, question, options}.
export function envelopeBuild(args) {
  const env = {
    vault: 1,
    id: args.id || '',
    text: args.text == null ? '' : args.text,
    name: args.name || '',
    avatar: args.avatar || '',
  };
  if (args.msg_type) env.type = args.msg_type;
  if (args.gavatar) env.gavatar = args.gavatar;
  env.key = args.key || '';
  env.ts = args.ts_ms || 0;
  if (args.pq_ek) env.pq = args.pq_ek;
  if (args.tok) env.tok = args.tok;
  if (Number(args.ttl_secs) > 0) env.ttl = Number(args.ttl_secs);
  return JSON.stringify(env);
}

export function envelopeParse(plain) {
  if (!plain || typeof plain !== 'string') return null;
  let obj;
  try { obj = JSON.parse(plain); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.vault !== 1 || typeof obj.text !== 'string') return null;
  const env = {
    id: obj.id || '',
    text: obj.text,
    name: obj.name || '',
    avatar: obj.avatar || '',
    type: obj.type || '',
    ts: obj.ts || 0,
    key: obj.key || '',
    pq: typeof obj.pq === 'string' ? obj.pq : '',
    ttl: Number(obj.ttl) || 0,
    bio: typeof obj.bio === 'string' ? obj.bio : undefined,
    tok: typeof obj.tok === 'string' ? obj.tok : '',
    gavatar: typeof obj.gavatar === 'string' ? obj.gavatar : '',
  };
  if (obj.poll && typeof obj.poll === 'object') {
    env.poll = {
      id: String(obj.poll.id || obj.id || ''),
      question: typeof obj.poll.question === 'string' ? obj.poll.question : '',
      options: Array.isArray(obj.poll.options) ? obj.poll.options.map((o) => String(o)) : [],
    };
  }
  return env;
}

// Устанавливает мок в globalThis.__invokeMock (или в переданный объект).
export function installEnvelopeMock(invokeMock) {
  const prev = invokeMock;
  return async (cmd, args) => {
    if (cmd === 'vault_build_envelope') return envelopeBuild(args || {});
    if (cmd === 'vault_parse_envelope') {
      const f = envelopeParse((args || {}).plain);
      return f === null ? null : f;
    }
    return prev ? prev(cmd, args) : null;
  };
}
