// Открытие ссылок во внешнем мире: адреса сайта, ссылки в сообщениях.
//
// ADR-003 Этап 3, партия 2. Жили методами App.vue без единого `this.*` —
// то есть не пользовались компонентом и просто были написаны там, где принято
// было писать. Теперь это отдельный модуль, потому что открытие ссылки нужно не
// только App.vue: MessageItem.vue адаптирует клик по сообщению, и раньше это
// означало «передать обработчик из компонента в компонент».
//
// Порядок проб и запасной путь здесь неслучаен и не меняется: на Android сначала
// нативная команда (она умеет то, чего не умеет WebView — открыть intent), и
// только при её отказе — browser fallback. Если убрать откат, то на устройстве
// без команды ссылка перестанет открываться ВИДОМО, а просто не откроется.

import { open as openExternal } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';

// Сайт приложения (лендинг, веха M4). Пока сайта нет — пустая строка:
// когда появится, подставить адрес (vault-msg.ru / vault-msg.tech),
// и клик по логотипу в шапке откроет его во внешнем браузере.
const APP_SITE_URL = '';

export function openUrl(url) {
  openExternal(String(url)).catch(() => {});
}

export async function openExternalUrl(url) {
  if (/android/i.test(navigator.userAgent)) {
    try {
      await invoke('android_open_url', { url });
      return;
    } catch (e) {
      console.warn('[open] android_open_url failed:', e);
    }
  }
  try {
    await openExternal(String(url));
  } catch (e) {
    console.warn('[open] openExternal failed:', e);
  }
}

export function openAppSite() {
  if (!APP_SITE_URL) return;
  try {
    openExternal(APP_SITE_URL);
  } catch (e) {
    window.open(APP_SITE_URL, '_blank');
  }
}
