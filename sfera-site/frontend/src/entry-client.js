import { createApp } from './app.js'

const state = window.__INITIAL_STATE__
if (state) {
  createApp(state).mount('#app')
}
