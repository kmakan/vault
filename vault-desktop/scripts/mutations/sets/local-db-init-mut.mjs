// Набор мутаций: local-db-init-mut
// Цель: убедиться, что смоук local-db-init-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'local-db-init-mut',
  file: 'src/features/local-db-init.js',
  smoke: 'local-db-init-smoke.mjs',
  mutations: [
    { name: "тумбстоуны и mid не разделяются",
      pattern: "    tombstones: tombs.filter(t => t[0]).map(t => t[0]),\n    midTombstones: tombs.filter(t => t[1]).map(t => t[1]),",
      replacement: "    tombstones: tombs.map(t => t[0]),\n    midTombstones: tombs.map(t => t[1])," },
    { name: "при отказе загрузки кэш обнуляется вместо null",
      pattern: "  } catch (e) {\n    console.warn('initLocalDb tombstones failed:', e);",
      replacement: "  } catch (e) {\n    out.tombstones = [];\n    out.midTombstones = [];\n    console.warn('initLocalDb tombstones failed:', e);" },
    { name: "при отказе курсоров кэш обнуляется вместо null",
      pattern: "  } catch (e) {\n    console.warn('initLocalDb cursors failed:', e);",
      replacement: "  } catch (e) {\n    out.cursors = [];\n    console.warn('initLocalDb cursors failed:', e);" },
    { name: "курсоры грузятся не из того пространства имён",
      pattern: "    out.cursors = await db.cursorsLoad('local');",
      replacement: "    out.cursors = await db.cursorsLoad(accEmail);" },
    { name: "томбстоуны грузятся не из namespace аккаунта",
      pattern: "    const tombs = await db.tombstonesLoad(accEmail);",
      replacement: "    const tombs = await db.tombstonesLoad('local');" },
  ],
};
