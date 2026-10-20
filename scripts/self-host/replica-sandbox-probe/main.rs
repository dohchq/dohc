//! Disposable syscall probe. The production daemon has no sandbox bypass.

#[cfg(target_os = "linux")]
#[path = "../../../crates/dohc-workspace-engine/src/replica_sandbox.rs"]
#[allow(dead_code)]
mod replica_sandbox;

#[cfg(not(target_os = "linux"))]
fn main() {}

#[cfg(target_os = "linux")]
fn main() {
    use crate::replica_sandbox::{ADDRESS_SPACE, CPU_SECONDS, FILE_BYTES};
    use std::{
        ffi::CString,
        fs::File,
        io::{Read, Write},
        os::unix::{io::AsRawFd, net::UnixStream, process::CommandExt},
    };
    let args: Vec<_> = std::env::args().collect();
    let action = args[1].as_str();
    if action == "exec-target" {
        std::process::exit(42);
    }
    let confined = args[2] == "sandbox";
    let parent: i32 = args[3].parse().unwrap();
    let own_file = CString::new("probe-file").unwrap();
    File::create("probe-file").unwrap();
    let executable = std::env::current_exe().unwrap();
    if action == "cpu-short" && confined {
        let limit = libc::rlimit {
            rlim_cur: 2,
            rlim_max: 2,
        };
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_CPU, &limit) }, 0);
    }
    if confined {
        assert_eq!(
            replica_sandbox::apply(&std::env::current_dir().unwrap()).unwrap(),
            2
        );
    }
    let outcome: Result<(), Box<dyn std::error::Error>> = (|| {
        // Every unsafe call below uses initialized arguments. Targets belong to this test container.
        let result = unsafe {
            match action {
                "async-fcntl" | "async-ioctl" | "setown-ex" | "setsig" | "siocspgrp" => {
                    let (mut reader, mut writer) = UnixStream::pair()?;
                    let fd = reader.as_raw_fd();
                    let owner = if action == "async-ioctl" {
                        libc::ioctl(fd, 0x8901, &parent)
                    } else if action == "siocspgrp" {
                        let group = libc::getpgid(parent);
                        libc::ioctl(fd, 0x8902, &group)
                    } else if action == "setown-ex" {
                        let owner = [1i32, parent]; // F_OWNER_PID
                        libc::fcntl(fd, 15 /* F_SETOWN_EX */, owner.as_ptr())
                    } else if action == "setsig" {
                        libc::fcntl(fd, 10 /* F_SETSIG */, libc::SIGUSR2)
                    } else {
                        libc::fcntl(fd, libc::F_SETOWN, parent)
                    };
                    if owner < 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    if action.starts_with("async-") {
                        if libc::fcntl(fd, 10 /* F_SETSIG */, libc::SIGUSR2) < 0 {
                            return Err(std::io::Error::last_os_error().into());
                        }
                        let flags = libc::fcntl(fd, libc::F_GETFL);
                        if libc::fcntl(fd, libc::F_SETFL, flags | libc::O_ASYNC | libc::O_NONBLOCK)
                            < 0
                        {
                            return Err(std::io::Error::last_os_error().into());
                        }
                        writer.write_all(b"signal relay")?;
                        let mut byte = [0u8; 1];
                        reader.read_exact(&mut byte)?;
                    }
                    0
                }
                "operator" => {
                    let secret = if confined {
                        String::new()
                    } else {
                        std::fs::read_to_string(&args[5])?
                    };
                    let mut socket = UnixStream::connect(&args[4])?;
                    writeln!(
                        socket,
                        "{{\"type\":\"disable-publication\",\"publicationId\":\"{}\",\"reason\":\"local proof\",\"secret\":\"{secret}\"}}",
                        "a".repeat(64)
                    )?;
                    let mut response = String::new();
                    socket.read_to_string(&mut response)?;
                    println!("{response}");
                    if !response.contains("\"code\":0") {
                        return Err("operator refused".into());
                    }
                    0
                }
                "operator-secret" => {
                    std::fs::read(&args[4])?;
                    0
                }
                "unlinked" => {
                    let mut file = File::create("unlinked")?;
                    std::fs::remove_file("unlinked")?;
                    for _ in 0..24 {
                        file.write_all(&vec![1u8; 1024 * 1024])?;
                    }
                    println!("unlinked-ready");
                    std::io::stdout().flush()?;
                    loop {
                        std::thread::park();
                    }
                }
                "kernel-surface" => {
                    for syscall in [
                        libc::SYS_perf_event_open,
                        libc::SYS_userfaultfd,
                        libc::SYS_keyctl,
                        libc::SYS_add_key,
                        libc::SYS_request_key,
                        libc::SYS_init_module,
                        libc::SYS_finit_module,
                        libc::SYS_delete_module,
                        libc::SYS_kexec_load,
                        libc::SYS_kexec_file_load,
                        libc::SYS_mount,
                        libc::SYS_umount2,
                        libc::SYS_pivot_root,
                        libc::SYS_chroot,
                        libc::SYS_open_by_handle_at,
                        libc::SYS_name_to_handle_at,
                        libc::SYS_fanotify_init,
                        libc::SYS_quotactl,
                        libc::SYS_swapon,
                        libc::SYS_swapoff,
                        libc::SYS_reboot,
                        libc::SYS_acct,
                    ] {
                        // Invalid null/zero arguments cannot change host state in the control.
                        let result = libc::syscall(syscall, 0, 0, 0, 0, 0, 0);
                        let errno = std::io::Error::last_os_error().raw_os_error();
                        if confined {
                            assert_eq!(
                                (result, errno),
                                (-1, Some(libc::EPERM)),
                                "syscall {syscall}"
                            );
                        }
                        println!("syscall={syscall} result={result} errno={errno:?}");
                    }
                    0
                }
                "ipc" => {
                    // The control creates, uses and removes its own objects. Raw syscalls: glibc's semop calls semtimedop.
                    let mut calls = Vec::new();
                    let mut call = |name, number, a: [i64; 5]| {
                        let result = libc::syscall(number, a[0], a[1], a[2], a[3], a[4]);
                        calls.push((name, result, std::io::Error::last_os_error().raw_os_error()));
                        result
                    };
                    let mut message = [1i64, 0]; // mtype, then an 8-byte body
                    let ops = [1, -1].map(|sem_op| libc::sembuf {
                        sem_num: 0,
                        sem_op,
                        sem_flg: libc::IPC_NOWAIT as i16,
                    });
                    let timeout = libc::timespec {
                        tv_sec: 0,
                        tv_nsec: 0,
                    };
                    let mut attr: libc::mq_attr = std::mem::zeroed();
                    (attr.mq_maxmsg, attr.mq_msgsize) = (1, 8);
                    let (body, up, down) = (
                        message.as_mut_ptr() as i64,
                        &raw const ops[0] as i64,
                        &raw const ops[1] as i64,
                    );
                    let (now, attr_ptr) = (&raw const timeout as i64, &raw mut attr as i64);
                    let queue_name = c"dohc-replica-probe".as_ptr() as i64;
                    let (private, create, rmid, nowait) = (
                        libc::IPC_PRIVATE as i64,
                        (libc::IPC_CREAT | 0o600) as i64,
                        libc::IPC_RMID as i64,
                        libc::IPC_NOWAIT as i64,
                    );
                    let shm = call("shmget", libc::SYS_shmget, [private, 4096, create, 0, 0]);
                    let at = call("shmat", libc::SYS_shmat, [shm, 0, 0, 0, 0]);
                    call("shmdt", libc::SYS_shmdt, [at, 0, 0, 0, 0]);
                    call("shmctl", libc::SYS_shmctl, [shm, rmid, 0, 0, 0]);
                    let msg = call("msgget", libc::SYS_msgget, [private, create, 0, 0, 0]);
                    call("msgsnd", libc::SYS_msgsnd, [msg, body, 8, nowait, 0]);
                    call("msgrcv", libc::SYS_msgrcv, [msg, body, 8, 0, nowait]);
                    call("msgctl", libc::SYS_msgctl, [msg, rmid, 0, 0, 0]);
                    let sem = call("semget", libc::SYS_semget, [private, 1, create, 0, 0]);
                    call("semop", libc::SYS_semop, [sem, up, 1, 0, 0]);
                    call("semtimedop", libc::SYS_semtimedop, [sem, down, 1, now, 0]);
                    call("semctl", libc::SYS_semctl, [sem, 0, rmid, 0, 0]);
                    let flags = (libc::O_CREAT | libc::O_RDWR) as i64;
                    let queue = call(
                        "mq_open",
                        libc::SYS_mq_open,
                        [queue_name, flags, 0o600, attr_ptr, 0],
                    );
                    call(
                        "mq_timedsend",
                        libc::SYS_mq_timedsend,
                        [queue, body, 8, 0, now],
                    );
                    call(
                        "mq_timedreceive",
                        libc::SYS_mq_timedreceive,
                        [queue, body, 8, 0, now],
                    );
                    call("mq_notify", libc::SYS_mq_notify, [queue, 0, 0, 0, 0]);
                    call(
                        "mq_getsetattr",
                        libc::SYS_mq_getsetattr,
                        [queue, 0, attr_ptr, 0, 0],
                    );
                    libc::close(queue as i32);
                    call("mq_unlink", libc::SYS_mq_unlink, [queue_name, 0, 0, 0, 0]);
                    for (name, result, errno) in &calls {
                        println!("{name} result={result} errno={errno:?}");
                    }
                    if confined {
                        let denied = |(_, result, errno): &(_, i64, _)| {
                            (*result, *errno) == (-1, Some(libc::EPERM))
                        };
                        assert!(calls.iter().all(denied), "an IPC call escaped");
                    }
                    if calls.iter().any(|(_, result, _)| *result < 0) {
                        return Err("IPC denied".into());
                    }
                    0
                }
                "data" => {
                    std::fs::read("/data/secret")?;
                    0
                }
                "environ" => {
                    std::fs::read(format!("/proc/{parent}/environ"))?;
                    0
                }
                "sibling" => {
                    std::fs::read("/replicas/sibling/secret")?;
                    0
                }
                "proc-unix" => {
                    std::fs::read("/proc/net/unix")?;
                    0
                }
                "tcp" | "postgres" | "dns" => {
                    std::net::TcpStream::connect(&args[4])?;
                    0
                }
                "udp" => {
                    let s = std::net::UdpSocket::bind("0.0.0.0:0")?;
                    s.send_to(b"local probe", &args[4])?;
                    0
                }
                "internet" => {
                    // No packet leaves the machine: socket creation is the boundary, before connect/DNS.
                    let fd = libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0);
                    if fd >= 0 {
                        libc::close(fd);
                    }
                    fd as i64
                }
                "chmod" => libc::syscall(libc::SYS_chmod, own_file.as_ptr(), 0o600),
                "xattr" => libc::syscall(
                    libc::SYS_setxattr,
                    own_file.as_ptr(),
                    c"user.test".as_ptr(),
                    c"x".as_ptr(),
                    1,
                    0,
                ),
                "truncate" => libc::syscall(libc::SYS_truncate, own_file.as_ptr(), 1),
                "kill" => libc::syscall(libc::SYS_kill, parent, 0),
                "kill-group" => libc::syscall(libc::SYS_kill, 0, 0),
                "tgkill" => libc::syscall(libc::SYS_tgkill, parent, parent, 0),
                "prlimit" => {
                    let mut old: libc::rlimit = std::mem::zeroed();
                    libc::syscall(
                        libc::SYS_prlimit64,
                        parent,
                        libc::RLIMIT_NOFILE,
                        std::ptr::null::<libc::rlimit>(),
                        &mut old,
                    )
                }
                "priority" => libc::syscall(libc::SYS_setpriority, libc::PRIO_PROCESS, parent, 0),
                "scheduler" => libc::syscall(libc::SYS_sched_getscheduler, parent),
                "ptrace" => libc::ptrace(libc::PTRACE_SEIZE, parent, 0, 0) as i64,
                "io-uring" => {
                    let mut p: [u64; 32] = [0; 32];
                    libc::syscall(libc::SYS_io_uring_setup, 1, p.as_mut_ptr())
                }
                "bpf" => {
                    let p: [u64; 32] = [0; 32];
                    libc::syscall(libc::SYS_bpf, 0, p.as_ptr(), 128)
                }
                "fork" => {
                    let pid = libc::fork();
                    if pid == 0 {
                        libc::_exit(0);
                    }
                    if pid > 0 {
                        libc::waitpid(pid, std::ptr::null_mut(), 0);
                    }
                    pid as i64
                }
                "exec" => {
                    return Err(std::process::Command::new(executable)
                        .arg("exec-target")
                        .exec()
                        .into());
                }
                "as" => {
                    let length = ADDRESS_SPACE as usize + 4096;
                    let ptr = libc::mmap(
                        std::ptr::null_mut(),
                        length,
                        libc::PROT_READ | libc::PROT_WRITE,
                        libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                        -1,
                        0,
                    );
                    if ptr == libc::MAP_FAILED {
                        -1
                    } else {
                        libc::munmap(ptr, length);
                        0
                    }
                }
                "fsize" => {
                    File::create("oversize")?.set_len(FILE_BYTES + 1)?;
                    0
                }
                "nofile" => {
                    let mut files = Vec::new();
                    for _ in 0..256 {
                        files.push(File::open("probe-file")?);
                    }
                    0
                }
                "core" => {
                    let mut r: libc::rlimit = std::mem::zeroed();
                    libc::getrlimit(libc::RLIMIT_CORE, &mut r);
                    println!("core={}", r.rlim_max);
                    return Ok(());
                }
                "nice" => {
                    println!("nice={}", libc::getpriority(libc::PRIO_PROCESS, 0));
                    return Ok(());
                }
                "cpu" | "cpu-short" => {
                    let seconds = if action == "cpu-short" {
                        2
                    } else {
                        CPU_SECONDS
                    };
                    if confined {
                        let mut limit: libc::rlimit = std::mem::zeroed();
                        assert_eq!(libc::getrlimit(libc::RLIMIT_CPU, &mut limit), 0);
                        assert_eq!((limit.rlim_cur, limit.rlim_max), (seconds, seconds));
                    }
                    let mut time: libc::timespec = std::mem::zeroed();
                    let mut next_report = seconds as i64;
                    loop {
                        for i in 0..100_000 {
                            std::hint::black_box(i * 2);
                        }
                        libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut time);
                        if confined && time.tv_sec >= next_report {
                            println!("cpu clock={}", time.tv_sec);
                            next_report += 10;
                        }
                        // Only the unsandboxed control exits voluntarily. The outer test bounds wall time.
                        if !confined && time.tv_sec > seconds as i64 + 5 {
                            break;
                        }
                    }
                    let mut usage: libc::rusage = std::mem::zeroed();
                    assert_eq!(libc::getrusage(libc::RUSAGE_SELF, &mut usage), 0);
                    println!(
                        "cpu clock={} usage={}.{}+{}.{}",
                        time.tv_sec,
                        usage.ru_utime.tv_sec,
                        usage.ru_utime.tv_usec,
                        usage.ru_stime.tv_sec,
                        usage.ru_stime.tv_usec
                    );
                    0
                }
                "get" | "post" | "wrong-lease" | "wrong-path" | "sibling-socket" => {
                    let mut socket = UnixStream::connect(if action == "sibling-socket" {
                        args[4].as_str()
                    } else {
                        "relay.sock"
                    })?;
                    let method = if action == "post" { "POST" } else { "GET" };
                    let token = if action == "wrong-lease" {
                        "other-lease"
                    } else {
                        "probe-lease"
                    };
                    let path = if action == "wrong-path" {
                        "/sync/other/bootstrap"
                    } else {
                        "/sync/w/bootstrap"
                    };
                    write!(
                        socket,
                        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
                    )?;
                    let mut body = String::new();
                    socket.read_to_string(&mut body)?;
                    println!("{}", body.lines().next().unwrap());
                    return Ok(());
                }
                _ => panic!("unknown action {action}"),
            }
        };
        if result < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    })();
    match outcome {
        Ok(()) => println!("allowed"),
        Err(error) => {
            println!("denied: {error}");
            std::process::exit(13);
        }
    }
}
