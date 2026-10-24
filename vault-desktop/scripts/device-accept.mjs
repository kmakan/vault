// Device-приёмка UI: живая проверка на телефоне через WebView-CDP.
//
// ЗАЧЕМ. Смоуки проверяют МОДУЛИ, гейты — СТАТИКУ. Ни то, ни другое не
// видит разрыв между модулем и компонентом: 20.10.2026 на живом X50 так
// нашлось: «Новая папка» создавалась БЕЗ ИМЕНИ (модуль читал владельца форм,
// шаблон писал в поле данных — состояние фичи было раздвоено). Сборка была
// зелёная, 79 смоуков зелёные, все гейты зелёные.
//
// ПОДГОТОВКА (в другом терминале):
//   export PATH="$HOME/Android/Sdk/platform-tools:$PATH"
//   SER=$(adb devices | awk '/device$/{print $1; exit}')   # mDNS-имя телефона
//   adb -s "$SER" shell am start -n com.vault.vault/.MainActivity
//   PID=$(adb -s "$SER" shell pidof com.vault.vault | tr -d '\r')
//   adb -s "$SER" forward tcp:9224 localabstract:webview_devtools_remote_$PID
//
// ЗАПУСК:
//   node scripts/device-accept.mjs [--url http://127.0.0.1:9224]
//
// Приложение должно быть НА ПЕРЕДНЕМ ПЛАНЕ: WebView не обрабатывает
// сообщения, пока не в фокусе (иначе CDP молчит — не «инструмент сломался»).
//
// Выход: 0 — все проверки прошли, 1 — есть провалы.

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = argOf('--url', 'http://127.0.0.1:9224');

async function cdpEvaluate(expression) {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('нет страницы в CDP: ' + JSON.stringify(list).slice(0, 300));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP: не удалось подключиться'));
  });
  try {
    const id = 1;
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    }));
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP: таймаут ответа')), 90000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== id) return;
        clearTimeout(timer);
        const r = msg.result || {};
        if (r.exceptionDetails) {
          rej(new Error('исключение в странице: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)));
          return;
        }
        res(r.result ? r.result.value : undefined);
      };
    });
  } finally {
    ws.close();
  }
}

