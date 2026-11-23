<script setup>
// Создание поста: форма и один вызов. Адресат приходит из Rust готовым
// `PostAudience`, UI его не собирает и не пересчитывает (ADR-006 §9.3).
import { computed, ref } from 'vue';

const props = defineProps({ state: Object, api: Object });

const body = ref('');
const audienceId = ref('');
const busy = ref(false);
const status = ref('');
const attachInput = ref(null);
const attachStatus = ref('');
const attachBusy = ref(false);
const sphereName = ref('');
const sphereMembers = ref([]);
const sphereBusy = ref(false);
const sphereStatus = ref('');

// Вложение шифруется и попадает в общий список загрузок; публикация берёт
// его оттуда. Ключ и тип файла остаются в Rust.
async function onAttach(event) {
  const file = event.target.files?.[0];
  if (!file || attachBusy.value) return;
  attachBusy.value = true;
  attachStatus.value = '';
  try {
    const result = await props.api.uploadFile(file);
    attachStatus.value = props.api.t('storage_uploaded', {
      name: file.name, kind: result.kind, size: result.size,
    });
  } catch (e) {
    attachStatus.value = props.api.t('storage_upload_fail') + ': ' + (e?.message ?? e);
  } finally {
    attachBusy.value = false;
    if (attachInput.value) attachInput.value.value = '';
  }
}

function removeUpload(index) {
  props.state.uploads.splice(index, 1);
}

async function createSphere() {
  if (sphereBusy.value || !sphereName.value.trim()) return;
  sphereBusy.value = true;
  sphereStatus.value = '';
  try {
    const id = sphereName.value.trim();
    await props.api.createAudience({ id, members: sphereMembers.value });
    // Созданную сферу выбираем явно: публикация без выбора по-прежнему
    // недоступна.
    audienceId.value = id;
    sphereName.value = '';
    sphereMembers.value = [];
    sphereStatus.value = props.api.t('create_sphere_created');
  } catch (e) {
    sphereStatus.value = String(e?.message ?? e);
  } finally {
    sphereBusy.value = false;
  }
}

// Аудитория — явный выбор человека. Молча взять первую сферу нельзя:
// пост ушёл бы не тем людям (продукт §3.3, «дефолт — пусто»).
const selected = computed(
  () => props.state.audiences.find((a) => a.id === audienceId.value) ?? null,
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
    status.value = props.api.t('create_published');
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

      <div class="attach-row">
        <button type="button" class="ghost" :disabled="attachBusy"
                @click="attachInput?.click()">
          {{ api.t('create_attach') }}
        </button>
        <input ref="attachInput" type="file" class="hidden-input" @change="onAttach" />
        <span v-if="attachStatus" class="muted">{{ attachStatus }}</span>
      </div>

      <div class="composer-row">
        <label class="field">
          <span class="muted">{{ api.t('create_audience') }}</span>
          <select v-if="state.audiences.length" v-model="audienceId" class="select">
            <option value="" disabled>{{ api.t('create_choose_audience') }}</option>
            <option v-for="a in state.audiences" :key="a.id" :value="a.id">{{ a.id }}</option>
          </select>
          <span v-else class="muted">{{ api.t('create_no_audience') }}</span>
          <span v-if="state.audiences.length && !selected" class="muted hint">
            {{ api.t('create_audience_required') }}
          </span>
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
.hint { font-size: 12px; line-height: 1.4; }
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

.attach-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.hidden-input { display: none; }
.ghost {
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.ghost:hover { border-color: var(--accent-primary); }
</style>
