//! The cutoverBlocking SOAK RUNNER (GATE6 evidence).
//!
//! Drives the REAL daemon binary over DOP1 stdio through the scenario mix
//! `tools/rust-engine-program/soak-config.json` specifies for the
//! `cutoverBlocking` tier — open/close cycling, sidecar crash/restart loops,
//! two-workspace switches with in-flight requests, watcher storms,
//! cancellation storms, and editor (Y.Doc) cycles — while sampling the
//! daemon process's RSS / handle count / thread count, then fits a linear
//! trend to RSS and checks return-to-baseline for handles and threads.
//!
//! Harness-only by construction (`required-features = ["harness"]`): the
//! runner writes shadow markers, so production builds never compile it.
//!
//!   cargo run --features harness --bin dohc-soak-runner -- \
//!       [--minutes 30] [--cycles 1000] [--quick] [--daemon <path>] \
//!       [--evidence <out.json>]
//!
//! Prints an EXECUTION_LOG-style evidence line and writes the full sample
//! series as JSON. Exit code 0 only if every assertion passed.

#![forbid(unsafe_code)]

use base64::Engine as _;
use dohc_engine_protocol::{
    frame::{Frame, FrameDecoder},
    limits::WireLimits,
    wire::{Envelope, Hello, PROTOCOL_VERSION, Request, decode_control, encode_control},
};
use dohc_workspace_engine::shadow_fence::write_shadow_marker_for_harness;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_EVERY: Duration = Duration::from_secs(5);
/// Windows handle counts are noisy (thread pools, timers); the assertion is
/// "returns to baseline plus a documented constant", and this is the
/// documented constant.
const HANDLE_SLACK: i64 = 48;
const THREAD_SLACK: i64 = 8;
/// A true leak over a 30–60 minute run dwarfs this; transient allocator
/// behavior does not.
const MAX_RSS_SLOPE_BYTES_PER_SEC: f64 = 20.0 * 1024.0;
/// The trend fit is only evidence with enough samples behind it: below this
/// the slope assertion FAILS rather than passing vacuously.
const MIN_TREND_SAMPLES: usize = 24;
/// ...and with enough WALL-CLOCK span: a short window cannot distinguish
/// cache warmup from a leak (a 3-minute quick run measures ~80 KiB/s of
/// page-cache fill on a healthy daemon). Below this span the trend is
/// reported as NOT EVALUATED — never as leak evidence in either direction.
const MIN_TREND_SPAN_SECS: f64 = 900.0;

struct Options {
    minutes: u64,
    cycles: u64,
    daemon: PathBuf,
    evidence: PathBuf,
    /// The caller ASKED for a smoke: PASS-SCENARIOS-ONLY is then a
    /// successful exit. A full run that degrades to it is not.
    quick: bool,
}

fn parse_options() -> Options {
    let mut minutes = 30_u64;
    let mut cycles = 1000_u64;
    let mut daemon: Option<PathBuf> = None;
    let mut evidence = PathBuf::from("soak-evidence.json");
    let mut quick = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--minutes" => minutes = args.next().expect("--minutes N").parse().expect("minutes"),
            "--cycles" => cycles = args.next().expect("--cycles N").parse().expect("cycles"),
            "--daemon" => daemon = Some(PathBuf::from(args.next().expect("--daemon PATH"))),
            "--evidence" => evidence = PathBuf::from(args.next().expect("--evidence PATH")),
            "--quick" => {
                minutes = 3;
                cycles = 36;
                quick = true;
            }
            other => panic!("unknown argument {other}"),
        }
    }
    let daemon = daemon.unwrap_or_else(|| {
        let mut path = std::env::current_exe().expect("current exe");
        path.set_file_name(if cfg!(windows) {
            "dohc-workspace-engine.exe"
        } else {
            "dohc-workspace-engine"
        });
        path
    });
    // `cargo run --bin dohc-soak-runner` builds ONLY the runner; the sibling
    // daemon exe is a separate target. Fail with instructions instead of a
    // cryptic spawn error.
    assert!(
        daemon.exists(),
        "daemon binary not found at {} — build both:          cargo build --features harness --bin dohc-soak-runner --bin dohc-workspace-engine",
        daemon.display()
    );
    Options {
        minutes,
        cycles,
        daemon,
        evidence,
        quick,
    }
}

