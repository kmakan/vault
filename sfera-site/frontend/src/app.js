import { createSSRApp } from 'vue'
import App from './App.vue'
import './styles/legacy.css'
import './styles/content.css'

export function createApp(state) {
  return createSSRApp(App, { state })
}
