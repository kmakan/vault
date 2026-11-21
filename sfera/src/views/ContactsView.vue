<script setup>
// Контакты: состав и состояние приходят из `social-contacts`.
import { ref } from 'vue';

const props = defineProps({ state: Object, api: Object });
const inviteText = ref('');
const inviteStatus = ref('');
const busy = ref(false);

async function acceptInvite() {
  if (busy.value || !inviteText.value.trim()) return;
  busy.value = true;
  inviteStatus.value = '';
  try {
    // QR/файл несёт готовую заявку; разбор и дедуп — в Rust.
    const request = JSON.parse(inviteText.value.trim());
    const accepted = await props.api.acceptInvite(request);
    inviteStatus.value = accepted
      ? props.api.t('contacts_invite_accepted')
      : props.api.t('contacts_invite_duplicate');
    inviteText.value = '';
  } catch (e) {
    inviteStatus.value = props.api.t('contacts_invite_bad') + ': ' + (e?.message ?? e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>{{ api.t('nav_contacts') }}</h1>
      <span class="badge">{{ state.contacts.length }}</span>
    </header>

    <p v-if="state.error" class="error">{{ state.error }}</p>

    <div class="card invite">
      <h2>{{ api.t('contacts_invite_title') }}</h2>
      <textarea v-model="inviteText" class="invite-input" rows="3"
                :placeholder="api.t('contacts_invite_hint')"></textarea>
      <button class="primary" :disabled="busy || !inviteText.trim()" @click="acceptInvite">
        {{ busy ? api.t('create_encrypting') : api.t('contacts_invite_action') }}
      </button>
      <p v-if="inviteStatus" class="muted">{{ inviteStatus }}</p>
    </div>

    <div v-if="!state.contacts.length" class="empty">{{ api.t('contacts_empty') }}</div>

    <article v-for="contact in state.contacts" :key="contact.fp" class="card contact">
      <div class="contact-main">
        <span class="fp">{{ contact.fp }}</span>
        <span class="muted">{{ contact.role }} · {{ contact.state }}</span>
      </div>
      <div v-if="contact.spheres?.length" class="chips">
        <span v-for="sphere in contact.spheres" :key="sphere" class="chip">{{ sphere }}</span>
      </div>
    </article>
  </section>
</template>

<style scoped>
.contact-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.invite { margin-bottom: 12px; }
.invite h2 { font-size: 15px; margin: 0 0 8px; }
.invite-input { width: 100%; box-sizing: border-box; resize: vertical; padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--text-primary); font: inherit; font-size: 12px; }
</style>
