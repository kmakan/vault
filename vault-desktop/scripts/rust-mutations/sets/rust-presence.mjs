// Набор мутаций: rust-presence — решения json-реестра присутствия.
//
// ЗАЧЕМ. `src-tauri/src/presence.rs` держит три решения (ключ записи, дедуп
// heartbeat-а, граница чистки) и ни одно из них не мерилось гейтом, потому что
// мост вне `rust-mutation-gate`. Первое было живым дефектом: ключом служил
// `email.to_string()` без нормализации, поэтому `Bob@X` и `bob@x` — два
// реестра об одном человеке, и «был онлайн N мин назад» терялось при любой
// дороге письма с другим регистром адреса.
export default {
  id: 'rust-presence',
  file: 'vault-client/src/vault/presence.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'источник не нормализуется при сравнении (одно письмо заводится дважды)',
      pattern: '    let source = normalize(source);',
      replacement: '    let source = source.to_string();' },
    { name: 'метрика времени в дедупе не участвует (ретрансляция с новыми часами теряется)',
      pattern: '        .any(|(s, t)| normalize(s) == source && t == ts)',
      replacement: '        .any(|(s, _t)| normalize(s) == source)' },
    { name: 'источник в дедупе не участвует (любое письмо с той же меткой считается известным)',
      pattern: '        .any(|(s, t)| normalize(s) == source && t == ts)',
      replacement: '        .any(|(_s, t)| t == ts)' },
    { name: 'совпадение часов перевёрнуто (известный heartbeat заводится заново каждый опрос)',
      pattern: '        .any(|(s, t)| normalize(s) == source && t == ts)',
      replacement: '        .any(|(s, t)| normalize(s) == source && t != ts)' },
    { name: 'граница чистки строгая (запись ровно в cutoff стирается на тик раньше)',
      pattern: '    ts >= cutoff_ms',
      replacement: '    ts > cutoff_ms' },
    { name: 'условие чистки перевёрнуто (остаются только старые, свежие стираются)',
      pattern: '    ts >= cutoff_ms',
      replacement: '    cutoff_ms >= ts' },
    { name: '«последняя активность» берётся минимумом (профиль всегда показывает самое раннее)',
      pattern: '    timestamps.into_iter().max().copied()',
      replacement: '    timestamps.into_iter().min().copied()' },
  ],
};
