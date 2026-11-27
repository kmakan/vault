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
    if (path === '/') {
      state.page = await get('/api/v1/pages/home/', siteHost)
      state.view = 'home'
      title = state.page.seo_title || state.page.title || title
      description = state.page.seo_description || description
    } else if (path === '/pricing' || path === '/pay') {
      state.page = await get(`/api/v1/pages/${path.slice(1)}/`, siteHost)
      state.view = 'page'
      title = state.page.seo_title || state.page.title || title
      description = state.page.seo_description || description
    } else if (path.startsWith('/legal/')) {
      const kind = decodeSlug(path, '/legal/')
      state.legal = await get(`/api/v1/legal/${encodeURIComponent(kind)}/`, siteHost)
      state.view = 'legal'
      title = state.legal.title || title
    } else if (path === '/docs' || path === '/docs/') {
      const tree = await get('/api/v1/docs/tree/', siteHost)
      state.tree = tree.tree || []
      state.view = 'docs'
      title = shell.site.locale === 'en' ? 'Documentation' : 'Руководство'
    } else if (path.startsWith('/docs/')) {
      const slug = decodeSlug(path, '/docs/')
      state.doc = await get(`/api/v1/docs/${encodeURIComponent(slug)}/`, siteHost)
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
