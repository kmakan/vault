// Feature module: входящие конверты (router). Этап 4 декомпозиции App.vue —
// единая точка классификации всех входящих писем/relay-конвертов.
// Зависимости приходят ЯВНО объектом `deps` (ADR-005 R3): в W1 модуль перестал
// читать компонент как `ctx`, поэтому у него больше нет доступа к состоянию,
// которого нет в контракте. Контракт собирается в одном месте —
// `App.vue:processIncoming`. `groups` и `channels` передаются ГЕТТЕРАМИ, а не
// снимком: во время батча ренейм адреса вызывает loadGroups, который
// ПЕРЕПРИСВАИВАЕТ массив, и снимок показал бы устаревший список (следующие
// письма батча не нашли бы группу и не посчитались).
//
// Семантика перенесена 1:1 из App.vue:processIncoming —
// без изменения логики (три хрупких инварианта: ignore-continue ДО
// расшифровки и ДО дедупа; эхо/профиль — seen, но не уведомление;
// разделение дедупа счётчика и дедупа уведомления, регресс 2fa9103).
//
// Расширение новым типом конверта: тип объявляется в Rust-классификаторе
// (vault-client/src/vault/incoming.rs) и закрепляется кейсом в общей фикстуре;
// здесь добавляется только ЭФФЕКТ. Ветвиться на «что это за конверт» в JS
// нельзя — это протокольное решение (ADR-005 R1, W1 `t_2243231f`).

import * as WireSignalRule from '../wire-signal-rule.js';
import { uiStore } from "./session-store.js";
import api from '../api.js';
import crypto from '../crypto.js';
import * as relay from '../relay-client.js';
import { notifyNewMessage } from '../notify.js';
import * as PresenceFeature from './presence.js';
// ADR-004 J.6: владелец peer-ключей — прямой импорт, БЕЗ deps.
import { identityStore } from './identity-store.js';
// W1 (ADR-005 R1): решение «что это за письмо» — в Rust. `invoke` до W1 здесь
// вообще не был импортирован, хотя вызывался для vault_store_incoming_message:
// ReferenceError глотался catch'ем, и персист в Rust MessageStore не работал.
import { invoke } from '@tauri-apps/api/core';

const MAX_POOL = 50;          // писем за один прогон (как было)
const FRESH_WINDOW_MS = 15 * 60 * 1000;

// ── Решение «что это за письмо» — в Rust (ADR-005 R1, эпик W1) ─────────────
// До W1 роутер решал сам: `parseCallSignal` / `presence === 1` /
// `parseEnvelope` / `channel === 1` / `hav === 1`. Это были ДУБЛИ решений
// Rust-классификатора, и расходились они молча. Теперь решение одно —
// `vault_classify_incoming`; в JS остаются только эффекты (обработчик звонка,
// presence, сохранение профиля, тосты/бейджи, кэш тел).
//
// Паритет закреплён фикстурой `vault-client/tests/fixtures/m0-wire-contract.json`
// (гейты `cargo test --test m0_wire_contract` и `npm run smoke:m0-wire`):
// «Rust-ветка» и «JS-ветка» не могут разойтись незаметно.
//
// Возврат: `{kind,...}` — решение; `null` — не наше письмо; `undefined` — мост
// упал. Разница принципиальная: `null` окончателен, письмо можно забыть;
// `undefined` значит «не смогли решить», письмо НЕ помечается обработанным и
// поллинг повторит его. Глотать отказ моста в `null` — терять почту тихо.
async function classifyPlain(plain, from) {
  try {
    return await invoke('vault_classify_incoming', { input: { from, decrypted: plain } });
  } catch (e) {
    console.error('[classify] Rust-классификатор недоступен — письмо останется необработанным:', e && e.message || e);
    return undefined;
  }
}

