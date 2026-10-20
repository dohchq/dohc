//! The Landlock rules and seccomp filters that confine the worker and esbuild
//! on Linux, in place of the macOS Seatbelt profile.
//!
//! The tree may run only the installed Node, esbuild and the dynamic loader,
//! read those, the compiler root and the system libraries, and read and write
//! its own build directory, where it can run nothing. It cannot open a
//! socket, so it has no network and cannot reach D-Bus or any other local
//! service. It cannot signal, trace or change the limits of the owner, even
//! on a kernel too old for Landlock to scope signals. Path metadata stays
//! readable everywhere, as on macOS, because Landlock does not mediate it.
//! See docs/engineering/app-compiler.md.
use crate::sys::Pid;
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
pub fn rules(root: &Path, node: &Path, build: &Path, owner: Pid) -> Result<Rules, String> {
    let landlock = landlock(root, node, build).map_err(|error| {
        format!("{error}. The app compiler needs Landlock, in Linux 5.13 or later with Landlock enabled.")
    })?;
    let seccomp = [
        absent_syscalls().map_err(|error| format!("seccomp: {error}"))?,
        refused_syscalls(owner).map_err(|error| format!("seccomp: {error}"))?,
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

/// io_uring can open sockets and files without the syscalls the next filter
/// checks. Node's libuv falls back to ordinary calls when it is absent.
fn absent_syscalls() -> Result<BpfProgram, Box<dyn std::error::Error>> {
    use libc::{ENOSYS, SYS_io_uring_enter, SYS_io_uring_register, SYS_io_uring_setup};
    let rules = [
        SYS_io_uring_setup,
        SYS_io_uring_enter,
        SYS_io_uring_register,
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
    Ok(guard_x32(filter.try_into()?))
}

fn refused_syscalls(owner: Pid) -> Result<BpfProgram, Box<dyn std::error::Error>> {
    use libc::*;
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    // No sockets at all. Node and esbuild talk over socketpair and pipes.
    // Tracing, other processes' memory, keys, namespaces and priorities.
    for syscall in [
        SYS_socket,
        SYS_ptrace,
        SYS_process_vm_readv,
        SYS_process_vm_writev,
        SYS_pidfd_getfd,
        SYS_pidfd_send_signal,
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
    let equals = |index: u8, value: u64| -> Result<SeccompRule, seccompiler::BackendError> {
        SeccompRule::new(vec![SeccompCondition::new(
            index,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Eq,
            value,
        )?])
    };
    // A pid as the kernel reads the 32-bit argument.
    let pid = |pid: Pid| u64::from(pid as u32);
    // kill reaches the owner by its pid, its group, the caller's group (0),
    // which the worker shares, or every process (-1).
    rules.insert(
        SYS_kill,
        [owner, -owner, 0, -1]
            .into_iter()
            .map(|target| equals(0, pid(target)))
            .collect::<Result<_, _>>()?,
    );
    for syscall in [
        SYS_tkill,
        SYS_tgkill,
        SYS_rt_sigqueueinfo,
        SYS_rt_tgsigqueueinfo,
        SYS_pidfd_open,
        SYS_prlimit64,
        SYS_sched_setaffinity,
        SYS_sched_setparam,
        SYS_sched_setscheduler,
        SYS_sched_setattr,
    ] {
        rules.insert(syscall, vec![equals(0, pid(owner))?]);
    }
    // Async I/O ownership lets the kernel signal another process without kill:
    // F_SETOWN, F_SETOWN_EX and F_SETSIG, then FIOSETOWN and SIOCSPGRP.
    rules.insert(
        SYS_fcntl,
        [F_SETOWN as u64, 15, 10]
            .into_iter()
            .map(|command| equals(1, command))
            .collect::<Result<_, _>>()?,
    );
    rules.insert(
        SYS_ioctl,
        [0x8901, 0x8902]
            .into_iter()
            .map(|command| equals(1, command))
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
