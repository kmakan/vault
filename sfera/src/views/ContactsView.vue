<script setup>
// Контакты: состав и состояние приходят из `social-contacts`.
import { ref, computed } from 'vue';

const props = defineProps({ state: Object, api: Object });
const inviteText = ref('');
const inviteStatus = ref('');
const busy = ref(false);
const editing = ref('');
const draft = ref([]);
const sphereBusy = ref(false);
const sphereStatus = ref('');
const roleBusy = ref('');
const roleStatus = ref({ fp: '', text: '' });
const inboxBusy = ref(false);
const inboxStatus = ref('');
const receivedSummary = computed(() => {
  const r = props.state.receiveReport;
  if (!r) return '';
  const hasEvents = (r.profiles + r.comments + r.reactions) > 0;
  return props.api.t(hasEvents ? 'contacts_receive_report' : 'contacts_receive_empty', {
    profiles: r.profiles, comments: r.comments, reactions: r.reactions, rejected: r.rejected,
  });
});
const deliverySummary = computed(() => {
  const s = props.state.sync;
  return s ? props.api.t('contacts_delivery_report', {
    pending: s.pending, sent: s.sent, failed: s.failed,
  }) : '';
});

async function receiveInbox() {
  if (inboxBusy.value) return;
  inboxBusy.value = true;
  inboxStatus.value = '';
  try {
    await props.api.receiveInbox();
    inboxStatus.value = receivedSummary.value;
  } catch (e) {
    inboxStatus.value = props.api.t('contacts_receive_fail') + ': ' + (e?.message ?? e);
  } finally {
    inboxBusy.value = false;
  }
}

function profileOf(fp) { return props.state.contactProfiles?.[fp]?.profile ?? null; }
function avatarOf(fp) { return props.state.contactAvatars?.[fp] ?? ''; }

// Значения ролей и права приходят из Rust; UI только подставляет подписи.
function roleLabel(value) {
  return props.api.t('contact_role_' + value);
}

function stateLabel(value) {
  return props.api.t('contact_state_' + value);
}

function roleHint(value) {
  const opt = (props.state.roleOptions ?? []).find((o) => o.value === value);
  if (!opt) return '';
  const parts = [];
  if (opt.can_view_media) parts.push(props.api.t('contact_right_media'));
  if (opt.can_react) parts.push(props.api.t('contact_right_react'));
  if (opt.can_view_history) parts.push(props.api.t('contact_right_history'));
  if (opt.can_request_chat) parts.push(props.api.t('contact_right_chat'));
  parts.push(
    props.api.t('contact_right_profile', {
      v: props.api.t('contact_profile_' + opt.profile),
    }),
  );
  return parts.join(' · ');
}

async function onRole(fp, value) {
  if (roleBusy.value) return;
  roleBusy.value = fp;
  roleStatus.value = { fp, text: '' };
  try {
    await props.api.setContactRole(fp, value);
    roleStatus.value = { fp, text: props.api.t('contacts_role_saved') };
  } catch (e) {
    roleStatus.value = {
      fp,
      text: props.api.t('contacts_role_save_fail') + ': ' + (e?.message ?? e),
    };
  } finally {
    roleBusy.value = '';
  }
}

function membersOf(id) {
  return props.state.audienceMembers?.[id]?.members ?? [];
}

// Сферы контакта считаем по фактическому составу сфер, а не по полю записи
// контакта: после правки состава оно может отставать.
function contactSpheres(fp) {
  return (props.state.audiences ?? [])
    .filter((a) => membersOf(a.id).includes(fp))
    .map((a) => a.id);
}

// Состав сферы меняется целиком; эпоху и ключ ротирует Rust.
async function toggleEdit(id) {
  sphereStatus.value = '';
  if (editing.value === id) {
    editing.value = '';
    return;
  }
  await props.api.loadAudienceMembers(id);
  draft.value = [...membersOf(id)];
  editing.value = id;
}

