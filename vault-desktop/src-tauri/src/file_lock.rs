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
