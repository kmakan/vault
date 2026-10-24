//! Правила списка участников группы (ADR-005 §W4, партия 4b).
//!
//! ЗАЧЕМ В ЯДРЕ. Эти правила решают, СКОЛЬКО записей об одном человеке живёт в
//! `groups.json` и кого нельзя выгнать из группы. Ошибка здесь — это испорченные
//! данные, а не косметика: живые группы с «двумя участниками на один отпечаток»
//! (06.10.2026, группа «Четыре») появились именно из-за неверного слияния при
//! смене почты. До переноса правила жили в мосту
//! (`src-tauri/src/groups.rs::rename_member`, `import_group`, `remove_member`,
//! `set_member_role`), то есть вне `rust-mutation-gate`, который меряет только
//! этот крейт: сдвиг индекса `if i < j { j - 1 } else { j }` проверяла только
//! приёмка на живых данных, а это часы, а не секунды.
//!
//! ФОРМА. Ядро решает, а тип участника не знает: вход — индексы и строки,
//! ничего про `GroupMember` (ни мостовый, ни ядровый). Поэтому правило одно для
//! десктопа и CLI, а мосту остаётся обход и запись.
//!
//! СРАВНЕНИЕ АДРЕСОВ — тоже не здесь: «одно ли это письмо» решает
//! [`crate::vault::identity`], а эти функции принимают уже найденные позиции.

use crate::vault::identity::{normalize, same_address};
use std::cmp::Ordering;

/// Что сделать со списком участников, когда собеседник переехал на новый
/// адрес. `drop`/`at` — позиции в списке ДО изменений, `keep` — уже со сдвигом
/// после удаления.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rename {
    /// Старого адреса в списке нет — трогать нечего. Сюда же попадает
    /// идемпотентный случай «старого нет, а новый уже участник»: вставка
    /// иначе завела бы ВТОРУЮ запись о том же человеке.
    Nothing,
    /// Оба адреса в списке (переименование догнало свежий инвайт). Убираем
    /// СТАРУЮ запись, а НОВУЮ помечаем общим ключом — она авторитетнее,
    /// потому что пришла из свежего письма.
    MergeDuplicate { drop: usize, keep: usize },
    /// Запись одна: переименовываем её и помечаем общим ключом.
    Move { at: usize },
}

/// Сплит решений ренейма. `old_idx`/`new_idx` — позиции, найденные по форме
/// адреса из ядра; совпадение индексов означает «старый и новый адрес — одна и
/// та же запись» (регистр/обрамление различаются, человек тот же).
pub fn plan_rename(old_idx: Option<usize>, new_idx: Option<usize>) -> Rename {
    match (old_idx, new_idx) {
        (None, _) => Rename::Nothing,
        (Some(i), Some(j)) if i != j => Rename::MergeDuplicate {
            // После remove(i) всё, что шло после него, сдвигается влево на
            // единицу. Ошибиться стороной — пометить `key_shared` не того
            // участника (дефект группы «Четыре»).
            keep: if i < j { j - 1 } else { j },
            drop: i,
        },
        (Some(i), _) => Rename::Move { at: i },
    }
}

/// Можно ли убирать участника из группы. Создателя — нельзя: он выходит сам.
/// Иначе «удалить участника» в чужом клиенте ломает группу всем остальным.
pub fn may_remove_member(candidate: &str, created_by: &str) -> bool {
    !same_address(candidate, created_by)
}

/// Можно ли ставить участнику эту роль. Создателя нельзя понизить с Admin,
/// но «оставить Admin» разрешено — это идемпотентный вызов, а не отказ.
pub fn may_set_role(candidate: &str, created_by: &str, target_is_admin: bool) -> bool {
    target_is_admin || !same_address(candidate, created_by)
}

/// Право текущего пользователя в группе (партия 4d). Носитель раньше был во
/// фронте: `member?.role === 'Admin' || group.created_by === currentUser`
/// (`GroupSettings.vue:194`, `isCreator:209`, `App.vue::isGroupAdmin`) — то есть
/// решение о роли и о том, чья это группа, принималось СРАВНЕНИЕМ АДРЕСА в JS,
/// где форма адреса своя и регистрозависимая. Ядро отвечает на тот же вопрос по
/// УСТАНОВЛЕННЫМ фактам (создатель я или нет, админ ли меня назначили), а
/// носителю остаётся найти эти факты своей идентичностью
/// ([`crate::vault::identity::Identity::member_matches`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Access {
    pub is_creator: bool,
    pub is_admin: bool,
}

