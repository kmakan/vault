<script setup>
defineProps({ state: { type: Object, required: true } })
</script>

<template>
  <main class="content-page legal-page">
    <div class="container">
      <h1>{{ state.legal?.title }}</h1>
      <p class="updated">
        {{ state.site?.locale === 'en' ? 'Version' : 'Редакция' }}:
        {{ state.legal?.version }}
      </p>
      <div v-html="state.legal?.body_html"></div>
    </div>
  </main>
</template>
