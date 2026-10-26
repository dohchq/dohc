//! One build: start the confined worker, forward its input, watch its bounds,
//! then stop everything it started.
//!
//! The memory and process bounds are detection thresholds, not ceilings. The
//! owner measures every `SAMPLE_INTERVAL`, so a tree can pass a bound until
//! the next sample and the kill that follows. On an Apple M2 a real compile
//! passed the 1 GiB bound by 24 to 43 MB, an allocator touching 14.4 GB/s by
//! 33 to 67 MB, and a spawn loop reached 9 to 12 processes against a bound of
//! 8. See docs/engineering/app-compiler.md.
use crate::args::Args;
use crate::sys::{self, Wait};
use crate::tree::{System, Tree};
use std::io::{self, ErrorKind, Write};
use std::os::fd::AsRawFd;
use std::process::{ChildStdin, Command, ExitCode, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const SAMPLE_INTERVAL: Duration = Duration::from_millis(10);
/// The most task slots the tree may take: threads on Linux, and processes
/// no one has reaped. A real compile takes a few dozen.
const MAX_TASKS: u64 = 1024;
/// How long teardown may keep signalling before the owner reports failure.
const TEARDOWN_BUDGET: Duration = Duration::from_secs(2);
const CHUNK: usize = 64 * 1024;
/// The caller holds this pipe's other end open for the build and never
/// writes to it, so input or a hangup on it means the caller is gone.
const LIFELINE: i32 = 3;

/// Exit codes the desktop reads. Worker codes below 120 pass through.
const STOP_FAILED: u8 = 121;
const PROCESSES: u8 = 122;
const MEMORY: u8 = 123;
const TIMEOUT: u8 = 124;
const CALLER_CLOSED: u8 = 125;
const SETUP_FAILED: u8 = 126;

enum Outcome {
    Exited(u8),
    Memory,
    Processes,
    Timeout,
    CallerClosed,
    Unmeasurable(io::Error),
}

pub fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("The app compiler could not start.\n{message}");
            ExitCode::from(SETUP_FAILED)
        }
    }
}

fn worker_code(status: ExitStatus) -> u8 {
    // A worker cannot pose as the owner. A signal ends it as a failure.
    status
        .code()
        .and_then(|code| u8::try_from(code).ok())
        .filter(|&code| code < 120)
        .unwrap_or(1)
}

fn run() -> Result<u8, String> {
    if !sys::is_open(LIFELINE) {
        return Err("The caller did not pass a lifeline on descriptor 3.".to_owned());
    }
    let owner = sys::lead_process_group().map_err(|error| format!("Process group: {error}"))?;
    #[cfg(target_os = "linux")]
    sys::adopt_orphans().map_err(|error| format!("Subreaper: {error}"))?;
    sys::close_inherited_descriptors_on_exec().map_err(|error| format!("Descriptors: {error}"))?;
    let args = Args::parse(std::env::args_os())?;
    let started = Instant::now();
    let deadline = started + args.timeout;
    let cpus = std::thread::available_parallelism().map_or(1, |count| count.get() as u64);
    // A backstop if the owner dies: esbuild may keep every core busy.
    let cpu_seconds = args
        .timeout
        .as_secs()
        .saturating_add(1)
        .saturating_mul(cpus);
    let mut tmpdir = args.build.clone().into_os_string();
    tmpdir.push("/");
    let mut command = Command::new(&args.node);
    command
        .arg(&args.worker)
        .args(&args.worker_args)
        .env_clear()
        .env("TMPDIR", tmpdir)
        .current_dir(&args.build)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    // Node stops at startup when the system OpenSSL configuration exists but
    // the sandbox keeps it unreadable. The compiler needs none.
    #[cfg(target_os = "linux")]
    command.env("OPENSSL_CONF", "/dev/null");
    sys::confine(
        &mut command,
        sys::sandbox(&args.root, &args.node, &args.build)?,
        cpu_seconds,
    );
    let mut child = command
        .spawn()
        .map_err(|error| format!("Worker: {error}"))?;
    let mut tree = Tree::new(owner, System);
    let outcome = match child
        .stdin
        .take()
        .map(|stdin| Input::new(args.input_bytes, stdin))
    {
        Some(Ok(mut input)) => watch(&mut child, &mut tree, &mut input, &args, deadline),
        Some(Err(error)) => Outcome::Unmeasurable(error),
        None => Outcome::Unmeasurable(io::Error::other("the worker has no input pipe")),
    };
    let stopped = tree.stop(TEARDOWN_BUDGET);
    remove_build_directory(&args.build);
    let code = match outcome {
        Outcome::Exited(code) => code,
        Outcome::Memory => MEMORY,
        Outcome::Processes => PROCESSES,
        Outcome::Timeout => TIMEOUT,
        Outcome::CallerClosed => CALLER_CLOSED,
        Outcome::Unmeasurable(error) => {
            eprintln!("The app compiler could not measure the build, so dohc stopped it.\n{error}");
            STOP_FAILED
        }
    };
    if let Err(problem) = stopped {
        eprintln!("The app compiler could not stop every process it started.\n{problem}");
        // A bound or deadline outcome stays the first reason. Success cannot.
        return Ok(if code == 0 { STOP_FAILED } else { code });
    }
    Ok(code)
}