impl Access {
    /// Управлять составом и ролями может создатель ИЛИ назначенный админ.
    pub fn may_manage(&self) -> bool {
        self.is_creator || self.is_admin
    }

    /// Удалить участника: только управляющему, не создателя (он выходит сам) и
    /// не себя этим действием (выход — отдельная операция).
    pub fn may_remove(&self, target_is_creator: bool, target_is_self: bool) -> bool {
        self.may_manage() && !target_is_creator && !target_is_self
    }

    /// Менять ли роль этого участника. Создателя — никто: его запись обязана
    /// остаться управляющей, иначе группа теряет носителя прав. Для фронта
    /// это ответ «строку выбора роли прятать/гасить», а не «разрешить и
    /// получить отказ при попытке».
    pub fn may_set_role_of(&self, target_is_creator: bool) -> bool {
        self.may_manage() && !target_is_creator
    }
}

/// План слияния локального списка участников со списком из инвайта.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InvitePlan {
    /// (позиция в локальном списке, позиция в инвайте) — роль из инвайта
    /// авторитетна для уже известного участника.
    pub update: Vec<(usize, usize)>,
    /// Позиции в инвайте, которых нет локально — их надо добавить.
    pub push: Vec<usize>,
    /// Отправитель инвайта обязан числиться участником; если его нет в
    /// инвайте и нет локально — мост добавляет его сам.
    pub push_sender: bool,
}

/// Что делает инвайт со списком. Пустой адрес участника инвайта не заводит
/// запись: «участник с пустым адресом» — это дыра, через которую позже
/// совпадает кто угодно (`identity` пустое ни с чем не сравнивает).
pub fn plan_invite(existing: &[&str], incoming: &[&str], sender: &str) -> InvitePlan {
    let mut plan = InvitePlan::default();
    for (j, email) in incoming.iter().enumerate() {
        if normalize(email).is_empty() {
            continue;
        }
        // Повтор адреса в самом инвайте: первую запись мост добавит (или
        // обновит), вторая не должна заводить ещё одну — иначе один человек
        // получает две строки из одного письма.
        if incoming[..j].iter().any(|e| same_address(e, email)) {
            continue;
        }
        match existing.iter().position(|e| same_address(e, email)) {
            Some(i) => plan.update.push((i, j)),
            None => plan.push.push(j),
        }
    }
    plan.push_sender = !normalize(sender).is_empty()
        && !existing.iter().any(|e| same_address(e, sender))
        && !plan.push.iter().any(|&j| same_address(incoming[j], sender));
    plan
}

