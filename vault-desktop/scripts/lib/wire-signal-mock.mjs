// Тестовый двойник сервисных wire-форматов (Rust) для node-смоуков.
//
// Правила живут в Rust (ADR-005 R1 / W4): vault::call::parse_call_signal,
// vault::signals::parse_dod_data / build_dod_data, vault::envelope::raw_object.
// В node-смоуках моста нет — нужен двойник.
//
// ТАБЛИЦА ДОЛЖНА СОВПАДАТЬ с Rust. Расхождение здесь не сломает прод (прод
// зовёт Rust), но сделает смоук слепым к правке правил: при правке Rust нужно
// править и здесь. Осознанный размен — как с двойником правила звонка
// (scripts/lib/call-state-mock.mjs).
//
// Формат ответа: undefined — команда не наша (зови дальше), иначе значение
// (в т.ч. null — «формат не распознан»).

// ── Сигнал звонка (vault::call::parse_call_signal) ───────────────────────
export function callSignalParse(decrypted) {
  if (!decrypted || typeof decrypted !== 'string') return null;
  let obj;
  try { obj = JSON.parse(decrypted); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.vault !== 1) return null;
  if (typeof obj.type !== 'string' || obj.type.indexOf('call_') !== 0) return null;
  if (typeof obj.call_id !== 'string' || !obj.call_id) return null;
  const sig = {
    id: typeof obj.id === 'string' ? obj.id : '',
    type: obj.type,
    call_id: obj.call_id,
    ts: Number(obj.ts) || 0,
  };
  // Option-поля Rust-структуры: absent, если поля нет (skip_serializing_if).
  for (const k of ['sdp', 'role', 'kemct', 'sender_ek', 'tok']) {
    if (typeof obj[k] === 'string') sig[k] = obj[k];
  }
  return sig;
}

// ── Data-письмо (vault::signals::parse_dod_data) ─────────────────────────
export function dodParse(plain) {
  if (!plain || typeof plain !== 'string') return null;
  let obj;
  try { obj = JSON.parse(plain); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.vault_dod_data !== 1) return null;
  const data = typeof obj.data === 'string' ? obj.data : '';
  if (!data) return null;
  return { ref: typeof obj.ref === 'string' ? obj.ref : '', data };
}

// ── Data-письмо (vault::signals::build_dod_data) ─────────────────────────
export function dodBuild(reference, data) {
  return JSON.stringify({
    vault_dod_data: 1,
    ref: reference == null ? '' : String(reference),
    data: data == null ? '' : String(data),
  });
}

// ── Объект конверта (vault::envelope::raw_object) ────────────────────────
export function envelopeRawObject(text) {
  if (!text || typeof text !== 'string') return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return obj;
}

// ── Роутер сервисных сигналов (vault::signals::parse_signal) ─────────────
// Порядок проверок — как в Rust: реакция → правка → квитанция → голос →
// presence → meta → hav.
export function signalParse(plain) {
  if (!plain || typeof plain !== 'string') return null;
  let obj;
  try { obj = JSON.parse(plain); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const isOne = (k) => obj[k] === 1;
  const str = (k) => (typeof obj[k] === 'string' ? obj[k] : '');

  if (isOne('react') && str('msg_id') && str('emoji')) {
    return { kind: 'reaction', msg_id: str('msg_id'), emoji: str('emoji'), action: str('action') === 'remove' ? 'remove' : 'add' };
  }
  if (isOne('edit') && str('msg_id')) {
    return {
      kind: 'edit',
      msg_id: str('msg_id'),
      text: str('text'),
      action: str('action') === 'delete' ? 'delete' : 'edit',
      ts: Number(obj.ts) || 0,
      sender: str('sender'),
    };
  }
  if ((isOne('read') || isOne('delivered')) && Array.isArray(obj.msg_ids)) {
    return {
      kind: 'ack',
      level: isOne('read') ? 'read' : 'delivered',
      msg_ids: obj.msg_ids.map((v) => (typeof v === 'string' ? v : String(v))),
    };
  }
  if (isOne('poll') && str('poll_id')) {
    return { kind: 'poll_vote', poll_id: str('poll_id'), option: Number(obj.option) || 0 };
  }
  if (isOne('presence')) return { kind: 'presence', ts: Number(obj.ts) || 0 };
  if (isOne('meta')) return { kind: 'group_meta', avatar: str('avatar'), name: str('name'), ts: Number(obj.ts) || 0 };
  if (isOne('hav')) return { kind: 'group_avatar_heal' };
  return null;
}

// ── Канальный конверт (vault::channels::parse_channel_envelope) ─────────
export function channelParse(plain) {
  if (!plain || typeof plain !== 'string') return null;
  let obj;
  try { obj = JSON.parse(plain); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.channel !== 1) return null;
  const str = (k) => (typeof obj[k] === 'string' ? obj[k] : '');
  const env = {
    chan: str('chan'),
    id: str('id'),
    is_meta: obj.meta === 1,
    is_hello: obj.hello === 1,
    has_post: false,
    post_body: '',
    post_images: [],
    name: str('name'),
    avatar: str('avatar'),
    owner_fpr: str('owner_fpr'),
    ts: Number(obj.ts) || 0,
  };
  // about отсутствует, а не null (вызывающий проверяет «поле было?»).
  if (typeof obj.about === 'string') env.about = obj.about;
  if (obj.post !== undefined && obj.post !== null && obj.post !== false) {
    env.has_post = true;
    if (typeof obj.post === 'object') {
      env.post_body = typeof obj.post.body === 'string' ? obj.post.body : '';
      env.post_images = Array.isArray(obj.post.images) ? obj.post.images.map((v) => String(v)) : [];
    }
  }
  return env;
}

// ── Идентификатор из конверта (vault::envelope::id_of) ───────────────────
// Значение поля id — как есть (нулевой id валиден); нет поля или null —
// пустая строка.
export function envelopeIdOf(text) {
  if (!text || typeof text !== 'string') return '';
  let obj;
  try { obj = JSON.parse(text); } catch { return ''; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  if (obj.id === undefined || obj.id === null) return '';
  return obj.id;
}

// ── Диспетчер мостовых команд ───────────────────────────────────────────
export function wireSignalHandler(cmd, args) {
  const a = args || {};
  if (cmd === 'call_parse_signal') return callSignalParse(a.decrypted);
  if (cmd === 'vault_parse_signal') return signalParse(a.plain);
  if (cmd === 'vault_envelope_id') return envelopeIdOf(a.text);
  if (cmd === 'vault_parse_channel_envelope') return channelParse(a.plain);
  if (cmd === 'vault_parse_dod_data') return dodParse(a.plain);
  if (cmd === 'vault_build_dod_data') return dodBuild(a.reference, a.data);
  if (cmd === 'vault_envelope_object') return envelopeRawObject(a.text);
  return undefined; // не наша команда
}

// ── Обёртка для чужого invoke ────────────────────────────────────────────
// Нужна смоукам, у которых мост лежит не в globalThis.__invokeMock, а в своём
// объекте (например __tauri.invoke): правила сервисных форматов должны
// работать в любом случае, иначе смоук молча проверяет не то.
export function wrapInvoke(fn) {
  return async (cmd, args) => {
    const v = wireSignalHandler(cmd, args);
    return v !== undefined ? v : fn(cmd, args);
  };
}
