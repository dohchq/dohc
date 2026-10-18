//! Applied on the main thread before creating any engine threads or reading stdin.

use std::{io, path::Path, sync::OnceLock};

pub const MIN_ABI: u32 = 2;
pub const ADDRESS_SPACE: u64 = 2 * 1024 * 1024 * 1024;
pub const CPU_SECONDS: u64 = 120;
pub const FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const OPEN_FILES: u64 = 128;
pub const NICE: i32 = 10;
static APPLIED: OnceLock<u32> = OnceLock::new();

macro_rules! denied_syscalls {
    ($($name:ident),+ $(,)?) => {
        pub const DENIED_SYSCALL_NAMES: &[&str] = &[$(stringify!($name)),+];
        #[cfg(target_os = "linux")]
        const DENIED_SYSCALLS: &[i64] = &[$(libc::$name),+];
    };
}
denied_syscalls!(
    SYS_fchmod,
    SYS_fchmodat,
    SYS_fchmodat2,
    SYS_truncate,
    SYS_setxattr,
    SYS_lsetxattr,
    SYS_fsetxattr,
    SYS_removexattr,
    SYS_lremovexattr,
    SYS_fremovexattr,
    SYS_getxattr,
    SYS_lgetxattr,
    SYS_fgetxattr,
    SYS_listxattr,
    SYS_llistxattr,
    SYS_flistxattr,
    SYS_fchown,
    SYS_fchownat,
    SYS_execve,
    SYS_execveat,
    SYS_io_uring_setup,
    SYS_io_uring_enter,
    SYS_io_uring_register,
    SYS_bpf,
    SYS_ptrace,
    SYS_process_vm_readv,
    SYS_process_vm_writev,
    SYS_pidfd_open,
    SYS_pidfd_getfd,
    SYS_pidfd_send_signal,
    SYS_tkill,
    SYS_unshare,
    SYS_setns,
);

pub fn applied_abi() -> Option<u32> {
    APPLIED.get().copied()
}

