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
//
// ВАЖНО про имена аргументов: мок принимает их в camelCase — ровно как
// ждёт Tauri v2. Если читать их в snake_case, смоуки будут проверять не тот
// путь, который реально работает: мост snake_case от JS молча теряет, и
// конверт уходит без типа (SOS, сигналы звонков) — а тесты зелёные.
export function envelopeBuild(args) {
  // Имена аргументов — camelCase: так их ждёт Tauri v2 (он сам переводит их
  // в snake_case для Rust). Мок раньше читал snake_case — и тем самым
  // закреплял СЛОМАННУЮ схему: смоуки проходили, хотя реальный мост терял
  // тип конверта и PQ-ключ. Из-за этого SOS-конверт уходил без type, а
  // сигналы звонка (msg_type=call_request) — без типа, то есть получатель
  // не опознавал их как звонок.
  const camel = (snake) => snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  const a = {};
  for (const [k, v] of Object.entries(args || {})) a[camel(k)] = v;
  const env = {
    vault: 1,
    id: a.id || '',
    text: a.text == null ? '' : a.text,
    name: a.name || '',
    avatar: a.avatar || '',
  };
  if (a.msgType) env.type = a.msgType;
  if (a.gavatar) env.gavatar = a.gavatar;
  env.key = a.key || '';
  env.ts = a.tsMs || 0;
  if (a.pqEk) env.pq = a.pqEk;
  if (a.tok) env.tok = a.tok;
  if (Number(a.ttlSecs) > 0) env.ttl = Number(a.ttlSecs);
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
