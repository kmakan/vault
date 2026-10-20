// Набор мутаций: clipboard-mut
// Цель: убедиться, что смоук clipboard-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'clipboard-mut',
  file: 'src/clipboard.js',
  smoke: 'clipboard-smoke.mjs',
  mutations: [
    { name: "фолбэк рапортует успех, не копируя",
      pattern: "    document.execCommand('copy');",
      replacement: "    void 0;" },
    { name: "текст не выделяется (execCommand не срабатывает)",
      pattern: "    ta.select();",
      replacement: "    void 0;" },
    { name: "textarea остаётся в DOM",
      pattern: "    document.body.removeChild(ta);",
      replacement: "    void 0;" },
    { name: "ошибка копирования возвращает успех",
      pattern: "  } catch (e) {\n    return false;\n  }",
      replacement: "  } catch (e) {\n    return true;\n  }" },
  ],
};
