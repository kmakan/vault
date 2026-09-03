import { reactive, computed } from 'vue'
import en from './locales/en.js'
import ru from './locales/ru.js'
import zh from './locales/zh.js'

const locales = { en, ru, zh }

const state = reactive({
  locale: localStorage.getItem('vault-locale') || 'en',
})

export function useI18n() {
  // t(key, params?) — params подставляются в {плейсхолдеры} строки
  // только ключ, и приходилось склеивать строки руками).
  const t = (key, params) => {
    let s = locales[state.locale]?.[key] || locales.en[key] || key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.replaceAll('{' + k + '}', String(v))
      }
    }
    return s
  }

  const setLocale = (locale) => {
    if (locales[locale]) {
      state.locale = locale
      localStorage.setItem('vault-locale', locale)
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
