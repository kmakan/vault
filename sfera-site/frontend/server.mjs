import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { render } from './dist/server/entry-server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDir = path.join(__dirname, 'dist/client')
const templatePath = path.join(clientDir, 'index.html')
const port = Number(process.env.PORT || 3000)

if (!fs.existsSync(templatePath)) {
  throw new Error('Build the frontend first: npm run build')
}

const template = fs.readFileSync(templatePath, 'utf8')
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function sendStatic(req, res, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = path.resolve(clientDir, relative)
  if (!file.startsWith(clientDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return false
  }
  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=2592000, immutable' : 'public, max-age=300',
  })
  fs.createReadStream(file).pipe(res)
  return true
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://site.local')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end('Method Not Allowed')
      return
    }
    if (url.pathname.startsWith('/assets/') || path.extname(url.pathname)) {
      if (sendStatic(req, res, url.pathname)) return
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }

    const host = req.headers['x-site-host'] || req.headers.host || process.env.SITE_HOST || 'vault-msg.ru'
    const result = await render({ url: req.url || '/', host: String(host) })
    const stateJson = JSON.stringify(result.state).replace(/</g, '\\u003c')
    const domain = result.state.site?.domain || 'vault-msg.ru'
    const pagePath = result.state.path === '/' ? '/' : result.state.path
    const canonical = `https://${domain}${pagePath}`
    const ogImage = result.state.site?.og_image_path
      ? `https://${domain}${result.state.site.og_image_path}`
      : `https://${domain}/og-image.png`
    const head = [
      `<link rel="canonical" href="${escapeHtml(canonical)}">`,
      `<link rel="alternate" hreflang="ru" href="https://vault-msg.ru${escapeHtml(pagePath)}">`,
      `<link rel="alternate" hreflang="en" href="https://vault-msg.tech${escapeHtml(pagePath)}">`,
      `<link rel="alternate" hreflang="x-default" href="https://vault-msg.ru${escapeHtml(pagePath)}">`,
      result.description ? `<meta name="description" content="${escapeHtml(result.description)}">` : '',
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${escapeHtml(canonical)}">`,
      `<meta property="og:title" content="${escapeHtml(result.title)}">`,
      result.description ? `<meta property="og:description" content="${escapeHtml(result.description)}">` : '',
      `<meta property="og:image" content="${escapeHtml(ogImage)}">`,
      `<meta property="og:locale" content="${result.state.site?.locale === 'en' ? 'en_US' : 'ru_RU'}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    ].filter(Boolean).join('\n')
    let html = template
      .replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(result.title)}</title>`)
      .replace('</head>', `${head}\n</head>`)
      .replace(
        '<div id="app"></div>',
        `<div id="app">${result.html}</div><script>window.__INITIAL_STATE__=${stateJson}</script>`,
      )
    res.writeHead(result.status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    })
    res.end(html)
  } catch (error) {
    console.error(error)
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Internal Server Error')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`sfera-site SSR on http://127.0.0.1:${port}`)
})