// Сравнение писем для разбора батча: ХРОНОЛОГИЯ, старые первыми.
// Ключ 1 — Date-заголовок (UID между папками несравнимы: в INBOX и в Спам
// счётчики свои), ключ 2 — UID как число (в пределах папки это порядок
// доставки). Строковое сравнение UID не годится: '9' > '10' лексически.
function byArrival(a, b) {
  const ta = Date.parse(a.date || '') || 0;
  const tb = Date.parse(b.date || '') || 0;
  if (ta !== tb) return ta - tb;
  const ua = Number(a.uid || a.id) || 0;
  const ub = Number(b.uid || b.id) || 0;
  if (ua !== ub) return ua - ub;
  return 0;
}

// ── Драйвер: батч-доставка тел по папкам + цикл классификации ──────────────
export async function processIncoming(deps, fetched, opts = {}) {
  const { notify = false } = opts;
  if (!fetched || !fetched.length || !deps.cryptoReady) return;
  const myEmail = (deps.email || '').toLowerCase();
  // Срез ДО сортировки: MAX_POOL отбирает 50 НОВЕЙШИХ писем батча (как было).
  // ПОРЯДОК РАЗБОРА — хронологический, а не «как вернул IMAP».
  // Rust отдаёт батч новыми сверху (email.rs: sort_by(|a,b| b.id.cmp(&a.id)) —
  // в fetch_folder и в fetch_newer), и processIncoming шёл по нему как есть.
  // Для обычных писем порядок безразличен (дедуп по env.id/Message-ID+папка
  // идемпотентен), но для звонка он был фатальным: в одном батче call_cancel
  // (UID больше, пришёл позже) разбирался ПЕРВЫМ и успевал записать call_id
  // в persist kv 'call-seen' (calls.js: case 'call_cancel' → rememberCallSeen),
  // после чего call_request с тем же call_id гас на гварде isCallSeen —
// без рингтона, без экрана, без «пропущенного». Обратный порядок даёт
  // корректный сценарий: звонок успевает зазвонить и сразу гаснет по своему
  // же отбою. См. docs/CALL-MAIL-PATH-DIAGNOSIS.md §3 (слой 3), t_674c770f.
  const pool = fetched.slice(0, MAX_POOL).slice().sort(byArrival);
  await ensureBodies(deps, pool);
  for (const m of pool) {
    const from = deps.senderEmail(m.from);
    // Пропускаем исходящие (от себя) и пустые from.
    if (!from || from === myEmail) continue;
    const cls = await routeLetter(deps, m, from);
    if (cls === null) continue;
    if (cls.kind === 'message') {
      // M1.10: persist classified message via Rust MessageStore bridge
      if (cls.msg) {
        try {
          await invoke('vault_store_incoming_message', {
            chatKey: cls.chatKey || null,
            from: cls.msg.from,
            envId: cls.msg.id || cls.envId || null,
            plain: JSON.stringify(cls.msg),
          });
        } catch (e) {
          console.warn('[vault_bridge] store_incoming failed:', e && e.message || e);
        }
      }
      await countAndNotify(deps, m, cls, { notify });
    }
  }
}

// Тела: добираем недостающие батчем по папкам (как sendDeliveredReceipts).
// Download-on-demand: письма крупнее 2МБ пропускаем — их содержимое
// подтягивается по клику с карточки вложения, а не в фоне поллинга.
async function ensureBodies(deps, pool) {
  const byFolder = {};
  for (const m of pool) {
    const f = m.folder || 'INBOX';
    (byFolder[f] = byFolder[f] || []).push(m);
  }
  for (const [folder, msgs] of Object.entries(byFolder)) {
    const missing = msgs.filter(m =>
      deps.emailBodyCache[`${folder}:${m.uid || m.id}`] === undefined
      && (m.size || 0) <= 2 * 1024 * 1024
    );
    if (!missing.length) continue;
    try {
      const bodies = await api.fetchBodiesDbFirst(folder, missing.map(m => m.uid || m.id));
      for (const m of missing) {
        const b = bodies ? bodies[String(m.uid || m.id)] : undefined;
        if (b) deps.cacheBody(`${folder}:${m.uid || m.id}`, b);
      }
    } catch (e) { /* тела не обязательны — классификация тихо пропустит */ }
  }
}