/// Порядок группы в списке: сравнение двух групп по (created_at, id).
///
/// ЗАЧЕМ В ЯДРЕ. Регресс «список групп прыгает сам»: `groups.json` читается в
/// HashMap, а итерация по нему в Rust случайна на каждый процесс, значит без
/// детерминированной сортировки порядок выдаётся хранилищем. До переноса
/// компаратор жил внутри команды моста (`src-tauri/src/lib.rs::groups_load_own`),
/// а тесты сортировали СВОЮ копию функции — удаление или переворот реальной
/// строки не сломали бы ни одну проверку (тот же класс, что тавтологический
/// тест сортировки тредов, `4030f1c`).
///
/// ФОРМА — строки, не тип: `created_at` пишется как RFC3339, поэтому
/// лексикографическое сравнение совпадает с хронологическим; при равенстве
/// времени решает id, иначе две группы одного момента меняются местами.
pub fn group_order(created_a: &str, id_a: &str, created_b: &str, id_b: &str) -> Ordering {
    created_b.cmp(created_a).then_with(|| id_a.cmp(id_b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_of_absent_member_does_nothing() {
        assert_eq!(plan_rename(None, None), Rename::Nothing);
        // (а) старый адрес уже ушёл, а новый значится — повторный вызов
        // обязан ничего не добавлять.
        assert_eq!(plan_rename(None, Some(3)), Rename::Nothing);
    }

    #[test]
    fn rename_moves_the_single_record() {
        assert_eq!(plan_rename(Some(2), None), Rename::Move { at: 2 });
        // Тот же адрес в другом написании — одна запись, не дубль.
        assert_eq!(plan_rename(Some(1), Some(1)), Rename::Move { at: 1 });
    }

    #[test]
    fn duplicate_keeps_the_newer_record_and_shifts_its_index() {
        // Новый адрес стоит ПОСЛЕ старого: после remove(i) индекс j
        // съезжает, и без сдвига key_shared получил бы сосед.
        assert_eq!(
            plan_rename(Some(1), Some(4)),
            Rename::MergeDuplicate { drop: 1, keep: 3 }
        );
        // Новый адрес стоит ДО старого — сдвигать нечего.
        assert_eq!(
            plan_rename(Some(4), Some(1)),
            Rename::MergeDuplicate { drop: 4, keep: 1 }
        );
    }

    /// Индекс `keep` обязан оставаться в границах списка после удаления —
    /// иначе мост падает на испорченном groups.json.
    #[test]
    fn keep_index_is_always_in_bounds_after_the_removal() {
        for n in 2..8usize {
            for i in 0..n {
                for j in 0..n {
                    if i == j {
                        continue;
                    }
                    let Rename::MergeDuplicate { drop, keep } = plan_rename(Some(i), Some(j))
                    else {
                        panic!("ожидался MergeDuplicate для {i}/{j}");
                    };
                    assert_eq!(drop, i);
                    assert!(
                        keep < n - 1,
                        "n={n} i={i} j={j}: keep={keep} вышел за список"
                    );
                }
            }
        }
    }

    #[test]
    fn creator_cannot_be_removed_or_demoted() {
        assert!(!may_remove_member("anna@mail.ru", "ANNA@mail.ru "));
        assert!(may_remove_member("oleg@mail.ru", "anna@mail.ru"));
        assert!(!may_set_role("anna@mail.ru", " Anna@Mail.RU ", false));
        // «Оставить создателя Admin» — не отказ, а идемпотентный вызов.
        assert!(may_set_role("anna@mail.ru", "anna@mail.ru", true));
        assert!(may_set_role("oleg@mail.ru", "anna@mail.ru", false));
        // Кириллическая «а» — ДРУГОЙ адрес, а не вариант написания: снижать
        // её к латинской значило бы «создатель = любой похожий по буквам».
        assert!(may_remove_member("анна@mail.ru", "anna@mail.ru"));
    }

    #[test]
    fn invite_updates_known_members_and_pushes_unknown() {
        let existing = ["anna@mail.ru", "oleg@mail.ru"];
        let incoming = ["ANNA@mail.ru", "petr@mail.ru", ""];
        let plan = plan_invite(&existing, &incoming, "anna@mail.ru");
        assert_eq!(plan.update, [(0, 0)]);
        assert_eq!(plan.push, [1], "пустой адрес инвайта не заводит участника");
        assert!(!plan.push_sender, "отправитель уже в списке");
    }

    #[test]
    fn repeated_address_in_one_invite_adds_one_member() {
        // Письмо-инват могло перечислить адрес дважды (гонка правок):
        // вторая строка того же человека — это путь к группе «Четыре».
        let plan = plan_invite(
            &["oleg@mail.ru"],
            &["petr@mail.ru", " PETR@mail.ru ", ""],
            "anna@mail.ru",
        );
        assert_eq!(plan.push, [0]);
        assert!(plan.push_sender);
        // А повтор уже известного участника — одна роль, а не две: при
        // конфликте берётся ПЕРВАЯ строка инвайта (вторая — это то же письмо,
        // прочитанное дважды, а не свежее решение о роли).
        let twice = plan_invite(
            &["petr@mail.ru"],
            &["petr@mail.ru", "PETR@mail.ru"],
            "anna@mail.ru",
        );
        assert_eq!(twice.update, [(0, 0)]);
        assert!(twice.push.is_empty());
    }

    #[test]
    fn invite_always_adds_the_sender() {
        let plan = plan_invite(&["oleg@mail.ru"], &["petr@mail.ru"], "anna@mail.ru");
        assert!(plan.push_sender);
        // Отправитель уже в инвайте — второй записи о нём не будет.
        let again = plan_invite(&["oleg@mail.ru"], &["anna@mail.ru"], "ANNA@mail.ru");
        assert!(!again.push_sender);
        assert_eq!(again.push, [0]);
    }

    #[test]
    fn empty_sender_is_not_a_member() {
        // Пустой адрес — не участник: иначе `push_sender` заводил бы
        // безымянную запись, а она позже совпадала бы с кем угодно.
        assert!(!plan_invite(&["oleg@mail.ru"], &[], "").push_sender);
    }

    #[test]
    fn creator_or_admin_manages_the_roster() {
        let creator = Access {
            is_creator: true,
            is_admin: false,
        };
        let admin = Access {
            is_creator: false,
            is_admin: true,
        };
        let member = Access::default();
        assert!(creator.may_manage());
        assert!(admin.may_manage());
        assert!(
            !member.may_manage(),
            "обычный участник не управляет составом"
        );
    }

    #[test]
    fn only_manager_removes_and_never_the_creator_or_self() {
        let admin = Access {
            is_creator: false,
            is_admin: true,
        };
        assert!(admin.may_remove(false, false));
        assert!(
            !admin.may_remove(true, false),
            "создателя не удаляет никто, даже админ"
        );
        assert!(
            !admin.may_remove(false, true),
            "себя убирают выходом из группы, а не удалением"
        );
        assert!(!Access::default().may_remove(false, false));
    }

    #[test]
    fn creator_who_is_not_marked_admin_still_removes() {
        // Создатель всегда управляет, даже если роль в записи не проставлена
        // (старые groups.json): право следует из создательства, а не из роли.
        let creator = Access {
            is_creator: true,
            is_admin: false,
        };
        assert!(creator.may_remove(false, false));
    }

    #[test]
    fn only_manager_changes_roles_and_never_the_creator_row() {
        let admin = Access {
            is_creator: false,
            is_admin: true,
        };
        assert!(admin.may_set_role_of(false));
        assert!(
            !admin.may_set_role_of(true),
            "роль создателя не меняет никто, даже админ"
        );
        assert!(Access {
            is_creator: true,
            is_admin: false
        }
        .may_set_role_of(false));
        assert!(
            !Access::default().may_set_role_of(false),
            "обычный участник не назначает роли"
        );
    }

    /// Список групп детерминирован БЕЗотносительно к порядку HashMap: свежие
    /// сверху, при равенстве времени — по id.
    #[test]
    fn newer_group_sorts_above_older() {
        let sorted = {
            let mut v = vec![
                ("2026-01-01T10:00:00Z", "grp_a"),
                ("2026-03-01T10:00:00Z", "grp_b"),
                ("2026-02-01T10:00:00Z", "grp_c"),
            ];
            v.sort_by(|a, b| group_order(a.0, a.1, b.0, b.1));
            v.into_iter().map(|(_, id)| id).collect::<Vec<_>>()
        };
        assert_eq!(
            sorted,
            vec!["grp_b", "grp_c", "grp_a"],
            "порядок задает created_at по убыванию"
        );
    }

    /// Равные `created_at` — не жребий: порядок замыкает id.
    #[test]
    fn equal_created_at_is_broken_by_id() {
        let sorted = {
            let mut v = vec![
                ("2026-01-01T00:00:00Z", "grp_z"),
                ("2026-01-01T00:00:00Z", "grp_a"),
                ("2026-01-01T00:00:00Z", "grp_m"),
            ];
            v.sort_by(|a, b| group_order(a.0, a.1, b.0, b.1));
            v.into_iter().map(|(_, id)| id).collect::<Vec<_>>()
        };
        assert_eq!(sorted, vec!["grp_a", "grp_m", "grp_z"], "тай-брейкер по id");
    }

    /// Компаратор — строгий порядок: одинаковая группа не «больше самой себя»,
    /// а разные моменты времени сравниваются в обе стороны согласованно.
    #[test]
    fn group_order_is_a_strict_ordering() {
        let (old, new) = ("2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z");
        assert_eq!(group_order(old, "x", old, "x"), Ordering::Equal);
        assert_eq!(group_order(new, "x", old, "x"), Ordering::Less);
        assert_eq!(group_order(old, "x", new, "x"), Ordering::Greater);
    }
}
