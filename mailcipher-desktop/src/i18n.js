import { reactive, computed } from 'vue'
import en from './locales/en.js'
import ru from './locales/ru.js'
import zh from './locales/zh.js'

const locales = { en, ru, zh }

const state = reactive({
  locale: localStorage.getItem('whisper-locale') || 'en',
})

export function useI18n() {
  const t = (key) => {
    return locales[state.locale]?.[key] || locales.en[key] || key
  }

  const setLocale = (locale) => {
    if (locales[locale]) {
      state.locale = locale
      localStorage.setItem('whisper-locale', locale)
    }
  }

  const availableLocales = computed(() => [
    { code: 'en', name: locales.en.language_en },
    { code: 'ru', name: locales.ru.language_ru },
    { code: 'zh', name: locales.zh.language_zh },
  ])

  const currentLocale = computed(() => state.locale)

  return { t, setLocale, availableLocales, currentLocale }
}
