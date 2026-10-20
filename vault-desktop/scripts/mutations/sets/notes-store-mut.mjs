// Набор мутаций: notes-store-mut
// Цель: убедиться, что смоук notes-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'notes-store-mut',
  file: 'src/features/notes-store.js',
  smoke: 'notes-store-smoke.mjs',
  mutations: [
    { name: "заметка не добавляется в список",
      pattern: "      list.push(note);",
      replacement: "      void 0;" },
    { name: "заметка не удаляется",
      pattern: "      const filtered = list.filter((n) => n && n.id !== id);",
      replacement: "      const filtered = list;" },
    { name: "дубль по id не отклоняется",
      pattern: "      if (note && note.id != null && list.some((n) => n && n.id === note.id)) return false;",
      replacement: "      if (false) return false;" },
    { name: "битый JSON роняет чтение (вместо [])",
      pattern: "      } catch (e) {\n        return [];",
      replacement: "      } catch (e) {\n        return null;" },
  ],
};
