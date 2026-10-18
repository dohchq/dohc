//! Every libc, libproc and Seatbelt call the owner makes. No other module may
//! use `unsafe`.
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::io;
use std::mem::{MaybeUninit, size_of};
use std::os::fd::RawFd;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::time::Duration;

pub type Pid = libc::pid_t;

/// `PROC_PGRP_ONLY` and `PROC_PPID_ONLY` in `<sys/proc_info.h>`.
const PROC_PGRP_ONLY: u32 = 2;
const PROC_PPID_ONLY: u32 = 6;

/// The most pids one listing may hold before the owner gives up on it.
const MAX_LISTED: usize = 1 << 20;

// SAFETY: These match `<sandbox.h>`, deprecated since macOS 10.8 and still
// exported by libSystem. With zero `flags`, `profile` is SBPL source. On
// failure `errorbuf` receives a string that only `sandbox_free_error` frees.
#[allow(unsafe_code)]
unsafe extern "C" {
    fn sandbox_init(profile: *const c_char, flags: u64, errorbuf: *mut *mut c_char) -> c_int;
    fn sandbox_free_error(errorbuf: *mut c_char);
}

/// A process with its start time, so a reused pid never matches it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Identity {
    pub pid: Pid,
    started: (u64, u64),
}

/// libproc reports a zombie as ESRCH, so a zombie reads as gone: it holds no
/// memory, runs nothing, and keeps its pid until its parent reaps it.
pub enum State {
    Gone,
    Live(Identity),
}

pub enum Signalled {
    Sent,
    Gone,
}

fn os_error() -> io::Error {
    io::Error::last_os_error()
}

fn is(error: &io::Error, code: c_int) -> bool {
    error.raw_os_error() == Some(code)
}

fn listing(kind: u32, value: Pid) -> io::Result<Vec<Pid>> {
    let value = u32::try_from(value).map_err(|_| io::Error::other("negative pid"))?;
    let mut capacity = 256;
    while capacity <= MAX_LISTED {
        let mut pids: Vec<Pid> = vec![0; capacity];
        let bytes = c_int::try_from(capacity * size_of::<Pid>())
            .map_err(|_| io::Error::other("process listing too large"))?;
        // SAFETY: `pids` holds `bytes` bytes. The call writes at most that
        // many and keeps no pointer to the buffer.
        #[allow(unsafe_code)]
        let written =
            unsafe { libc::proc_listpids(kind, value, pids.as_mut_ptr().cast::<c_void>(), bytes) };
        if written < 0 {
            return Err(os_error());
        }
        let count = usize::try_from(written).unwrap_or(0) / size_of::<Pid>();
        // A full buffer may have dropped pids, so list again with more room.
        if count < capacity {
            pids.truncate(count);
            pids.retain(|&pid| pid > 0);
            return Ok(pids);
        }
        capacity *= 2;
    }
    Err(io::Error::other("too many processes to list"))
}

/// Every process whose process group is `group`, zombies included.
pub fn group_members(group: Pid) -> io::Result<Vec<Pid>> {
    listing(PROC_PGRP_ONLY, group)
}

/// Every process whose parent is `parent`, zombies included.
pub fn children(parent: Pid) -> io::Result<Vec<Pid>> {
    listing(PROC_PPID_ONLY, parent)
}

pub fn state(pid: Pid) -> io::Result<State> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = c_int::try_from(size_of::<libc::proc_bsdinfo>()).unwrap_or(c_int::MAX);
    // SAFETY: `info` is a zeroed proc_bsdinfo of `size` bytes. The call
    // writes at most `size` bytes and keeps no pointer to it.
    #[allow(unsafe_code)]
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        let error = os_error();
        return if written <= 0 && is(&error, libc::ESRCH) {
            Ok(State::Gone)
        } else if written <= 0 {
            Err(error)
        } else {
            Err(io::Error::other("short process information"))
        };
    }
    // SAFETY: The struct was zeroed and holds only integers, so every byte
    // pattern, filled or not, is a valid value.
    #[allow(unsafe_code)]
    let info = unsafe { info.assume_init() };
    Ok(State::Live(Identity {
        pid,
        started: (info.pbi_start_tvsec, info.pbi_start_tvusec),
    }))
}

/// The physical footprint the kernel charges `pid`, the figure Activity
/// Monitor shows: dirty and compressed memory. None once the process is gone.
pub fn footprint(pid: Pid) -> io::Result<Option<u64>> {
    let mut usage = MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: RUSAGE_INFO_V4 writes one rusage_info_v4, the size of `usage`,
    // and keeps no pointer to it.
    #[allow(unsafe_code)]
    let result =
        unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, usage.as_mut_ptr().cast()) };
    if result != 0 {
        let error = os_error();
        return if is(&error, libc::ESRCH) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    // SAFETY: The struct was zeroed and holds only integers.
    #[allow(unsafe_code)]
    let usage = unsafe { usage.assume_init() };
    Ok(Some(usage.ri_phys_footprint))
}

