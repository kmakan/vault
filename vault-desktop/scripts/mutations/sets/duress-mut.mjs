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
    // Текст SOS — правило ЯДРА (ADR-005 партия 5k, 27.10): до этого здесь
    // жила вторая копия правила, разошедшаяся с мостовой. Мутации бьют по
    // ОБВЯЗКЕ: какие данные доезжают до ядра и что делает фронт, когда ядро
    // не ответило.
    { name: "текст письма собирает фронт, а не ядро (вторая копия правила вернулась)",
      pattern: "      text = await invoke('duress_sos_text', {",
      replacement: "      text = String(cfg.sos_text || 'Телефон не у меня'); void invoke('duress_sos_text', {" },
    { name: "имя команды сборки текста SOS перепутано (текст не соберётся никогда)",
      pattern: "      text = await invoke('duress_sos_text', {",
      replacement: "      text = await invoke('duress_sos_text_v2', {" },
    { name: "настроенный текст не передаётся в ядро (всегда дефолт локали)",
      pattern: "        sosText: cfg.sos_text || '',",
      replacement: "        sosText: ''," },
    { name: "дефолт из локали не передаётся (пустая настройка = письмо без слов)",
      pattern: "        defaultText: uiStore.tr('sos_default'),",
      replacement: "        defaultText: ''," },
    { name: "флаг гео не доезжает ядра (координаты не дописываются)",
      pattern: "        geoOn: !!cfg.sos_geo,",
      replacement: "        geoOn: false," },
    { name: "фраза координат не доезжает ядра (место теряется)",
      pattern: "        geoOn: !!cfg.sos_geo,\n        geo,",
      replacement: "        geoOn: !!cfg.sos_geo,\n        geo: ''," },
    { name: "отказ ядра текст подменяется литералом во фронте",
      pattern: "      console.error('[duress] SOS: ядро не собрало текст, письмо уходит без него:', e);",
      replacement: "      text = cfg.sos_text || 'Телефон не у меня';" },
    { name: "подпись координат — литерал вместо локали (письмо не на языке отправителя)",
      pattern: "              label: uiStore.tr('sos_coords_label'),",
      replacement: "              label: 'мои координаты'," },
    { name: "имя команды фразы координат перепутано",
      pattern: "            finish(await invoke('duress_geo_phrase', {",
      replacement: "            finish(await invoke('duress_geo_phrase_v2', {" },
    { name: "координаты не передаются в ядро (всегда ноль)",
      pattern: "              lat: pos.coords.latitude,",
      replacement: "              lat: 0," },
    { name: "при отказе ядра фронт сам сочиняет фразу координат",
      pattern: `            console.error('[duress] SOS: ядро не собрало фразу координат:', e);
            finish('');`,
      replacement: `            console.error('[duress] SOS: ядро не собрало фразу координат:', e);
            finish(', мои координаты: 0.00000, 0.00000');` },
    { name: "геолокация не опрашивается, даже когда гео включено",
      pattern: "    if (cfg.sos_geo) {\n      geo = await new Promise(",
      replacement: "    if (false) {\n      geo = await new Promise(" },
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
