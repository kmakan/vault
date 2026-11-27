<script setup>
defineProps({ state: { type: Object, required: true } })
</script>

<template>
  <section
    v-for="block in state.page?.blocks || []"
    :id="block.key"
    :key="block.key"
    :class="block.data?.class || ''"
    :style="block.data?.style || ''"
    v-html="block.body_html"
  ></section>
</template>