// ── Классификация одного письма ────────────────────────────────────────────
// Возвращает {kind:'message', chatKey, title, envId} для сообщения,
// null — если письмо не должно попасть в счётчик/уведомления (в т.ч. после
// выполнения побочных эффектов: call-сигнал, профиль, миграция).
async function routeLetter(deps, m, from) {
  const { isBounceMessage, bounceRecipients, bounceReason, ingestChannelEnvelope } = deps;
  // Ignore-лист: сообщения/звонки заблокированного скрыты у получателя
  // целиком — не считаются, не уведомляют, в историю не пишутся
  // (continue ДО расшифровки и ДО дедуп-механики: письмо остаётся
  // «необработанным» и после разблокировки не всплывёт).
  if (deps.isIgnored(from)) return null;

  const body = deps.emailBodyCache[`${m.folder || 'INBOX'}:${m.uid || m.id}`] || '';

  // Служебное письмо о НЕДОСТАВКЕ (DSN / bounce). Проверяем ДО
  // crypto.isEncrypted: DSN — обычный текст, и раньше он молча отбрасывался.
  // Цена ошибки: письмо-вызов отбито провайдером, а вызов висит в гудках до
  // таймаута и пишет «нет ответа», хотя до собеседника ничего не дошло
  // (инцидент 12.10.2026). Теперь баунс гасит исходящий вызов сразу — но
  // только если релей-копия НЕ была принята (см. calls.js: onMailBounce:
  // relayDelivered). Баунс дубля-письма живой (релейный) вызов не рвёт.
  if (isBounceMessage(from, m.subject)) {
    const recipients = bounceRecipients(body);
    const reason = bounceReason(body);
    console.log('[mail] bounce: recipients=' + (recipients.join(',') || '?')
      + ' reason=' + (reason || '?'));
    try { await deps.onMailBounce(recipients, reason); }
    catch (e) { console.warn('[mail] bounce handling failed:', e && e.message || e); }
    return null; // служебное письмо: не сообщение, в счётчик/уведомления не идёт
  }

  if (!body || !crypto.isEncrypted(body)) return null;

  let chatKey = null; // email (1:1) или 'group:<id>'
  let title = '';
  let envId = ''; // id конверта (общий для relay-копии и email-копии)

  // 1:1 — расшифровка пир-ключом.
  if (deps.peerKeys[from]) {
    try {
      crypto.setPeerPublicKey(deps.peerKeys[from], deps.peerPqKeys && deps.peerPqKeys[from]);
      const plain = await crypto.decryptVault(body);
      // Тип письма решает Rust (W1). undefined — мост упал: письмо не наше
      // дело в этом прогоне, но и «обработанным» оно не станет.
      const cls = await classifyPlain(plain, from);
      if (cls === undefined) return null;
      // Звонки (M3): call_* конверты — сигналы, НЕ сообщения (не в
      // бейджи, не в уведомления) — уходят в state machine звонка.
      // AWAIT (было fire-and-forget): handleCallSignal внутри ходит в
      // persist kv 'call-seen' (isCallSeen/rememberCallSeen), и при
      // параллельном запуске двух сигналов одного call_id (request + его
      // cancel в одном батче) терминальный успевал записать kv РАНЬШЕ,
      // чем request дочитал свой isCallSeen, — звонок гас без рингтона.
      // Порядок разбора батча (processIncoming: byArrival) + последовательный
      // await дают request → cancel строго по порядку доставки.
      if (cls && cls.kind === 'call') {
        // Разбор сигнала — в Rust (ADR-005 R1 / W4); JS получает готовые поля.
        const callSig = await deps.parseCallSignal(plain);
        try { await deps.handleCallSignal(callSig, from); }
        catch (e) { console.warn('[call] signal failed:', e); }
        return null;
      }
      // Presence (M2): heartbeat «я онлайн» от пира — точка загорается сразу,
      // без открытия чата (kind=presence Rust выдаёт до «это конверт»).
      if (cls && cls.kind === 'presence') {
        PresenceFeature.noteHeartbeat(deps.noteSeen, deps.canonicalOf(from) || from, new Date(m.date || Date.now()).getTime());
        console.log('[presence] heartbeat from', from);
        return null; // не сообщение, не уведомление
      }
      const env = cls && (cls.kind === 'message' || cls.kind === 'profile')
        ? await deps.parseEnvelope(plain)
        : null;
      if (env) {
        // env.id — ключ кросс-канального дедупа (relay-копия и
        // email-копия одного сообщения несут ОДИН конверт).
        if (env.id) envId = String(env.id);
        // M2.4 АВТООБМЕН токенами: конверт несёт tok отправителя
        // (адрес его relay-очереди) — сохраняем молча, чтобы
        // отвечать ему мгновенными пушами. Ноль ручного ввода.
        if (env.tok) {
          try {
            const rs = await relay.getSettings(deps.email);
            const r = rs.relays[rs.active] || rs.relays[0];
            if (r) {
              const known = (rs.peers[r.url] || {})[String(from).toLowerCase()];
              
              // Resolve peer fingerprint from the sender's public key (env.key)
              let peerFp = null;
              try {
                if (env.key) {
                  peerFp = await relay.fingerprintOf(env.key);
                }
              } catch (e) {
                // If fingerprint resolution fails, continue without fp
                peerFp = null;
              }
              
              if (known !== env.tok) {
                await relay.setPeerToken(deps.email, r.url, from, env.tok, peerFp);
                console.log('[relay] peer token auto-learned:', from, peerFp ? '(fp: ' + peerFp + ')' : '');
              }
            }
          } catch (e) { /* релей опционален */ }
        }
        // ЭХО-ЗАЩИТА: письмо с МОИМ ключом — это я сам
        // (старый адрес после смены почты / копия в свой ящик).
        // Не профиль, не сообщение, не «смена почты» — иначе свой же
        // аватар перезаписывается старым из собственного письма.
        if (env.key && crypto.publicKey && env.key === crypto.publicKey) {
          deps.processedUnreadIds.add(m.uid + '|' + (m.folder || 'INBOX'));
          return null;
        }
        // Смена почты: письмо могло прийти со старого адреса
        // контакта (алиаса) — чат ведём по каноническому (показываемому).
        chatKey = deps.canonicalOf(from) || from;
        // Имя для заголовка: локальное переопределение пользователя →
        // свежее из профиля письма (env.name) → nameOf(). НЕ contact.name —
        {
          const lpn = deps.localProfileOf(from);
          title = (lpn && lpn.name) || env.name || deps.nameOf(from);
        }
        // Профиль отправителя: имя/аватар/«О себе» — сохраняем
        // СРАЗУ при поллинге, не дожидаясь открытия чата.
        // «Это письмо профиля» решает Rust (kind=profile), а не сверка полей.
        if (cls.kind === 'profile' || env.name || env.avatar || typeof env.bio === 'string') {
          api.saveProfile(from, env.name, env.avatar, env.ts || 0,
            typeof env.bio === 'string' ? env.bio : undefined);
          if (cls.kind === 'profile') { deps.processedUnreadIds.add(m.uid + '|' + (m.folder || 'INBOX')); return null; }
        }
      }
    } catch (e) { /* не наше письмо */ }
  } else if (crypto.isEncrypted(body)) {
    // Смена почты: отправитель сменил адрес, но ключ тот же.
    // Ключ под НОВЫМ email ещё не зарегистрирован — ищем его среди
    // известных peerKeys (fingerprint-матчинг) и привязываем новый адрес.
    try {
      let matched = null;
      for (const [knownEmail, knownKey] of Object.entries(deps.peerKeys)) {
        if (String(knownEmail).toLowerCase() === from) continue;
        crypto.setPeerPublicKey(knownKey);
        try {
          const plain = await crypto.decryptVault(body);
          // Тип письма — Rust (W1). ЗВОНОК под ещё не известным адресом:
          // конверт расшифрован ключом пира, но это сигнал, а не письмо
          // личности. Раньше сигнал отличался тем, что `parseCallSignal` его
          // узнавал, а `parseEnvelope` нет; теперь это одно решение Rust.
          // Сигнал, ушедший в ветку «смена почты», терялся (регресс 25dd18a).
          const cls = await classifyPlain(plain, knownEmail);
          if (cls === undefined) return null; // мост упал — письмо не трогаем
          if (cls && cls.kind === 'call') {
            // Адрес для state machine — ИЗВЕСТНЫЙ адрес пира (knownEmail),
            // а не сырой `from`: иначе currentCall.peer = 'fp:…' и все
            // ответные конверты идут на несуществующий SMTP-адрес.
            console.log('[call] signal from new address', from, '— пир известен как', knownEmail);
            try { await deps.handleCallSignal(await deps.parseCallSignal(plain), knownEmail); }
            catch (e) { console.warn('[call] signal failed:', e); }
            return null;
          }
          const env = cls && (cls.kind === 'message' || cls.kind === 'profile')
            ? await deps.parseEnvelope(plain)
            : null;
          // Эхо-защита: письмо с моим ключом — от меня (старый адрес),
          // НЕ «смена почты» собеседника.
          if (env && env.key === knownKey && !(crypto.publicKey && env.key === crypto.publicKey)) {
            matched = { knownEmail, plain, env, kind: cls.kind }; break;
          }
        } catch (e) { /* не этим ключом */ }
      }
      if (matched) {
        // ANTI-PING-PONG: старое письмо (ts ≤ порога) не переименовывает
        // назад — пропускаем обработку целиком (содержимое уже в истории).
        const _idTs = new Date(m.date || 0).getTime() || 0;
        if (!(await api.identityLetterFresh(matched.env.key, _idTs))) {
          console.log('[identity] stale letter — rename skipped (poll):', from, '→', matched.knownEmail);
          return null;
        }
        console.log('[identity] fingerprint match:', matched.knownEmail, '→', from, '— смена почты (poll)');
        // ПОЛНЫЙ ренейм личности — паритет с путём из App.vue (loadMessages):
        // списки пометок, alias-словарь, relay-токены, счётчики, профиль,
        // история. Без этого слои рассинхронизировались: имя/почта расходились,
        // группы и пометки откатывались на старый адрес (живые данные 08.10).
        await api.renamePeerIdentity(matched.knownEmail, from);
        // Группы: переименовать адрес участника во всех, где он числится.
        await deps.migratePeerGroups(matched.knownEmail, from);
        // Переносим историю чата по ВСЕЙ цепочке алиасов, а не только со
        // старого адреса. Если пир менял почту дважды и приложение не работало
        // в первый раз, одного переноса мало: chat-cache самого первого адреса
        // осиротел бы, и переписка исчезла бы молча (ADR-003 §5.1).
        await deps.migrateChatHistoryChain(from, deps.email, deps.contactAliases);
        // СТАРЫЙ адрес убираем из всех хранилищ — иначе второй контакт
        // с тем же ключом (порядок: до setPeerKey, как в App.vue).
        if (String(matched.knownEmail).toLowerCase() !== String(from).toLowerCase()) {
          try { await crypto.removePeerKey(matched.knownEmail); } catch (e) { /* ignore */ }
          // Удаление — через владельца identity (ADR-004 J.6), БЕЗ deps.
          identityStore.removePeerKey(matched.knownEmail);
          api.removeContact(matched.knownEmail);
          api.deleteProfile(matched.knownEmail);
        }
        deps.setPeerKey(from, matched.env.key, matched.env.pq || null);
        // Порог ренейма = дата этого (свежего) письма.
        await api.bumpIdentityRenameTs(matched.env.key, _idTs);
        // Профиль со старого адреса переносим на новый.
        const oldProf = deps.profiles[matched.knownEmail];
        if (oldProf) api.saveProfile(from, oldProf.name, oldProf.avatar, matched.env.ts || 0);
        // «Это письмо профиля» — решение Rust (kind пира, совпавшего по ключу).
        if (matched.kind === 'profile' || matched.env.name || matched.env.avatar || typeof matched.env.bio === 'string') {
          api.saveProfile(from, matched.env.name, matched.env.avatar, matched.env.ts || 0,
            typeof matched.env.bio === 'string' ? matched.env.bio : undefined);
        }
        chatKey = deps.canonicalOf(from) || from;
        const lp = deps.localProfileOf(from);
        title = (lp && lp.name) || from;
        if (matched.kind === 'profile') { deps.processedUnreadIds.add(m.uid + '|' + (m.folder || 'INBOX')); return null; }
      }
    } catch (e) { /* не наше письмо */ }
  }

  // Каналы (M2): расшифровка канальным ключом. Отправитель — владелец
  // канала (или наш эхо-пост, если мы владелец и письмо ушло себе в копию).
  // В отличие от групп, отправитель НЕ обязан быть в members-списке —
  // подписчик не знает других подписчиков; авторизация = знание ключа.
  if (!chatKey) {
    for (const ch of (deps.channels() || [])) {
      if (!ch.key) continue;
      try {
        const plain = await crypto.decryptWithGroupKey(body, ch.key);
        // Канальный конверт — решение Rust (`channel===1`), не проверка полей в JS.
        const cls = await classifyPlain(plain, from);
        if (cls === undefined) return null; // мост упал — письмо не трогаем
        if (!cls || cls.kind !== 'channel') continue; // не канал — мимо
        // ФОРМАТ КАНАЛЬНОГО КОНВЕРТА — В RUST (ADR-005 R1 / W4): «это канал»
        // и набор его полей решает ядро (vault::channels::parse_channel_envelope).
        const robj = await WireSignalRule.parseChannelEnvelope(plain);
        const applied = ingestChannelEnvelope(robj, from);
        if (applied) {
          console.log('[channel] envelope', applied, 'from', from, 'chan', ch.id);
          // post — как сообщение (бейдж+пуш); meta/hello — тихие
          if (applied === 'post') {
            return { kind: 'message', chatKey: 'channel:' + ch.id, title: ch.name || '', envId: String(robj.id || '') };
          }
          return null;
        }
      } catch (e) { /* не канал — мимо */ }
    }
  }

  // Группы — ключом группы, где отправитель участник (1:1-ключ не пройдёт).
  // MEMBERSHIP ПО FINGERPRINT: отправитель может быть участником
  // под СТАРЫМ адресом (сменил почту). Если from не найден среди email,
  // но pubkey конверта совпадает с peerKey одного из участников —
  // мигрируем адрес в составе группы (groups_rename_member) и считаем
  // участником. Без этого письмо от сменившего почту молча терялось
  if (!chatKey) {
    for (const g of deps.groups()) {
      let members = (g.members || []).map(x => String(x.email || '').toLowerCase());
      if (!members.includes(from)) {
        // Ошибку ПРОГРАММИРОВАНИЯ в tryMigrateGroupMember ловим здесь, а не
        // пропускаем: выше нет защиты, и необработанный бросок оборвал бы весь
        // батч входящих писом. Но ловим ГРОМКО и с маркером — этот catch не
        // должен выглядеть как обычный путь «переезжать нечего» (ADR-003 §5.2).
        // Группы продолжаем обходить: сломанная одна не должна блокировать
        // переезд в остальных.
        let migrated;
        try {
          migrated = await deps.tryMigrateGroupMember(g, from);
        } catch (err) {
          migrated = false;
          console.error('[groups] tryMigrateGroupMember упал — группа', g.id,
            'оставлена как есть, возможен дубль участника:', err && err.message || err);
        }
        if (!migrated) continue;
        members = (g.members || []).map(x => String(x.email || '').toLowerCase());
      }
      if (!members.includes(from)) continue;
      let gk = deps.groupKeys[g.id];
      if (!gk && deps.cryptoReady) {
        try {
          const kd = await api.getMyGroupKey(g.id);
          if (kd && kd.group_key) { deps.setGroupKey(g.id, kd.group_key); gk = kd.group_key; }
        } catch (e) { /* ключ недоступен */ }
      }
      if (!gk) continue;
      try {
        const plain = await crypto.decryptWithGroupKey(body, gk);
        // Тип письма — Rust (W1): hav-запрос, сообщение или не наше.
        const cls = await classifyPlain(plain, from);
        if (cls === undefined) return null; // мост упал — письмо не трогаем
        if (cls && cls.kind === 'group-service') {
          // Сервис-письма группы: hav = запрос аватарки — отвечаем владельцу
          // аватара (24ч rate-limit внутри replyGroupAvatarHeal).
          console.log('[classify] hav seen:', g.id);
          await deps.replyGroupAvatarHeal(g.id);
          return null;
        }
        const env = cls && (cls.kind === 'message' || cls.kind === 'profile')
          ? await deps.parseEnvelope(plain)
          : null;
        if (env) {
          // Самовосстановление аватарки группы из конверта сообщения
          // (guard на непустое — внутри метода).
          if (env.gavatar) await deps.healGroupAvatarFromMessage(g.id, env.gavatar);
          chatKey = 'group:' + g.id; title = g.name || '';
          // env.id — ключ кросс-канального дедупа (relay-копия и
          // email-копия одного сообщения несут ОДИН конверт).
          if (env.id) envId = String(env.id);
          break;
        }
      } catch (e) { /* не из этой группы */ }
    }
  }

  // Квитанции/инвайты/meta/legacy — не сообщения, не считаем и не шлём.
  if (!chatKey) return null;
  // M1.10: минимум для Rust MessageStore bridge (dedup по envId).
  // plain (payload) недоступен здесь — const в try-scope; полную
  // персист получает db_history_save. bridge = parity с CLI M1.8.1.
  let msg = {
    id: envId || m.message_id || (m.uid + "|" + (m.folder || "INBOX")),
    from,
    to: deps.email || "",
    ts: m.date ? Math.floor(new Date(m.date).getTime()) : 0,
    text: "",
    name: "",
    avatar: "",
    reactions: [],
    edited: false,
    replies: [],
    in_reply_to: null,
    ttl: null,
  };
  return { kind: 'message', chatKey, title, envId, msg };
}

