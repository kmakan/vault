// Набор мутаций: rust-relay-claim — получка веб-покупки приложением.
//
// ЗАЧЕМ. Покупка теперь живёт на сайте: браузер создаёт чекаут и платит, а
// токен забирает приложение по fp + своему read-токену. Это место решает три
// вещи, которые «на глаз» не проверить: кто вообще может получить выдачу
// (доказательство токеном), сколько раз одна оплата выдаёт подписку
// (отметка о выдаче на verify, claim и идемпотентности создания) и что
// считается живой сессией (crypto живёт после локального таймера).
//
// Мутируем: отказ без процессоров, разбор fp, доказательство токена и его
// привязку, ранний выход по пустой очереди, потолок очереди, снятие
// просроченного crypto, выбор провайдера, выдачу (персист, отметка, срок),
// guard повторной выдачи в verify и скип уже выданного чекаута в
// идемпотентности создания.
// Смоук — только claim-тесты: они прогоняют весь путь «сайт оплатил →
// приложение получило» и ловят и порчу grant-а, общего с verify.
export default {
  id: 'rust-relay-claim',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'all',
  file: 'vault-relay/src/main.rs',
  smoke: 'cargo test -p vault-relay --bin vault-relay claim',
  timeoutMs: 600_000,
  mutations: [
    { name: 'claim без настроенных процессоров отвечает вместо честного 402',
      pattern: `    if app.payment.is_none() && app.crypto.is_none() {
        return err(StatusCode::PAYMENT_REQUIRED, "checkout disabled");
    }
    let Some(fp) = norm_fp(Some(&req.fp)) else {`,
      replacement: `    let Some(fp) = norm_fp(Some(&req.fp)) else {` },
    { name: 'пустой fp не отвергается (очередь лезет в память по мусору)',
      pattern: '    let Some(fp) = norm_fp(Some(&req.fp)) else {\n        return err(StatusCode::UNPROCESSABLE_ENTITY, "bad fp");\n    };',
      replacement: '    let fp = req.fp.trim().to_ascii_lowercase();' },
    { name: 'claim принимает любого без токена-доказательства',
      pattern: '        .filter(|t| check_token_binding(&app, &t.hash, &Some(fp.clone())))\n        .is_some();',
      replacement: '        .is_some() || true;' },
    { name: 'привязка токена к fp не проверяется (чужим токеном забирают чужую покупку)',
      pattern: '        .filter(|t| check_token_binding(&app, &t.hash, &Some(fp.clone())))\n',
      replacement: '' },
    { name: 'пустая очередь не ранний выход, а «не оплачено» (клиент ждёт вечно)',
      pattern: '    if candidates.is_empty() {',
      replacement: '    if false {' },
    { name: 'очередь получки обрезается до нуля (веб-покупку невозможно забрать)',
      pattern: '        v.truncate(max);',
      replacement: '        v.truncate(0);' },
    { name: 'выданный crypto-чекаут не снимается с очереди (одна оплата выдаётся дважды)',
      pattern: `                c.fp == fp
                    && !self.is_redeemed(&c.id)
                    && (c.provider == "crypto" || c.expires_at > now())`,
      replacement: `                c.fp == fp
                    && (c.provider == "crypto" || c.expires_at > now())` },
    { name: 'просроченный crypto-чекаут снимается с очереди (подтверждённая сетью покупка теряется)',
      pattern: '                    && (c.provider == "crypto" || c.expires_at > now())',
      replacement: '                    && c.expires_at > now()' },
    { name: 'крипто-чекаут верифицирует рублёвая касса (спрос не у того процессора)',
      pattern: `) -> Option<Arc<dyn vault_relay::payments::PaymentProvider>> {
    if checkout.provider == "crypto" {`,
      replacement: `) -> Option<Arc<dyn vault_relay::payments::PaymentProvider>> {
    if false {` },
    { name: 'выдача не сохраняет подписку (персист теряется — рестарт обнулит Pro)',
      pattern: '    app.save_subscription(sub, checkout.plan, &checkout.fp, paid_until);\n    let token = vault_relay::tokens::issue_v2(',
      replacement: '    let token = vault_relay::tokens::issue_v2(' },
    { name: 'срок подписки не зависит от купленных месяцев (год = ноль дней)',
      pattern: '    let paid_until = now() + (checkout.months as u64) * 30 * 86400;',
      replacement: '    let paid_until = now();' },
    { name: 'выдача не помечает чекаут выданным (повтор claim выдаёт токен заново)',
      pattern: '    app.mark_redeemed(&checkout.id);\n    serde_json::json!({',
      replacement: '    serde_json::json!({' },
    { name: 'verify после выдачи пропускает повтор (одна оплата — много токенов)',
      pattern: '    if app.is_redeemed(&req.checkout_id) {\n        return err(StatusCode::CONFLICT, "already_redeemed");\n    }',
      replacement: '    if false {\n        return err(StatusCode::CONFLICT, "already_redeemed");\n    }' },
    { name: 'идемпотентность создания отдаёт уже выданный чекаут (повторный клик ведёт к оплаченному сессии)',
      pattern: `                    && c.expires_at > now()
                    // Выданный чекаут — не «та же покупка»: подписка по нему
                    // уже выпущена, повторный клик обязан создать новый платёж.
                    && !self.is_redeemed(&c.id)`,
      replacement: '                    && c.expires_at > now()' },
  ],
};
