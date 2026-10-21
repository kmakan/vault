// Набор мутаций: ui-mut
// Цель: убедиться, что смоук ui-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'ui-mut',
  file: 'src/ui.js',
  smoke: 'ui-smoke.mjs',
  mutations: [
    { name: "«Отмена» в confirm возвращает null вместо false (не Web-API)",
      pattern: "    cancelBtn.addEventListener('click', () => finish(inputEl ? null : false));",
      replacement: "    cancelBtn.addEventListener('click', () => finish(null));" },
    { name: "«ОК» в prompt возвращает true вместо введённого",
      pattern: "    okBtn.addEventListener('click', () => finish(inputEl ? inputEl.value : true));",
      replacement: "    okBtn.addEventListener('click', () => finish(inputEl ? true : true));" },
    { name: "Escape не закрывает диалог (модалка «висит»)",
      pattern: "      if (e.key === 'Escape') finish(inputEl ? null : false);",
      replacement: "      if (e.key === 'Escape') { /* пропущено */ }" },
    { name: "Enter не отправляет введённое в prompt",
      pattern: "      if (e.key === 'Enter' && inputEl) finish(inputEl.value);",
      replacement: "      if (e.key === 'Enter' && inputEl) { /* пропущено */ }" },
    { name: "клик по подложке не закрывает диалог",
      pattern: "    overlay.addEventListener('mousedown', e => {\n      if (e.target === overlay) finish(inputEl ? null : false);\n    });",
      replacement: "    overlay.addEventListener('mousedown', e => {\n      if (e.target === overlay) { /* пропущено */ }\n    });" },
    { name: "после закрытия диалог остаётся в DOM",
      pattern: "      overlay.remove();",
      replacement: "      void 0;" },
    { name: "alert не показывает тост (текст пропадает)",
      pattern: "window.alert = function (msg) {\n  toast(String(msg));\n};",
      replacement: "window.alert = function (msg) { void 0; };" },
  ],
};
