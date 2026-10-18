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
        os::unix::{net::UnixStream, process::CommandExt},
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
                    loop {
                        for i in 0..100_000 {
                            std::hint::black_box(i * 2);
                        }
                        libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut time);
                        // Give the kernel's CPU accounting timer time to deliver the hard-limit signal.
                        if time.tv_sec > seconds as i64 + 5 {
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
