//! The Landlock rules and seccomp filters that confine the worker and esbuild
//! on Linux, in place of the macOS Seatbelt profile.
//!
//! The tree may execute only the installed Node, esbuild and the dynamic
//! loader, read those, the compiler root and the system libraries, and read
//! and write its own build directory, where it can execute nothing. Through
//! the loader or a memory file, code it already runs can start other code,
//! still under these rules. It cannot open a socket, so it has no network and
//! cannot reach D-Bus or any other local service. It cannot signal any
//! process, trace one or change its limits, even on a kernel too old for
//! Landlock to scope signals, and cannot change a file's mode, owner,
//! attributes or times. Path metadata stays readable everywhere, as on macOS,
//! because Landlock does not mediate reading it.
//! See docs/engineering/app-compiler.md.
use landlock::{
    ABI, Access, AccessFs, AccessNet, BitFlags, CompatLevel, Compatible, PathBeneath, PathFd,
    Ruleset, RulesetAttr, RulesetCreated, RulesetCreatedAttr, RulesetStatus, Scope,
};
use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The staged esbuild binary.
#[cfg(target_arch = "x86_64")]
pub const ESBUILD: &str = "node_modules/@esbuild/linux-x64/bin/esbuild";
#[cfg(target_arch = "aarch64")]
pub const ESBUILD: &str = "node_modules/@esbuild/linux-arm64/bin/esbuild";

/// The dynamic loader Node's binary names. The kernel opens it for execution
/// with Node, so it needs the same right.
#[cfg(target_arch = "x86_64")]
const LOADER: &str = "/lib64/ld-linux-x86-64.so.2";
#[cfg(target_arch = "aarch64")]
const LOADER: &str = "/lib/ld-linux-aarch64.so.1";

/// The system library directories Node links from. Missing ones are skipped.
const LIBRARIES: [&str; 4] = ["/lib", "/lib64", "/usr/lib", "/usr/lib64"];

pub struct Rules {
    landlock: RulesetCreated,
    /// Applied in order. The first answers ENOSYS, the second EPERM.
    seccomp: [BpfProgram; 2],
}

impl Rules {
    /// Confines the calling process and everything it starts. Runs in the
    /// forked child before exec.
    pub fn apply(self) -> Result<(), String> {
        let status = self
            .landlock
            .restrict_self()
            .map_err(|error| format!("Landlock: {error}"))?;
        if status.ruleset == RulesetStatus::NotEnforced || !status.no_new_privs {
            return Err("Landlock did not enforce the compiler rules.".to_owned());
        }
        for filter in &self.seccomp {
            seccompiler::apply_filter(filter).map_err(|error| format!("seccomp: {error}"))?;
        }
        Ok(())
    }
}

/// `root`, `node` and `build` must already be canonical.
pub fn rules(root: &Path, node: &Path, build: &Path) -> Result<Rules, String> {
    let landlock = landlock(root, node, build).map_err(|error| {
        format!("{error}. The app compiler needs Landlock, in Linux 5.13 or later with Landlock enabled.")
    })?;
    let seccomp = [
        absent_syscalls().map_err(|error| format!("seccomp: {error}"))?,
        refused_syscalls().map_err(|error| format!("seccomp: {error}"))?,
    ];
    Ok(Rules { landlock, seccomp })
}

fn landlock(root: &Path, node: &Path, build: &Path) -> Result<RulesetCreated, String> {
    let read = AccessFs::ReadFile | AccessFs::ReadDir;
    let run = AccessFs::ReadFile | AccessFs::Execute;
    let loader = std::fs::canonicalize(LOADER).map_err(|error| format!("{LOADER}: {error}"))?;
    let mut grants: Vec<(PathBuf, BitFlags<AccessFs>)> = vec![
        (root.to_owned(), read),
        (node.to_owned(), run),
        (loader, run),
        (
            build.to_owned(),
            AccessFs::from_all(ABI::V5) & !AccessFs::Execute,
        ),
        ("/dev/null".into(), AccessFs::ReadFile | AccessFs::WriteFile),
        ("/dev/random".into(), AccessFs::ReadFile.into()),
        ("/dev/urandom".into(), AccessFs::ReadFile.into()),
    ];
    // A compiler root without esbuild, as in the desktop's tests, runs none.
    // A system without a library folder or the loader cache needs no rule for it.
    let optional = [
        (root.join(ESBUILD), run),
        ("/etc/ld.so.cache".into(), AccessFs::ReadFile.into()),
    ]
    .into_iter()
    .chain(LIBRARIES.map(|library| (PathBuf::from(library), read)));
    grants.extend(optional.filter(|(path, _)| path.exists()));
    let error = |error: landlock::RulesetError| error.to_string();
    let mut rules = Ruleset::default()
        // The filesystem rights of the first Landlock ABI are required.
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(ABI::V1))
        .map_err(error)?
        // Later rights apply where the kernel has them: renames across
        // folders, truncation and device ioctls; TCP; signals and abstract
        // sockets outside the sandbox.
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(ABI::V5))
        .map_err(error)?
        .handle_access(AccessNet::from_all(ABI::V4))
        .map_err(error)?
        .scope(Scope::from_all(ABI::V6))
        .map_err(error)?
        .create()
        .map_err(error)?;
    for (path, access) in grants {
        let fd = PathFd::new(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        rules = rules
            .add_rule(PathBeneath::new(fd, access))
            .map_err(error)?;
    }
    Ok(rules)
}

