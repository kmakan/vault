// Враппер для gradle: gen/android/buildSrc BuildTask.kt запускает
// `node tauri android android-studio-script` — node ищет файл `tauri.js`
// в cwd (src-tauri) и выполняет его как CLI. Перенаправляем на
// @tauri-apps/cli из node_modules проекта.
require('./node_modules/@tauri-apps/cli/tauri.js');