// ---------------------------------------------------------------- DOP1 client

/// In-flight request table: id -> the caller waiting on its result.
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Daemon {
    child: Child,
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
    limits: WireLimits,
    reader: tokio::task::JoinHandle<()>,
}

impl Daemon {
    async fn spawn(daemon: &Path) -> Daemon {
        let mut child = Command::new(daemon)
            .env("DOHC_ENGINE_AUTH_TOKEN", TOKEN)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn daemon");
        let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().expect("stdin")));
        let stdout = child.stdout.take().expect("stdout");
        let limits = WireLimits::default();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (hello_tx, hello_rx) = oneshot::channel();
        let reader = tokio::spawn(read_loop(
            stdout,
            limits.clone(),
            Arc::clone(&pending),
            hello_tx,
        ));

        let daemon = Daemon {
            child,
            stdin,
            pending,
            next_id: AtomicU64::new(1),
            limits,
            reader,
        };
        daemon
            .send(&Envelope::Hello(Hello {
                protocol_version: PROTOCOL_VERSION,
                auth_token: TOKEN.to_owned(),
                capabilities: Vec::new(),
                last_session_generation: None,
            }))
            .await;
        // A daemon that starts but never completes the handshake must fail
        // the run, not block it forever.
        tokio::time::timeout(Duration::from_secs(30), hello_rx)
            .await
            .expect("daemon sent no HelloAck within 30s")
            .expect("helloAck");
        daemon
    }

    async fn send(&self, envelope: &Envelope) {
        // encode_control emits the COMPLETE DOP1 frame (header + payload) —
        // wrapping it again would double-frame and the daemon would reject
        // the inner bytes as an invalid envelope.
        let frame = encode_control(envelope, &self.limits).expect("encode envelope");
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&frame).await.expect("write frame");
        stdin.flush().await.expect("flush frame");
    }

    /// Fire a request; the returned receiver resolves with the response.
    async fn begin(
        &self,
        method: &str,
        workspace: Option<Value>,
        params: Value,
    ) -> (u64, oneshot::Receiver<Result<Value, String>>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending").insert(id, tx);
        let workspace = workspace
            .map(|handle| serde_json::from_value(handle).expect("workspace handle"))
            .or(None);
        self.send(&Envelope::Request(Request {
            id,
            method: method.to_owned(),
            workspace,
            deadline_ms: None,
            idempotency_key: None,
            params,
        }))
        .await;
        (id, rx)
    }

    async fn call(&self, method: &str, workspace: Option<Value>, params: Value) -> Value {
        let (_, rx) = self.begin(method, workspace, params).await;
        // A handler that hangs (alive but never answering) must become a
        // failing verdict, not an eternal await.
        tokio::time::timeout(Duration::from_secs(60), rx)
            .await
            .unwrap_or_else(|_| panic!("{method}: no response within 60s — daemon hang"))
            .expect("response channel")
            .unwrap_or_else(|error| panic!("{method} failed: {error}"))
    }

    async fn cancel(&self, id: u64) {
        self.send(&Envelope::Cancel(dohc_engine_protocol::wire::Cancel { id }))
            .await;
    }

    /// Returns whether the daemon exited cleanly within the deadline after
    /// stdin close — a shutdown deadlock is a soak FAILURE, not a footnote
    /// for kill_on_drop to paper over.
    async fn shutdown(mut self) -> bool {
        // Closing stdin is the daemon's normal end-of-session signal. Clean
        // means exited IN TIME and SUCCESSFULLY — a non-zero exit status is
        // a reported shutdown failure, not a footnote.
        drop(self.stdin);
        let clean = match tokio::time::timeout(Duration::from_secs(30), self.child.wait()).await {
            Ok(Ok(status)) => status.success(),
            Ok(Err(_)) | Err(_) => false,
        };
        self.reader.abort();
        clean
    }

    async fn kill(mut self) {
        let _ = self.child.kill().await;
        self.reader.abort();
    }

    fn pid(&self) -> u32 {
        self.child.id().expect("daemon pid")
    }
}