// Проба — код, исполняемый В СТРАНИЦЕ приложения. Возвращает отчёт.
const PROBES = {
  // Проба экрана платного тарифа (ADR-005 W5/монетизация). Отдельная от
  // общей UI-пробы: покупка — единственное место, где нужно нажать кнопку и
  // дождаться ответа сервера, и единственное, где ошибка «тихая» (экран
  // покажет «оплачено», а токена нет).
  pro: `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const report = { steps: [] };
    const step = (name, cond, extra) => {
      report.steps.push({ name, pass: !!cond, extra: extra === undefined ? undefined : extra });
    };
    const text = (el) => (el && el.innerText || '').replace(/\\n+/g, ' | ').trim();
    const content = () => text(document.querySelector('.settings-content'));

    step('приложение залогинено', p.isLoggedIn === true, { isLoggedIn: p.isLoggedIn, email: p.email });

    // Настройки открыты?
    if (!p.showSettings) {
      const btns = document.querySelectorAll('.header-actions button');
      if (btns.length) { btns[btns.length - 1].click(); await sleep(900); }
    }
    step('настройки открылись', p.showSettings === true, { showSettings: p.showSettings });

    // Раздел «Приватность» (там секция тарифа и релея).
    const cat = Array.from(document.querySelectorAll('.settings-nav-item'))
      .find((el) => /Приватн|Privacy/i.test(el.innerText || ''));
    step('пункт «Приватность» есть', !!cat, {
      items: Array.from(document.querySelectorAll('.settings-nav-item')).map((e) => (e.innerText || '').trim()),
    });
    if (cat) { cat.click(); await sleep(800); }

    step('секция «Тариф Pro» видна', /Тариф Pro|Pro plan/i.test(content()), { text: content().slice(0, 300) });

    // Проба ИДЕМПОТЕНТНА: если тариф уже активен (аккаунт покупал раньше),
    // покупку не повторяем — проверяем состояние. Иначе — покупаем.
    const alreadyPro = /Pro активен|Pro is active/i.test(content());
    const buyBtn = Array.from(document.querySelectorAll('.settings-content button'))
      .find((b) => /Купить Pro|Buy Pro/i.test(b.innerText || ''));
    step('кнопка «Купить Pro» есть (или тариф уже активен)', !!buyBtn || alreadyPro, {
      alreadyPro,
      buttons: Array.from(document.querySelectorAll('.settings-content button')).map((e) => (e.innerText || '').trim().slice(0, 24)),
    });

    if (buyBtn && !alreadyPro) {
      buyBtn.click();
      let bought = false;
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (/Pro активен|Pro is active/i.test(content())) { bought = true; break; }
      }
      step('после оплаты статус «Pro активен»', bought, { text: content().slice(0, 300) });
      step('число устройств показано', /устройств|devices/i.test(content()), { text: content().slice(0, 300) });
      step('кнопка стала «Продлить»', /Продлить|Extend/i.test(content()), { text: content().slice(0, 300) });
    }

    // Закрыть настройки: бейдж PRO — в шапке чата. В чате ЗАМЕТОК бейджа нет
    // (это локальный чат, тариф там ни при чём) — открываем обычный.
    p.showSettings = false;
    await sleep(900);
    if (!p.activeChat || p.activeChat === '__notes__') {
      const c = document.querySelector('.contact-item:not(.notes-self)');
      if (c) { c.click(); await sleep(1400); }
    }
    step('открыт обычный чат (не заметки)', p.activeChat !== '__notes__', { activeChat: p.activeChat });
    const badge = document.querySelector('.pro-badge');
    step('бейдж PRO в шапке чата', !!badge, {
      badge: badge ? text(badge) : null,
      header: text(document.querySelector('.chat-header')).slice(0, 200),
    });
    return report;
  })()`,
  ui: `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const comp = app._container._vnode.component;
    const p = comp.proxy;
    const report = { steps: [] };
    const step = (name, cond, extra) => {
      report.steps.push({ name, pass: !!cond, extra: extra === undefined ? undefined : extra });
    };

    step('приложение залогинено', p.isLoggedIn === true, { isLoggedIn: p.isLoggedIn, email: p.email });
    step('владельцы на месте (ADR-004)',
      !!(p.uiStore && p.chatStore && p.messagesStore && p.sessionStore),
      { uiStore: !!p.uiStore, chatStore: !!p.chatStore, messagesStore: !!p.messagesStore });

    // Модалка настроек: на APK 0.1.228 шестерёнка не открывала ничего.
    const headerBtns = document.querySelectorAll('.header-actions button');
    step('в шапке есть кнопка настроек', headerBtns.length >= 6, { count: headerBtns.length });
    const before = document.querySelectorAll('.modal-overlay').length;
    headerBtns[headerBtns.length - 1].click();
    await sleep(800);
    const overlay = document.querySelectorAll('.modal-overlay');
    step('модалка настроек ОТКРЫЛАСЬ', overlay.length > before && p.showSettings === true,
      { overlayBefore: before, overlayAfter: overlay.length, showSettings: p.showSettings });
    if (overlay.length > before) {
      const closeBtn = document.querySelector('.modal-close-x, .modal-close');
      if (closeBtn) closeBtn.click();
      else p.showSettings = false;
      await sleep(400);
      step('модалка настроек ЗАКРЫЛАСЬ', p.showSettings === false, { showSettings: p.showSettings });
    }

    // Чат: открыть, ввод, отправка.
    if (!p.activeChat) {
      const c = document.querySelector('.contact-item:not(.notes-self)');
      if (c) { c.click(); await sleep(1200); }
    }
    const composer = document.querySelector('input.message-field');
    step('чат открылся (поле ввода есть)', !!composer, { hasComposer: !!composer, activeChat: p.activeChat });
    // Мобильная навигация (W3 партия 10): чат открыт — значит мобильный чат
    // переключился (список → переписка).
    step('мобильный чат переключился на переписку', p.mobileChatOpen === true, { mobileChatOpen: p.mobileChatOpen });
    if (composer) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(composer, 'проверка приёмки');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(500);
      const sendBtn = document.querySelector('.send-btn-round');
      step('ввод в композер включает отправку', !!sendBtn && !sendBtn.disabled,
        { disabled: sendBtn ? sendBtn.disabled : null });
      // НИЧЕГО не отправляем: чистим поле.
      setter.call(composer, '');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
    }

    // Чат заметок (W3 партия 6): открывается по «Заметки для себя».
    {
      const notes = Array.from(document.querySelectorAll('.contact-item'))
        .find((el) => /Заметки|Notes/i.test(el.innerText || ''));
      if (notes) {
        notes.click();
        await sleep(1200);
        const p2 = app._container._vnode.component.proxy;
        step('чат заметок открыт (activeChat = __notes__)', p2.activeChat === '__notes__', { activeChat: p2.activeChat });
        step('в шапке есть поле ввода (композер)', !!document.querySelector('input.message-field'));
      } else {
        report.steps.push({ name: 'чат заметок открыт', pass: null, extra: 'пункт «Заметки для себя» не найден' });
      }
    }

    // Полный путь «Новая папка…» (баг 20.10: папка создавалась БЕЗ ИМЕНИ).
    // Меню закрываем заранее: проба должна быть идемпотентной (предыдущий
    // прогон мог оставить меню открытым — тогда следующий клик по «Создать»
    // ушёл бы в закрытое меню).
    p.closeChatMenu();
    await sleep(400);
    // Диалог папки тоже сбрасываем: если прошлый прогон оставил его открытым,
    // в меню будет «Создать» вместо «Новая папка…» — проба должна быть
    // идемпотентной.
    p.folderDialogOpen = false;
    p.chatFolderNewName = '';
    await sleep(300);
    const fakeEvent = {
      clientX: 120, clientY: 300,
      target: document.querySelector('.message-bubble, .msg-bubble, .message-item') || document.body,
      preventDefault() {}, stopPropagation() {},
    };
    p.openChatMenu({ type: 'contact', email: p.activeChat }, fakeEvent);
    await sleep(700);
    step('контекстное меню чата открылось', !!document.querySelector('.chat-menu'),
      { found: !!document.querySelector('.chat-menu') });
    const newFolderBtn = Array.from(document.querySelectorAll('.chat-menu button'))
      .find((b) => /Новая папка|New folder/i.test(b.innerText || ''));
    step('в меню есть кнопка «Новая папка…»', !!newFolderBtn, {
      text: newFolderBtn ? (newFolderBtn.innerText || '').trim() : null,
      menuText: (document.querySelector('.chat-menu') ? document.querySelector('.chat-menu').innerText : '').replace(/\\n+/g, ' | ').slice(0, 160),
      menuCount: document.querySelectorAll('.chat-menu').length,
    });
    if (newFolderBtn) {
      const t0 = Date.now();
      newFolderBtn.click();
      let input = null;
      for (let i = 0; i < 12; i++) {
        input = document.querySelector('.chat-menu input.duress-input');
        if (input) break;
        await sleep(50);
      }
      step('поле имени папки появилось СРАЗУ (реактивно)', !!input, { ms: Date.now() - t0 });
      step('флаг folderDialogOpen = true', p.folderDialogOpen === true, { flag: p.folderDialogOpen });
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const name = 'Приёмка' + String(Date.now()).slice(-4);
        setter.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(300);
        step('имя папки дошло до владельца форм', p.chatFolderNewName === name,
          { form: p.chatFolderNewName, expected: name });
        const createBtn = Array.from(document.querySelectorAll('.chat-menu button'))
          .find((b) => /Создать|Create/i.test(b.innerText || ''));
        step('кнопка «Создать» есть', !!createBtn, {
          buttons: Array.from(document.querySelectorAll('.chat-menu button')).map((b) => (b.innerText || '').trim().slice(0, 20)),
        });
        if (createBtn) {
          createBtn.click();
          await sleep(800);
          const names = p.chatFoldersNames || [];
          step('папка создана и появилась в списке', names.includes(name), { names, created: name });
          step('диалог закрылся после создания', p.folderDialogOpen === false, { flag: p.folderDialogOpen });
          // убор за собой
          p.chatFoldersNames = names.filter((n) => n !== name);
        }
      }
    }
    p.closeChatMenu();
    await sleep(300);
    step('меню закрылось', !document.querySelector('.chat-menu'));

    // Попап сообщения (24.10.2026): пункт «Реакция» ОБЯЗАН открыть пикер.
    // Регрессия 49861f5 → c7a1f65: фича «возвращала» состояние, Vue-обработчик
    // отбрасывал результат, сеттер не вызывался — пикер не открывался.
    // Смоуки это ловят на модуле; эта проба меряет ПРОВОДКУ в живом DOM.
    {
      // Активный чат может быть пустым (проверка «приёмка» не отправляется) —
      // перебираем контакты, пока не найдём чат с настоящим сообщением.
      let bubble = document.querySelector('.message:not(.call-event)');
      if (!bubble) {
        const items = Array.from(document.querySelectorAll('.contact-item:not(.notes-self)')).slice(0, 8);
        for (const it of items) {
          it.click();
          await sleep(1000);
          bubble = document.querySelector('.message:not(.call-event)');
          if (bubble) break;
        }
      }
      if (!bubble) {
        report.steps.push({ name: 'попап сообщения: пункт «Реакция»', pass: null, extra: 'ни в одном из 8 чатов нет сообщений — проба пропущена' });
      } else {
        const mid = bubble.getAttribute('data-msg-id');
        bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 }));
        await sleep(600);
        const menu = document.querySelector('.message-menu');
        step('попап сообщения открывается', !!menu, { found: !!menu });
        const reactBtn = menu && Array.from(menu.querySelectorAll('button'))
          .find((b) => /Реакция|React/i.test(b.innerText || ''));
        step('в попапе есть пункт «Реакция»', !!reactBtn, {
          items: menu ? Array.from(menu.querySelectorAll('button')).map((b) => (b.innerText || '').trim().slice(0, 22)) : [],
        });
        if (reactBtn) {
          reactBtn.click();
          await sleep(600);
          step('пикер реакций: состояние записано сеттером (c7a1f65)', p.reactionPickerMsgId === mid,
            { reactionPickerMsgId: p.reactionPickerMsgId, expected: mid });
          step('пикер отрисован в DOM', !!document.querySelector('.reaction-picker'));
          p.reactionPickerMsgId = null; // убор за собой
        }
        p.messageMenu = null;
        await sleep(200);
      }
    }
    return report;
  })()`,
  // Призрак «свой аккаунт в контактах» (24.10, X50): под сессией koanmak@ya.ru
  // в списке стояли собственные адреса (koanmak@gmail.com, vault-msg@ya.ru),
  // а клик по ним открывал попап «Добавить контакт». Решение «это мы?» живёт в
  // Rust; эта проба меряет ЕГО ПРОВОДКУ на живом устройстве: список контактов
  // не содержит ни одного адреса с нашим публичным ключом. Идемпотентна и
  // ничего не трогает в UI.
  ghosts: `(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const report = { steps: [] };
    const step = (name, cond, extra) => {
      report.steps.push({ name, pass: !!cond, extra: extra === undefined ? undefined : extra });
    };
    const norm = (s) => String(s || '').trim().toLowerCase();
    const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    step('мост доступен', !!inv);
    if (!inv) return report;
    const own = await inv('load_my_keypair');
    step('наш keypair прочитан', !!(own && own.public_key), {});
    const all = await inv('load_peer_keys');
    const ownKey = norm(own && own.public_key);
    const ownAddrs = (all || []).filter((k) => norm(k.public_key) === ownKey).map((k) => k.email);
    const mine = new Set([norm(p.email), ...ownAddrs.map(norm)]);
    const ghosts = (p.contacts || []).filter((c) => mine.has(norm(c.email)) || mine.has(norm(c.id)));
    step('своих адресов в контактах нет', ghosts.length === 0, {
      email: p.email, ownAddrs,
      ghosts: ghosts.map((g) => g.email || g.id),
      contacts: (p.contacts || []).length,
    });
    const dom = Array.from(document.querySelectorAll('.contact-item')).map((e) => (e.innerText || '').toLowerCase());
    const domGhosts = dom.filter((t) => [...mine].some((m) => m && t.includes(m)));
    step('в отрисованном списке своих нет', domGhosts.length === 0, { domGhosts });
    // ── второй класс дефекта: ДУБЛЬ известной идентичности без ключа ──
    // На X50 (24.10) в списке стояли vault-msg@ya.ru (ключ 9cadcd4d…) и
    // koanmak@gmail.com без ключа — тот же человек: пир сменил почту, а
    // группы остались со старым адресом. Тап по дублю открывал попап
    // «Добавить контакт», а аватарка была видна дважды.
    const keys = p.peerKeys || {};
    const withKey = (p.contacts || []).filter((c) => keys[norm(c.email)] || keys[c.email]);
    const keyOf = (c) => norm(keys[norm(c.email)] || keys[c.email] || c.public_key);
    const seenKey = new Map();
    for (const c of withKey) {
      const k = keyOf(c);
      if (k) seenKey.set(k, (seenKey.get(k) || []).concat(c.email));
    }
    const dupKeys = [...seenKey.entries()].filter(([, v]) => v.length > 1);
    step('одна идентичность (ключ) — одна строка в списке', dupKeys.length === 0, { dupKeys });
    const step2 = (await inv('groups_load', {})) || [];
    const members = [];
    for (const g of step2) for (const m of (g.members || [])) members.push([m.email || '', m.fingerprint || '']);
    const keyset = new Set(withKey.map(keyOf).filter(Boolean));
    const traceOf = new Map(members.map(([e, fp]) => [norm(e), norm(fp)]));
    const dupes = (p.contacts || []).filter((c) => {
      const k = keyOf(c);
      if (k) return false;                       // с ключом — чат открывается
      const fp = traceOf.get(norm(c.email));
      return !!fp && fp.length === 64 && keyset.has(fp);
    });
    step('в списке нет строки без ключа там, где идентичность уже известна',
      dupes.length === 0, { dupes: dupes.map((d) => d.email || d.id) });
    // Та же проверка на стороне ядра: ставим РЕАЛЬНУЮ пару (адрес, ключ) из
    // контактов под другим адресом в members — ровно это делает состав группы
    // после смены почты пиром — и заведомо нового пира без ключа. Живые адреса
    // в пробу не подставляются: она должна работать под любым аккаунтом.
    const known = withKey[0];
    const knownKey = known && keyOf(known);
    step('проба добивки осмысленна: в контактах есть ключ', !!knownKey, {});
    const pad = await inv('groups_contacts_to_pad', {
      email: p.email || '',
      fingerprint: String(p.fingerprint || ''),
      aliases: ownAddrs,
      members: [
        ['ghost.probe@example.invalid', knownKey || ''],
        ['new.probe@example.invalid', ''],
      ],
      contacts: withKey.map((c) => [c.email, keyOf(c)]),
    });
    step('дубль известной идентичности не зовётся, новый пир — зовётся',
      Array.isArray(pad)
      && !pad.includes('ghost.probe@example.invalid')
      && pad.includes('new.probe@example.invalid'), { pad });
    const dropped = await inv('contacts_drop_own', {
      email: p.email || '',
      fingerprint: String(p.fingerprint || ''),
      aliases: ownAddrs,
      contacts: [['vault-msg@ya.ru', own.public_key || ''], ['icemaksim@gmail.com', 'c73ce55a' + '00'.repeat(28)]],
    });
    step('команда contacts_drop_own зарегистрирована и убирает наш ключ',
      Array.isArray(dropped) && dropped.length === 1 && dropped[0][0] === 'icemaksim@gmail.com',
      { dropped });
    return report;
  })()`,
  // Проводка стражей записи ключа (24.10, партия 5e). Юниты и мутации меряют
  // правило; эта проба меряет ПРОВОД на живом устройстве: аргумент `ownEmail`
  // доезжает до моста. Различающий случай — ЧУЖОЙ ключ под НАШЕЙ почтой: если
  // own_email не передан, страж молчит и запись сохраняется (так свой аккаунт
  // и возвращался в контакты). Проба обратима: нормальная запись удаляется
  // сразу, а записью с НАШИМ ключом хранилище не пачкается — её отсекает
  // self-key guard ядра независимо от проводки.
  guards: `(async () => {
    const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    const report = { steps: [] };
    const step = (name, cond, extra) => {
      report.steps.push({ name, pass: !!cond, extra: extra === undefined ? undefined : extra });
    };
    if (!inv) { step('мост доступен', false); return report; }
    const norm = (s) => String(s || '').trim().toLowerCase();
    const app = document.querySelector('#app').__vue_app__;
    const ownEmail = norm(app._container._vnode.component.proxy.email);
    const own = await inv('load_my_keypair');
    const bogus = 'b'.repeat(64);            // формально правильный ЧУЖОЙ ключ
    const probeAddr = 'probe.' + ownEmail;   // пробы не должно остаться в хранилище
    const before = ((await inv('load_peer_keys')) || []).length;

    let errOwn = null;
    try {
      await inv('save_peer_key', { email: ownEmail, publicKey: bogus,
        label: null, pqPublicKey: null, ownEmail });
    } catch (e) { errOwn = String(e); }
    const leaked = ((await inv('load_peer_keys')) || [])
      .filter((k) => norm(k.email) === ownEmail).length;
    step('чужой ключ под своей почтой отвергнут мостом',
      !!errOwn && /our own address/i.test(errOwn) && leaked === 0,
      { err: errOwn, leaked });

    let errPeer = null;
    try {
      await inv('save_peer_key', { email: probeAddr, publicKey: bogus,
        label: null, pqPublicKey: null, ownEmail });
    } catch (e) { errPeer = String(e); }
    step('обычная запись (чужой ключ под чужой почтой) проходит — guard не сжигает её',
      errPeer === null, { err: errPeer });
    try { await inv('remove_peer_key', { email: probeAddr }); } catch (e) {}

    let errSelf = null;
    try {
      await inv('save_peer_key', { email: probeAddr, publicKey: own.public_key,
        label: null, pqPublicKey: null, ownEmail });
    } catch (e) { errSelf = String(e); }
    step('наш ключ как ключ пира отвергнут ядром',
      !!errSelf && /own public key/i.test(errSelf), { err: errSelf });
    try { await inv('remove_peer_key', { email: probeAddr }); } catch (e) {}

    const after = ((await inv('load_peer_keys')) || []).length;
    step('проба ничего не оставила в хранилище', after === before, { before, after });
    return report;
  })()`,

  // Тумблеры возможностей и выбор транспорта (ADR-005 W1: правило дефолта и
  // план доставки — в Rust). Отдельная проба потому, что ни смоук, ни
  // статика не видят живую связку «kv → мост → фронт»: на стенде 22.10
  // расхождение имени аргумента выглядело как «кнопка не работает», а
  // молчаливый no-op правила состояния — как «приложение глючит».
  flags: `(async () => {
    const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    const report = { steps: [] };
    const step = (name, cond, extra) => {
      report.steps.push({ name, pass: cond === null ? null : !!cond,
        extra: extra === undefined ? undefined : extra });
    };
    if (!inv) { step('мост доступен', false); return report; }
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const account = String(p.email || '').trim().toLowerCase();
    step('проба на вошедшем аккаунте (есть адрес)', !!account, account || 'адрес пуст');

    // 1. Дефолт считает ядро: без записи звонки включены, видео выключено.
    const calls = await inv('settings_flag', { name: 'exp-calls' });
    const video = await inv('settings_flag', { name: 'exp-video' });
    step('флаги прочитаны мостом (не null, не строка)',
      typeof calls === 'boolean' && typeof video === 'boolean', { calls, video });

    // 2. Раунд-трип тумблера видео: включённое читается как включённое.
    await inv('settings_flag_set', { name: 'exp-video', enabled: true });
    const on = await inv('settings_flag', { name: 'exp-video' });
    step('видео: включено и читается как включено', on === true, on);
    await inv('settings_flag_set', { name: 'exp-video', enabled: false });
    const off = await inv('settings_flag', { name: 'exp-video' });
    step('видео: выключено и читается как выключено', off === false, off);
    const callsAfter = await inv('settings_flag', { name: 'exp-calls' });
    step('тумблер видео не трогает звонки (флаги независимы)', callsAfter === calls,
      { before: calls, after: callsAfter });

    // 3. Цикл выбора транспорта: имя возвращает Rust, запись читается как запись.
    const start = await inv('transport_preference', { account });
    const next = await inv('transport_preference_next', { account });
    const readBack = await inv('transport_preference', { account });
    step('сдвиг даёт известное имя транспорта',
      ['auto', 'mail', 'relay'].includes(next), { start, next });
    step('сдвинутый выбор читается обратно', readBack === next, { readBack, next });
    await inv('transport_preference_next', { account });
    await inv('transport_preference_next', { account });
    const restored = await inv('transport_preference', { account });
    step('проба вернула выбор пользователя', restored === start, { start, restored });

    // 4. Гарант доставки: ни один план не остаётся без почтового пути, а
    // выбор «только почта» не трогает релей (не тратит суточный лимит).
    const bad = [];
    for (const name of ['auto', 'mail', 'relay']) {
      await inv('transport_preference_set', { account, preference: name });
      for (const avail of [true, false]) {
        const plan = await inv('transport_plan', { account, relayAvailable: avail });
        if (!(plan.mail || plan.mailFallback || !plan.relay)) bad.push(name + '/' + avail + ' без почты');
        if (name === 'mail' && plan.relay) bad.push('mail включил релей');
        if (!avail && plan.relay) bad.push(name + '/релей выключен, но публикуется');
      }
    }
    step('план Rust держит почту гарантией при каждом выборе', bad.length === 0, bad);
    await inv('transport_preference_set', { account, preference: start });

    // 5. Проводка интерфейса: чип показывает текущий выбор (тот же класс,
    // что и значение из моста). Без открытого чата рядку фич нет — не проваливаем.
    if (p.activeChat) {
      const chip = document.querySelector('.feature-row .transport-' + start);
      step('чип транспорта в рядку фич подписан текущим выбором', !!chip,
        { pref: start, found: !!chip });
    } else {
      step('чип транспорта', null, 'нет открытого чата — рядок фич не отрендерен');
    }
    // 6. Разбор 429 живёт в мосте, а не в строке сравнения фронта. имена
    // веток — провод: фронт сравнивает 'daily'/'rate', и расхождение имён
    // видно только здесь (в компиляторе JS не проверяется).
    const daily = await inv('relay_pub_rejection', {
      status: 429,
      body: '{"error":"daily relay limit reached","limit":100,"retry_after":18640}',
    });
    const burst = await inv('relay_pub_rejection', { status: 429, body: '{"error":"rate limit"}' });
    const other = await inv('relay_pub_rejection', { status: 401, body: '' });
    step('429 суточного лимита → daily (и срок назван)',
      daily && daily.kind === 'daily' && daily.retryAfter === 18640, daily);
    step('429 вспышки → rate (релей не гаснет на сутки)',
      burst && burst.kind === 'rate', burst);
    step('не-429 → other (у фронта своя ветка)',
      other && other.kind === 'other', other);
    return report;

const which = argOf('--probe', 'ui');
const probe = PROBES[which];
if (!probe) {
  console.error('нет пробы: ' + which + ' (доступны: ' + Object.keys(PROBES).join(', ') + ')');
  process.exit(2);
}

let report;
try {
  report = await cdpEvaluate(probe);
} catch (e) {
  console.error('✗ device-accept: ' + (e && e.message ? e.message : e));
  console.error('  Частая причина: приложение не на переднем плане — WebView не отвечает.');
  process.exit(1);
}

let failed = 0;
for (const s of (report && report.steps) || []) {
  if (s.pass === null) { console.log('  ~ ' + s.name + ' — ' + (s.extra || '')); continue; }
  if (s.pass) { console.log('  ✓ ' + s.name); continue; }
  failed++;
  console.log('  ✗ ' + s.name + (s.extra !== undefined ? ' — ' + JSON.stringify(s.extra) : ''));
}
console.log('\n=== ИТОГ: ' + ((report && report.steps ? report.steps.length : 0) - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
