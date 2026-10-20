//! Every system call the owner makes: the POSIX calls both platforms share
//! here, and the process table, descriptor listing and sandbox in `macos` and
//! `linux`. No other module may use `unsafe`.
use std::ffi::c_int;
use std::io;
use std::os::fd::RawFd;
use std::time::Duration;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(target_os = "macos")]
pub use macos::*;

pub type Pid = libc::pid_t;

/// A process with its start time, so a reused pid never matches it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Identity {
    pub pid: Pid,
    pub started: (u64, u64),
}

/// A zombie reads as gone: it holds no memory, runs nothing, and keeps its pid
/// until its parent reaps it.
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

/// Collects every exited child of the owner, so none stays a zombie in its
/// group. True while the owner still has a child, or may have one.
pub fn reap_children() -> bool {
    loop {
        let mut status: c_int = 0;
        // SAFETY: `status` is a valid c_int for the call to fill. WNOHANG
        // never blocks.
        #[allow(unsafe_code)]
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        // 0: a child lives. -1: no children left, or a signal; the teardown
        // loop calls again.
        if pid == 0 {
            return true;
        }
        if pid < 0 {
            return !is(&os_error(), libc::ECHILD);
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

#[derive(Clone, Copy)]
pub enum Wait {
    Read,
    Write,
}

/// Waits up to `timeout` for any listed descriptor. Each answer is true when
/// that descriptor has input or a hangup (`Read`) or accepts output
/// (`Write`). A negative descriptor never answers. A signal ends the wait
/// early with every answer false.
pub fn poll(watch: &[(RawFd, Wait)], timeout: Duration) -> io::Result<Vec<bool>> {
    let mut fds: Vec<libc::pollfd> = watch
        .iter()
        .map(|&(fd, wait)| libc::pollfd {
            fd,
            events: match wait {
                Wait::Read => libc::POLLIN,
                Wait::Write => libc::POLLOUT,
            },
            revents: 0,
        })
        .collect();
    let count =
        libc::nfds_t::try_from(fds.len()).map_err(|_| io::Error::other("too many descriptors"))?;
    let milliseconds = c_int::try_from(timeout.as_millis()).unwrap_or(c_int::MAX);
    // SAFETY: `fds` holds `count` pollfd records, and poll ignores those
    // whose fd is negative.
    #[allow(unsafe_code)]
    let ready = unsafe { libc::poll(fds.as_mut_ptr(), count, milliseconds) };
    if ready < 0 {
        let error = os_error();
        return if is(&error, libc::EINTR) {
            Ok(vec![false; fds.len()])
        } else {
            Err(error)
        };
    }
    let done = libc::POLLHUP | libc::POLLERR | libc::POLLNVAL;
    Ok(fds
        .iter()
        .map(|fd| fd.fd >= 0 && fd.revents & (fd.events | done) != 0)
        .collect())
}

/// Whether `fd` is an open descriptor.
pub fn is_open(fd: RawFd) -> bool {
    // SAFETY: fcntl with F_GETFD reads descriptor flags only.
    #[allow(unsafe_code)]
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    flags >= 0
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

/// The type glibc gives a resource limit's name. Elsewhere it is an int.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
type Resource = libc::__rlimit_resource_t;
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
type Resource = c_int;

fn limit(resource: Resource, value: u64) -> io::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
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
    fn reads_this_process_with_a_footprint() {
        let pid = std::process::id() as Pid;
        assert!(matches!(state(pid).unwrap(), State::Live(identity) if identity.pid == pid));
        assert!(footprint(pid).unwrap().unwrap() > 0);
    }
}