pub fn kill(pid: Pid) -> io::Result<Signalled> {
    // SAFETY: kill takes two integers and touches no memory of ours.
    #[allow(unsafe_code)]
    let result = unsafe { libc::kill(pid, libc::SIGKILL) };
    if result == 0 {
        return Ok(Signalled::Sent);
    }
    let error = os_error();
    if is(&error, libc::ESRCH) {
        Ok(Signalled::Gone)
    } else {
        Err(error)
    }
}

/// Collects every exited child of the owner, so none stays a zombie in its group.
pub fn reap_children() {
    loop {
        let mut status: c_int = 0;
        // SAFETY: `status` is a valid c_int for the call to fill. WNOHANG
        // never blocks.
        #[allow(unsafe_code)]
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        // 0: no child has exited. -1: no children left, or a signal; the
        // teardown loop calls again.
        if pid <= 0 {
            return;
        }
    }
}

/// Makes the owner the leader of its own process group, which the worker and
/// esbuild then inherit. The desktop spawns the owner detached, so it usually
/// leads one already.
pub fn lead_process_group() -> io::Result<Pid> {
    // SAFETY: getpid, getpgrp and setpgid take and return integers only.
    #[allow(unsafe_code)]
    let (pid, group) = unsafe { (libc::getpid(), libc::getpgrp()) };
    if group != pid {
        // SAFETY: As above.
        #[allow(unsafe_code)]
        if unsafe { libc::setpgid(0, 0) } != 0 {
            return Err(os_error());
        }
    }
    Ok(pid)
}

/// Marks every descriptor above stderr close-on-exec, so the worker inherits
/// only stdin, stdout and stderr whatever the desktop left open.
pub fn close_inherited_descriptors_on_exec() -> io::Result<()> {
    // SAFETY: getpid takes no arguments.
    #[allow(unsafe_code)]
    let pid = unsafe { libc::getpid() };
    let mut capacity = 64;
    let descriptors = loop {
        if capacity > MAX_LISTED {
            return Err(io::Error::other("too many open descriptors"));
        }
        let mut entries: Vec<libc::proc_fdinfo> = vec![
            libc::proc_fdinfo {
                proc_fd: 0,
                proc_fdtype: 0
            };
            capacity
        ];
        let bytes = c_int::try_from(capacity * size_of::<libc::proc_fdinfo>())
            .map_err(|_| io::Error::other("descriptor listing too large"))?;
        // SAFETY: `entries` holds `bytes` bytes. The call writes at most that
        // many and keeps no pointer to the buffer.
        #[allow(unsafe_code)]
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                entries.as_mut_ptr().cast(),
                bytes,
            )
        };
        if written <= 0 {
            return Err(os_error());
        }
        let count = usize::try_from(written).unwrap_or(0) / size_of::<libc::proc_fdinfo>();
        if count < capacity {
            entries.truncate(count);
            break entries;
        }
        capacity *= 2;
    };
    for entry in descriptors.iter().filter(|entry| entry.proc_fd > 2) {
        // SAFETY: fcntl with F_GETFD and F_SETFD reads and writes descriptor
        // flags only.
        #[allow(unsafe_code)]
        let flags = unsafe { libc::fcntl(entry.proc_fd, libc::F_GETFD) };
        if flags < 0 {
            let error = os_error();
            // Closed since the listing.
            if is(&error, libc::EBADF) {
                continue;
            }
            return Err(error);
        }
        // SAFETY: As above.
        #[allow(unsafe_code)]
        if unsafe { libc::fcntl(entry.proc_fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(os_error());
        }
    }
    Ok(())
}

pub fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl with F_GETFL and F_SETFL reads and writes file status
    // flags only.
    #[allow(unsafe_code)]
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(os_error());
    }
    // SAFETY: As above.
    #[allow(unsafe_code)]
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(os_error());
    }
    Ok(())
}

/// Waits up to `timeout` for `read` to have input or a hangup and for `write`
/// to accept output. Returns (readable, writable). A signal ends the wait early.
pub fn poll(
    read: Option<RawFd>,
    write: Option<RawFd>,
    timeout: Duration,
) -> io::Result<(bool, bool)> {
    let mut fds = [
        libc::pollfd {
            fd: read.unwrap_or(-1),
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: write.unwrap_or(-1),
            events: libc::POLLOUT,
            revents: 0,
        },
    ];
    let milliseconds = c_int::try_from(timeout.as_millis()).unwrap_or(c_int::MAX);
    // SAFETY: `fds` holds two pollfd records, and poll ignores those whose fd
    // is negative.
    #[allow(unsafe_code)]
    let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, milliseconds) };
    if ready < 0 {
        let error = os_error();
        return if is(&error, libc::EINTR) {
            Ok((false, false))
        } else {
            Err(error)
        };
    }
    let done = libc::POLLHUP | libc::POLLERR | libc::POLLNVAL;
    Ok((
        read.is_some() && fds[0].revents & (libc::POLLIN | done) != 0,
        write.is_some() && fds[1].revents & (libc::POLLOUT | done) != 0,
    ))
}

