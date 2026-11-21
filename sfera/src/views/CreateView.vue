<script setup>
// Создание поста: форма и один вызов. Адресат приходит из Rust готовым
// `PostAudience`, UI его не собирает и не пересчитывает (ADR-006 §9.3).
import { computed, ref } from 'vue';

const props = defineProps({ state: Object, api: Object });

const body = ref('');
const audienceId = ref('');
const busy = ref(false);
const status = ref('');
const sphereName = ref('');
const sphereMembers = ref([]);
const sphereBusy = ref(false);
const sphereStatus = ref('');

function removeUpload(index) {
  props.state.uploads.splice(index, 1);
}

async function createSphere() {
  if (sphereBusy.value || !sphereName.value.trim()) return;
  sphereBusy.value = true;
  sphereStatus.value = '';
  try {
    await props.api.createAudience({ id: sphereName.value.trim(), members: sphereMembers.value });
    sphereName.value = '';
    sphereMembers.value = [];
    sphereStatus.value = props.api.t('create_sphere_created');
  } catch (e) {
    sphereStatus.value = String(e?.message ?? e);
  } finally {
    sphereBusy.value = false;
  }
}

const selected = computed(
  () => props.state.audiences.find((a) => a.id === audienceId.value) ?? props.state.audiences[0] ?? null,
);

async function submit() {
  if (busy.value) return;
  busy.value = true;
  status.value = '';
  try {
    if (props.state.uploads.length) {
      await props.api.publishWithMedia({ body: body.value, audience: selected.value });
    } else {
      await props.api.publish({ body: body.value, audience: selected.value });
    }
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

      <div v-if="state.uploads.length" class="attached">
        <span class="muted">{{ api.t('create_attached') }}</span>
        <span v-for="(u, i) in state.uploads" :key="u.blob_id" class="chip on">
          {{ u.kind }} · {{ u.size }}
          <button class="chip-remove" @click="removeUpload(i)">×</button>
        </span>
      </div>

      <p v-if="status" class="muted">{{ status }}</p>
    </div>

    <div class="card sphere">
      <h2>{{ api.t('create_sphere_title') }}</h2>
      <input v-model="sphereName" class="sphere-name"
             :placeholder="api.t('create_sphere_name')" />
      <div v-if="state.contacts.length" class="member-list">
        <label v-for="c in state.contacts" :key="c.fp" class="member">
          <input type="checkbox" :value="c.fp" v-model="sphereMembers" />
          <span class="fp">{{ c.fp }}</span>
        </label>
      </div>
      <p v-else class="muted">{{ api.t('create_sphere_no_contacts') }}</p>
      <button class="primary" :disabled="sphereBusy || !sphereName.trim()" @click="createSphere">
        {{ sphereBusy ? api.t('create_encrypting') : api.t('create_sphere_action') }}
      </button>
      <p v-if="sphereStatus" class="muted">{{ sphereStatus }}</p>
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

.sphere { margin-top: 16px; }
.sphere h2 { font-size: 15px; margin: 0 0 10px; }
.sphere-name { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--text-primary); font: inherit; }
.member-list { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; max-height: 160px; overflow-y: auto; }
.member { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }

.attached { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.chip-remove { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 0 2px; }
</style>
