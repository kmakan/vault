// Набор мутаций: groups-clone-mut
// Цель: убедиться, что смоук groups-clone-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'groups-clone-mut',
  file: 'src/features/groups-clone.js',
  smoke: 'groups-clone-smoke.mjs',
  mutations: [
    { name: "создатель клона приглашает сам себя",
      pattern: "    if (!em || em === (email || '').toLowerCase()) continue;",
      replacement: "    if (!em) continue;" },
    { name: "поиск ключа по нижнему регистру отключён",
      pattern: "    const peerPub = peerKeys[m.email] || peerKeys[em] || null;",
      replacement: "    const peerPub = peerKeys[m.email] || null;" },
    { name: "участник без ключа считается приглашённым",
      pattern: "    if (!peerPub) { skipped.push(m.email); continue; }",
      replacement: "    if (!peerPub) { invited.push(m.email); continue; }" },
    { name: "роль участника теряется при инвайте",
      pattern: "      group.members.push({ email: m.email, role: m.role || 'Member', invited: true });",
      replacement: "      group.members.push({ email: m.email, invited: true });" },
    { name: "ошибка инвайта не попадает в пропущенные",
      pattern: "    } catch (e) {\n      skipped.push(m.email);\n    }",
      replacement: "    } catch (e) {\n      invited.push(m.email);\n    }" },
    { name: "аватар исходной группы не копируется",
      pattern: "  if (avatar) await db.kvSet('anon', 'group-avatar:' + group.id, avatar);",
      replacement: "  if (false) await db.kvSet('anon', 'group-avatar:' + group.id, avatar);" },
  ],
};