async fn read_loop(
    stdout: tokio::process::ChildStdout,
    limits: WireLimits,
    pending: Pending,
    hello_tx: oneshot::Sender<()>,
) {
    use tokio::io::AsyncReadExt;
    let mut stdout = stdout;
    let mut decoder = FrameDecoder::new(limits.clone());
    let mut buf = vec![0_u8; 64 * 1024];
    let mut hello_tx = Some(hello_tx);
    loop {
        let read = match stdout.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        decoder.push(&buf[..read]);
        while let Ok(Some(frame)) = decoder.next_frame() {
            let Frame::Control(payload) = frame else {
                continue;
            };
            let Ok(envelope) = decode_control(&payload, &limits) else {
                continue;
            };
            match envelope {
                Envelope::HelloAck(_) => {
                    if let Some(tx) = hello_tx.take() {
                        let _ = tx.send(());
                    }
                }
                Envelope::Response(response) => {
                    if let Some(tx) = pending.lock().expect("pending").remove(&response.id) {
                        let _ = tx.send(Ok(response.result));
                    }
                }
                Envelope::Error(error) => {
                    if let Some(id) = error.id {
                        if let Some(tx) = pending.lock().expect("pending").remove(&id) {
                            let _ = tx.send(Err(format!("{:?}", error.error)));
                        }
                    } else {
                        eprintln!("soak: session error from daemon: {:?}", error.error);
                    }
                }
                other => {
                    let _ = &other;
                }
            }
        }
    }
    // The daemon closed stdout (crash or shutdown) — every request still in
    // flight would await a sender that can never fire. Fail them so a daemon
    // death mid-scenario is a failing run, not a hang.
    let in_flight: Vec<_> = pending
        .lock()
        .expect("pending")
        .drain()
        .map(|(_, tx)| tx)
        .collect();
    for tx in in_flight {
        let _ = tx.send(Err(
            "daemon closed stdout with the request in flight".to_owned()
        ));
    }
}

// ------------------------------------------------------------------- metrics

#[derive(Debug, Clone, serde::Serialize)]
struct Sample {
    at_secs: f64,
    rss_bytes: u64,
    handles: u64,
    threads: u64,
}