/// The newest call these filters were written against: `file_setattr`, in
/// Linux 6.17. Any later call looks absent, so a kernel that adds one cannot
/// open a gap the filters do not know about.
const NEWEST_SYSCALL: u32 = 469;

/// Calls that look absent, so callers fall back to ones the next filter
/// checks. io_uring can open sockets and files without those calls, and
/// Node's libuv then uses ordinary ones. clone3 passes its flags in memory a
/// filter cannot read, and glibc then uses clone, whose flags it can. Calls
/// newer than `NEWEST_SYSCALL` look absent too.
fn absent_syscalls() -> Result<BpfProgram, Box<dyn std::error::Error>> {
    use libc::{ENOSYS, SYS_clone3, SYS_io_uring_enter, SYS_io_uring_register, SYS_io_uring_setup};
    let rules = [
        SYS_io_uring_setup,
        SYS_io_uring_enter,
        SYS_io_uring_register,
        SYS_clone3,
    ]
    .into_iter()
    .map(|syscall| (syscall, vec![]))
    .collect();
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(ENOSYS as u32),
        std::env::consts::ARCH.try_into()?,
    )?;
    use seccompiler::sock_filter;
    let mut guarded = vec![
        // Load the syscall number.
        sock_filter {
            code: 0x20,
            jt: 0,
            jf: 0,
            k: 0,
        },
        // Newer than the filters know.
        sock_filter {
            code: 0x25,
            jt: 0,
            jf: 1,
            k: NEWEST_SYSCALL,
        },
        sock_filter {
            code: 0x06,
            jt: 0,
            jf: 0,
            k: libc::SECCOMP_RET_ERRNO | ENOSYS as u32,
        },
    ];
    guarded.extend(BpfProgram::try_from(filter)?);
    Ok(guard_x32(guarded))
}

