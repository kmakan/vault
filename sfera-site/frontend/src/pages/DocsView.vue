<script setup>
defineProps({ state: { type: Object, required: true } })
</script>

<template>
  <main class="content-page">
    <div class="container">
      <h1>{{ state.site?.locale === 'en' ? 'Documentation' : 'Руководство' }}</h1>
      <p v-if="!state.tree?.length" class="muted">
        {{ state.site?.locale === 'en' ? 'Documentation is being prepared.' : 'Руководство готовится.' }}
      </p>
      <ul class="docs-tree">
        <li v-for="node in state.tree || []" :key="node.slug">
          <a :href="`/docs/${node.slug}`">{{ node.title }}</a>
          <ul v-if="node.children?.length">
            <li v-for="child in node.children" :key="child.slug">
              <a :href="`/docs/${child.slug}`">{{ child.title }}</a>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </main>
</template>
