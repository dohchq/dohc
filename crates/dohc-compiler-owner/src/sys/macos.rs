//! The macOS process table, descriptors and Seatbelt, through libproc and
//! libSystem.
use super::{Identity, Pid, State, is, limit, os_error, report};
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::io;
use std::mem::{MaybeUninit, size_of};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

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

/// One: the user's process limit on macOS counts processes, whatever their
/// threads.
pub fn threads(_pid: Pid) -> io::Result<u64> {
    Ok(1)
}

/// The Seatbelt profile, as SBPL source.
pub type Sandbox = CString;

/// The profile for one build.
pub fn sandbox(root: &Path, node: &Path, build: &Path) -> Result<Sandbox, String> {
    crate::profile::profile(root, node, build)
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
pub fn confine(command: &mut Command, profile: Sandbox, cpu_seconds: u64) {
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

    /// Whether one sysctl answers, by name or as a MIB.
    fn sysctl_answers(name: &str) -> &'static str {
        let mut buffer = vec![0u8; 1 << 22];
        let mut size: libc::size_t = buffer.len();
        let result = if name == "kern.proc.all" {
            let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_ALL];
            // SAFETY: `mib` holds three integers and `buffer` holds `size`
            // writable bytes. The call keeps no pointer to either.
            #[allow(unsafe_code)]
            unsafe {
                libc::sysctl(
                    mib.as_mut_ptr(),
                    3,
                    buffer.as_mut_ptr().cast(),
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                )
            }
        } else {
            let name = CString::new(name).unwrap();
            // SAFETY: `name` is NUL-terminated, and `buffer` holds `size`
            // writable bytes. The call keeps no pointer to either.
            #[allow(unsafe_code)]
            unsafe {
                libc::sysctlbyname(
                    name.as_ptr(),
                    buffer.as_mut_ptr().cast(),
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                )
            }
        };
        match result {
            0 => "read",
            _ if is(&os_error(), libc::EPERM) => "refused",
            _ => "failed",
        }
    }

    const PROBE: &str = "DOHC_COMPILER_OWNER_SYSCTL_PROBE";
    const SYSCTLS: [&str; 6] = [
        "hw.ncpu",
        "kern.osrelease",
        "kern.hostname",
        "kern.uuid",
        "kern.boottime",
        "kern.proc.all",
    ];

    #[test]
    fn a_confined_child_reads_only_the_sysctls_node_needs() {
        // The re-executed copy below runs inside the sandbox and reports.
        if std::env::var_os(PROBE).is_some() {
            for name in SYSCTLS {
                println!("probe {name}={}", sysctl_answers(name));
            }
            std::process::exit(0);
        }
        let me = std::env::current_exe().unwrap().canonicalize().unwrap();
        let build =
            std::env::temp_dir().join(format!("dohc-compiler-owner-probe-{}", std::process::id()));
        std::fs::create_dir_all(&build).unwrap();
        let build = build.canonicalize().unwrap();
        // The test binary stands in for Node: it is the one program the profile lets run.
        let profile = crate::profile::profile(me.parent().unwrap(), &me, &build).unwrap();
        let mut command = Command::new(&me);
        command
            .args([
                "--exact",
                "sys::macos::tests::a_confined_child_reads_only_the_sysctls_node_needs",
                "--test-threads=1",
                "--nocapture",
            ])
            .env(PROBE, "1");
        confine(&mut command, profile, 10);
        let output = command.output().unwrap();
        std::fs::remove_dir_all(&build).unwrap();
        let report: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            // libtest may print its own "test ... " before the first line.
            .filter_map(|line| {
                line.split_once("probe ")
                    .map(|(_, report)| report.to_owned())
            })
            .collect();
        assert_eq!(
            report,
            [
                "hw.ncpu=read",
                "kern.osrelease=read",
                "kern.hostname=read",
                "kern.uuid=refused",
                "kern.boottime=refused",
                "kern.proc.all=refused"
            ]
        );
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