/// The calls the tree may not make, on any kernel. Landlock mediates neither
/// a file's mode, owner, extended attributes or times, nor truncation by path
/// before ABI 3, nor System V IPC, file watches or namespaces. The tree may
/// signal no process, itself included: Node and esbuild need no signal to
/// compile, the owner does all stopping, and seccomp cannot keep signals
/// inside the tree as Seatbelt does.
fn refused_syscalls() -> Result<BpfProgram, Box<dyn std::error::Error>> {
    use libc::*;
    // libc 0.2.189 omits these. Linux 6.6 through 6.17 number them alike on
    // every architecture.
    #[cfg(target_arch = "aarch64")]
    #[allow(non_upper_case_globals)]
    const SYS_fchmodat2: c_long = 452;
    #[allow(non_upper_case_globals)]
    const SYS_setxattrat: c_long = 463;
    #[allow(non_upper_case_globals)]
    const SYS_getxattrat: c_long = 464;
    #[allow(non_upper_case_globals)]
    const SYS_listxattrat: c_long = 465;
    #[allow(non_upper_case_globals)]
    const SYS_removexattrat: c_long = 466;
    #[allow(non_upper_case_globals)]
    const SYS_statmount: c_long = 457;
    #[allow(non_upper_case_globals)]
    const SYS_listmount: c_long = 458;
    #[allow(non_upper_case_globals)]
    const SYS_file_getattr: c_long = 468;
    #[allow(non_upper_case_globals)]
    const SYS_file_setattr: c_long = 469;
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    for syscall in [
        // No sockets at all. Node and esbuild talk over socketpair and pipes.
        SYS_socket,
        // Signals.
        SYS_kill,
        SYS_tkill,
        SYS_tgkill,
        SYS_rt_sigqueueinfo,
        SYS_rt_tgsigqueueinfo,
        SYS_pidfd_send_signal,
        // A file's mode, owner, attributes, times and length.
        SYS_fchmod,
        SYS_fchmodat,
        SYS_fchmodat2,
        SYS_fchown,
        SYS_fchownat,
        SYS_setxattr,
        SYS_lsetxattr,
        SYS_fsetxattr,
        SYS_removexattr,
        SYS_lremovexattr,
        SYS_fremovexattr,
        SYS_setxattrat,
        SYS_removexattrat,
        SYS_getxattr,
        SYS_lgetxattr,
        SYS_listxattr,
        SYS_llistxattr,
        SYS_getxattrat,
        SYS_listxattrat,
        SYS_fgetxattr,
        SYS_flistxattr,
        SYS_file_getattr,
        SYS_file_setattr,
        SYS_utimensat,
        SYS_truncate,
        // System V IPC and POSIX message queues, which other programs of the
        // user may hold, and watches on paths outside the sandbox.
        SYS_shmget,
        SYS_shmat,
        SYS_shmdt,
        SYS_shmctl,
        SYS_msgget,
        SYS_msgsnd,
        SYS_msgrcv,
        SYS_msgctl,
        SYS_semget,
        SYS_semop,
        SYS_semtimedop,
        SYS_semctl,
        SYS_mq_open,
        SYS_mq_unlink,
        // Mount points, which name the user's volumes.
        SYS_statmount,
        SYS_listmount,
        SYS_inotify_init1,
        SYS_inotify_add_watch,
        SYS_fanotify_init,
        SYS_fanotify_mark,
        // Tracing, other processes' memory, keys, namespaces and priorities.
        SYS_ptrace,
        SYS_process_vm_readv,
        SYS_process_vm_writev,
        SYS_pidfd_getfd,
        SYS_kcmp,
        SYS_bpf,
        SYS_perf_event_open,
        SYS_userfaultfd,
        SYS_keyctl,
        SYS_add_key,
        SYS_request_key,
        SYS_unshare,
        SYS_setns,
        SYS_setpriority,
        SYS_ioprio_set,
    ] {
        rules.insert(syscall, vec![]);
    }
    #[cfg(target_arch = "x86_64")]
    for syscall in [
        SYS_chmod,
        SYS_chown,
        SYS_lchown,
        SYS_utime,
        SYS_utimes,
        SYS_futimesat,
        SYS_inotify_init,
    ] {
        rules.insert(syscall, vec![]);
    }
    let rule = |index: u8, op: SeccompCmpOp, value: u64| {
        SeccompCondition::new(index, SeccompCmpArgLen::Dword, op, value)
            .and_then(|condition| SeccompRule::new(vec![condition]))
    };
    // A new namespace of any kind.
    rules.insert(
        SYS_clone,
        [
            CLONE_NEWNS,
            CLONE_NEWCGROUP,
            CLONE_NEWUTS,
            CLONE_NEWIPC,
            CLONE_NEWUSER,
            CLONE_NEWPID,
            CLONE_NEWNET,
        ]
        .into_iter()
        .map(|flag| rule(0, SeccompCmpOp::MaskedEq(flag as u64), flag as u64))
        .collect::<Result<_, _>>()?,
    );
    // Another process's limits and scheduling. A pid of 0 names the caller.
    for syscall in [
        SYS_prlimit64,
        SYS_sched_setaffinity,
        SYS_sched_setparam,
        SYS_sched_setscheduler,
        SYS_sched_setattr,
    ] {
        rules.insert(syscall, vec![rule(0, SeccompCmpOp::Ne, 0)?]);
    }
    // Async I/O ownership lets the kernel signal another process without kill:
    // F_SETOWN, F_SETOWN_EX and F_SETSIG, then FIOSETOWN and SIOCSPGRP.
    rules.insert(
        SYS_fcntl,
        [F_SETOWN as u64, 15, 10]
            .into_iter()
            .map(|command| rule(1, SeccompCmpOp::Eq, command))
            .collect::<Result<_, _>>()?,
    );
    rules.insert(
        SYS_ioctl,
        [0x8901, 0x8902]
            .into_iter()
            .map(|command| rule(1, SeccompCmpOp::Eq, command))
            .collect::<Result<_, _>>()?,
    );
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(EPERM as u32),
        std::env::consts::ARCH.try_into()?,
    )?;
    Ok(guard_x32(filter.try_into()?))
}

/// x32 shares AUDIT_ARCH_X86_64 but numbers its syscalls differently, so the
/// filter refuses every x32 call before matching numbers.
#[cfg(target_arch = "x86_64")]
fn guard_x32(filter: BpfProgram) -> BpfProgram {
    use seccompiler::sock_filter;
    let mut guarded = vec![
        // Load the syscall number.
        sock_filter {
            code: 0x20,
            jt: 0,
            jf: 0,
            k: 0,
        },
        // x32 sets bit 30.
        sock_filter {
            code: 0x35,
            jt: 0,
            jf: 1,
            k: 0x4000_0000,
        },
        sock_filter {
            code: 0x06,
            jt: 0,
            jf: 0,
            k: libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
        },
    ];
    guarded.extend(filter);
    guarded
}

#[cfg(not(target_arch = "x86_64"))]
fn guard_x32(filter: BpfProgram) -> BpfProgram {
    filter
}
