// Набор мутаций: history-cache-mut
// Цель: убедиться, что смоук history-cache-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'history-cache-mut',
  file: 'src/history.js',
  smoke: 'history-cache-smoke.mjs',
  mutations: [
    { name: "история пишется под емейлом, а не под namespace (данные лягут не туда)",
      pattern: "      await db.historySave(ns, chatKey, JSON.stringify(write));",
      replacement: "      await db.historySave(account, chatKey, JSON.stringify(write));" },
    { name: "история не сохраняется вовсе (переписка теряется)",
      pattern: "      await db.historySave(ns, chatKey, JSON.stringify(write));",
      replacement: "      void 0;" },
    { name: "загрузка отдаёт [] вместо null («нет истории» и «история сломана» неразличимы)",
      pattern: "      if (!json) return null;",
      replacement: "      if (!json) return [];" },
    { name: "битые данные роняют чтение (исключение наружу)",
      pattern: "    } catch (e) {\n      console.error('loadHistory (sqlite) failed:', e);\n      return null;\n    }",
      replacement: "    } catch (e) {\n      throw e;\n    }" },
    { name: "история читается не из того namespace",
      pattern: "      const json = await db.historyLoad(await accountNamespace(account), chatKey);",
      replacement: "      const json = await db.historyLoad(account, chatKey);" },
    { name: "сообщения сохраняются не как массив (в БД попадает мусор)",
      pattern: "      await db.historySave(ns, chatKey, JSON.stringify(write));",
      replacement: "      await db.historySave(ns, chatKey, write);" },
  ],
};
