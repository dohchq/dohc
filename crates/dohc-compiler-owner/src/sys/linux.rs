//! The Linux process table through /proc, the owner's descriptors, and the
//! confinement of the worker with the rules `rules.rs` builds.
use super::{Identity, Pid, State, is, limit, os_error, report};
use std::ffi::c_int;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

/// ENOENT or ESRCH: the process or thread exited.
fn gone(error: &io::Error) -> bool {
    is(error, libc::ENOENT) || is(error, libc::ESRCH)
}

/// Makes the owner a child subreaper, so an orphaned descendant becomes the
/// owner's child instead of init's. Every process the build started then
/// stays reachable through `children`, including one that left the owner's
/// group with setsid. Fails on a kernel without the per-thread children
/// lists the owner walks.
pub fn adopt_orphans() -> io::Result<()> {
    std::fs::metadata("/proc/thread-self/children").map_err(|error| {
        io::Error::other(format!(
            "/proc/thread-self/children: {error}. The app compiler needs a kernel built with CONFIG_PROC_CHILDREN."
        ))
    })?;
    // SAFETY: PR_SET_CHILD_SUBREAPER takes integers and touches no memory of ours.
    #[allow(unsafe_code)]
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(os_error());
    }
    Ok(())
}

/// None on Linux. The owner adopts every orphan, so `children` reaches the
/// whole tree, and a group walk would read the whole process table on every
/// sample.
pub fn group_members(_group: Pid) -> io::Result<Vec<Pid>> {
    Ok(Vec::new())
}

/// Every process whose parent is `parent`, zombies included, from each of
/// its threads' children lists. The kernel builds each list without one lock,
/// so a fork or exit during the read can hide a process from it. The census
/// looks again on the next sample, and teardown also waits until the owner
/// has no child left.
pub fn children(parent: Pid) -> io::Result<Vec<Pid>> {
    let tasks = match std::fs::read_dir(format!("/proc/{parent}/task")) {
        Ok(tasks) => tasks,
        Err(error) if gone(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut pids = Vec::new();
    for task in tasks {
        let task = match task {
            Ok(task) => task,
            Err(error) if gone(&error) => continue,
            Err(error) => return Err(error),
        };
        let list = match std::fs::read_to_string(task.path().join("children")) {
            Ok(list) => list,
            // The thread exited. `adopt_orphans` proved the lists exist.
            Err(error) if gone(&error) => continue,
            Err(error) => return Err(error),
        };
        for pid in list.split_ascii_whitespace() {
            pids.push(
                pid.parse()
                    .map_err(|_| io::Error::other("unreadable children list"))?,
            );
        }
    }
    Ok(pids)
}

pub fn state(pid: Pid) -> io::Result<State> {
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if gone(&error) => return Ok(State::Gone),
        Err(error) => return Err(error),
    };
    // The command name may hold spaces and parentheses, so the fields after
    // it count from the last ')'. They start at the state, field 3 of proc(5).
    let fields: Vec<&str> = stat
        .rsplit_once(')')
        .map(|(_, rest)| rest.split_ascii_whitespace().collect())
        .unwrap_or_default();
    match fields.first() {
        Some(&("Z" | "X")) => return Ok(State::Gone),
        Some(_) => {}
        None => return Err(io::Error::other("unreadable process status")),
    }
    // Field 22: the start time, in clock ticks since boot.
    let started = fields
        .get(19)
        .and_then(|ticks| ticks.parse::<u64>().ok())
        .ok_or_else(|| io::Error::other("unreadable process start time"))?;
    Ok(State::Live(Identity {
        pid,
        started: (started, 0),
    }))
}

/// The resident memory `pid` holds that no file backs: its anonymous pages
/// and its shared memory, the closest Linux figure to the macOS physical
/// footprint. Node's binary and the shared libraries stay out. None once the
/// process is gone.
pub fn footprint(pid: Pid) -> io::Result<Option<u64>> {
    let status = match std::fs::read_to_string(format!("/proc/{pid}/status")) {
        Ok(status) => status,
        Err(error) if gone(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut kilobytes: u64 = 0;
    for line in status.lines() {
        let Some(value) = line
            .strip_prefix("RssAnon:")
            .or_else(|| line.strip_prefix("RssShmem:"))
        else {
            continue;
        };
        let value = value
            .trim()
            .strip_suffix(" kB")
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| io::Error::other("unreadable process memory"))?;
        kilobytes = kilobytes.saturating_add(value);
    }
    Ok(Some(kilobytes.saturating_mul(1024)))
}

/// Marks every descriptor above stderr close-on-exec, so the worker inherits
/// only stdin, stdout and stderr whatever the desktop left open.
pub fn close_inherited_descriptors_on_exec() -> io::Result<()> {
    let mut descriptors: Vec<c_int> = Vec::new();
    for entry in std::fs::read_dir("/proc/self/fd")? {
        if let Some(fd) = entry?.file_name().to_str().and_then(|fd| fd.parse().ok()) {
            descriptors.push(fd);
        }
    }
    for fd in descriptors.into_iter().filter(|&fd| fd > 2) {
        // SAFETY: fcntl with F_GETFD and F_SETFD reads and writes descriptor
        // flags only.
        #[allow(unsafe_code)]
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            let error = os_error();
            // Closed since the listing, like the listing's own descriptor.
            if is(&error, libc::EBADF) {
                continue;
            }
            return Err(error);
        }
        // SAFETY: As above.
        #[allow(unsafe_code)]
        if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(os_error());
        }
    }
    Ok(())
}

