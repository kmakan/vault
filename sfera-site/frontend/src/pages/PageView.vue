<script setup>
defineProps({ state: { type: Object, required: true } })
</script>

<template>
  <main class="content-page">
    <div class="container">
      <h1>{{ state.page?.title }}</h1>
      <div v-html="state.page?.body_html"></div>
    </div>
  </main>
</template>
