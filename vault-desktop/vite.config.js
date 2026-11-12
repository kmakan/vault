import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    // Телефон собирается ИЗ ЭТОГО дерева (vault-desktop/src), а minSdk = 24
    // (Android 7.0). Системный WebView на Android 7-9 — это Chrome 50-80, и он
    // не разбирает ES2020: `?.`, `??`, `??=`, `||=`. Бандл без target выходил
    // с 37 вхождениями `?.` — на новом телефоне владельца симптома не видно, у
    // пользователя со старым телефоном приложение открывается белым экраном.
    // Защита стояла в заброшенном vault-android/vite.config.js и потерялась при
    // переезде сборки на vault-desktop (t_cca47c2c). Меряется гейтом
    // scripts/es-target-gate.mjs — по разбору готового бандла, а не по грепу.
    target: 'es2018',
  },
})