fn sample_process(pid: u32) -> Option<(u64, u64, u64)> {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "$p = Get-Process -Id {pid}; \
                     \"$($p.WorkingSet64) $($p.HandleCount) $($p.Threads.Count)\""
                ),
            ])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut parts = text.split_whitespace();
        Some((
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        ))
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        let field = |name: &str| -> Option<u64> {
            status
                .lines()
                .find(|line| line.starts_with(name))?
                .split_whitespace()
                .nth(1)?
                .parse()
                .ok()
        };
        let rss_kib = field("VmRSS:")?;
        let threads = field("Threads:")?;
        let handles = std::fs::read_dir(format!("/proc/{pid}/fd"))
            .map(|dir| dir.count() as u64)
            .unwrap_or(0);
        Some((rss_kib * 1024, handles, threads))
    }
    #[cfg(target_os = "macos")]
    {
        // /proc does not exist on macOS. RSS (KiB) via ps; thread count via
        // the mandatory `wq` state column trick is unreliable, so use
        // `ps -M` line count; open-file count via lsof (slow but fine at
        // the 5s sample cadence).
        let ps = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let rss_kib: u64 = String::from_utf8_lossy(&ps.stdout).trim().parse().ok()?;
        let threads_out = std::process::Command::new("ps")
            .args(["-M", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let thread_lines = String::from_utf8_lossy(&threads_out.stdout)
            .lines()
            .count()
            .saturating_sub(1) as u64;
        let lsof = std::process::Command::new("lsof")
            .args(["-p", &pid.to_string()])
            .output()
            .ok()?;
        let handles = String::from_utf8_lossy(&lsof.stdout)
            .lines()
            .count()
            .saturating_sub(1) as u64;
        Some((rss_kib * 1024, handles, thread_lines))
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        // Fail loudly rather than emit evidence from a platform whose
        // sampling was never implemented.
        let _ = pid;
        panic!("soak sampling is not implemented for this platform");
    }
}

/// Least-squares slope of RSS over time, bytes/second.
fn rss_slope(samples: &[Sample]) -> f64 {
    let n = samples.len() as f64;
    if n < 3.0 {
        return 0.0;
    }
    let mean_t = samples.iter().map(|s| s.at_secs).sum::<f64>() / n;
    let mean_y = samples.iter().map(|s| s.rss_bytes as f64).sum::<f64>() / n;
    let mut cov = 0.0;
    let mut var = 0.0;
    for sample in samples {
        let dt = sample.at_secs - mean_t;
        cov += dt * (sample.rss_bytes as f64 - mean_y);
        var += dt * dt;
    }
    if var == 0.0 { 0.0 } else { cov / var }
}

// ----------------------------------------------------------------- scenarios

fn make_root(tag: &str, seq: u64) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut root = std::env::temp_dir();
    root.push(format!(
        "dohc-soak-{tag}-{}-{}-{seq}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).expect("mkdir root");
    write_shadow_marker_for_harness(&root, TOKEN).expect("shadow marker");
    root
}

async fn open(daemon: &Daemon, root: &Path, workspace_id: &str) -> Value {
    let opened = daemon
        .call(
            "workspace.open",
            None,
            json!({
                "rootDir": root.to_string_lossy(),
                "workspaceId": workspace_id,
            }),
        )
        .await;
    opened["workspace"].clone()
}

async fn close(daemon: &Daemon, handle: Value) {
    daemon
        .call("workspace.close", Some(handle), json!({}))
        .await;
}

async fn flush_until_settled(daemon: &Daemon, handle: &Value, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        let flushed = daemon
            .call("capture.flush", Some(handle.clone()), json!({}))
            .await;
        if flushed["settled"] == json!(true) {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn scenario_open_close(daemon: &Daemon, root: &Path) {
    let handle = open(daemon, root, "soak-open-close").await;
    close(daemon, handle).await;
}

/// Returns whether the write was still IN FLIGHT when workspace B opened —
/// the path this scenario advertises. Fast runs can complete the write
/// first; the caller counts overlapped cycles separately so the evidence
/// never claims coverage the run didn't have.
async fn scenario_two_workspace_switch(
    daemon: &Daemon,
    root_a: &Path,
    root_b: &Path,
    n: u64,
) -> bool {
    let handle_a = open(daemon, root_a, "soak-switch-a").await;
    // An in-flight write on A while B opens and closes. The payload is
    // deliberately bulky — but bounded by the DOP1 wire limit on string
    // fields (64 KiB), which the first smoke of this scenario tripped at
    // 256 KiB. ~45 KiB keeps headroom while still straddling the switch
    // more often than a one-liner.
    let text = format!("in-flight during switch {n}\n").repeat(1600);
    let (_, mut in_flight) = daemon
        .begin(
            "versionedText.write",
            Some(handle_a.clone()),
            json!({
                "versionId": "main",
                "objectId": format!("soak-switch-object-{n}"),
                "path": format!("switch-{n}.md"),
                "text": text,
                "momentId": format!("soak-switch-moment-{n}"),
                "metadataOrigin": "api",
                "nowMs": 1
            }),
        )
        .await;
    let handle_b = open(daemon, root_b, "soak-switch-b").await;
    // try_recv CONSUMES a value that already completed — the answer must be
    // threaded through, never awaited again (polling a consumed oneshot
    // panics "called after complete").
    let early = in_flight.try_recv();
    let overlapped = matches!(early, Err(tokio::sync::oneshot::error::TryRecvError::Empty));
    close(daemon, handle_b).await;
    let answer = match early {
        Ok(answer) => answer,
        Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
            tokio::time::timeout(Duration::from_secs(60), in_flight)
                .await
                .expect("in-flight write answered within 60s")
                .expect("in-flight channel")
        }
        Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
            panic!("in-flight channel closed without an answer")
        }
    };
    answer.expect("in-flight write survives the switch");
    close(daemon, handle_a).await;
    overlapped
}

async fn scenario_watcher_storm(daemon: &Daemon, root: &Path, n: u64) {
    let handle = open(daemon, root, "soak-storm").await;
    for burst in 0..25 {
        std::fs::write(
            root.join(format!("storm/burst-{n}-{burst}.md")),
            format!("storm {n} file {burst}"),
        )
        .unwrap_or_else(|_| {
            std::fs::create_dir_all(root.join("storm")).expect("storm dir");
            std::fs::write(
                root.join(format!("storm/burst-{n}-{burst}.md")),
                format!("storm {n} file {burst}"),
            )
            .expect("storm write");
        });
    }
    assert!(
        flush_until_settled(daemon, &handle, Duration::from_secs(60)).await,
        "watcher storm must settle"
    );
    // A settled flush is NOT proof the burst was captured: writes still
    // inside the OS debounce are invisible to flush (the capture.flush
    // contract). Prove ingestion — one burst path must become readable,
    // re-flushing while the debounce drains.
    let probe = format!("storm/burst-{n}-0.md");
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let (_, rx) = daemon
            .begin(
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": probe }),
            )
            .await;
        let answer = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .expect("storm probe read resolves")
            .expect("response channel");
        if answer.is_ok() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "storm burst was never captured within 60s"
        );
        assert!(
            flush_until_settled(daemon, &handle, Duration::from_secs(60)).await,
            "watcher storm re-flush must settle"
        );
    }
    close(daemon, handle).await;
}

