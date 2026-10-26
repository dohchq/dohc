//! Applied on the main thread before creating any engine threads or reading stdin.

use std::{io, path::Path, sync::OnceLock};

pub const MIN_ABI: u32 = 2;
pub const ADDRESS_SPACE: u64 = 2 * 1024 * 1024 * 1024;
pub const CPU_SECONDS: u64 = 120;
pub const FILE_BYTES: u64 = 1024 * 1024 * 1024;
pub const OPEN_FILES: u64 = 128;
pub const NICE: i32 = 10;
static APPLIED: OnceLock<u32> = OnceLock::new();

/// ABI of the fully enforced policy, not the highest ABI supported by the kernel.
pub fn applied_policy_abi() -> Option<u32> {
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

    fn is_shared_library(name: &[u8]) -> bool {
        name.ends_with(b".so")
            || name.windows(4).enumerate().any(|(i, part)| {
                part == b".so."
                    && !name[i + 4..].is_empty()
                    && name[i + 4..]
                        .iter()
                        .all(|b| b.is_ascii_digit() || *b == b'.')
            })
    }

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
                            .is_some_and(|n| is_shared_library(n.as_encoded_bytes()))
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
            // clone3's pointed-to flags cannot be inspected. ENOSYS makes libc use clone.
            let clone3: BpfProgram = SeccompFilter::new(
                BTreeMap::from([(libc::SYS_clone3, vec![])]),
                SeccompAction::Allow,
                SeccompAction::Errno(libc::ENOSYS as u32),
                std::env::consts::ARCH.try_into()?,
            )?
            .try_into()?;
            seccompiler::apply_filter(&clone3)?;
            seccompiler::apply_filter(&filter()?)?;
            Ok(MIN_ABI)
        })()
        .map_err(fail)
    }

    fn filter() -> Result<BpfProgram, Box<dyn std::error::Error>> {
        use libc::*;
        // libc 0.2.189 omits this constant on AArch64; Linux numbers it 452 there too.
        #[cfg(target_arch = "aarch64")]
        #[allow(non_upper_case_globals)]
        const SYS_fchmodat2: c_long = 452;
        let mut rules = BTreeMap::new();
        for syscall in [
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
            SYS_perf_event_open,
            SYS_userfaultfd,
            SYS_keyctl,
            SYS_add_key,
            SYS_request_key,
            SYS_init_module,
            SYS_finit_module,
            SYS_delete_module,
            SYS_kexec_load,
            SYS_kexec_file_load,
            SYS_mount,
            SYS_umount2,
            SYS_pivot_root,
            SYS_chroot,
            SYS_open_by_handle_at,
            SYS_name_to_handle_at,
            SYS_fanotify_init,
            SYS_quotactl,
            SYS_swapon,
            SYS_swapoff,
            SYS_reboot,
            SYS_acct,
            SYS_fsopen,
            SYS_fspick,
            SYS_fsmount,
            SYS_move_mount,
            SYS_open_tree,
            SYS_mount_setattr,
            SYS_settimeofday,
            SYS_clock_settime,
            SYS_clock_adjtime,
            SYS_adjtimex,
            SYS_sethostname,
            SYS_setdomainname,
            SYS_ioprio_set,
            SYS_kcmp,
            SYS_lookup_dcookie,
            SYS_syslog,
            SYS_vhangup,
            // IPC objects are shared across the IPC namespace and Landlock does not mediate them.
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
            SYS_mq_timedsend,
            SYS_mq_timedreceive,
            SYS_mq_notify,
            SYS_mq_getsetattr,
        ] {
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
        // Async I/O ownership lets the kernel signal another process without kill().
        // fcntl64 is a 32-bit syscall; seccompiler supports only 64-bit architectures.
        rules.insert(
            SYS_fcntl,
            [F_SETOWN, 15 /* F_SETOWN_EX */, 10 /* F_SETSIG */]
                .into_iter()
                .map(|cmd| rule(vec![condition(1, SeccompCmpOp::Eq, cmd as u64)?]))
                .collect::<Result<Vec<_>, seccompiler::BackendError>>()?,
        );
        // FIOSETOWN and SIOCSPGRP from asm-generic/sockios.h.
        rules.insert(
            SYS_ioctl,
            [0x8901, 0x8902]
                .into_iter()
                .map(|cmd| rule(vec![condition(1, SeccompCmpOp::Eq, cmd)?]))
                .collect::<Result<Vec<_>, seccompiler::BackendError>>()?,
        );
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
    #[test]
    fn library_names_and_filter_construction() {
        for name in [b"libc.so".as_slice(), b"libc.so.6", b"ld-linux-x86-64.so.2"] {
            assert!(is_shared_library(name));
        }
        for name in [
            b"secret.so-backup".as_slice(),
            b"secret.so.txt",
            b"secret.so.",
        ] {
            assert!(!is_shared_library(name));
        }
        assert!(!filter().unwrap().is_empty());
        assert!(
            std::process::Command::new("true")
                .status()
                .unwrap()
                .success()
        );
    }

    /// Under the filter a replica runs with, which refuses mode changes, a
    /// replica opens its workspace again once the workspace's folders and
    /// store are private: the root binding, this computer's folder and the
    /// store all open. The filter holds only for the thread that applies it
    /// and the threads it starts.
    #[test]
    fn a_replica_reopens_its_workspace_under_the_filter() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let root = scratch.path().to_path_buf();
        replica_open(&root).unwrap();
        let program = filter().unwrap();
        let reopened = std::thread::spawn(move || {
            seccompiler::apply_filter(&program).unwrap();
            replica_open(&root)
        })
        .join()
        .unwrap();
        assert!(reopened.is_ok(), "{reopened:?}");
    }

    /// Open the workspace at `root` as a replica does, passively, then close
    /// it.
    #[cfg(test)]
    fn replica_open(root: &Path) -> Result<(), String> {
        use dohc_engine_protocol::transport::{EngineService as _, RequestContext};
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let service = crate::EngineService::replica(root).map_err(|e| e.to_string())?;
        let request = dohc_engine_protocol::wire::Request {
            id: 1,
            method: "workspace.open".into(),
            workspace: None,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: serde_json::json!({
                "rootDir": root,
                "workspaceId": "replica",
                "relay": {"socketPath": root.join("relay.sock"), "bearerToken": "lease"},
            }),
        };
        let opened = runtime.block_on(service.call(RequestContext::unbounded(), request));
        let db = root.join(".dohc/engine/engine.db");
        let _ = dohc_engine_runtime::WorkspaceSupervisor::global().close(&db);
        opened.map(drop).map_err(|e| format!("{e:?}"))
    }
}

#[cfg(all(test, not(target_os = "linux")))]
mod tests {
    use super::*;

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