// ── Хвост: дедуп + счётчик + уведомление ─────────────────────────────────
async function countAndNotify(deps, m, cls, { notify }) {
  const { chatKey, title, envId } = cls;
  // Дедуп: письмо уже учтено ранее (повторный фетч) — пропускаем,
  // иначе счётчик непрочитанных рос бы на каждом поллинге.
  const mid = m.uid + '|' + (m.folder || 'INBOX');
  // Дедуп по Message-ID: одно и то же письмо
  // приходит с РАЗНЫМИ ключами uid|folder — копия из INBOX и копия из
  // [Gmail]/All Mail имеют разные uid → два уведомления на письмо
  // (монитор + JS-поллинг гонят параллельно). Message-ID глобален.
  const dk = m.message_id ? 'mid:' + m.message_id : mid;
  // Кросс-канальный дедуп: relay-конверт (uid rl-*) и email-копия несут
  // ОДИН конверт с одним env.id. Без этого ключа бейдж группы рос дважды —
  // relay-копия приходила за ~1с, email через 30-60с, и обе считались
  // «новыми письмами» (uid разных каналов не пересекаются).
  const ek = envId ? 'env:' + envId : null;
  // дедуп СЧЁТЧИКА
  // (processedUnreadIds) не имеет права блокировать УВЕДОМЛЕНИЕ.
  // В 2fa9103 здесь стоял `continue` — тихий поллинг (notify=false)
  // первым «съедал» письмо, заносил mid:<Message-ID> в персистный
  // дедуп, и последующее push-событие монитора (notify=true) молча
  // пропускалось: пуш не появлялся НИКОГДА. Теперь счётчик растёт
  // только для новых писем, а уведомление дедупится НЕЗАВИСИМО —
  // персист notifiedIds в notify.js (ключ dk = Message-ID).
  const counted = !(deps.processedUnreadIds.has(mid) || deps.processedUnreadIds.has(dk) || (ek && deps.processedUnreadIds.has(ek)));
  if (counted) {
    deps.processedUnreadIds.add(mid);
    deps.processedUnreadIds.add(dk);
    if (ek) deps.processedUnreadIds.add(ek);
    if (deps.processedUnreadIds.size > 600) {
      // Держим хвост: выкидываем старые (Set в порядке вставки).
      for (const old of deps.processedUnreadIds) {
        deps.processedUnreadIds.delete(old);
        if (deps.processedUnreadIds.size <= 500) break;
      }
    }
    await deps.saveUnreadSeen();
  }
  const fresh = Date.now() - new Date(m.date || 0).getTime() < FRESH_WINDOW_MS;
  // Счётчик непрочитанных: для новых писем, кроме видимого сейчас чата.
  if (counted && !deps.chatVisible(chatKey)) {
    deps.incUnread(chatKey);
    await deps.saveUnreadCounts();
  }
  // Уведомление: только тихий поллинг, только свежие письма (старые
  // задержанные/догоняющие письма спамом не считаем) и только когда
  // чат НЕ виден (на mobile activeChat может хранить прошлый чат, пока
  // пользователь на списке контактов — иначе уведомление теряется).
  // Пара-фикс (0.1.164): гейт `!this.ecoMode` СНЯТ. Локальная нотификация
  // в эко-режиме при живом процессе — единственный путь уведомления
  // (ntfy-клиента может не быть), а дублей нет: серверный last_seen-гейт
  // (relay_pub) не шлёт ntfy-будильник получателю, который сам поллил
  // за последние 90с — эко-тикер поллит каждые 5с. Пара изменений
  // (сервер+клиент) деплоится строго вместе: сервер без клиента = ноль
  // уведомлений в эко+фон, клиент без сервера = дубли в эко+открыто.
  if (notify && fresh && !deps.chatVisible(chatKey) && !deps.isMuted(chatKey)) {
    // пуш должен был быть.
    console.log('[notify] FIRE mid=' + (m.message_id || '?').slice(0, 20) + ' chat=' + chatKey);
    notifyNewMessage({
      title,
      body: uiStore.tr('notif_new_message') || 'New message',
      chatKey,
      // Дедуп уведомления — по ГЛОБАЛЬНОМУ Message-ID (dk), а не
      // uid|folder: копия в INBOX и [Gmail]/All Mail не дадут два
      // пуша, при этом повторная доставка того же письма монитору
      // после тихого поллинга пуш НЕ отменит.
      id: dk,
    });
  } else if (notify) {
    console.log('[notify] SKIP fresh=' + fresh + ' visible=' + deps.chatVisible(chatKey) + ' muted=' + deps.isMuted(chatKey) + ' age=' + Math.round((Date.now() - new Date(m.date || 0).getTime()) / 1000) + 's');
  }
}