/// Returns how many of the storm's cancellations were OBSERVED (a request
/// answered `Cancelled`). Fast completions make a cancel a no-op; the run
/// aggregates this count into the evidence so a soak where cancellation
/// recovery was never actually exercised is visible, not assumed.
async fn scenario_cancel_storm(daemon: &Daemon, root: &Path) -> u64 {
    let handle = open(daemon, root, "soak-cancel").await;
    let mut receivers = Vec::new();
    for _ in 0..16 {
        let (id, rx) = daemon
            .begin(
                "versionedText.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "cancel-target.md" }),
            )
            .await;
        daemon.cancel(id).await;
        receivers.push(rx);
    }
    let mut cancellations_observed = 0_u64;
    for rx in receivers {
        // Either outcome (result or cancelled error) is fine; a HANG is not.
        let answer = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .expect("cancelled request must resolve");
        if let Ok(Err(error)) = answer {
            if error.contains("Cancelled") {
                cancellations_observed += 1;
            }
        }
    }
    // The queue must recover: a normal request still RESOLVES (the path does
    // not exist, so an error result is fine — a hang is not).
    let (_, rx) = daemon
        .begin(
            "versionedText.read",
            Some(handle.clone()),
            json!({ "versionId": "main", "path": "cancel-target.md" }),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .expect("post-storm request must resolve")
        .expect("response channel")
        .ok();
    close(daemon, handle).await;
    cancellations_observed
}

async fn scenario_editor_cycle(daemon: &Daemon, root: &Path, n: u64) {
    use dohc_engine_collab::Ydoc;
    let handle = open(daemon, root, "soak-editor").await;
    // Y.Doc updates apply to an EXISTING object lineage: seed it first.
    daemon
        .call(
            "versionedText.write",
            Some(handle.clone()),
            json!({
                "versionId": "main",
                "objectId": format!("soak-editor-object-{n}"),
                "path": format!("editor-{n}.md"),
                "text": "seed",
                "momentId": format!("soak-editor-seed-{n}"),
                "metadataOrigin": "api",
                "nowMs": 1
            }),
        )
        .await;
    let doc = Ydoc::wire();
    for edit in 0..5 {
        let update = doc.plaintext_insert(0, &format!("edit {n}-{edit} "));
        daemon
            .call(
                "ydoc.apply",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": format!("soak-editor-object-{n}"),
                    "contentKind": "plaintext",
                    "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
                    "nowMs": 1
                }),
            )
            .await;
    }
    close(daemon, handle).await;
}

