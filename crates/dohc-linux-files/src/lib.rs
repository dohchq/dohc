//! Linux read-lease probe for retained materialization originals.
//! Verified against Linux a90ee4305c4a5df72c11b31dacfdc76e00fcf78a, fs/locks.c:
//! lease_open_conflict returns EAGAIN for F_RDLCK when inode_is_open_for_write.
//! generic_add_lease checks it under the inode and file locks; lease breaks send SIGIO.
//! https://github.com/torvalds/linux/blob/a90ee4305c4a5df72c11b31dacfdc76e00fcf78a/fs/locks.c
#![cfg(target_os = "linux")]
pub mod held;
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
static BROKEN: AtomicBool = AtomicBool::new(false);
static PROBE: Mutex<()> = Mutex::new(());
static SIGNAL: OnceLock<Result<(), i32>> = OnceLock::new();
#[derive(Debug, PartialEq, Eq)]
pub enum LeaseProbe {
    Available,
    WriterPresent,
    Unsupported,
}

pub fn probe(file: &File) -> io::Result<LeaseProbe> {
    let _lock = PROBE
        .lock()
        .map_err(|_| io::Error::other("lease probe poisoned"))?;
    let signal = SIGNAL.get_or_init(install_signal);
    if let Err(code) = signal {
        return Err(io::Error::from_raw_os_error(*code));
    }
    BROKEN.store(false, Ordering::SeqCst);
    match set_lease(file, libc::F_RDLCK) {
        Ok(()) => {
            set_lease(file, libc::F_UNLCK)?;
            Ok(if BROKEN.load(Ordering::SeqCst) {
                LeaseProbe::WriterPresent
            } else {
                LeaseProbe::Available
            })
        }
        Err(e) if e.raw_os_error() == Some(libc::EAGAIN) => Ok(LeaseProbe::WriterPresent),
        Err(e)
            if matches!(
                e.raw_os_error(),
                Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP | libc::EPERM | libc::EACCES)
            ) =>
        {
            Ok(LeaseProbe::Unsupported)
        }
        Err(e) => Err(e),
    }
}
#[allow(unsafe_code)]
fn install_signal() -> Result<(), i32> {
    // The handler only stores an atomic flag; it neither allocates nor locks.
    unsafe { signal_hook_registry::register(libc::SIGIO, || BROKEN.store(true, Ordering::SeqCst)) }
        .map(|_| ())
        .map_err(|e| e.raw_os_error().unwrap_or(libc::EIO))
}
#[allow(unsafe_code)]
fn set_lease(file: &File, kind: i32) -> io::Result<()> {
    // The descriptor remains owned by file; fcntl receives an integer argument.
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLEASE, kind) };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sigio_is_handled_without_terminating_the_process() {
        let _lock = PROBE.lock().unwrap();
        assert!(SIGNAL.get_or_init(install_signal).is_ok());
        BROKEN.store(false, Ordering::SeqCst);
        deliver_sigio();
        assert!(BROKEN.load(Ordering::SeqCst));
    }
    #[allow(unsafe_code)]
    fn deliver_sigio() {
        // raise delivers to this test thread and returns after the handler.
        assert_eq!(unsafe { libc::raise(libc::SIGIO) }, 0);
    }
}
