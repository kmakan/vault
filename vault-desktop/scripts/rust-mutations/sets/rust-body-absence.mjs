// Набор мутаций: rust-body-absence — контракт «тела не будет никогда».
//
// ЗАЧЕМ. Решение о том, какая пустая ответ-строка окончательная, переехало из
// `src-tauri/src/email.rs` в `vault-client`: в мосте его нельзя было проверить
// мутационно (мута́ционная программа Rust меряет только крейт vault-client),
// и CLI-слушатель остался бы с СОБСТВЕННОЙ верией того же правила. Теперь
// решение одно, и этот набор требует, чтобы тесты реально на нём ловили поломку.
//
// ПРОВЕРЯЕТСЯ ЖИВОЕ ПОВЕДЕНИЕ, А НЕ ФОРМАЛЬНОСТЬ: каждая мутация — та ошибка,
// которую фронт уже совершал (жалоба 22.10 «приглашения от старых email»):
// негатив не помечен → перепрос каждым поллингом; помечен живой uid → письмо
// потеряно навсегда; desync там, где сессия жива → reconnect-шторм.
export default {
  id: 'rust-body-absence',
  file: 'vault-client/src/vault/body_absence.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'отсутствие не помечается записью: пустой ответ вместо отметки на каждый uid',
      pattern: '    uids.iter().map(|u| (u.clone(), String::new())).collect()',
      replacement: '    Vec::new()' },
    { name: 'пометка содержит тело-заглушку вместо пустого тела',
      pattern: '    uids.iter().map(|u| (u.clone(), String::new())).collect()',
      replacement: '    uids.iter().map(|u| (u.clone(), u.clone())).collect()' },
    { name: 'каждый молчащий uid помечается окончательным (живое письмо теряется навсегда)',
      pattern: '        .filter(|u| absent_set.contains(u.as_str()))',
      replacement: '        .filter(|_| true)' },
    { name: 'мёртвый uid не помечается вовсе (перепрос одним и тем же поллингом)',
      pattern: '        .filter(|u| absent_set.contains(u.as_str()))',
      replacement: '        .filter(|_| false)' },
    { name: 'рассинхрон объявляется даже когда тела пришли (reconnect-шторм)',
      pattern: '    (dead, got_bodies == 0 && silent_but_present > 0)',
      replacement: '    (dead, silent_but_present > 0)' },
    { name: 'рассинхрон не объявляется, если молчали только мёртвые uid рядом с живыми',
      pattern: '    (dead, got_bodies == 0 && silent_but_present > 0)',
      replacement: '    (dead, got_bodies == 0)' },
  ],
};