// ---------------------------------------------------------------------- main

#[tokio::main]
async fn main() {
    let options = parse_options();
    let started = Instant::now();
    let budget = Duration::from_secs(options.minutes * 60);
    eprintln!(
        "soak: cutoverBlocking tier — {} cycles / {} min budget, daemon {}",
        options.cycles,
        options.minutes,
        options.daemon.display()
    );

    let mut daemon = Daemon::spawn(&options.daemon).await;

    // Warm up the initial (phase-1) process; the LEAK baseline is taken on
    // the dedicated phase-2 subject below.
    let warm_root = make_root("warm", 0);
    scenario_open_close(&daemon, &warm_root).await;

    let root_cycle = make_root("cycle", 0);
    let root_a = make_root("a", 0);
    let root_b = make_root("b", 0);
    let root_storm = make_root("storm", 0);
    let root_cancel = make_root("cancel", 0);
    let root_editor = make_root("editor", 0);
    let root_crash = make_root("crash", 0);

    let mut samples: Vec<Sample> = Vec::new();
    let mut last_sample = Instant::now() - SAMPLE_EVERY;
    let mut counts: HashMap<&'static str, u64> = HashMap::new();
    let mut crashes = 0_u64;

    // TWO PHASES, deliberately. Interleaving crash/restart cycles with the
    // leak-trend measurement made the trend VACUOUS: each restart replaced
    // the measured process and cleared the sample series, so the slope was
    // fit over a few seconds of tail and no process was ever soaked longer
    // than a handful of cycles. Phase 1 runs the crash-recovery tier against
    // disposable processes; phase 2 soaks ONE process, uninterrupted, for
    // the entire remaining cycle/time budget — the trend fit and the
    // return-to-baseline assertions are measured over phase 2 only.
    let crash_cycles = (options.cycles / 12).max(3);
    eprintln!("soak: phase 1 — {crash_cycles} crash/restart recovery cycles");
    for cycle in 0..crash_cycles {
        if started.elapsed() > budget {
            break;
        }
        let handle = open(&daemon, &root_crash, "soak-crash").await;
        std::fs::write(root_crash.join("crash-window.md"), format!("cycle {cycle}"))
            .expect("crash-window write");
        let _ = handle;
        daemon.kill().await;
        daemon = Daemon::spawn(&options.daemon).await;
        let handle = open(&daemon, &root_crash, "soak-crash").await;
        assert!(
            flush_until_settled(&daemon, &handle, Duration::from_secs(60)).await,
            "post-crash reopen must settle (the un-acked write re-offers)"
        );
        close(&daemon, handle).await;
        crashes += 1;
        *counts.entry("crashRestart").or_default() += 1;
    }

    // Phase 2 subject: a FRESH process, then a warmup open/close so one-time
    // allocations never read as trend, then its baseline.
    daemon.kill().await;
    daemon = Daemon::spawn(&options.daemon).await;
    scenario_open_close(&daemon, &root_cycle).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (rss_base, handles_base, threads_base) =
        sample_process(daemon.pid()).expect("phase-2 baseline sample");
    eprintln!(
        "soak: phase 2 — leak-trend soak on one process \
         (baseline rss={rss_base} handles={handles_base} threads={threads_base})"
    );
    let mut cycle: u64 = 0;
    let mut hard_capped = false;
    let mut cancellations_observed: u64 = 0;
    loop {
        if cycle >= options.cycles && started.elapsed() >= budget {
            break;
        }
        if started.elapsed() > budget * 2 {
            eprintln!("soak: hard wall-clock cap reached at cycle {cycle}");
            hard_capped = true;
            break;
        }
        if last_sample.elapsed() >= SAMPLE_EVERY {
            if let Some((rss, handles, threads)) = sample_process(daemon.pid()) {
                samples.push(Sample {
                    at_secs: started.elapsed().as_secs_f64(),
                    rss_bytes: rss,
                    handles,
                    threads,
                });
            }
            last_sample = Instant::now();
        }
        match cycle % 5 {
            0 => {
                scenario_open_close(&daemon, &root_cycle).await;
                *counts.entry("openClose").or_default() += 1;
            }
            1 => {
                let overlapped =
                    scenario_two_workspace_switch(&daemon, &root_a, &root_b, cycle).await;
                *counts.entry("twoWorkspaceSwitch").or_default() += 1;
                if overlapped {
                    *counts.entry("twoWorkspaceSwitchOverlapped").or_default() += 1;
                }
            }
            2 => {
                scenario_watcher_storm(&daemon, &root_storm, cycle).await;
                *counts.entry("watcherStorm").or_default() += 1;
            }
            3 => {
                cancellations_observed += scenario_cancel_storm(&daemon, &root_cancel).await;
                *counts.entry("cancelStorm").or_default() += 1;
            }
            _ => {
                scenario_editor_cycle(&daemon, &root_editor, cycle).await;
                *counts.entry("editorCycle").or_default() += 1;
            }
        }
        cycle += 1;
    }

    // Everything closed; settle, then the final sample — all against the
    // phase-2 subject and ITS baseline.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let (rss_end, handles_end, threads_end) =
        sample_process(daemon.pid()).expect("final process sample");
    // The final sample joins the trend series: an RSS jump in the last
    // scenario after the most recent periodic sample must not escape the
    // fit that rssDisposition is computed from.
    samples.push(Sample {
        at_secs: started.elapsed().as_secs_f64(),
        rss_bytes: rss_end,
        handles: handles_end,
        threads: threads_end,
    });
    let slope = rss_slope(&samples);
    let (handle_base, thread_base) = (handles_base, threads_base);
    let handles_ok = handles_end as i64 <= handle_base as i64 + HANDLE_SLACK;
    let threads_ok = threads_end as i64 <= thread_base as i64 + THREAD_SLACK;
    // The trend verdict is TRI-STATE: evaluated-and-ok, evaluated-and-FAIL,
    // or NOT EVALUATED (too few samples / too short a span — quick runs).
    // Not-evaluated never reads as leak evidence: the run can still PASS on
    // scenario correctness, but the evidence records trendEvaluated:false
    // and a GATE6 citation requires trendEvaluated:true.
    let fit_span = match (samples.first(), samples.last()) {
        (Some(first), Some(last)) => last.at_secs - first.at_secs,
        _ => 0.0,
    };
    let trend_evaluated = samples.len() >= MIN_TREND_SAMPLES && fit_span >= MIN_TREND_SPAN_SECS;
    let slope_ok = !trend_evaluated || slope <= MAX_RSS_SLOPE_BYTES_PER_SEC;

    let clean_shutdown = daemon.shutdown().await;

    let verdict = if !(handles_ok && threads_ok && slope_ok && clean_shutdown) {
        "FAIL"
    } else if hard_capped {
        // The requested targets were NOT met — evidence, but not the tier's.
        "PASS-INCOMPLETE(hard-cap)"
    } else if !trend_evaluated {
        "PASS-SCENARIOS-ONLY(trend-not-evaluated)"
    } else {
        "PASS"
    };
    let evidence = json!({
        "tier": "cutoverBlocking",
        "verdict": verdict,
        "cyclesRequested": options.cycles,
        // Phase-2 WORKLOAD cycles only — the phase-1 crash prelude reports
        // under crashRestarts/scenarioCounts, never in this denominator.
        "cyclesCompleted": cycle,
        "scenarioCounts": counts,
        // How many cancel-storm cancellations were actually OBSERVED (a
        // request answered Cancelled) — fast completions make a cancel a
        // no-op, and a run that never exercised cancellation recovery must
        // be visible as such, not assumed covered.
        "cancelStormCancellationsObserved": cancellations_observed,
        "crashRestarts": crashes,
        "durationSecs": started.elapsed().as_secs(),
        "baseline": { "rss": rss_base, "handles": handles_base, "threads": threads_base },
        "trendSamples": samples.len(),
        "minTrendSamples": MIN_TREND_SAMPLES,
        "trendFitSpanSecs": fit_span,
        "trendEvaluated": trend_evaluated,
        "cleanShutdown": clean_shutdown,
        "hardCapped": hard_capped,
        // Auditable tolerances: the exact bounds the assertions above used.
        "tolerances": {
            "handleSlack": HANDLE_SLACK,
            "threadSlack": THREAD_SLACK,
            "maxRssSlopeBytesPerSec": MAX_RSS_SLOPE_BYTES_PER_SEC,
            "minTrendSamples": MIN_TREND_SAMPLES,
            "minTrendSpanSecs": MIN_TREND_SPAN_SECS,
        },
        // Explicit tri-state memory disposition (phase 2 is a SINGLE process
        // by design — no restart epochs in the series).
        "rssDisposition": if !trend_evaluated {
            "NOT-EVALUATED"
        } else if slope <= MAX_RSS_SLOPE_BYTES_PER_SEC {
            "PASS"
        } else {
            "FAIL"
        },
        "final": { "rss": rss_end, "handles": handles_end, "threads": threads_end },
        "rssSlopeBytesPerSec": slope,
        "assertions": {
            "handlesReturnToBaseline": handles_ok,
            "threadsReturnToBaseline": threads_ok,
            // Tri-state: null when the trend was not evaluated, so a
            // scenarios-only artifact can never read as leak evidence.
            "noMonotonicRssSlope": if trend_evaluated {
                json!(slope <= MAX_RSS_SLOPE_BYTES_PER_SEC)
            } else {
                json!(null)
            },
        },
        // Config assertions this runner does NOT measure, named in the
        // artifact itself so a PASS can never be read as covering them
        // (dispositions in soak-config.json).
        "unmeasuredAssertions": [
            "queue-steady-state",
            "workspace-close-resource-return-beyond-actor-count",
            "wal-update-log-index-growth",
        ],
        "samples": samples,
    });
    if let Some(parent) = options.evidence.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).expect("create evidence directory");
        }
    }
    std::fs::write(
        &options.evidence,
        serde_json::to_string_pretty(&evidence).expect("serialize evidence"),
    )
    .expect("write evidence");

    println!(
        "- {} | soak-cutoverBlocking | {}/{} | {} | cycles={} crashes={} durationSecs={} \
         rssSlopeB/s={:.1} handles {}->{} threads {}->{}",
        chrono_like_now(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        verdict,
        counts.values().sum::<u64>(),
        crashes,
        started.elapsed().as_secs(),
        slope,
        handle_base,
        handles_end,
        thread_base,
        threads_end,
    );
    // PASS exits 0. A REQUESTED smoke (--quick) legitimately reports
    // PASS-SCENARIOS-ONLY and also exits 0 — the caller asked for a run
    // that cannot evaluate a trend. Everything else (FAIL, a FULL run that
    // degraded to trend-not-evaluated, a hard-capped run) did not meet its
    // tier's targets: non-zero, so a CI gate checking only the process
    // status can never accept incomplete cutover evidence.
    let acceptable = verdict == "PASS"
        || (options.quick && verdict == "PASS-SCENARIOS-ONLY(trend-not-evaluated)");
    if !acceptable {
        std::process::exit(1);
    }
}

/// RFC3339-ish UTC timestamp without pulling in chrono.
fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock");
    let secs = now.as_secs();
    let days = secs / 86_400;
    let (mut year, mut remaining) = (1970_i64, days as i64);
    loop {
        let len = if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
            366
        } else {
            365
        };
        if remaining < len {
            break;
        }
        remaining -= len;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for len in lengths {
        if remaining < len {
            break;
        }
        remaining -= len;
        month += 1;
    }
    format!(
        "{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}Z",
        remaining + 1,
        (secs / 3600) % 24,
        (secs / 60) % 60,
        secs % 60
    )
}
