<script setup>
defineProps({ state: { type: Object, required: true } })
</script>

<template>
  <main class="content-page">
    <div class="container">
      <h1>404</h1>
      <p>{{ state.site?.locale === 'en' ? 'Page not found.' : 'Страница не найдена.' }}</p>
      <p><a href="/">{{ state.site?.locale === 'en' ? 'Home' : 'На главную' }}</a></p>
    </div>
  </main>
</template>
