// Выполнить JS в WebView приложения на эмуляторе через CDP.
//
// Зачем: сценарии съёмки скриншотов и подготовки демо-контента в приложении
// требуют точечных действий (открыть чат, переименовать контакт, отправить
// сообщение). Ввод через adb-input по координатам хрупкий, а DOM приложения
// доступен через devtools-протокол webview (localabstract:webview_devtools_remote_<pid>).
//
// Использование: node scripts/cdp-eval.mjs <port> <file-with-js>
//                node scripts/cdp-eval.mjs <port> --expr "expression"
import { readFileSync } from 'node:fs';

const port = process.argv[2] || '9224';
const BASE = 'http://127.0.0.1:' + port;

async function cdpEvaluate(expression) {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('нет страницы в CDP на порту ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP')); });
  try {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    }));
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('таймаут')), 60000);
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

const mode = process.argv[3];
let expression;
if (mode === '--expr') expression = process.argv[4];
else expression = readFileSync(process.argv[3], 'utf8');

const out = await cdpEvaluate(expression);
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
