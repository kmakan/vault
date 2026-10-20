// Набор мутаций: groups-create-mut
// Цель: убедиться, что смоук groups-create-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'groups-create-mut',
  file: 'src/features/groups-create.js',
  smoke: 'groups-create-smoke.mjs',
  mutations: [
    { name: "имя группы не обрезается",
      pattern: "  const group = await api.createGroup(name.trim(), '');",
      replacement: "  const group = await api.createGroup(name, '');" },
    { name: "аватар группы не сохраняется",
      pattern: "  if (avatar) await db.kvSet('anon', 'group-avatar:' + group.id, avatar);",
      replacement: "  if (false) await db.kvSet('anon', 'group-avatar:' + group.id, avatar);" },
    { name: "состояние не применяется (onCreated не вызван)",
      pattern: "  if (onCreated) onCreated({ group, avatar });",
      replacement: "  if (false) onCreated({ group, avatar });" },
    { name: "ключ группы не генерируется",
      pattern: "  if (cryptoReady) {",
      replacement: "  if (false) {" },
    { name: "аватар не рассылается участникам",
      pattern: "        await api.sendGroupMeta(group.id, content);",
      replacement: "        void 0;" },
    { name: "сбой рассылки аватара роняет создание группы",
      pattern: "      } catch (e) {\n        console.warn('Group avatar broadcast failed:', e);\n      }",
      replacement: "      } catch (e) {\n        throw e;\n      }" },
  ],
};
