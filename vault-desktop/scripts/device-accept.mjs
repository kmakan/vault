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
    return report;
  })()`,
};

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
