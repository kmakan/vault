<script setup>
// Создание поста: форма и один вызов. Адресат приходит из Rust готовым
// `PostAudience`, UI его не собирает и не пересчитывает (ADR-006 §9.3).
import { computed, ref } from 'vue';

const props = defineProps({ state: Object, api: Object });

const body = ref('');
const audienceId = ref('');
const busy = ref(false);
const status = ref('');

const selected = computed(
  () => props.state.audiences.find((a) => a.id === audienceId.value) ?? props.state.audiences[0] ?? null,
);

async function submit() {
  if (busy.value) return;
  busy.value = true;
  status.value = '';
  try {
    await props.api.publish({ body: body.value, audience: selected.value });
    body.value = '';
    status.value = props.api.t('create_sent', { n: 1, m: 1 });
  } catch (e) {
    status.value = String(e?.message ?? e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>{{ api.t('nav_create') }}</h1>
    </header>

    <div class="card">
      <textarea
        v-model="body"
        class="composer"
        rows="5"
        :placeholder="api.t('create_placeholder')"
      ></textarea>

      <div class="composer-row">
        <label class="field">
          <span class="muted">{{ api.t('create_audience') }}</span>
          <select v-if="state.audiences.length" v-model="audienceId" class="select">
            <option v-for="a in state.audiences" :key="a.id" :value="a.id">{{ a.id }}</option>
          </select>
          <span v-else class="muted">{{ api.t('create_no_audience') }}</span>
        </label>

        <button class="primary" :disabled="busy || !selected || !body.trim()" @click="submit">
          {{ busy ? api.t('create_encrypting') : api.t('create_publish') }}
        </button>
      </div>

      <p v-if="status" class="muted">{{ status }}</p>
    </div>
  </section>
</template>

<style scoped>
.composer {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  padding: 12px;
}
.composer-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.select {
  min-width: 180px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
}
</style>
