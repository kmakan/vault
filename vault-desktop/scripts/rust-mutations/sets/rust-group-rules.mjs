// Набор мутаций: rust-group-rules — слияние списка участников и защита
// создателя.
//
// ЗАЧЕМ. Эти правила решают, сколько записей об одном человеке живёт в
// `groups.json` и кого нельзя выгнать из группы. До переноса в ядро они жили в
// мосту (`src-tauri/src/groups.rs`: `rename_member`, `import_group`,
// `remove_member`, `set_member_role`), то есть под `cargo test`, но вне
// `rust-mutation-gate`, который меряет только крейт `vault-client`. Это ровно
// тот класс, где цена ошибки — испорченные данные, а не упавший тест: живая
// группа «Четыре» (06.10.2026) получила двух участников на один отпечаток
// именно из-за неверного слияния, и проверяла её тогда только приёмка.
//
// Отдельно держим индекс `keep`: после `remove(drop)` список короче на единицу,
// и это единственное место партии, где неверный адрес — паника моста, а не
// тихая порча. Границы закрепляет проба `keep_index_is_always_in_bounds_after_the_removal`.
export default {
  id: 'rust-group-rules',
  file: 'vault-client/src/vault/group_rules.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'сдвиг индекса потерян (после удаления помечается сосед, а не переехавший)',
      pattern: '            keep: if i < j { j - 1 } else { j },',
      replacement: '            keep: j,' },
    { name: 'сдвиг применяется в другую сторону (i>j съезжает туда, где съезжать нечему)',
      pattern: '            keep: if i < j { j - 1 } else { j },',
      replacement: '            keep: if i > j { j - 1 } else { j },' },
    { name: 'старого адреса нет — трактуются как ренейм первой записи (чужой участник переезжает)',
      pattern: '        (None, _) => Rename::Nothing,',
      replacement: '        (None, _) => Rename::Move { at: 0 },' },
    { name: 'случай «оба адреса — одна запись» больше не различается (дубль удаляется вместе с участником)',
      pattern: '        (Some(i), Some(j)) if i != j => Rename::MergeDuplicate {',
      replacement: '        (Some(i), Some(j)) => Rename::MergeDuplicate {' },
    { name: 'защита создателя от удаления снята (любого можно выгнать)',
      pattern: '    !same_address(candidate, created_by)\n}',
      replacement: '    true\n}' },
    { name: 'создателя можно понизить (Admin теряется вместе с правами на группу)',
      pattern: '    target_is_admin || !same_address(candidate, created_by)',
      replacement: '    true' },
    { name: 'идемпотентная роль «оставить Admin» стала отказом (UI не может переписать роли)',
      pattern: '    target_is_admin || !same_address(candidate, created_by)',
      replacement: '    target_is_admin && !same_address(candidate, created_by)' },
    { name: 'пустой адрес из инвайта заводит участника (потом он совпадает с кем угодно)',
      pattern: '        if normalize(email).is_empty() {\n            continue;\n        }',
      replacement: '        if false {\n            continue;\n        }' },
    { name: 'повтор адреса в одном инвайте добавляет второго участника (путь к группе «Четыре»)',
      pattern: '        if incoming[..j].iter().any(|e| same_address(e, email)) {',
      replacement: '        if false {' },
    { name: 'пустой отправитель считается участником (безымянная запись с ключом группы)',
      pattern: '    plan.push_sender = !normalize(sender).is_empty()',
      replacement: '    plan.push_sender = true' },
    { name: 'отправитель заводится вторым, хотя уже значится в списке',
      pattern: '        && !existing.iter().any(|e| same_address(e, sender))',
      replacement: '' },
    { name: 'отправитель заводится вторым, хотя он же в инвайте',
      pattern: 'plan.push.iter().any(|&j| same_address(incoming[j], sender))',
      replacement: 'plan.push.iter().any(|&j| same_address("", sender))' },
    { name: 'роли из инвайта не применяются к уже известным участникам',
      pattern: '            Some(i) => plan.update.push((i, j)),',
      replacement: '            Some(_i) => {}' },
    // Права в группе (партия 4d): ими фронт гасит кнопки, не сравнивая адреса.
    { name: 'назначенный админ не управляет составом (право только у создателя)',
      pattern: '        self.is_creator || self.is_admin',
      replacement: '        self.is_creator' },
    { name: 'создатель без роли Admin теряет управление (старые groups.json: кнопок нет)',
      pattern: '        self.is_creator || self.is_admin',
      replacement: '        self.is_admin' },
    { name: 'себя можно удалить кнопкой ✕ (вместо выхода из группы)',
      pattern: '        self.may_manage() && !target_is_creator && !target_is_self',
      replacement: '        self.may_manage() && !target_is_creator' },
    { name: 'создателя можно удалить (группа теряет носителя прав)',
      pattern: '        self.may_manage() && !target_is_creator && !target_is_self',
      replacement: '        self.may_manage() && !target_is_self' },
    { name: 'управление составом без управления правами (обычный участник «удаляет»)',
      pattern: '        self.may_manage() && !target_is_creator && !target_is_self',
      replacement: '        !target_is_creator && !target_is_self' },
    { name: 'роль создателя можно менять (его запись обязана остаться управляющей)',
      pattern: '    pub fn may_set_role_of(&self, target_is_creator: bool) -> bool {\n        self.may_manage() && !target_is_creator',
      replacement: '    pub fn may_set_role_of(&self, target_is_creator: bool) -> bool {\n        self.may_manage()' },
    { name: 'роли назначает любой участник (проверка управления потеряна)',
      pattern: '    pub fn may_set_role_of(&self, target_is_creator: bool) -> bool {\n        self.may_manage() && !target_is_creator',
      replacement: '    pub fn may_set_role_of(&self, target_is_creator: bool) -> bool {\n        !target_is_creator' },
  ],
};
