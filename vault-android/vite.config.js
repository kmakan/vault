import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    // Android: system WebView on older phones (Android 7-9, Chrome 50-80)
    // may not parse modern syntax (optional chaining, nullish coalescing).
    // Transpile down to ES2018 so the bundle runs on any WebView >= Chrome 63.
    target: 'es2018',
  },
})