pub fn apply(store: &Path) -> io::Result<u32> {
    #[cfg(target_os = "linux")]
    let result = linux::apply(store);
    #[cfg(not(target_os = "linux"))]
    let result = {
        let _ = store;
        Err(io::Error::other(
            "replicas require Linux 5.19 or later with Landlock ABI 2 or later enabled",
        ))
    };
    let abi = result.map_err(|e| io::Error::other(format!(
        "Replica sandbox refused: {e}. Use Linux 5.19 or later with Landlock ABI 2 or later enabled and permit landlock_* in the container seccomp profile."
    )))?;
    APPLIED
        .set(abi)
        .map_err(|_| io::Error::other("replica sandbox already applied"))?;
    Ok(abi)
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use landlock::{
        ABI, Access, AccessFs, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset, RulesetAttr,
        RulesetCreatedAttr, RulesetStatus,
    };
    use rustix::process::{Resource, Rlimit, getrlimit, setpriority_process, setrlimit};
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
        SeccompRule,
    };
    use std::collections::BTreeMap;

    pub(super) fn apply(store: &Path) -> io::Result<u32> {
        let fail = |e: Box<dyn std::error::Error>| io::Error::other(e.to_string());
        (|| -> Result<u32, Box<dyn std::error::Error>> {
            // Only exact mapped files are readable; no library directory grants.
            let maps = std::fs::read_to_string("/proc/self/maps")?;
            let binary = std::env::current_exe()?.canonicalize()?;
            let files = maps
                .lines()
                .filter_map(|line| line.find('/').map(|i| &line[i..]))
                .map(Path::new)
                .filter(|p| {
                    **p == binary
                        || p.file_name()
                            .is_some_and(|n| n.as_encoded_bytes().windows(3).any(|w| w == b".so"))
                })
                .map(Path::canonicalize)
                .collect::<io::Result<std::collections::BTreeSet<_>>>()?;
            let access = AccessFs::from_all(ABI::V2);
            let mut rules = Ruleset::default()
                .set_compatibility(CompatLevel::HardRequirement)
                .handle_access(access)?
                .create()?;
            rules = rules.add_rule(PathBeneath::new(
                PathFd::new(store)?,
                access & !AccessFs::Execute,
            ))?;
            for file in files.into_iter().chain(std::iter::once(binary)) {
                rules = rules.add_rule(PathBeneath::new(
                    PathFd::new(file)?,
                    AccessFs::ReadFile | AccessFs::Execute,
                ))?;
            }
            for (resource, cap) in [
                (Resource::As, ADDRESS_SPACE),
                (Resource::Cpu, CPU_SECONDS),
                (Resource::Fsize, FILE_BYTES),
                (Resource::Nofile, OPEN_FILES),
                (Resource::Core, 0),
            ] {
                let cap = getrlimit(resource).maximum.map_or(cap, |old| old.min(cap));
                setrlimit(
                    resource,
                    Rlimit {
                        current: Some(cap),
                        maximum: Some(cap),
                    },
                )?;
            }
            setpriority_process(None, NICE)?;
            let status = rules.restrict_self()?;
            if status.ruleset != RulesetStatus::FullyEnforced || !status.no_new_privs {
                return Err("Landlock ABI 2 was not fully enforced".into());
            }
            seccompiler::apply_filter(&filter()?)?;
            Ok(MIN_ABI)
        })()
        .map_err(fail)
    }

    fn filter() -> Result<BpfProgram, Box<dyn std::error::Error>> {
        use libc::*;
        let mut rules = BTreeMap::new();
        for &syscall in DENIED_SYSCALLS {
            rules.insert(syscall, vec![]);
        }
        #[cfg(target_arch = "x86_64")]
        for syscall in [SYS_chmod, SYS_chown, SYS_lchown, SYS_fork, SYS_vfork] {
            rules.insert(syscall, vec![]);
        }
        let condition =
            |index, op, value| SeccompCondition::new(index, SeccompCmpArgLen::Dword, op, value);
        let rule = |conditions| SeccompRule::new(conditions);
        rules.insert(
            SYS_socket,
            vec![rule(vec![condition(0, SeccompCmpOp::Ne, AF_UNIX as u64)?])?],
        );
        // clone3's pointed-to flags cannot be inspected by seccomp. ENOSYS makes libc use clone.
        let clone3: BpfProgram = SeccompFilter::new(
            BTreeMap::from([(SYS_clone3, vec![])]),
            SeccompAction::Allow,
            SeccompAction::Errno(ENOSYS as u32),
            std::env::consts::ARCH.try_into()?,
        )?
        .try_into()?;
        seccompiler::apply_filter(&clone3)?;
        // Only threads sharing this process's address space and signal handlers may clone.
        for bit in [CLONE_THREAD, CLONE_VM, CLONE_SIGHAND] {
            rules
                .entry(SYS_clone)
                .or_insert_with(Vec::new)
                .push(rule(vec![condition(
                    0,
                    SeccompCmpOp::MaskedEq(bit as u64),
                    0,
                )?])?);
        }
        let pid = u64::from(std::process::id());
        for syscall in [
            SYS_kill,
            SYS_tgkill,
            SYS_rt_sigqueueinfo,
            SYS_rt_tgsigqueueinfo,
        ] {
            rules.insert(
                syscall,
                vec![rule(vec![condition(0, SeccompCmpOp::Ne, pid)?])?],
            );
        }
        for syscall in [
            SYS_prlimit64,
            SYS_sched_setparam,
            SYS_sched_getparam,
            SYS_sched_setscheduler,
            SYS_sched_getscheduler,
            SYS_sched_setaffinity,
            SYS_sched_getaffinity,
            SYS_sched_rr_get_interval,
            SYS_sched_setattr,
            SYS_sched_getattr,
        ] {
            rules.insert(
                syscall,
                vec![rule(vec![
                    condition(0, SeccompCmpOp::Ne, 0)?,
                    condition(0, SeccompCmpOp::Ne, pid)?,
                ])?],
            );
        }
        rules.insert(
            SYS_setpriority,
            vec![
                rule(vec![condition(0, SeccompCmpOp::Ne, PRIO_PROCESS as u64)?])?,
                rule(vec![
                    condition(1, SeccompCmpOp::Ne, 0)?,
                    condition(1, SeccompCmpOp::Ne, pid)?,
                ])?,
            ],
        );
        let filter: BpfProgram = SeccompFilter::new(
            rules,
            SeccompAction::Allow,
            SeccompAction::Errno(EPERM as u32),
            std::env::consts::ARCH.try_into()?,
        )?
        .try_into()?;
        #[cfg(target_arch = "x86_64")]
        {
            // x32 shares AUDIT_ARCH_X86_64 but uses different syscall numbers.
            use seccompiler::sock_filter;
            let mut guarded = vec![
                sock_filter {
                    code: 0x20,
                    jt: 0,
                    jf: 0,
                    k: 0,
                },
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
                    k: SECCOMP_RET_ERRNO | EPERM as u32,
                },
            ];
            guarded.extend(filter);
            Ok(guarded)
        }
        #[cfg(not(target_arch = "x86_64"))]
        Ok(filter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_has_finite_process_budgets_and_required_landlock() {
        assert_eq!(MIN_ABI, 2);
        assert_eq!(ADDRESS_SPACE, 2_147_483_648);
        assert_eq!(CPU_SECONDS, 120);
        assert_eq!(FILE_BYTES, 268_435_456);
        assert_eq!(OPEN_FILES, 128);
        assert_eq!(NICE, 10);
        assert_eq!(applied_abi(), None);
    }

    #[test]
    fn policy_denies_process_and_filesystem_bypasses() {
        for name in [
            "SYS_fchmod",
            "SYS_fchmodat2",
            "SYS_truncate",
            "SYS_setxattr",
            "SYS_fsetxattr",
            "SYS_execve",
            "SYS_execveat",
            "SYS_ptrace",
            "SYS_tkill",
            "SYS_pidfd_send_signal",
            "SYS_process_vm_readv",
            "SYS_io_uring_setup",
            "SYS_bpf",
            "SYS_unshare",
            "SYS_setns",
        ] {
            assert!(DENIED_SYSCALL_NAMES.contains(&name), "missing {name}");
        }
    }

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn other_hosts_refuse_before_stdin() {
        assert!(
            apply(Path::new("."))
                .unwrap_err()
                .to_string()
                .contains("Linux 5.19")
        );
    }
}
