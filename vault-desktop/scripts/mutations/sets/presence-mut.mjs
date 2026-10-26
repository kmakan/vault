// Набор мутаций: presence-mut
// Цель: убедиться, что смоук presence-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'presence-mut',
  file: 'src/features/presence.js',
  smoke: 'presence-smoke.mjs',
  mutations: [
    { name: "presence включён без флага в kv",
      pattern: "    return (await db.kvGet(await accountNamespace(email), 'presence-enabled')) === '1';",
      replacement: "    return true;" },
    { name: "kv недоступен → presence считается включённым",
      pattern: "  } catch (e) { return false; }",
      replacement: "  } catch (e) { return true; }" },
    { name: "выключение presence не останавливает heartbeat",
      pattern: "  if (on) startHeartbeats();\n  else stopHeartbeats();",
      replacement: "  if (on) startHeartbeats();" },
    { name: "включение presence не запускает heartbeat",
      pattern: "  if (on) startHeartbeats();",
      replacement: "  if (false) startHeartbeats();" },
    { name: "heartbeat уходит неавторизованным",
      pattern: "  if (!sessionStore.state.isLoggedIn || !deps.cryptoReady()) return;",
      replacement: "  if (!deps.cryptoReady()) return;" },
    { name: "heartbeat уходит без готовой криптографии",
      pattern: "  if (!sessionStore.state.isLoggedIn || !deps.cryptoReady()) return;",
      replacement: "  if (!sessionStore.state.isLoggedIn) return;" },
    { name: "в конверте heartbeat нет presence:1",
      pattern: "  const payload = JSON.stringify({ presence: 1, ts: Date.now() });",
      replacement: "  const payload = JSON.stringify({ ts: Date.now() });" },
    { name: "heartbeat уходит всем, даже без ключа",
      pattern: "  const peers = Object.keys(identityStore.state.peerKeys || {}).filter(Boolean);",
      replacement: "  const peers = ['a@x.org', 'b@x.org'];" },
    { name: "зелёная точка не гаснет (окно онлайна)",
      pattern: "  return Date.now() - t < PRESENCE_ONLINE_MS;",
      replacement: "  return true;" },
    { name: "presence выключается, но heartbeat не останавливается (пишем в пустоту)",
      pattern: "    stopHeartbeats: () => deps.stopHeartbeats(),",
      replacement: "    stopHeartbeats: () => {}," },
    { name: "presence включается, но heartbeat не стартует (собеседник нас не видит)",
      pattern: "      startHeartbeats: () => deps.startHeartbeats(),",
      replacement: "      startHeartbeats: () => {}," },
    // Мутант «ошибка наружу» должен оставлять try с catch: раньше catch
    // удалялся целиком, и файл не парсился.
    { name: "сбой записи в kv роняет включение (ошибка уходит наружу)",
      pattern: "  } catch (e) {\n    console.warn('[presence] setEnabled failed:', e && e.message || e);\n  }",
      replacement: "  } catch (e) {\n    throw e;\n  }" },
  ],
};
