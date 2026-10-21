// Экран восстановления: выбор файла, разбор причины отказа, отправка
// эскроу-письма — ADR-005 W3.
//
// Три разные вещи, но одна область: «пользователь восстанавливает доступ».
// Логика вынесена из App.vue.
//
// ОСОБЫЙ СЛУЧАЙ — ЭСКРОУ-ПИСЬМО. Провайдеры кладут служебные письма в Спам, а
// Gmail удаляет спам через ~30 дней — тогда эскроу пропадёт, и восстановление
// станет невозможным. Поэтому после отправки показываем предупреждение (на
// 10 секунд) и фоново ищем фактическую папку письма.
//
// ПРАВИЛО ПРО ТЕКСТ ОШИБКИ: он продублирован и в features/recovery-escrow.js
// (там он был заведён, но не читался — англоязычные с китайскими получали
// по-русски самое важное предупреждение приложения). Здесь — только вызов
// фичи, без копии текста.
//
// deps (ADR-001 R3): всё, что нужно снаружи, — явными параметрами.

export async function onRecoveryFilePicked(deps, e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  deps.setRecoveryFileJson(await file.text());
  deps.setRecoveryFileName(file.name);
}

// Показать разбор причины отказа восстановления (и сохранённую конфигурацию).
// Раскладка причины и правило про порты-строки — в features/restore-failure.js.
export function showRestoreFailure(deps) {
  deps.setEmail(deps.apiEmail() || deps.email());
  const st = deps.buildRestoreFailureState();
  deps.setLoginError(st.loginError);
  deps.setImapServer(st.imapServer);
  deps.setImapPort(st.imapPort);
  deps.setSmtpServer(st.smtpServer);
  deps.setSmtpPort(st.smtpPort);
  deps.setShowServerSettings(st.showServerSettings);
  deps.setMailProvider(st.mailProvider);
}

// Восстановление создано — отправить себе эскроу-письмо (ключ восстановления
// должен пережить потерю доступа к ящику).
export async function onRecoveryCreated(deps, { mnemonic }) {
  console.log('[recovery] onRecoveryCreated, words len =', mnemonic ? mnemonic.split(/\s+/).length : 0);
  try {
    // Отправка и проверка результата — в features/recovery-escrow.js.
    const r = await deps.sendEscrowEmail(deps.email(), mnemonic, 'recovery_spam_toast');
    // Провайдеры кладут служебные письма в Спам, а Gmail удаляет спам
    // через ~30 дней — тогда эскроу пропадёт.
    deps.toast(deps.tr(r.spamToastKey), 10000);
    // Фоново определяем фактическую папку письма и предупреждаем точечно.
    deps.locateEscrow(r.wrappedJson);
  } catch (e) {
    console.error('escrow send failed:', e);
    deps.toast((deps.tr('recovery_escrow_failed') || 'Не удалось отправить эскроу-письмо: ') + (e.message || e));
  }
}
