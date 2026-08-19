// Замены нативных диалогов (alert/confirm/prompt) — ДО монтирования Vue,
// чтобы ни один вызов не ушёл в системный WebKit-диалог с заголовком tauri://localhost
import './ui.js';
import './style.css';
import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
