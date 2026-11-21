import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Sfera UI: Vue 3 без роутера и без состояния в компонентах. Пять вкладок —
// это `src/ui/shell.js`, данные — Tauri-команды (ADR-006 §17).
export default defineConfig({
  plugins: [vue()],
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
