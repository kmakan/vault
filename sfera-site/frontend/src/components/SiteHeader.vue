<script setup>
const props = defineProps({
  site: { type: Object, default: () => ({}) },
  nav: { type: Object, default: () => ({ header: [] }) },
  path: { type: String, default: '/' },
})

function href(url) {
  if (!url) return '/'
  if (url.startsWith('#') && props.path !== '/') return `/${url}`
  return url
}

const cta = props.site?.locale === 'en' ? 'Download' : 'Скачать'
</script>

<template>
  <header>
    <div class="container nav">
      <a class="brand" href="/">
        <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M16 2 4 7v9c0 7.2 5.1 12.4 12 14 6.9-1.6 12-6.8 12-14V7L16 2z" stroke="#f59e0b" stroke-width="2.2" stroke-linejoin="round" />
          <path d="M11 15.5l3.5 3.5L21 12" stroke="#8b5cf6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {{ site?.brand || 'Vault' }}
      </a>
      <nav class="nav-links" aria-label="Main">
        <a v-for="item in nav?.header || []" :key="item.url" :href="href(item.url)">
          {{ item.label }}
        </a>
      </nav>
      <a class="btn btn-primary" href="/#download">{{ cta }}</a>
    </div>
  </header>
</template>
