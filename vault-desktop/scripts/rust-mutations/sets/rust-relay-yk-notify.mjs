// Набор мутаций: rust-relay-yk-notify — уведомления ЮKassa и незавершённые
// оплаты на релее.
//
// ЗАЧЕМ. 15.11.2026 разбор «оплатил — Pro не пришёл» вскрыл две вещи сразу:
// в кабинете ЮKassa НЕ БЫЛО настроено ни одного HTTP-уведомления, а релей
// узнавал об оплате только когда клиент сам опрашивал verify. Человек платил,
// закрывал приложение — деньги списаны, подписка никому не выдана. Теперь
// уведомление приходит, но само уведомление НЕ является доказательством:
// ЮKassa их не подписывает, подделать POST может кто угодно. Каждая мутация
// ниже — поломка одного из трёх правил, на которых держится выплата:
//
//   1) право даёт ОТВЕТ ПРОВАЙДЕРА, а не тело запроса;
//   2) «кому и какой план» переживает рестарт (state.json), иначе уведомление
//      после деплоя приходит в пустоту;
//   3) выплата не зависит от одного HTTP-запроса — есть второй путь (сторож).
//
// Смоук — весь крейт: 250+ тестов идут ~5 с, и любая правка общего
// grant_paid_checkout ловится здесь же (этот путь общий с verify и claim).
export default {
  id: 'rust-relay-yk-notify',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'all',
  file: 'vault-relay/src/main.rs',
  smoke: 'cargo test -p vault-relay',
  timeoutMs: 600_000,
  mutations: [
    {
      name: 'уведомление верит телу вместо ответа провайдера (поддельный POST выдаёт Pro)',
      pattern: '    match provider.verify(&checkout).await {\n        Ok(vault_relay::payments::PaymentStatus::Paid) => {\n            grant_paid_checkout(&app, &checkout);',
      replacement:
        '    match Ok::<vault_relay::payments::PaymentStatus, vault_relay::payments::PaymentError>(\n        vault_relay::payments::PaymentStatus::Paid,\n    ) {\n        Ok(vault_relay::payments::PaymentStatus::Paid) => {\n            grant_paid_checkout(&app, &checkout);',
    },
    {
      name: 'неизвестный платёж получает 404 — ЮKassa ретраит уведомление сутки',
      pattern: '        tracing::info!(payment = %payment_id, event = %event, "yk-notify: неизвестный платёж, пропускаем");\n        return StatusCode::OK.into_response();',
      replacement:
        '        tracing::info!(payment = %payment_id, event = %event, "yk-notify: неизвестный платёж, пропускаем");\n        return err(StatusCode::NOT_FOUND, "unknown payment");',
    },
    {
      name: 'битое тело уведомления принимается за успех (ошибка транспорта выглядит как «принято»)',
      pattern: '    let Ok(body) = serde_json::from_slice::<serde_json::Value>(&raw) else {\n        return err(StatusCode::BAD_REQUEST, "bad payload");\n    };',
      replacement:
        '    let Ok(body) = serde_json::from_slice::<serde_json::Value>(&raw) else {\n        return StatusCode::OK.into_response();\n    };',
    },
    {
      name: 'уведомление без id платежа пытается кого-то выдать',
      pattern: '    if payment_id.is_empty() {\n        return err(StatusCode::BAD_REQUEST, "no payment id");\n    }',
      replacement: '    if false {\n        return err(StatusCode::BAD_REQUEST, "no payment id");\n    }',
    },
    {
      name: 'повторное уведомление выдаёт Pro второй раз по тому же чекауту',
      pattern: '    if app.is_redeemed(&pending.checkout_id) {\n        app.forget_pending_checkout(payment_id);\n        return StatusCode::OK.into_response();\n    }',
      replacement: '    if false {\n        app.forget_pending_checkout(payment_id);\n        return StatusCode::OK.into_response();\n    }',
    },
    {
      name: 'провайдер не узнаёт свой платёж (id платежа потерян при сборке чекаута)',
      pattern: '        created_at: p.created_at,\n        provider_ref: provider_ref.to_string(),',
      replacement: '        created_at: p.created_at,\n        provider_ref: String::new(),',
    },
    {
      name: 'срок подписки берётся из константы, а не из покупки (месяц = срок по умолчанию)',
      pattern: '        months: p.months,\n        created_at: p.created_at,',
      replacement: '        months: 1,\n        created_at: p.created_at,',
    },
    {
      name: 'отменённый платёж остаётся в ожидании (вечный опрос мёртвого платежа)',
      pattern: '        Ok(vault_relay::payments::PaymentStatus::Failed(why)) => {\n            app.forget_pending_checkout(payment_id);\n            tracing::info!(payment = %payment_id, reason = %why, event = %event, "yk-notify: платёж не состоялся, ожидание снято");',
      replacement:
        '        Ok(vault_relay::payments::PaymentStatus::Failed(why)) => {\n            tracing::info!(payment = %payment_id, reason = %why, event = %event, "yk-notify: платёж не состоялся, ожидание снято");',
    },
    {
      name: 'выдача не снимает запись ожидания (оплаченное спрашивается снова и снова)',
      pattern: '    if !checkout.provider_ref.trim().is_empty() {\n        app.forget_pending_checkout(&checkout.provider_ref);\n    }',
      replacement: '    if false {\n        app.forget_pending_checkout(&checkout.provider_ref);\n    }',
    },
    {
      name: 'сторож не снимает просроченные ожидания (сутки прошли — платёж мёртв, опрос не кончается)',
      pattern: '        if now.saturating_sub(pending.created_at) > 86_400 {',
      replacement: '        if now.saturating_sub(pending.created_at) > u64::MAX {',
    },
    {
      name: 'сторож трогает только что созданный чекаут (лишний вопрос к API на каждый клик)',
      pattern: '        if now.saturating_sub(pending.created_at) < 45 {',
      replacement: '        if false {',
    },
    {
      name: 'сторож не выдаёт оплату — второй путь к выплате отключён',
      pattern: '                grant_paid_checkout(app, &checkout);',
      replacement: '                let _ = &checkout;',
    },
    {
      name: 'ожидания не пишутся в state.json (рестарт релея теряет «кому и какой план»)',
      file: 'vault-relay/src/persist.rs',
      pattern: '            pending_checkouts: pending_checkouts.clone(),',
      replacement: '            pending_checkouts: HashMap::new(),',
    },
    {
      name: 'битая запись ожидания переживает загрузку (Pro выдадут не тому или не за тот срок)',
      file: 'vault-relay/src/persist.rs',
      pattern: '            .retain(|_, p| p.valid() && p.created_at >= stale_before);',
      replacement: '            .retain(|_, p| p.created_at >= stale_before);',
    },
    {
      name: 'просроченные ожидания переживают загрузку (опрос платежей, которых уже нет)',
      file: 'vault-relay/src/persist.rs',
      pattern: '        let stale_before = now_unix().saturating_sub(86_400);',
      replacement: '        let stale_before = now_unix().saturating_sub(0);',
    },
    {
      name: 'проверка оплаты после выдачи отвечает 409 вместо токена (клиент видит «не удалось» при выданном Pro)',
      pattern: '        if let Some((sub, plan_name, paid_until, saved_token)) = app.granted_subscription_for_fp(&fp) {',
      replacement:
        '        if let Some((sub, plan_name, paid_until, saved_token)) = None::<(u64, String, u64, String)> {',
    },
    {
      name: 'проверка оплаты не смотрит в карту ожиданий (после рестарта 410 на оплаченный чекаут)',
      pattern: '        .or_else(|| app.pending_by_checkout_id(&req.checkout_id).map(|(r, p)| checkout_from_pending(&r, &p)))',
      replacement: '        .or_else(|| Option::<vault_relay::payments::Checkout>::None)',
    },
    {
      name: 'получка не видит оплат, подтверждённых уведомлением (оплатил и закрыл — Pro не появился)',
      pattern: '        if let Some(body) = handout_granted(&app, sub, &plan_name, paid_until, &saved_token) {',
      replacement:
        '        if let Some(body) = Option::<serde_json::Value>::None {',
    },
    {
      name: 'повторная получка выпускает НОВЫЙ токен (адрес очереди меняется на каждом старте приложения)',
      pattern: '    let token = if saved_token.is_empty() {',
      replacement: '    let token = if true {',
    },
    {
      name: 'получка не смотрит в карту ожиданий на диске (после рестарта «нечего получать»)',
      pattern: '    for (provider_ref, p) in app.pending_for_fp(&fp) {',
      replacement:
        '    for (provider_ref, p) in Vec::<(String, persist::PendingCheckout)>::new() {',
    },
    {
      name: 'выдача не сохраняет токен подписки (повторная получка даст другой адрес очереди)',
      pattern: '                    revoked: false,\n                    token: token.to_string(),',
      replacement: '                    revoked: false,\n                    token: String::new(),',
    },
    {
      name: 'запоминается платёж без id у провайдера (ожидание, которое не о чем спрашивать)',
      pattern: '        if c.provider_ref.trim().is_empty() || c.provider != "yookassa" {',
      replacement: '        if false {',
    },
  ],
};
