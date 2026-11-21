import { createApp } from 'vue';
import App from './App.vue';
import { createBridge } from './ui/bridge.js';
import { createAppState } from './ui/app.js';
import { tauriInvoke } from './ui/tauri.js';
import './ui/styles.css';

const api = createAppState({ bridge: createBridge(tauriInvoke) });
// Состояние уже реактивное внутри createAppState: все методы и Vue видят
// один и тот же объект (иначе вкладки не переключаются).
const state = api.state;

api.init();
createApp(App, { state, api }).mount('#app');
