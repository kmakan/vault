// Sfera UI: единственный адаптер к рантайму Tauri. Если приложение открыто
// в браузере без оболочки, вызов честно падает, а не подставляет фальшивые
// данные (ADR-006 §9.3).
export async function tauriInvoke(command, args) {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    throw new Error('Tauri runtime is not available');
  }
  return internals.invoke(command, args);
}
