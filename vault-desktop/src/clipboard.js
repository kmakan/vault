// Копирование в буфер обмена.
//
// ADR-003 Этап 3, партия 10. Вынесено по правилу «модуль возвращает факт, UI
// показывает»: алерты и переводы остались в App.vue, здесь только попытка
// скопировать. Так фолбэк можно проверить тестом, не подделывая компонент.
//
// ФОЛБЭК НЕ КОСМЕТИКА. navigator.clipboard недоступен там, где нет защищённого
// контекста и разрешения: в WebKitGTK без фокуса, в старом WebView, иногда на
// Android при вызове не из жеста. Тогда execCommand('copy') через временный
// textarea — единственный путь. Убрать фолбэк = «скопировать» перестаёт работать
// там, где раньше работало, и это заметно только у тех, у кого иначе.
//
// textarea обязателен ПЕРЕД вызовом execCommand: без выделения команда не
// срабатывает. Элемент уводится с глаз (position:fixed, opacity:0), иначе
// страница дёргается на время копирования.

export async function copyTextToClipboard(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* фолбэк ниже */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (e) {
    return false;
  }
}
