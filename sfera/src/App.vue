<script setup>
// App.vue — только вызовы: навигация, тема и выбор экрана. Ни одного правила
// протокола, прав или форматов (ADR-006 §9.3, §17).
import { computed, onMounted, onUnmounted } from 'vue';
import FeedView from './views/FeedView.vue';
import ContactsView from './views/ContactsView.vue';
import CreateView from './views/CreateView.vue';
import StorageView from './views/StorageView.vue';
import ProfileView from './views/ProfileView.vue';

const props = defineProps({
  state: { type: Object, required: true },
  api: { type: Object, required: true },
});

const VIEWS = {
  feed: FeedView,
  contacts: ContactsView,
  create: CreateView,
  storage: StorageView,
  profile: ProfileView,
};

const view = computed(() => VIEWS[props.state.tab] ?? FeedView);

// Десктоп: Ctrl/Cmd+1…5 переключают вкладки. Это навигация, не правило.
function onKey(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const index = Number(event.key) - 1;
  const tab = props.api.tabs()[index];
  if (!tab) return;
  event.preventDefault();
  props.api.openTab(tab.id);
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="app" :style="api.themeVars()" :data-theme="state.theme">
    <nav class="rail" aria-label="Sfera">
      <button
        v-for="tab in api.tabs()"
        :key="tab.id"
        class="rail-btn"
        :class="{ active: state.tab === tab.id }"
        :aria-current="state.tab === tab.id ? 'page' : undefined"
        @click="api.openTab(tab.id)"
      >
        {{ api.t(tab.labelKey) }}
      </button>
    </nav>
    <main class="content">
      <component :is="view" :state="state" :api="api" />
    </main>
  </div>
</template>
