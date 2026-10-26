// Набор мутаций: rust-bridge-file-lock — advisory-лок файлового дескриптора.
//
// ЗАЧЕМ (t_043d6a21, слепая зона №3). `src-tauri/src/file_lock.rs` — 47 строк,
// НИ ОДНОГО теста. Файл появился после регрессии 11.10: `std::fs::File::lock`
// на x86_64-linux-android возвращает `ErrorKind::Unsupported`, стартовый барьер
// восстановления падал с ERR_IO, а fail-closed `exit(1)` крутил старт в
// крэш-луп. Решение — сырой `flock(2)`. До этого хода ничто в дереве не
// мешало «решению» молча вернуться к `File::lock` или ослабнуть до разделяемого
// лока: проверок, различающих эти семантики, не было.
//
// ПОЧЕМУ ЭТО ИЗМЕРИМО НА ХОСТЕ (и почему исключение было бы ошибкой). Выбор
// реализации с хоста не воспроизводится — на Linux `File::lock` работает. Но
// СЕМАНТИКА различима: POSIX record lock принадлежит ПРОЦЕССУ, а `flock` —
// открытому описанию файла. Значит второй fd того же inode при `flock` обязан
// ждать, а при `File::lock` залочился бы мгновенно. Отсюда проба «второй fd
// ждёт, а `unlock` отпускает» убивает и ослабление до LOCK_SH, и перевод в
// неблокирующий режим, и неснятие лока.
//
// ЧЕСТНАЯ ГРАНИЦА. Два места вне набора:
//   • ветвь `#[cfg(not(unix))]` (`file.lock()` / `file.unlock()`) — на хосте не
//     компилируется, мутация в ней неотличима от её отсутствия; сборка под
//     Windows в проекте не ведётся;
//   • «ошибка flock проглочена и возвращён Ok» — наблюдима только при отказе
//     ядра, а вызвать отказ нечем: fd валиден, LOCK_UN на незалокированном fd
//     не ошибка. Проба на EINVAL была бы пробой на сам мутант.
export default {
  id: 'rust-bridge-file-lock',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/file_lock.rs',
  smoke: 'cargo test -p vault-desktop --lib file_lock',
  timeoutMs: 900_000,
  mutations: [
    // ── Эксклюзивность ──
    { name: 'лок стал разделяемым: два держателя одного файла идут в запись одновременно',
      pattern: '    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };',
      replacement: '    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH) };' },
    // ── Блокировка обязана ждать, а не отказывать ──
    { name: 'лок стал неблокирующим: барьер восстановления падает вместо ожидания соседнего процесса',
      pattern: '    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };',
      replacement: '    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };' },
    { name: 'операция лока обнулена: flock отказывает с EINVAL, лок не берётся вовсе',
      pattern: '    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };',
      replacement: '    let rc = unsafe { libc::flock(file.as_raw_fd(), 0) };' },
    // ── Снятие лока ──
    { name: 'unlock переводит в разделяемый лок вместо снятия: следующий держатель ждёт вечно',
      pattern: '    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };',
      replacement: '    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH) };' },
    { name: 'unlock не снимает лок (операция обнулена): освобождения не происходит',
      pattern: '    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };',
      replacement: '    let rc = unsafe { libc::flock(file.as_raw_fd(), 0) };' },
  ],
};
