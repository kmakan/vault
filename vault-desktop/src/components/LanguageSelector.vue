<template>
  <div class="language-selector">
    <label>{{ t('language_selector') }}</label>
    <select :value="currentLocale" @change="onLocaleChange">
      <option v-for="locale in availableLocales" :key="locale.code" :value="locale.code">
        {{ locale.name }}
      </option>
    </select>
  </div>
</template>

<script>
import { useI18n } from '../i18n.js'

export default {
  name: 'LanguageSelector',
  setup() {
    const { t, setLocale, availableLocales, currentLocale } = useI18n()

    const onLocaleChange = (e) => {
      setLocale(e.target.value)
    }

    return { t, availableLocales, currentLocale, onLocaleChange }
  }
}
</script>

<style scoped>
.language-selector {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 1rem 0;
}

.language-selector label {
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
}

.language-selector select {
  padding: 0.5rem 1rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 0.9rem;
  cursor: pointer;
  transition: border-color 0.2s;
}

.language-selector select:hover {
  border-color: var(--accent-primary);
}

.language-selector select:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px var(--accent-glow);
}
</style>
