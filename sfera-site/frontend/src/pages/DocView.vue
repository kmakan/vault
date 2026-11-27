<script setup>
defineProps({ state: { type: Object, required: true } })
</script>

<template>
  <main class="content-page">
    <div class="container">
      <p class="muted"><a :href="state.docsBase || '/docs'">← {{ state.docsLabel || 'Руководство' }}</a></p>
      <h1>{{ state.doc?.title }}</h1>
      <p v-if="state.doc?.summary" class="lead">{{ state.doc.summary }}</p>
      <div v-html="state.doc?.body_html"></div>
      <p v-if="state.doc?.version" class="updated">{{ state.doc.version }}</p>
    </div>
  </main>
</template>
