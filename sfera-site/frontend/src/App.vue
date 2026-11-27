<script setup>
import { computed } from 'vue'
import SiteHeader from './components/SiteHeader.vue'
import SiteFooter from './components/SiteFooter.vue'
import HomeView from './pages/HomeView.vue'
import PageView from './pages/PageView.vue'
import LegalView from './pages/LegalView.vue'
import DocsView from './pages/DocsView.vue'
import DocView from './pages/DocView.vue'
import NotFoundView from './pages/NotFoundView.vue'

const props = defineProps({ state: { type: Object, required: true } })

const VIEWS = {
  home: HomeView,
  page: PageView,
  legal: LegalView,
  docs: DocsView,
  doc: DocView,
  notfound: NotFoundView,
}

const view = computed(() => VIEWS[props.state.view] ?? NotFoundView)
</script>

<template>
  <div class="site" :data-locale="state.site?.locale">
    <SiteHeader :site="state.site" :nav="state.nav" :path="state.path" />
    <component :is="view" :state="state" />
    <SiteFooter :site="state.site" :nav="state.nav" />
  </div>
</template>
