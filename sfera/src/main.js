import { createApp, reactive } from 'vue';
import App from './App.vue';
import { createBridge } from './ui/bridge.js';
import { createAppState } from './ui/app.js';
import { tauriInvoke } from './ui/tauri.js';
import './ui/styles.css';

const api = createAppState({ bridge: createBridge(tauriInvoke) });
const state = reactive(api.state);

api.init();
createApp(App, { state, api }).mount('#app');