async function saveMembers(id) {
  if (sphereBusy.value) return;
  sphereBusy.value = true;
  sphereStatus.value = '';
  try {
    await props.api.setAudienceMembers({ id, members: draft.value });
    sphereStatus.value = props.api.t('contacts_sphere_saved');
    editing.value = '';
  } catch (e) {
    sphereStatus.value = props.api.t('contacts_sphere_save_fail') + ': ' + (e?.message ?? e);
  } finally {
    sphereBusy.value = false;
  }
}

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

    <div class="card inbox">
      <button type="button" class="ghost" :disabled="inboxBusy" @click="receiveInbox">
        {{ inboxBusy ? api.t('contacts_receiving') : api.t('contacts_receive') }}
      </button>
      <p v-if="inboxStatus" class="muted" role="status">{{ inboxStatus }}</p>
      <p v-if="inboxStatus && deliverySummary" class="muted">{{ deliverySummary }}</p>
      <p class="muted hint">{{ api.t('contacts_receive_hint') }}</p>
    </div>

    <div class="card invite">
      <h2>{{ api.t('contacts_invite_title') }}</h2>
      <textarea v-model="inviteText" class="invite-input" rows="3"
                :placeholder="api.t('contacts_invite_hint')"></textarea>
      <button class="primary" :disabled="busy || !inviteText.trim()" @click="acceptInvite">
        {{ busy ? api.t('create_encrypting') : api.t('contacts_invite_action') }}
      </button>
      <p v-if="inviteStatus" class="muted">{{ inviteStatus }}</p>
    </div>

    <div class="card spheres">
      <h2>{{ api.t('contacts_spheres') }}</h2>
      <p v-if="!state.audiences.length" class="muted">{{ api.t('contacts_spheres_empty') }}</p>
      <div v-for="a in state.audiences" :key="a.id" class="sphere">
        <div class="sphere-head">
          <span class="sphere-name">{{ a.id }}</span>
          <span class="muted">{{ api.t('contacts_sphere_epoch', { n: a.epoch }) }}</span>
          <button type="button" class="ghost" @click="toggleEdit(a.id)">
            {{ editing === a.id ? api.t('common_cancel') : api.t('contacts_sphere_edit') }}
          </button>
        </div>
        <div v-if="editing !== a.id" class="chips">
          <span v-for="fp in membersOf(a.id)" :key="fp" class="chip">{{ fp }}</span>
          <span v-if="!membersOf(a.id).length" class="muted">
            {{ api.t('contacts_sphere_no_members') }}
          </span>
        </div>
        <div v-else class="sphere-edit">
          <label v-for="c in state.contacts" :key="c.fp" class="member">
            <input type="checkbox" :value="c.fp" v-model="draft" />
            <span class="fp">{{ c.fp }}</span>
          </label>
          <p v-if="!state.contacts.length" class="muted">{{ api.t('contacts_empty') }}</p>
          <button type="button" class="primary" :disabled="sphereBusy" @click="saveMembers(a.id)">
            {{ sphereBusy ? api.t('create_encrypting') : api.t('common_save') }}
          </button>
        </div>
      </div>
      <p v-if="sphereStatus" class="muted">{{ sphereStatus }}</p>
    </div>

    <div v-if="!state.contacts.length" class="empty">{{ api.t('contacts_empty') }}</div>

    <article v-for="contact in state.contacts" :key="contact.fp" class="card contact">
      <div class="contact-heading">
        <img v-if="avatarOf(contact.fp)" :src="avatarOf(contact.fp)" class="contact-avatar" alt="" />
        <div v-else class="contact-avatar placeholder" aria-hidden="true">?</div>
        <div class="contact-main">
          <strong v-if="profileOf(contact.fp)">{{ profileOf(contact.fp).display_name }}</strong>
          <span class="fp">{{ contact.fp }}</span>
          <span class="muted">{{ stateLabel(contact.state) }}</span>
        </div>
      </div>
      <div class="role-row">
        <label class="role-field">
          <span class="role-caption">{{ api.t('contacts_role_label') }}</span>
          <select :value="contact.role" :disabled="roleBusy === contact.fp"
                  @change="onRole(contact.fp, $event.target.value)">
            <option v-for="opt in state.roleOptions" :key="opt.value" :value="opt.value">
              {{ roleLabel(opt.value) }}
            </option>
          </select>
        </label>
        <span class="muted role-hint">{{ roleHint(contact.role) }}</span>
      </div>
      <p v-if="roleStatus.fp === contact.fp && roleStatus.text" class="muted">
        {{ roleStatus.text }}
      </p>
      <div v-if="contactSpheres(contact.fp).length" class="chips">
        <span v-for="sphere in contactSpheres(contact.fp)" :key="sphere" class="chip">{{ sphere }}</span>
      </div>
    </article>
  </section>
</template>

<style scoped>
.contact-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.contact-heading { display: flex; align-items: center; gap: 10px; }
.contact-avatar {
  width: 48px;
  height: 48px;
  flex: none;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--border-subtle);
}
.contact-avatar.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.inbox { margin-bottom: 12px; }
.inbox .hint { margin: 8px 0 0; font-size: 11px; }
.role-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}
.role-field { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.role-caption { color: var(--text-secondary); }
.role-field select {
  border: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  font: inherit;
  font-size: 12px;
}
.role-hint { font-size: 11px; }
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.invite { margin-bottom: 12px; }
.invite h2 { font-size: 15px; margin: 0 0 8px; }
.invite-input { width: 100%; box-sizing: border-box; resize: vertical; padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--text-primary); font: inherit; font-size: 12px; }

.spheres { margin-bottom: 12px; }
.spheres h2 { font-size: 15px; margin: 0 0 10px; }
.sphere { border-top: 1px solid var(--border-subtle); padding: 10px 0; }
.sphere:first-of-type { border-top: 0; padding-top: 0; }
.sphere-head { display: flex; align-items: center; gap: 10px; }
.sphere-name { font-weight: 600; }
.sphere-head .ghost { margin-left: auto; }
.sphere-edit { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.member { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }
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
