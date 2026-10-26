//! Advisory-лок файлового дескриптора (LOCK_FILE импорта/гварда ключей).
//!
//! ВАЖНО (регрессия 11.10, device-приёмка): `std::fs::File::lock` (стабилен
//! с 1.97) на x86_64-linux-android возвращает `ErrorKind::Unsupported`
//! («lock() not supported») — стартовый барьер восстановления падал с
//! ERR_IO и fail-closed `exit(1)` крутил старт в крэш-луп. Поэтому на unix
//! используем сырой `flock(2)` — ту же семантику, что задумывалась
//! (межпроцессный advisory-лок того же inode).
use std::fs::File;
use std::io;

/// Блокирующий эксклюзивный лок.
#[cfg(unix)]
pub(crate) fn lock_exclusive(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: flock на валидном fd; ошибок памяти не порождает.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Снять лок.
#[cfg(unix)]
pub(crate) fn unlock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: flock на валидном fd.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Не-unix (desktop Windows-сборки): стандартный API std.
#[cfg(not(unix))]
pub(crate) fn lock_exclusive(file: &File) -> io::Result<()> {
    file.lock()
}

#[cfg(not(unix))]
pub(crate) fn unlock(file: &File) -> io::Result<()> {
    file.unlock()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Семантика `flock` отличается от `File::lock` НА ХОСТЕ, и проба это
    /// различает: POSIX record lock принадлежит ПРОЦЕССУ (второй fd того же
    /// inode залочился бы мгновенно), а `flock` — открытому описанию файла,
    /// поэтому второй обязан ЖДАТЬ, пока первый не отпустит. Это ровно то, ради
    /// чего файл существует после регрессии 11.10.
    #[test]
    fn lock_is_exclusive_across_descriptors_and_release_frees_it() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("vault-filelock-{}-{}.lock", std::process::id(), stamp));
        let holder = File::create(&path).unwrap();
        let waiter = File::create(&path).unwrap();

        lock_exclusive(&holder).expect("первый держатель обязан залочиться");

        let acquired = Arc::new(AtomicBool::new(false));
        let flag = acquired.clone();
        // Поток намеренно не join'ится: на мутанте «unlock не отпускает» он
        // остаётся заблокированным, а зависать прогону не позволено.
        std::thread::spawn(move || {
            if lock_exclusive(&waiter).is_ok() {
                flag.store(true, Ordering::SeqCst);
            }
        });

        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !acquired.load(Ordering::SeqCst),
            "второй fd того же файла залочился, не дождавшись: это не блокирующий эксклюзивный flock"
        );

        unlock(&holder).expect("разблокировка обязана отпустить лок");

        let deadline = Instant::now() + Duration::from_secs(3);
        while !acquired.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            acquired.load(Ordering::SeqCst),
            "после unlock следующий держатель не получил лок: освобождения не произошло"
        );
        let _ = std::fs::remove_file(&path);
    }
}
