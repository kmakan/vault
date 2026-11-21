<script setup>
// Контакты: состав и состояние приходят из `social-contacts`.
defineProps({ state: Object, api: Object });
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>{{ api.t('nav_contacts') }}</h1>
      <span class="badge">{{ state.contacts.length }}</span>
    </header>

    <p v-if="state.error" class="error">{{ state.error }}</p>

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
</style>
