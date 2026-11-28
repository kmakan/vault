import { renderToString } from 'vue/server-renderer'
import { createApp } from './app.js'

const API_ORIGIN = process.env.API_ORIGIN || 'http://127.0.0.1:8000'
const DEFAULT_SITE = process.env.SITE_HOST || 'vault-msg.ru'

async function get(path, host) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    headers: { 'X-Site-Host': host || DEFAULT_SITE },
  })
  if (!response.ok) {
    const error = new Error(`API ${response.status} for ${path}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

function normalizeHost(host) {
  return (host || DEFAULT_SITE).split(':')[0].toLowerCase()
}

function decodeSlug(path, prefix) {
  return decodeURIComponent(path.slice(prefix.length)).replace(/\/+$/, '')
}

export async function render({ url = '/', host = DEFAULT_SITE } = {}) {
  const siteHost = normalizeHost(host)
  const path = new URL(url, 'http://site.local').pathname
  let shell
  try {
    shell = await get('/api/v1/site/', siteHost)
  } catch (error) {
    return {
      status: 503,
      state: {
        site: { locale: 'ru', brand: 'Vault' },
        nav: { header: [], footer: [], legal: [] },
        path,
        view: 'notfound',
      },
      html: '<main class="content-page"><div class="container"><h1>503</h1><p>Site API is unavailable.</p></div></main>',
      title: '503',
      description: '',
    }
  }

  const state = {
    site: shell.site,
    nav: shell.navigation,
    path,
    view: 'notfound',
  }
  let status = 200
  let title = shell.site.default_seo_title || shell.site.brand
  let description = shell.site.default_seo_description || ''

  try {
    if (path === '/' || path === '/vault') {
      state.page = await get('/api/v1/pages/home/', siteHost)
      state.view = 'home'
      title = state.page.seo_title || state.page.title || title
      description = state.page.seo_description || description
    } else if (path === '/sfera/channels') {
      state.channels = await get('/api/v1/public/channels/', siteHost)
      state.view = 'channels'
      title = shell.site.locale === 'en' ? 'Sfera public channels' : 'Публичные каналы Sfera'
      description = shell.site.locale === 'en'
        ? 'Public pages signed by their authors.'
        : 'Открытые страницы, подписанные их авторами.'
    } else if (path.startsWith('/sfera/channels/')) {
      const id = decodeSlug(path, '/sfera/channels/')
      state.channel = await get(`/api/v1/public/channels/${encodeURIComponent(id)}/`, siteHost)
      state.view = 'channel'
      title = state.channel.channel?.title || title
      description = state.channel.channel?.description || description
    } else if (path === '/pricing' || path === '/pay' || path === '/sfera') {
      state.page = await get(`/api/v1/pages/${path.slice(1)}/`, siteHost)
      state.view = 'page'
      title = state.page.seo_title || state.page.title || title
      description = state.page.seo_description || description
    } else if (path === '/vault/pricing') {
      state.page = await get('/api/v1/pages/pricing/', siteHost)
      state.view = 'page'
      title = state.page.seo_title || state.page.title || title
      description = state.page.seo_description || description
    } else if (path === '/vault/pay') {
      state.page = await get('/api/v1/pages/pay/', siteHost)
      state.view = 'page'
      title = state.page.seo_title || state.page.title || title
      description = state.page.seo_description || description
    } else if (path.startsWith('/legal/')) {
      const kind = decodeSlug(path, '/legal/')
      state.legal = await get(`/api/v1/legal/${encodeURIComponent(kind)}/`, siteHost)
      state.view = 'legal'
      title = state.legal.title || title
    } else if (['/docs', '/docs/', '/vault/docs', '/vault/docs/', '/sfera/docs', '/sfera/docs/'].includes(path)) {
      const product = path.startsWith('/vault') ? 'vault' : 'sfera'
      const base = path.startsWith('/vault') ? '/vault/docs' : '/sfera/docs'
      const tree = await get(`/api/v1/docs/tree/?product=${product}`, siteHost)
      state.tree = tree.tree || []
      state.docsBase = base
      state.docsProduct = product
      state.docsTitle = product === 'vault'
        ? (shell.site.locale === 'en' ? 'Vault guide' : 'Руководство Vault')
        : (shell.site.locale === 'en' ? 'Sfera guide' : 'Руководство Sfera')
      state.docsLabel = state.docsTitle
      if (path === '/docs' || path === '/docs/') state.path = base
      state.view = 'docs'
      title = state.docsTitle
    } else if (path.startsWith('/docs/') || path.startsWith('/vault/docs/') || path.startsWith('/sfera/docs/')) {
      const vault = path.startsWith('/vault/docs/')
      const base = vault ? '/vault/docs' : '/sfera/docs'
      const prefix = vault ? '/vault/docs/' : path.startsWith('/sfera/docs/') ? '/sfera/docs/' : '/docs/'
      const slug = decodeSlug(path, prefix)
      const product = vault ? 'vault' : 'sfera'
      state.doc = await get(`/api/v1/docs/${encodeURIComponent(slug)}/?product=${product}`, siteHost)
      state.docsBase = base
      state.docsProduct = product
      state.docsLabel = vault
        ? (shell.site.locale === 'en' ? 'Vault guide' : 'Руководство Vault')
        : (shell.site.locale === 'en' ? 'Sfera guide' : 'Руководство Sfera')
      if (path.startsWith('/docs/')) state.path = `${base}/${slug}`
      state.view = 'doc'
      title = state.doc.title || title
      description = state.doc.summary || description
    } else {
      status = 404
      state.view = 'notfound'
      title = '404'
    }
  } catch (error) {
    if (error.status === 404) {
      status = 404
      state.view = 'notfound'
      title = '404'
    } else {
      status = 503
      state.view = 'notfound'
      title = '503'
    }
  }

  const app = createApp(state)
  const html = await renderToString(app)
  return { status, state, html, title, description }
}