/// A process that escaped the tree may still write in the build directory,
/// even swap a directory for a symlink. remove_dir_all opens each directory
/// with O_NOFOLLOW and unlinks relative to it, so it never follows one. A
/// path-based recursive remove, Node's included, can. The caller only removes
/// the directory if it is left empty.
fn remove_build_directory(build: &std::path::Path) {
    let _ = std::fs::remove_dir_all(build);
}

fn watch(
    child: &mut std::process::Child,
    tree: &mut Tree<System>,
    input: &mut Input,
    args: &Args,
    deadline: Instant,
) -> Outcome {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Outcome::Exited(worker_code(status)),
            Ok(None) => {}
            Err(error) => return Outcome::Unmeasurable(error),
        }
        #[cfg(target_os = "linux")]
        if let Err(error) = sys::reap_adopted(child.id() as sys::Pid) {
            return Outcome::Unmeasurable(error);
        }
        match tree.measure() {
            Ok(sample) if sample.footprint > args.memory_bytes => return Outcome::Memory,
            Ok(sample) if sample.processes > args.max_processes || sample.tasks > MAX_TASKS => {
                return Outcome::Processes;
            }
            Ok(_) => {}
            Err(error) => return Outcome::Unmeasurable(error),
        }
        let now = Instant::now();
        if now >= deadline {
            return Outcome::Timeout;
        }
        if !input.pump((now + SAMPLE_INTERVAL).min(deadline)) {
            return Outcome::CallerClosed;
        }
    }
}

/// Forwards exactly the framed input from the caller to the worker without
/// blocking, and watches the caller's lifeline throughout, including while
/// the worker is slow to take its input.
struct Input {
    remaining: u64,
    pending: Vec<u8>,
    sent: usize,
    /// None once the frame is forwarded or the worker closed its input.
    worker: Option<ChildStdin>,
}

impl Input {
    fn new(bytes: u64, worker: ChildStdin) -> io::Result<Input> {
        sys::set_nonblocking(0)?;
        sys::set_nonblocking(LIFELINE)?;
        sys::set_nonblocking(worker.as_raw_fd())?;
        let mut input = Input {
            remaining: bytes,
            pending: Vec::new(),
            sent: 0,
            worker: Some(worker),
        };
        input.close_when_forwarded();
        Ok(input)
    }

    fn close_when_forwarded(&mut self) {
        if self.remaining == 0 && self.sent == self.pending.len() {
            self.worker = None;
        }
    }

    /// Moves input until `until`. False when the caller is gone: its
    /// lifeline answered, or its input ended before the frame did.
    fn pump(&mut self, until: Instant) -> bool {
        loop {
            let now = Instant::now();
            if now >= until {
                return true;
            }
            let writing = self.sent < self.pending.len();
            let worker = self
                .worker
                .as_ref()
                .filter(|_| writing)
                .map_or(-1, AsRawFd::as_raw_fd);
            // Backpressure: read more of the frame only once the worker took
            // the last chunk. The lifeline stays watched either way.
            let caller = if writing || self.remaining == 0 {
                -1
            } else {
                0
            };
            let watch = [
                (LIFELINE, Wait::Read),
                (caller, Wait::Read),
                (worker, Wait::Write),
            ];
            let Ok(ready) = sys::poll(&watch, until - now) else {
                return false;
            };
            if ready[0] {
                return false;
            }
            if ready[2] {
                self.write();
            }
            if ready[1] && !self.read() {
                return false;
            }
        }
    }

    fn write(&mut self) {
        let Some(worker) = self.worker.as_mut() else {
            return;
        };
        match worker.write(&self.pending[self.sent..]) {
            Ok(count) => self.sent += count,
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
            // The worker closed its input. Keep reading the frame, so the
            // caller's protocol stays the same.
            Err(_) => self.worker = None,
        }
        if self.worker.is_none() || self.sent == self.pending.len() {
            self.pending.clear();
            self.sent = 0;
        }
        self.close_when_forwarded();
    }

    /// Reads the next part of the frame. False when the caller's input ended first.
    fn read(&mut self) -> bool {
        let mut buffer = [0u8; CHUNK];
        let wanted = usize::try_from(self.remaining).map_or(CHUNK, |left| left.min(CHUNK));
        match sys::read(0, &mut buffer[..wanted]) {
            Ok(0) => false,
            Ok(count) => {
                self.remaining -= count as u64;
                if self.worker.is_some() {
                    self.pending.extend_from_slice(&buffer[..count]);
                }
                self.close_when_forwarded();
                true
            }
            Err(error) => matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted),
        }
    }
}