pub fn read(fd: RawFd, buffer: &mut [u8]) -> io::Result<usize> {
    // SAFETY: `buffer` is valid for `buffer.len()` writable bytes.
    #[allow(unsafe_code)]
    let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
    if count < 0 {
        Err(os_error())
    } else {
        Ok(usize::try_from(count).unwrap_or(0))
    }
}

/// Writes `message` to stderr from the forked child, where only
/// async-signal-safe calls are certain to work.
fn report(message: &str) {
    // SAFETY: `message` is valid for its length. A failed diagnostic write
    // changes nothing the caller can act on, so its result is ignored.
    #[allow(unsafe_code)]
    let _ = unsafe { libc::write(2, message.as_ptr().cast(), message.len()) };
}

fn limit(resource: c_int, value: u64) -> io::Result<()> {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `current` is a valid rlimit for getrlimit to fill.
    #[allow(unsafe_code)]
    if unsafe { libc::getrlimit(resource, &mut current) } != 0 {
        return Err(os_error());
    }
    // An unprivileged process can lower its hard limit but never raise it.
    let value = value.min(current.rlim_max);
    let wanted = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: `wanted` is a valid rlimit that setrlimit only reads.
    #[allow(unsafe_code)]
    if unsafe { libc::setrlimit(resource, &wanted) } != 0 {
        return Err(os_error());
    }
    Ok(())
}

fn enter_sandbox(profile: &CStr) -> io::Result<()> {
    let mut error: *mut c_char = std::ptr::null_mut();
    // SAFETY: `profile` is NUL-terminated and outlives the call, and `error`
    // is a valid place for sandbox_init to store its error string.
    #[allow(unsafe_code)]
    if unsafe { sandbox_init(profile.as_ptr(), 0, &mut error) } == 0 {
        return Ok(());
    }
    report("The app compiler could not start its sandbox, so dohc did not build the app.\n");
    if !error.is_null() {
        // SAFETY: sandbox_init set `error` to a NUL-terminated string that
        // stays valid until sandbox_free_error.
        #[allow(unsafe_code)]
        unsafe {
            report(
                CStr::from_ptr(error)
                    .to_str()
                    .unwrap_or("unreadable sandbox error"),
            );
            report("\n");
            sandbox_free_error(error);
        }
    }
    Err(io::Error::from_raw_os_error(libc::EPERM))
}

/// Confines the child between fork and exec: no core file, a CPU-time limit
/// it keeps after the owner dies, then the Seatbelt profile. Any failure stops
/// the exec, so the worker never runs unconfined.
pub fn confine(command: &mut Command, profile: CString, cpu_seconds: u64) {
    // SAFETY: The closure runs in the forked child before exec. The owner has
    // a single thread, so no other thread can hold a lock that sandbox_init or
    // the allocator needs. The closure uses only `profile`, which it owns, and
    // values on its own stack.
    #[allow(unsafe_code)]
    unsafe {
        command.pre_exec(move || {
            let limited =
                limit(libc::RLIMIT_CORE, 0).and_then(|()| limit(libc::RLIMIT_CPU, cpu_seconds));
            if let Err(error) = limited {
                report(
                    "The app compiler could not set its limits, so dohc did not build the app.\n",
                );
                return Err(error);
            }
            enter_sandbox(&profile)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn an_unreaped_child_is_listed_but_never_live() {
        let mut child = Command::new("/usr/bin/true").spawn().unwrap();
        let pid = Pid::try_from(child.id()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while matches!(state(pid).unwrap(), State::Live(_)) {
            assert!(Instant::now() < deadline, "the child never exited");
            std::thread::sleep(Duration::from_millis(5));
        }
        // Exited but not reaped: still a child in the table, gone to the census.
        assert!(children(std::process::id() as Pid).unwrap().contains(&pid));
        child.wait().unwrap();
        assert!(!children(std::process::id() as Pid).unwrap().contains(&pid));
        assert!(matches!(state(pid).unwrap(), State::Gone));
    }

    #[test]
    fn reads_this_process_in_its_group_with_a_footprint() {
        // SAFETY: getpgrp takes no arguments.
        #[allow(unsafe_code)]
        let group = unsafe { libc::getpgrp() };
        let pid = std::process::id() as Pid;
        assert!(group_members(group).unwrap().contains(&pid));
        assert!(matches!(state(pid).unwrap(), State::Live(identity) if identity.pid == pid));
        assert!(footprint(pid).unwrap().unwrap() > 0);
    }

    #[test]
    fn a_profile_the_kernel_rejects_stops_the_exec() {
        let mut command = Command::new("/usr/bin/true");
        command.stderr(std::process::Stdio::null());
        confine(
            &mut command,
            CString::new("(version 1)(not sbpl").unwrap(),
            10,
        );
        assert!(command.spawn().is_err());
    }
}
