// ЗАЧЕМ. `email.rs::fetch_bodies`/`fetch_message_body` — путь, по которому UI
// вообще получает тела писем. Ответ здесь трёхзначный, и выбрать значение может
// только транспорт: `(uid,"")` = «тела не будет никогда» (фронт кэширует
// негатив), «нет записи» = «переспроси в следующем тике», `Err` = «сессия
// рассинхронизирована, reconnect». Путаница между этими
// тремя стоит живому телефону reconnect-шторм (замер 22.10: 32 переподключения в
// минуту на папке Gmail с пятью исчезнувшими письмами; 04.10 на X50 — 59
// «reconnect deferred» на отсутствующую папку). Само решение (`body_absence`,
// `imap_dialect`, `relay::is_imap_uid`) живёт в `vault-client` и измерено там
// (`rust-body-absence`, `rust-imap-dialect`, `rust-relay-shape`); здесь мерится
// ПРОВОДКА — что мост вызывает ядро на каждом из своих путей и не теряет часть
// запрошенных uid по дороге.
//
// СТЕНД. Пробеги идут по loopback-TLS IMAP-фикстуре
// (`src-tauri/src/email/full_scan_tests.rs`): реальный `UID FETCH`/`UID SEARCH`
// разговор, поэтому ветки «папки нет», «письма ушли», «FETCH молчит при живом
// письме» наблюдаемы, а не декларируются.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (не измеримо в изоляции, а не «забыто»):
//   * `let Ok(n) = u.trim().parse::<u32>() else { return true; }` в `uids_absent` —
//     в оба вызова попадают только uid, уже прошедшие `relay::is_imap_uid`
//     (только цифры), поэтому ветка «не число» недостижима изнутри; она сторожит
//     чужой вызов. Проба на неё была бы вакуумной.
//   * `.cloned()` в обоих фильтрах-разделителях — компилятор не принимает
//     заимствование из `uids` после движения (`Vec<&String>` vs `Vec<String>`),
//     это ловит `cargo`, а не тест.
//   * строки `eprintln!` (диагностика шторма реконнектов) — не поведение.
//   * `uid_fetch(uid, "(RFC822.TEXT)")` — фикстура отвечает на обе спрашиваемые
//     секции, смена строки убила бы пробы, не проверив правило.
//   * `if sel.exists == 0 { bail!(…) }` в `fetch_message_body` — guard против
//     «select промолчал»; фикстура отвечает `* 2 EXISTS` на любой SELECT, так что
//     наблюдаем он был бы только новой фикстурой (задолженность: режим EmptyFolder).
export default {
  id: 'rust-bridge-batch-bodies',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/email.rs',
  smoke: 'cargo test -p vault-desktop --lib fetch_',
  timeoutMs: 900_000,
  mutations: [
    // ── виртуальная папка релея: ни SELECT, ни FETCH, ответ = «никогда» ──
    {
      name: 'batch: виртуальная папка доходит до IMAP',
      pattern: `        if relay::is_virtual_folder(folder) {
            eprintln!("[fetch_bodies] folder={folder} virtual — skipped");`,
      replacement: `        if false {
            eprintln!("[fetch_bodies] folder={folder} virtual — skipped");`,
    },
    {
      name: 'single: виртуальная папка доходит до IMAP',
      pattern: `        if relay::is_virtual_folder(folder) {
            eprintln!("[email] body fetch: virtual folder {folder} — skipped");`,
      replacement: `        if false {
            eprintln!("[email] body fetch: virtual folder {folder} — skipped");`,
    },
    {
      name: 'single: безадресный uid доходит до IMAP',
      pattern: `        if !relay::is_imap_uid(uid) {
            eprintln!("[email] body fetch: uid {uid:?} is not an IMAP uid — skipped");`,
      replacement: `        if false {
            eprintln!("[email] body fetch: uid {uid:?} is not an IMAP uid — skipped");`,
    },
    // ── разделитель реальных и псевдо-uid: ни один запрошенный uid не теряется ──
    {
      name: 'batch: реальные uid фильтруются по отрицанию (инверсия)',
      pattern: `        let real_uids: Vec<String> = uids
            .iter()
            .filter(|u| relay::is_imap_uid(u))`,
      replacement: `        let real_uids: Vec<String> = uids
            .iter()
            .filter(|u| !relay::is_imap_uid(u))`,
    },
    {
      name: 'batch: псевдо-uid считается реальным (инверсия)',
      pattern: `        let pseudo_uids: Vec<String> = uids
            .iter()
            .filter(|u| !relay::is_imap_uid(u))`,
      replacement: `        let pseudo_uids: Vec<String> = uids
            .iter()
            .filter(|u| relay::is_imap_uid(u))`,
    },
    {
      name: 'batch: оба раздела пусты — каждый uid становится псевдо',
      pattern: `        let pseudo_uids: Vec<String> = uids
            .iter()
            .filter(|u| !relay::is_imap_uid(u))
            .cloned()
            .collect();`,
      replacement: `        let pseudo_uids: Vec<String> = Vec::new();`,
    },
    {
      name: 'single: правило формы uid заменено на префикс конверта',
      pattern: `        if !relay::is_imap_uid(uid) {`,
      replacement: `        if relay::is_virtual_id(uid) {`,
    },
    {
      name: 'batch: правило формы uid заменено на префикс конверта',
      pattern: `            .filter(|u| relay::is_imap_uid(u))`,
      replacement: `            .filter(|u| !relay::is_virtual_id(u))`,
    },
    {
      name: 'batch: батч из одних псевдо-uid уходит в IMAP',
      pattern: `        if real_uids.is_empty() {
            eprintln!(`,
      replacement: `        if false {
            eprintln!(`,
    },
    {
      name: 'batch: на сервер отправляются все uid, включая псевдо',
      pattern: `        let uids = real_uids.as_slice();`,
      replacement: `        let uids: &[String] = uids;`,
    },
    // ── «папки нет» ≠ сетевой сбой: помечаются ВСЕ запрошенные uid ──
    {
      name: 'batch: отсутствующая папка трактуется как сбой сессии',
      pattern: `            if Self::is_missing_folder_error(&err) {
                eprintln!("[fetch_bodies] folder={folder} missing on server — skipped");`,
      replacement: `            if false {
                eprintln!("[fetch_bodies] folder={folder} missing on server — skipped");`,
    },
    {
      name: 'batch: при отсутствующей папке псевдо-uid теряются',
      pattern: `                let mut all = body_absence::absent_bodies(uids);
                all.extend(body_absence::absent_bodies(&pseudo_uids));`,
      replacement: `                let all = body_absence::absent_bodies(uids);`,
    },
    {
      name: 'single: отсутствующая папка трактуется как сбой сессии',
      pattern: `                if Self::is_missing_folder_error(&err) {
                    eprintln!("[email] body fetch: folder {folder} missing — skipped");`,
      replacement: `                if false {
                    eprintln!("[email] body fetch: folder {folder} missing — skipped");`,
    },
    // ── молчание FETCH: различие «письмо ушло» / «сессия врёт» ──
    {
      name: 'batch: мёртвые uid не собираются и не классифицируются',
      pattern: `            if body.is_empty() {
                empty_uids.push(uid.clone());
                continue;
            }`,
      replacement: `            if body.is_empty() {
                continue;
            }`,
    },
    {
      name: 'batch: вопрос о существовании не задаётся вовсе',
      pattern: `            match Self::uids_absent(session, &empty_uids) {`,
      replacement: `            match Ok::<Vec<String>, anyhow::Error>(Vec::new()) {`,
    },
    {
      name: 'batch: сбой SEARCH превращается в terminal-пометку',
      pattern: `                Err(e) => return Err(e),
            }
        };

        if folder != "INBOX" {`,
      replacement: `                Err(_) => (Vec::new(), false),
            }
        };

        if folder != "INBOX" {`,
    },
    {
      name: 'single: ушедшее письмо считается рассинхроном (шторм реконнектов)',
      pattern: `                Ok(_) => {
                    eprintln!("[email] body fetch: uid {uid} in {folder} отсутствует на сервере — не рассинхрон");
                }`,
      replacement: `                Ok(_) => desync = true,`,
    },
    {
      name: 'single: рассинхрон больше не Err (мёртвый курсор зациклится)',
      pattern: `                Ok(absent) if absent.is_empty() => desync = true,`,
      replacement: `                Ok(absent) if !absent.is_empty() => desync = true,`,
    },
    // ── разбор тела на границе: quoted-printable обязана применяться ──
    {
      name: 'batch: тело отдаётся без quoted-printable',
      pattern: `                        body = mail_codec::quoted_printable(&String::from_utf8_lossy(text));`,
      replacement: `                        body = String::from_utf8_lossy(text).to_string();`,
    },
    {
      name: 'single: тело отдаётся без quoted-printable',
      pattern: `        if let Ok(data) = fetch_res {
            for fetch in data.iter() {
                if let Some(text) = fetch.text() {
                    body = mail_codec::quoted_printable(&String::from_utf8_lossy(text));`,
      replacement: `        if let Ok(data) = fetch_res {
            for fetch in data.iter() {
                if let Some(text) = fetch.text() {
                    body = String::from_utf8_lossy(text).to_string();`,
    },
    // ── сборка ответа: живые тела → мёртвые → псевдо, ничего не дублируется ──
    {
      name: 'batch: мёртвые uid не помечены — фронт переспрашивает их каждый тик',
      pattern: `        out.extend(body_absence::absent_bodies(&dead));`,
      replacement: `        // dead-пометка утеряна`,
    },
    {
      name: 'batch: безадресные uid не помечены — фронт переспрашивает их каждый тик',
      pattern: `        out.extend(body_absence::absent_bodies(&pseudo_uids));`,
      replacement: `        // pseudo-пометка утеряна`,
    },
    {
      name: 'batch: псевдо-uid помечаются дважды',
      pattern: `        out.extend(body_absence::absent_bodies(&dead));
        out.extend(body_absence::absent_bodies(&pseudo_uids));`,
      replacement: `        out.extend(body_absence::absent_bodies(&dead));
        out.extend(body_absence::absent_bodies(&dead));
        out.extend(body_absence::absent_bodies(&pseudo_uids));`,
    },
    {
      name: 'batch: сессию не возвращают в INBOX после чужой папки',
      pattern: `        if folder != "INBOX" {
            let _ = session.select("INBOX");
        }

        if desync {
            anyhow::bail!(
                "Empty body for ALL {n} uids in {folder} (session desync?)",`,
      replacement: `        if false {
            let _ = session.select("INBOX");
        }

        if desync {
            anyhow::bail!(
                "Empty body for ALL {n} uids in {folder} (session desync?)",`,
    },
    // ── существование проверяется СПРАШИВАНИЕМ тех же uid ──
    {
      name: 'existence: спрашивается не тот набор uid',
      pattern: `uids.join(",")`,
      replacement: `uids.iter().map(|_| "1").collect::<Vec<_>>().join(",")`,
    },
    {
      name: 'existence: absent-ответ инвертирован (живое письмо считается мёртвым)',
      pattern: `                !found.contains(&n)`,
      replacement: `                found.contains(&n)`,
    },
  ],
};
