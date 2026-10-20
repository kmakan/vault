// Набор мутаций: groups-migrate-mut
// Цель: убедиться, что смоук groups-migrate-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'groups-migrate-mut',
  file: 'src/features/groups-migrate.js',
  smoke: 'groups-migrate-smoke.mjs',
  mutations: [
    { name: "поиск устаревшего участника по файлу на диске отключён",
      pattern: "      const dk = (await loadDiskKeys()).find(k => String(k.email).toLowerCase() === emLc);",
      replacement: "      const dk = null;" },
    { name: "поиск по fingerprint группы отключён",
      pattern: "        if (newFp && String(m.fingerprint) === newFp) { stale = m; break; }",
      replacement: "        if (false) { stale = m; break; }" },
    { name: "участник не помечается key_shared",
      pattern: "    stale.key_shared = true;",
      replacement: "    stale.key_shared = false;" },
    { name: "ошибка записи возвращает «успех»",
      pattern: "    } catch (e) {\n      console.warn('[groups] groups_rename_member отказал, участник не переехал:',\n        e && e.message || e);\n      return false;\n    }",
      replacement: "    } catch (e) {\n      return true;\n    }" },
    { name: "участник под новым адресом не пропускается",
      pattern: "      if (em.toLowerCase() === fromLc) continue; // уже под новым адресом",
      replacement: "      if (false) continue;" },
  ],
};
