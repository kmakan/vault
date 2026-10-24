// Набор мутаций: groups-load-mut
// Цель: убедиться, что смоук groups-load-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'groups-load-mut',
  file: 'src/features/groups-load.js',
  smoke: 'groups-load-smoke.mjs',
  mutations: [
    { name: "частичный результат теряется при сбое загрузки",
      pattern: "  } catch (error) {\n    console.error('Failed to load groups:', error);",
      replacement: "  } catch (error) {\n    groups = null;\n    console.error('Failed to load groups:', error);" },
    { name: "участник группы попадает в контакты повторно",
      pattern: "        if (addr === email || seen.has(addr)) continue;",
      replacement: "        if (addr === email) continue;" },
    { name: "аватар группы не читается",
      pattern: "      const av = await db.kvGet('anon', 'group-avatar:' + g.id);",
      replacement: "      const av = null;" },
    { name: "иконка группы не читается",
      pattern: "      const ic = await db.kvGet('anon', 'group-icon:' + g.id);",
      replacement: "      const ic = null;" },
    { name: "запрос аватара у участников не отправляется",
      pattern: "      else if (requestGroupAvatarHeal) requestGroupAvatarHeal(g.id).catch(() => {});",
      replacement: "      else if (false) requestGroupAvatarHeal(g.id).catch(() => {});" },
    { name: "алиасы не передаются в фильтр групп",
      pattern: "      aliases,",
      replacement: "      aliases: []," },
    { name: "канонический адрес моста игнорируется (контакт-призрак)",
      pattern: "        const addr = canonical || m.email;",
      replacement: "        const addr = m.email;" },
    { name: "вопрос «тот ли это человек» не задаётся мосту",
      pattern: "          canonical = await invoke('groups_member_canonical', {",
      replacement: "          canonical = await (async () => null)() && invoke('groups_member_canonical', {" },
  ],
};
