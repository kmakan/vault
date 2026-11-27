<script setup>
const props = defineProps({
  site: { type: Object, default: () => ({}) },
  nav: { type: Object, default: () => ({ footer: [], legal: [] }) },
})

const links = [...(props.nav?.footer || []), ...(props.nav?.legal || [])]
const copyright = props.site?.locale === 'en'
  ? '© 2026 Vault. Encryption on device. Messages are not ours.'
  : '© 2026 Vault · Самозанятый Козлов М. А. · ИНН 774338097699'
</script>

<template>
  <footer>
    <div class="container foot">
      <div>{{ copyright }}</div>
      <div class="links">
        <a v-for="item in links" :key="item.url" :href="item.url">{{ item.label }}</a>
      </div>
    </div>
  </footer>
</template>
