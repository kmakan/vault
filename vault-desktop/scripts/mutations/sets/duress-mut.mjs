// Набор мутаций: duress-mut
// Цель: убедиться, что смоук duress-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'duress-mut',
  file: 'src/features/duress.js',
  smoke: 'duress-smoke.mjs',
  mutations: [
    { name: "замок поднимается без хеша пароля",
      pattern: "    const enabled = !!(cfg && cfg.lock_enabled && cfg.lock_hash);",
      replacement: "    const enabled = !!(cfg && cfg.lock_enabled);" },
    { name: "замок не поднимается при включённой защите",
      pattern: "    const enabled = !!(cfg && cfg.lock_enabled && cfg.lock_hash);",
      replacement: "    const enabled = false;" },
    { name: "в Android ветке показывается свой замок",
      pattern: "    deps.setLocked(false);\n    console.log('[duress] android branch",
      replacement: "    deps.setLocked(true);\n    console.log('[duress] android branch" },
    { name: "разблокировка не снимает флаг сессии (замок вернётся)",
      pattern: "  deps.setUnlockedThisSession(true); // до ухода в фон замок не ре-армить",
      replacement: "  void 0;" },
    { name: "duress-PIN не ставит pending (SOS не уйдёт)",
      pattern: "  deps.setPending(true);",
      replacement: "  void 0;" },
    { name: "duress-PIN не снимает замок",
      pattern: "export function onLockDuress(deps) {\n  deps.setLocked(false);",
      replacement: "export function onLockDuress(deps) {\n  void 0;" },
    { name: "паника не стирает данные в Rust",
      pattern: "    await api.logout();",
      replacement: "    void 0;" },
    { name: "паника не чистит локальный email",
      pattern: "  sessionStore.setCurrentEmail(null);",
      replacement: "  void 0;" },
    // Формат конверта уехал в Rust (ADR-005 W4) — мутация бьёт по вызову
    // адаптера: подтип «sos» не передаётся, и получатель не поймёт, что это
    // сигнал бедствия.
    { name: "SOS уходит без типа sos",
      pattern: "          msgType: 'sos',",
      replacement: "          msgType: null," },
    { name: "SOS отправляется без ключа получателя (не шифруется)",
      pattern: "        if (!pk) {",
      replacement: "        if (false) {" },
    { name: "SOS уходит с плейсхолдером {coords} вместо координат",
      pattern: "    let text = rawText.replace('{coords}', coords);",
      replacement: "    let text = rawText;" },
    // Учёт доставки (25.10, диагностика на устройстве): строка «sent to N»
    // печаталась ВСЕГДА, включая проход, где не ушло ни одного письма. Пока
    // журнал врал, тихий отказ SOS был неотличим от работающего сигнала —
    // поэтому эти четыре мутации бьют по самому факту учёта, а не по тексту.
    { name: "SOS без получателей пишется в журнал как успех",
      pattern: "      console.error('[duress] SOS НЕ ОТПРАВЛЕН: получатели не настроены (замок, скорее всего, не настраивался)');",
      replacement: "      console.log('[duress] SOS sent (no recipients configured)');" },
    { name: "успешная отправка не засчитывается",
      pattern: "        sent += 1;",
      replacement: "        sent += 0;" },
    { name: "нулевая доставка не считается отказом",
      pattern: "    if (sent === 0) {",
      replacement: "    if (false) {" },
    { name: "частичная доставка выдаётся за полную",
      pattern: "    } else if (failed.length) {",
      replacement: "    } else if (false) {" },
  ],
};
