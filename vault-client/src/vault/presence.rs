//! Решения реестра присутствия (ADR-005 §W4, партия 4).
//!
//! ЗАЧЕМ В ЯДРЕ. `src-tauri/src/presence.rs` — json-реестр heartbeat-ов, и
//! три решения в нём ничем не отличались от решений протокола: под каким
//! ключом запись лежит, когда heartbeat считается уже известным и что
//! переживает чистку. Все три жили в мосту, то есть вне
//! `rust-mutation-gate`, и первый из них был реальным дефектом: ключом служил
//! `email.to_string()` **без нормализации**, поэтому `Bob@X` и `bob@x` — два
//! разных реестра, и `last_seen("Bob@X")` не находил то, что записал
//! `last_seen("bob@x")`. Форма адреса — один носитель во всём проекте
//! (`vault::identity`), здесь только вызов.
//!
//! ПОРОГ «КТО СЧИТАЕТСЯ В СЕТИ» ЗДЕСЬ НЕ ЖИВЁТ. Окно `PRESENCE_ONLINE_MS`
//! держит фронт (`features/presence.js`), и перенос чисел присутствия в ядро —
//! часть задачи про снапшот окон (`t_ee90c534`), а не этой партии. Здесь —
//! только то, что и так решалось в Rust.

use crate::vault::identity::normalize;

/// Известен ли уже такой heartbeat: дедуп по (источник, метка времени).
///
/// Источник — Message-ID конверта, поэтому одно и то же письмо, прочитанное
/// дважды, не добавляет записи. Но `ts` в паре обязателен: одно письмо может
/// нести два heartbeat-а с разными часами (ретрансляция), и схлопнув их по
/// одному лишь источнику, реестр перестал бы видеть «был онлайн позже».
pub fn heartbeat_known<'a, I>(seen: I, source: &str, ts: i64) -> bool
where
    I: IntoIterator<Item = (&'a str, i64)>,
{
    let source = normalize(source);
    seen.into_iter()
        .any(|(s, t)| normalize(s) == source && t == ts)
}

/// Переживёт ли heartbeat чистку (`prune_older_than`).
///
/// Граница включительная: `ts == cutoff` остаётся. Ровно так вело себя и
/// исходное `retain(|h| h.ts >= cutoff_ms)`; мутация `>=` → `>` стирает
/// запись, пришедшуюся ровно в cutoff, на один тик раньше — ловится пробой
/// на границе.
pub fn survives_prune(ts: i64, cutoff_ms: i64) -> bool {
    ts >= cutoff_ms
}

/// Последняя активность по heartbeat-ам: максимум метки времени.
pub fn latest_ts<'a, I>(timestamps: I) -> Option<i64>
where
    I: IntoIterator<Item = &'a i64>,
{
    timestamps.into_iter().max().copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_is_known_only_for_the_same_source_and_clock() {
        let seen = [("uid1".to_string(), 1000i64), ("uid2".to_string(), 2000)];
        let view = || seen.iter().map(|(s, t)| (s.as_str(), *t));
        let none: [(&str, i64); 0] = [];
        assert!(heartbeat_known(view(), "uid2", 2000));
        assert!(!heartbeat_known(view(), "uid2", 2100));
        assert!(!heartbeat_known(view(), "uid3", 2000));
        assert!(!heartbeat_known(none, "uid1", 1000));
    }

    #[test]
    fn heartbeat_source_is_normalized_like_an_address() {
        let seen = [("UID1".to_string(), 1000i64)];
        assert!(heartbeat_known(
            seen.iter().map(|(s, t)| (s.as_str(), *t)),
            "uid1",
            1000
        ));
        // И в обратную сторону: в реестре нормальная форма, а приходит письмо
        // с регистром/обрамлением чужой дороги. Без нормализации ВХОДЯЩЕГО
        // источника heartbeat заводится вторым, и «последний раз онлайн»
        // начинает зависеть от того, как написал адрес MTA.
        let stored = [("uid1".to_string(), 1000i64)];
        assert!(heartbeat_known(
            stored.iter().map(|(s, t)| (s.as_str(), *t)),
            " UID1 ",
            1000
        ));
    }

    #[test]
    fn prune_boundary_keeps_the_exact_cutoff_entry() {
        assert!(survives_prune(150, 150));
        assert!(survives_prune(151, 150));
        assert!(!survives_prune(149, 150));
    }

    #[test]
    fn latest_is_the_max_and_empty_is_none() {
        assert_eq!(latest_ts([1000i64, 3000, 2000].iter()), Some(3000));
        assert_eq!(latest_ts([1000i64].iter()), Some(1000));
        assert_eq!(latest_ts([].iter()), None);
    }
}
