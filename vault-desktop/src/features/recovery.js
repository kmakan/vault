// Feature module: восстановление аккаунта из эскроу-письма по 12 словам.
// Изоляция фичи (правило канбан t_7c3929d2): новая фича — отдельный модуль,
// App.vue — только тонкий делегат; ВСЕ зависимости явные (ctx + инъекция
// { api, crypto, invoke }), поэтому модуль импортируется в Node без
// Tauri/Vue и покрывается smoke'ом напрямую. Новых npm-зависимостей нет.
//
// Поиск эскроу-письма среди последних писем ящика + распаковка backup по
// мнемонике. Вызывается ПОСЛЕ логина ДО initCrypto() — иначе создалась бы
// новая пара ключей.
//
// Устойчивость (fix/recovery-resilience): parse/unwrap ОТДЕЛЬНОГО кандидата
// оборачиваются в try/catch — чужое/битое эскроу-письмо НЕ обрывает поиск
// правильного. НО import_backup идёт ВНЕ этого catch: он частично меняет
// дисковое состояние, поэтому его сбой бросается вызывающему (его нельзя
// проглотить как чужое письмо или попытаться импортировать другой кандидат).
export async function recoverFromEscrow(ctx, mnemonic, { api, crypto, invoke }) {
  console.log('[recovery] step 1: validate mnemonic');
  if (!(await crypto.recoveryValidateMnemonic(mnemonic))) {
    throw new Error('Неверный формат ключа (нужно 12 слов)');
  }
  console.log('[recovery] step 2: fetch emails');
  const msgs = await api.fetchEmails(ctx.email);
  console.log('[recovery] step 3: got', msgs.length, 'msgs, filtering empty subject');
  const candidates = msgs.filter((m) => !(m.subject || '').trim()).slice(0, 80);
  console.log('[recovery] step 4: candidates', candidates.length, 'byFolder');
  const byFolder = {};
  for (const m of candidates) (byFolder[m.folder] = byFolder[m.folder] || []).push(m);
  for (const [folder, list] of Object.entries(byFolder)) {
    console.log('[recovery] step 5: fetch bodies from', folder, list.length, 'msgs');
    const uids = list.map((m) => m.uid);
    let bodies = [];
    try {
      bodies = await invoke('email_fetch_bodies', { uids: uids.map(String), folder });
    } catch (e) {
      // fetch_bodies по одной папке не критичен — пробуем следующую папку.
      console.warn('[recovery] fetch_bodies failed for a folder; skipping');
      continue;
    }
    console.log('[recovery] step 6: got', bodies.length, 'bodies, parsing');
    for (const [, body] of bodies || []) {
      // parse/unwrap кандидата НЕ бросают наружу: чужое или битое эскроу
      // не должно обрывать поиск правильного письма. Логи НЕ содержат
      // тело письма / wrapped / слова / backup / текст ошибки.
      let wrappedJson;
      try {
        wrappedJson = await crypto.recoveryParseEscrowEmail(body);
      } catch (e) {
        console.warn('[recovery] parse failed for a candidate; skipping');
        continue;
      }
      if (!wrappedJson) {
        console.log('[recovery]   parseEscrowEmail returned null');
        continue;
      }
      console.log('[recovery] step 7: unwrapping…');
      let backupJson;
      try {
        backupJson = await crypto.recoveryUnwrapBackup(wrappedJson, mnemonic);
      } catch (e) {
        console.warn('[recovery] unwrap failed for a candidate; skipping');
        continue;
      }
      // import_backup ВНЕ candidate-catch: частично меняет дисковое
      // состояние — его сбой нельзя проглотить как чужое письмо или
      // попытаться импортировать другой кандидат. Бросаем вызывающему.
      console.log('[recovery] step 8: import_backup');
      await invoke('import_backup', { jsonData: backupJson });
      return true;
    }
  }
  console.log('[recovery] no escrow found');
  return false;
}
