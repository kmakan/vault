//!Terminal/transient verdict for a mail body that came back empty.
//!
//! The wire contract between the transport (Tauri bridge, CLI listener) and the
//! frontend is three-valued, and only the transport can decide which:
//!
//! * `(uid, "")` — this body will **never** arrive: the message left the folder
//!   (moved, deleted, spam-purged) or it is not an IMAP message at all (a relay
//!   envelope). The frontend caches this negative and stops asking.
//! * no entry for `uid` — "I don't know, ask again next tick" (transient).
//! * `Err` — the IMAP session is desynced: reconnect and retry the whole batch.
//!
//! Without the first class the frontend re-requested the same vanished message
//! on every poll: the 22.10 complaint «приглашения от старых email» measured 368
//! identical log lines per 2.5 minutes on a live mailbox.
//!
//! Lives in the core crate rather than in `src-tauri` because it is the
//! protocol decision itself, not transport plumbing: the CLI listener needs the
//! same verdict, and `src-tauri` is outside the mutation program
//! (docs/testing/testing-strategy.md), so a decision placed there is untested by
//! construction.

/// Marker entries for uids whose body will never arrive: one entry per
/// requested uid, each with an empty body. A missing entry is reserved for
/// "unknown", so it must never stand in for "absent".
pub fn absent_bodies(uids: &[String]) -> Vec<(String, String)> {
    uids.iter().map(|u| (u.clone(), String::new())).collect()
}

/// Verdict for a batch in which some uids returned no body.
///
/// `absent` — uids the selected folder does not contain (`UID SEARCH`). Those
/// messages are gone, so they are marked terminal **always**, regardless of
/// whether the rest of the batch succeeded: SEARCH is authoritative and an
/// unmarked dead uid would be re-fetched every poll.
///
/// `desync` — a message is present on the server, FETCH stayed silent about it,
/// and not a single body arrived. That is a session desync: the caller
/// reconnects and repeats. If at least one body arrived the session is alive,
/// so no desync is reported.
pub fn classify_empty_batch(
    got_bodies: usize,
    empty_uids: &[String],
    absent: &[String],
) -> (Vec<String>, bool) {
    let absent_set: std::collections::HashSet<&str> =
        absent.iter().map(String::as_str).collect();
    let dead: Vec<String> = empty_uids
        .iter()
        .filter(|u| absent_set.contains(u.as_str()))
        .cloned()
        .collect();
    let silent_but_present = empty_uids.len() - dead.len();
    (dead, got_bodies == 0 && silent_but_present > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn absent_bodies_returns_empty_body_entry_per_uid() {
        let uids = e(&["rl-3fa85f64", "", "636"]);
        let got = absent_bodies(&uids);
        assert_eq!(got.len(), 3, "каждый запрошенный uid помечен");
        assert!(
            got.iter().all(|(_, body)| body.is_empty()),
            "пометка = пустое тело, не пропуск"
        );
        let marked: Vec<&str> = got.iter().map(|(u, _)| u.as_str()).collect();
        assert_eq!(marked, vec!["rl-3fa85f64", "", "636"]);
        assert!(absent_bodies(&[]).is_empty(), "пустой запрос — пустой ответ");
    }

    #[test]
    fn classify_marks_server_absent_uids_terminal_even_in_mixed_batch() {
        // Ни одного тела, все uid на сервере отсутствуют → мёртвый курсор:
        // каждый помечен, ошибки НЕТ (иначе вызывающий зациклится на reconnect).
        let (dead, desync) = classify_empty_batch(0, &e(&["1", "2"]), &e(&["1", "2"]));
        assert_eq!(dead, e(&["1", "2"]), "оба помечены окончательными");
        assert!(!desync, "письма ушли — сессия жива, это не рассинхрон");

        // Смешанный батч: часть тел пришла, один uid отсутствует. Пометка
        // ставится и здесь — SEARCH авторитетен.
        let (dead, desync) = classify_empty_batch(2, &e(&["3", "4"]), &e(&["4"]));
        assert_eq!(
            dead,
            e(&["4"]),
            "отсутствующий помечен, даже когда остальные тела пришли"
        );
        assert!(!desync, "раз хоть одно тело пришло — сессия жива");

        // Тело не пришло НИ ОДНОГО, но письмо на сервере ЕСТЬ — это рассинхрон,
        // и помечать его «никогда» нельзя: повтор после reconnect может дать тело.
        let (dead, desync) = classify_empty_batch(0, &e(&["7"]), &e(&[]));
        assert!(dead.is_empty(), "живой uid не помечается: его тело ещё может прийти");
        assert!(desync, "молчание FETCH при живом письме = Err на reconnect");

        // Гибрид: один ушёл, другой молчит при пустом батче. Ушедший помечен,
        // но решение по батчу — «рассинхрон» (Err): вызывающий повторит батч и
        // увидит пометку в следующем проходе.
        let (dead, desync) = classify_empty_batch(0, &e(&["8", "9"]), &e(&["9"]));
        assert_eq!(dead, e(&["9"]));
        assert!(desync);
    }
}
