// Живая проверка «сообщение не исчезает» через CDP на телефоне.
//
// СИМПТОМ, который чинили: отправленное сообщение пропадало из чата после
// ближайшего поллинга, а вместе с ним затирался архив. Обычная приёмка (19
// CDP-проб) это НЕ видит: она проверяет, что экран собран, а не что экран
// выживает после перезаписи. Здесь проверяются три вещи подряд:
//   1) сообщение есть сразу после отправки;
//   2) оно есть после ПЕРЕключения на другой чат и обратно (полный цикл
//      loadMessages → merge → перезапись экрана и архива);
//   3) оно есть после реального поллинга (ждём цикл, ничего не трогая);
//   4) в чате НЕТ записей-не-объектов: символы вместо переписки — это второй
//      дефект того же дня (потерянный аргумент зависимости → бакет pending
//      стал строкой), и он даёт «пустые пузыри», которые приёмка 19/19 не видит.
//
// Использование: node scripts/phone-persist-check.mjs "<подпись сообщения>" ["<получатель>"]
// Требует: adb -s <сер> forward tcp:9224 localabstract:webview_devtools_remote_<pid>
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:9224';

async function cdpEvaluate(expression, timeoutMs = 180000) {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('нет страницы в CDP');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP')); });
  try {
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    }));
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('таймаут CDP')), timeoutMs);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) {
          clearTimeout(timer);
          if (m.result && m.result.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)));
          else res(m.result.result.value);
        }
      };
    });
  } finally { ws.close(); }
}

const MARK = process.argv[2] || 'PERSIST-CHECK';
const PEER = process.argv[3] || 'icemaksim@gmail.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Считаем, есть ли метка на экране и в архиве, не трогая UI.
const probeExpr = (tag) => `(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const p = app._container._vnode.component.proxy;
  // Текст сообщения лежит в content (поле text у сообщений нет — было бы
  // «пузыри пустые», если смотреть на text).
  const body = (m) => String((m && (m.content || m.text)) || '');
  const onScreen = (p.chat.state.messages || []).filter((m) => body(m).includes(${JSON.stringify(MARK)}));
  // Сообщения обязаны быть записями. Символы вместо переписки = расхождение
  // контракта на границе фичи (22.10: бакет pending получил строку, и поллинг
  // подмешал её символы в чат «пустыми пузырями»).
  const junk = (p.chat.state.messages || []).filter((m) => !m || typeof m !== 'object').length;
  let archived = null;
  try {
    // Архив читаем методом приложения (loadLocalHistory), а не импортом
    // модуля: в собранном WebView пути исходников недоступны.
    const list = await p.loadLocalHistory(${JSON.stringify(PEER)});
    archived = (list || []).filter((m) => body(m).includes(${JSON.stringify(MARK)})).length;
  } catch (e) { archived = 'err:' + (e && e.message); }
  return { tag: ${JSON.stringify(tag)}, activeChat: p.activeChat,
           screenCount: (p.chat.state.messages || []).length,
           markOnScreen: onScreen.length, markArchived: archived, junkOnScreen: junk };
})()`;

const openChatExpr = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
  if (p.activeChat === ${JSON.stringify(PEER)}) return { already: true };
  const item = Array.from(document.querySelectorAll('.contact-item')).find((e) => (e.innerText || '').includes(${JSON.stringify(PEER)}));
  if (!item) return { error: 'контакт не найден' };
  item.click(); await sleep(2500); return { opened: p.activeChat };
})()`;

const otherChatExpr = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const items = Array.from(document.querySelectorAll('.contact-item')).filter((e) => !(e.innerText || '').includes(${JSON.stringify(PEER)}));
  if (!items.length) return { error: 'нет другого чата' };
  items[0].click(); await sleep(2500);
  const p = document.querySelector('#app').__vue_app__._container._vnode.component.proxy;
  return { switchedTo: p.activeChat };
})()`;

const results = [];
results.push(await cdpEvaluate(probeExpr('после отправки')));
results.push(await cdpEvaluate(otherChatExpr));
results.push(await cdpEvaluate(openChatExpr));
results.push(await cdpEvaluate(probeExpr('после переключения чата')));
// Живой поллинг: ждём дольше цикла (поллинг + IDLE-таймауты), не трогая UI.
await sleep(75000);
results.push(await cdpEvaluate(probeExpr('после поллинга')));

const last = results[results.length - 1];
const ok = results.filter((r) => r.markOnScreen !== undefined)
  .every((r) => r.markOnScreen >= 1 && r.junkOnScreen === 0
    && (typeof r.markArchived === 'number' ? r.markArchived >= 1 : false));
console.log(JSON.stringify({ ok, mark: MARK, peer: PEER, results }, null, 2));
mkdirSync('/tmp/vault-accept', { recursive: true });
writeFileSync('/tmp/vault-accept/persist-check.json', JSON.stringify({ ok, mark: MARK, peer: PEER, results }, null, 2));
process.exit(ok ? 0 : 1);
