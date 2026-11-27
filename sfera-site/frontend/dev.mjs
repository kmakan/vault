import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 3000)
const vite = await createViteServer({
  root: __dirname,
  server: { middlewareMode: true },
  appType: 'custom',
})

const server = http.createServer((req, res) => {
  vite.middlewares(req, res, async () => {
    try {
      const url = new URL(req.url || '/', 'http://site.local')
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      const template = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
      const { render } = await vite.ssrLoadModule('/src/entry-server.js')
      const host = req.headers['x-site-host'] || req.headers.host || 'vault-msg.ru'
      const result = await render({ url: req.url || '/', host: String(host) })
      const stateJson = JSON.stringify(result.state).replace(/</g, '\\u003c')
      const html = template
        .replace('<div id="app"></div>', `<div id="app">${result.html}</div><script>window.__INITIAL_STATE__=${stateJson}</script>`)
        .replace('<title>Sfera</title>', `<title>${result.title}</title>`)
      res.writeHead(result.status, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch (error) {
      console.error(error)
      res.writeHead(500)
      res.end('Internal Server Error')
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`sfera-site dev SSR on http://127.0.0.1:${port}`)
})