/// The Landlock ruleset and seccomp filters, built before the fork.
pub type Sandbox = crate::rules::Rules;

pub fn sandbox(root: &Path, node: &Path, build: &Path, owner: Pid) -> Result<Sandbox, String> {
    crate::rules::rules(root, node, build, owner)
}

/// Confines the child between fork and exec: no core file, a CPU-time limit
/// it keeps after the owner dies, death when the owner dies, then the
/// Landlock rules and seccomp filters. Any failure stops the exec, so the
/// worker never runs unconfined.
pub fn confine(command: &mut Command, sandbox: Sandbox, cpu_seconds: u64) {
    // SAFETY: getpid takes no arguments.
    #[allow(unsafe_code)]
    let owner = unsafe { libc::getpid() };
    let mut sandbox = Some(sandbox);
    // SAFETY: The closure runs in the forked child before exec. The owner has
    // a single thread, so no other thread can hold a lock that the allocator
    // or the rules need. The closure uses only `sandbox`, which it owns, and
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
            // The owner may have died before the signal was armed.
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0
                || libc::getppid() != owner
            {
                report("The app compiler owner is gone, so dohc did not build the app.\n");
                return Err(io::Error::from_raw_os_error(libc::ESRCH));
            }
            let applied = sandbox
                .take()
                .ok_or_else(|| "the sandbox was already used".to_owned())
                .and_then(crate::rules::Rules::apply);
            if let Err(problem) = applied {
                report("The app compiler could not start its sandbox, so dohc did not build the app.\n");
                report(&problem);
                report("\n");
                return Err(io::Error::from_raw_os_error(libc::EPERM));
            }
            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const PROBE: &str = "DOHC_COMPILER_OWNER_RULES_PROBE";

    /// What one attempt got: done, or the errno name that stopped it.
    fn outcome(result: c_int) -> &'static str {
        if result >= 0 {
            return "done";
        }
        match io::Error::last_os_error().raw_os_error() {
            Some(libc::EACCES) => "EACCES",
            Some(libc::EPERM) => "EPERM",
            Some(libc::ENOSYS) => "ENOSYS",
            _ => "failed",
        }
    }

    fn io_outcome<T>(result: io::Result<T>) -> &'static str {
        match result {
            Ok(_) => "done",
            Err(error) if is(&error, libc::EACCES) => "EACCES",
            Err(error) if is(&error, libc::EPERM) => "EPERM",
            Err(_) => "failed",
        }
    }

    /// Runs inside the sandbox: tries what the rules allow and what they refuse.
    fn probe(root: &Path, build: &Path, outside: &Path) {
        let owner: Pid = std::env::var("DOHC_PROBE_OWNER").unwrap().parse().unwrap();
        let report = |name: &str, result: &str| println!("probe {name}={result}");
        report(
            "read root",
            io_outcome(std::fs::read(root.join("readable"))),
        );
        report(
            "write build",
            io_outcome(std::fs::write(build.join("out"), b"x")),
        );
        report(
            "read outside",
            io_outcome(std::fs::read(outside.join("secret"))),
        );
        report(
            "write outside",
            io_outcome(std::fs::write(outside.join("new"), b"x")),
        );
        let program = build.join("program");
        let written = std::fs::write(&program, b"#!/bin/sh\n").and_then(|()| {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755))
        });
        report("write program", io_outcome(written));
        report(
            "run from build",
            io_outcome(Command::new(&program).status()),
        );
        report("run system", io_outcome(Command::new("/bin/true").status()));
        let environ = format!("/proc/{owner}/environ");
        report("read owner environ", io_outcome(std::fs::read(environ)));
        // SAFETY: Each call takes integers or a valid array, and every
        // descriptor it returns is closed with the process.
        #[allow(unsafe_code)]
        unsafe {
            report(
                "tcp socket",
                outcome(libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0)),
            );
            report(
                "unix socket",
                outcome(libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0)),
            );
            let mut pair = [0 as c_int; 2];
            let made = libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, pair.as_mut_ptr());
            report("socketpair", outcome(made));
            report("signal owner", outcome(libc::kill(owner, 0)));
            report("signal own group", outcome(libc::kill(0, 0)));
            report("signal everyone", outcome(libc::kill(-1, 0)));
            report("signal self", outcome(libc::kill(libc::getpid(), 0)));
            let mut limits = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            let owner_limits =
                libc::prlimit(owner, libc::RLIMIT_NOFILE, std::ptr::null(), &mut limits);
            report("owner limits", outcome(owner_limits));
            report(
                "own async signals",
                outcome(libc::fcntl(pair[0], libc::F_SETOWN, owner)),
            );
            let ring = libc::syscall(libc::SYS_io_uring_setup, 1, std::ptr::null_mut::<u8>());
            report("io_uring", outcome(c_int::try_from(ring).unwrap_or(-1)));
        }
    }

    #[test]
    fn the_rules_keep_a_confined_child_to_its_build() {
        // The probe names its folders after the owner, the test process.
        let owner: Pid = std::env::var("DOHC_PROBE_OWNER")
            .ok()
            .and_then(|owner| owner.parse().ok())
            .unwrap_or(std::process::id() as Pid);
        let scratch = |name: &str| {
            let path =
                std::env::temp_dir().join(format!("dohc-compiler-owner-rules-{name}-{owner}"));
            if std::env::var_os(PROBE).is_none() {
                let _ = std::fs::remove_dir_all(&path);
                std::fs::create_dir_all(&path).unwrap();
            }
            path.canonicalize().unwrap()
        };
        let (root, build, outside) = (scratch("root"), scratch("build"), scratch("outside"));
        // The re-executed copy below runs inside the sandbox and reports.
        if std::env::var_os(PROBE).is_some() {
            probe(&root, &build, &outside);
            std::process::exit(0);
        }
        std::fs::write(root.join("readable"), b"x").unwrap();
        std::fs::write(outside.join("secret"), b"x").unwrap();
        let esbuild: PathBuf = root.join(crate::rules::ESBUILD);
        std::fs::create_dir_all(esbuild.parent().unwrap()).unwrap();
        std::fs::copy("/bin/true", &esbuild).unwrap();
        // The test binary stands in for Node: it is the one program, with
        // esbuild, that the rules let run.
        let me = std::env::current_exe().unwrap().canonicalize().unwrap();
        let sandbox = sandbox(&root, &me, &build, owner).unwrap();
        let mut command = Command::new(&me);
        command
            .args([
                "--exact",
                "sys::linux::tests::the_rules_keep_a_confined_child_to_its_build",
                "--test-threads=1",
                "--nocapture",
            ])
            .env(PROBE, "1")
            .env("DOHC_PROBE_OWNER", owner.to_string())
            .env("TMPDIR", std::env::temp_dir());
        confine(&mut command, sandbox, 10);
        let output = command.output().unwrap();
        for path in [&root, &build, &outside] {
            std::fs::remove_dir_all(path).unwrap();
        }
        let report: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                line.split_once("probe ")
                    .map(|(_, report)| report.to_owned())
            })
            .collect();
        assert_eq!(
            report,
            [
                "read root=done",
                "write build=done",
                "read outside=EACCES",
                "write outside=EACCES",
                "write program=done",
                "run from build=EACCES",
                "run system=EACCES",
                "read owner environ=EACCES",
                "tcp socket=EPERM",
                "unix socket=EPERM",
                "socketpair=done",
                "signal owner=EPERM",
                "signal own group=EPERM",
                "signal everyone=EPERM",
                "signal self=done",
                "owner limits=EPERM",
                "own async signals=EPERM",
                "io_uring=ENOSYS",
            ],
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn a_missing_program_stops_the_rules() {
        let missing = Path::new("/nonexistent/dohc-compiler-owner");
        assert!(sandbox(missing, missing, missing, 1).is_err());
    }
}
