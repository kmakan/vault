// Набор мутаций: rust-call
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-call',
  file: 'vault-client/src/vault/call.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "сигнал звонка определяется по наличию call_id, а не по type call_*",
      pattern: "        && obj.get(\"type\").and_then(|v| v.as_str()).map(|t| t.starts_with(\"call_\")).unwrap_or(false)",
      replacement: "        && true" },
    { name: "не-конверт принимается за сигнал звонка",
      pattern: "    if !is_call {\n        return None;\n    }",
      replacement: "    if false {\n        return None;\n    }" },
    { name: "тип сигнала не читается (вызывающий не знает, что за сигнал)",
      pattern: "    let call_type = obj.get(\"type\").and_then(|v| v.as_str()).unwrap_or(\"\").to_string();",
      replacement: "    let call_type = String::new();" },
    { name: "идентификатор звонка не читается (звонки смешиваются)",
      pattern: "    let call_id = obj.get(\"call_id\").and_then(|v| v.as_str()).unwrap_or(\"\").to_string();",
      replacement: "    let call_id = String::new();" },
    { name: "время сигнала не читается (звонок приходит в 1970-м)",
      pattern: "    let ts = obj.get(\"ts\").and_then(|v| v.as_i64()).unwrap_or(0);",
      replacement: "    let ts = 0;" },
    // ── Сборка конверта (26.10): правило формата переехало из
    // `service_monitor.rs`, где его не мерил никто — тот модуль компилируется
    // только под `cfg(target_os = "android")`, и прогон с хоста его не видит.
    // Три копии (`json!` в двух звонковых сигналах и в SOS) сведены в одну, и
    // вот что обязано оставаться правдой.
    { name: "маркер формата уезжает (получатель не признает сигнал своим)",
      pattern: "        vault: 1,",
      replacement: "        vault: 2," },
    { name: "идентификатор сигнала не попадает в конверт",
      pattern: "        id: &sig.id,",
      replacement: "        id: \"\"," },
    { name: "звонок в конверте не назван (собеседник не поймёт, к какому звонку сигнал)",
      pattern: "        call_id: &sig.call_id,",
      replacement: "        call_id: \"\"," },
    { name: "момент сигнала не попадает в конверт (получатель сверяет свежесть по 1970-м)",
      pattern: "        ts: sig.ts,",
      replacement: "        ts: 0," },
    { name: "поле type собирается под другим именем (разбор на том конце не находит тип)",
      pattern: "        #[serde(rename = \"type\")]\n        call_type: &'a str,",
      replacement: "        #[serde(rename = \"typ\")]\n        call_type: &'a str," },
    { name: "пустой sdp пишется как null вместо «поля нет»",
      pattern: "        #[serde(skip_serializing_if = \"Option::is_none\")]\n        sdp: Option<&'a str>,",
      replacement: "        sdp: Option<&'a str>," },
    { name: "метка сервисного процесса в идентификаторе теряется (суффикс na)",
      pattern: "        id: format!(\"{ts_ms}na\"),",
      replacement: "        id: format!(\"{ts_ms}\")," },
  ],
};
