// ДиагностикPhone: read-only инспекция состояния телефона через WebView-CDP.
// Не отправляет ни одной команды, которая что-то пишет; все запросы — *_list/*_load.
// Использование: node scripts/diag-phone.mjs '<JS-выражение>' [--url http://127.0.0.1:9224]

const args = process.argv.slice(2);
const BASE = (() => { const i = args.indexOf('--url'); return i >= 0 && args[i + 1] ? args[i + 1] : 'http://127.0.0.1:9224'; })();
const EXPR = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] === '--url'))[0];
if (!EXPR) { console.error('нужно JS-выражение'); process.exit(2); }

async function main() {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('нет страницы в CDP');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: EXPR, returnByValue: true, awaitPromise: true },
  }));
  const out = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP timeout')), 60000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(t);
      if (m.result?.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 500)));
      else res(m.result?.result?.value);
    };
  });
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  ws.close();
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
