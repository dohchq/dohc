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

/// Reaps every exited child of the owner but `worker`, which stays for
/// `Child::try_wait`. The owner adopts every orphan, so without this a loop of
/// short-lived processes could hold the user's pids as zombies until
/// teardown.
pub fn reap_adopted(worker: Pid) -> io::Result<()> {
    // SAFETY: getpid takes no arguments.
    #[allow(unsafe_code)]
    let owner = unsafe { libc::getpid() };
    for pid in children(owner)?.into_iter().filter(|&pid| pid != worker) {
        let mut status: c_int = 0;
        // SAFETY: `status` is a valid c_int for waitpid to fill. WNOHANG
        // never blocks, and a child still running is left alone.
        #[allow(unsafe_code)]
        unsafe {
            libc::waitpid(pid, &mut status, libc::WNOHANG)
        };
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
        // A leader that exited before its other threads reads as a zombie,
        // but the process lives until its last thread ends.
        Some(&("Z" | "X")) if threads(pid)? <= 1 => return Ok(State::Gone),
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
    let tasks = match std::fs::read_dir(format!("/proc/{pid}/task")) {
        Ok(tasks) => tasks,
        Err(error) if gone(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    // Every thread shares the process's memory. A leader that exited before
    // the others reports none, so the first thread that reports it counts.
    for task in tasks {
        let status = match task.and_then(|task| std::fs::read_to_string(task.path().join("status")))
        {
            Ok(status) => status,
            Err(error) if gone(&error) => continue,
            Err(error) => return Err(error),
        };
        if let Some(kilobytes) = resident_kilobytes(&status)? {
            return Ok(Some(kilobytes.saturating_mul(1024)));
        }
    }
    Ok(Some(0))
}

/// RssAnon plus RssShmem, or None when the status shows no memory.
fn resident_kilobytes(status: &str) -> io::Result<Option<u64>> {
    let mut kilobytes = None;
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
        kilobytes = Some(kilobytes.unwrap_or(0u64).saturating_add(value));
    }
    Ok(kilobytes)
}

/// How many threads /proc lists for `pid`, each one of the user's task
/// slots. 0 once it is gone.
pub fn threads(pid: Pid) -> io::Result<u64> {
    match std::fs::read_dir(format!("/proc/{pid}/task")) {
        Ok(tasks) => Ok(tasks.count() as u64),
        Err(error) if gone(&error) => Ok(0),
        Err(error) => Err(error),
    }
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

pub fn sandbox(root: &Path, node: &Path, build: &Path) -> Result<Sandbox, String> {
    crate::rules::rules(root, node, build)
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
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

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
        let unrelated: Pid = std::env::var("DOHC_PROBE_UNRELATED")
            .unwrap()
            .parse()
            .unwrap();
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
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&program)
            .and_then(|mut file| file.write_all(b"#!/bin/sh\n"));
        report("write program", io_outcome(written));
        report(
            "run from build",
            io_outcome(Command::new(&program).status()),
        );
        report("run system", io_outcome(Command::new("/bin/true").status()));
        let environ = format!("/proc/{owner}/environ");
        report("read owner environ", io_outcome(std::fs::read(environ)));
        let secret = outside.join("secret");
        let mode = std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000));
        report("chmod outside", io_outcome(mode));
        report(
            "chown outside",
            io_outcome(std::os::unix::fs::chown(&secret, None, None)),
        );
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
            let path = std::ffi::CString::new(secret.as_os_str().as_encoded_bytes()).unwrap();
            report(
                "truncate outside",
                outcome(libc::truncate(path.as_ptr(), 0)),
            );
            let name = c"user.dohc";
            let attribute = libc::getxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0);
            report("read attributes outside", outcome(attribute as c_int));
            let memory = libc::shmget(libc::IPC_PRIVATE, 4096, libc::IPC_CREAT | 0o600);
            report("System V memory", outcome(memory));
            report("watch a path", outcome(libc::inotify_init1(0)));
            let flags = (libc::CLONE_NEWUSER | libc::SIGCHLD) as libc::c_ulong;
            let cloned = libc::syscall(libc::SYS_clone, flags, 0, 0, 0, 0);
            if cloned == 0 {
                libc::_exit(0);
            }
            report("new namespace", outcome(cloned as c_int));
            let cloned = libc::syscall(libc::SYS_clone3, std::ptr::null_mut::<u8>(), 0);
            report("clone3", outcome(cloned as c_int));
            // file_setattr, from Linux 6.17, and a number no kernel has yet.
            let attributes = libc::syscall(469, libc::AT_FDCWD, path.as_ptr(), 0, 0, 0);
            report("file attributes", outcome(attributes as c_int));
            report("newer call", outcome(libc::syscall(1000) as c_int));
            // glibc's mq_unlink turns EPERM into EACCES, so this asks the kernel.
            let unlinked = libc::syscall(libc::SYS_mq_unlink, c"dohc".as_ptr());
            report("remove a queue", outcome(unlinked as c_int));
            report("signal owner", outcome(libc::kill(owner, 0)));
            report("signal own group", outcome(libc::kill(0, 0)));
            report("signal everyone", outcome(libc::kill(-1, 0)));
            report("signal unrelated", outcome(libc::kill(unrelated, 0)));
            report("signal self", outcome(libc::kill(libc::getpid(), 0)));
            let mut limits = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            let owner_limits =
                libc::prlimit(owner, libc::RLIMIT_NOFILE, std::ptr::null(), &mut limits);
            report("owner limits", outcome(owner_limits));
            let own_limits = libc::prlimit(0, libc::RLIMIT_NOFILE, std::ptr::null(), &mut limits);
            report("own limits", outcome(own_limits));
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
        let sandbox = sandbox(&root, &me, &build).unwrap();
        // Another process of the same user, outside the tree.
        let mut unrelated = Command::new("sleep").arg("30").spawn().unwrap();
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
            .env("DOHC_PROBE_UNRELATED", unrelated.id().to_string())
            .env("TMPDIR", std::env::temp_dir());
        confine(&mut command, sandbox, 10);
        let output = command.output().unwrap();
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        let untouched = std::fs::metadata(outside.join("secret")).unwrap();
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
                "chmod outside=EPERM",
                "chown outside=EPERM",
                "tcp socket=EPERM",
                "unix socket=EPERM",
                "socketpair=done",
                "truncate outside=EPERM",
                "read attributes outside=EPERM",
                "System V memory=EPERM",
                "watch a path=EPERM",
                "new namespace=EPERM",
                "clone3=ENOSYS",
                "file attributes=EPERM",
                "newer call=ENOSYS",
                "remove a queue=EPERM",
                "signal owner=EPERM",
                "signal own group=EPERM",
                "signal everyone=EPERM",
                "signal unrelated=EPERM",
                "signal self=EPERM",
                "owner limits=EPERM",
                "own limits=done",
                "own async signals=EPERM",
                "io_uring=ENOSYS",
            ],
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // The refused calls left the outside file's length and mode alone.
        assert_eq!(untouched.len(), 1);
        assert_ne!(untouched.permissions().mode() & 0o777, 0);
    }

    #[test]
    fn a_missing_program_stops_the_rules() {
        let missing = Path::new("/nonexistent/dohc-compiler-owner");
        assert!(sandbox(missing, missing, missing).is_err());
    }

    /// Runs in a forked owner, so its reaping cannot touch another test's
    /// children. 0 when the adopted zombie is reaped and the worker is not.
    fn reap_around_the_worker() -> c_int {
        // SAFETY: Each forked child only exits. waitpid fills a valid c_int.
        #[allow(unsafe_code)]
        unsafe {
            let adopted = libc::fork();
            if adopted == 0 {
                libc::_exit(0);
            }
            let worker = libc::fork();
            if worker == 0 {
                libc::_exit(0);
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            while [adopted, worker]
                .iter()
                .any(|&pid| !matches!(state(pid), Ok(State::Gone)))
            {
                if Instant::now() >= deadline {
                    return 2;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            if reap_adopted(worker).is_err() {
                return 3;
            }
            let mut status: c_int = 0;
            let adopted_reaped = libc::waitpid(adopted, &mut status, libc::WNOHANG) == -1;
            let worker_left = libc::waitpid(worker, &mut status, libc::WNOHANG) == worker;
            if adopted_reaped && worker_left { 0 } else { 1 }
        }
    }

    #[test]
    fn the_owner_reaps_an_exited_child_but_not_the_worker() {
        // SAFETY: The forked child runs `reap_around_the_worker` and exits
        // without returning into the test.
        #[allow(unsafe_code)]
        let owner = unsafe { libc::fork() };
        if owner == 0 {
            let code = reap_around_the_worker();
            // SAFETY: _exit takes an integer and never returns.
            #[allow(unsafe_code)]
            unsafe {
                libc::_exit(code)
            }
        }
        let mut status: c_int = 0;
        // SAFETY: `status` is a valid c_int for waitpid to fill.
        #[allow(unsafe_code)]
        let reaped = unsafe { libc::waitpid(owner, &mut status, 0) };
        assert_eq!(reaped, owner);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }

    extern "C" fn sleep_then_exit(_: *mut libc::c_void) -> *mut libc::c_void {
        // SAFETY: sleep and _exit take integers only.
        #[allow(unsafe_code)]
        unsafe {
            libc::sleep(30);
            libc::_exit(0)
        }
    }

    #[test]
    fn a_process_whose_first_thread_exited_reads_live_until_its_last_ends() {
        // SAFETY: The forked child calls only pthread_create, which glibc
        // supports after fork, and the exit syscall, which ends the calling
        // thread without unwinding into the test.
        #[allow(unsafe_code)]
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            // SAFETY: `thread` is a valid place for the new thread's id, and
            // `sleep_then_exit` matches the start routine pthread_create takes.
            #[allow(unsafe_code)]
            unsafe {
                let mut thread: libc::pthread_t = 0;
                libc::pthread_create(
                    &mut thread,
                    std::ptr::null(),
                    sleep_then_exit,
                    std::ptr::null_mut(),
                );
                libc::syscall(libc::SYS_exit, 0);
            }
        }
        assert!(pid > 0);
        let first_exited = || {
            std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                stat.rsplit_once(')')
                    .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z'))
            })
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !first_exited() {
            assert!(Instant::now() < deadline, "the first thread never exited");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(matches!(state(pid).unwrap(), State::Live(identity) if identity.pid == pid));
        assert!(footprint(pid).unwrap().unwrap() > 0);
        assert!(matches!(
            super::super::kill(pid).unwrap(),
            super::super::Signalled::Sent
        ));
        let mut status: c_int = 0;
        // SAFETY: `status` is a valid c_int for waitpid to fill.
        #[allow(unsafe_code)]
        let reaped = unsafe { libc::waitpid(pid, &mut status, 0) };
        assert_eq!(reaped, pid);
        assert!(matches!(state(pid).unwrap(), State::Gone));
    }
}
