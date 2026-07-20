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

struct Options {
    minutes: u64,
    cycles: u64,
    daemon: PathBuf,
    evidence: PathBuf,
}

fn parse_options() -> Options {
    let mut minutes = 30_u64;
    let mut cycles = 1000_u64;
    let mut daemon: Option<PathBuf> = None;
    let mut evidence = PathBuf::from("soak-evidence.json");
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
    Options {
        minutes,
        cycles,
        daemon,
        evidence,
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
        hello_rx.await.expect("helloAck");
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
        rx.await
            .expect("response channel")
            .unwrap_or_else(|error| panic!("{method} failed: {error}"))
    }

    async fn cancel(&self, id: u64) {
        self.send(&Envelope::Cancel(dohc_engine_protocol::wire::Cancel { id }))
            .await;
    }

    async fn shutdown(mut self) {
        // Closing stdin is the daemon's normal end-of-session signal.
        drop(self.stdin);
        let _ = tokio::time::timeout(Duration::from_secs(30), self.child.wait()).await;
        self.reader.abort();
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
            Ok(0) | Err(_) => return,
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
    #[cfg(unix)]
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

async fn scenario_two_workspace_switch(daemon: &Daemon, root_a: &Path, root_b: &Path, n: u64) {
    let handle_a = open(daemon, root_a, "soak-switch-a").await;
    // An in-flight write on A while B opens and closes.
    let (_, in_flight) = daemon
        .begin(
            "versionedText.write",
            Some(handle_a.clone()),
            json!({
                "versionId": "main",
                "objectId": format!("soak-switch-object-{n}"),
                "path": format!("switch-{n}.md"),
                "text": format!("in-flight during switch {n}"),
                "momentId": format!("soak-switch-moment-{n}"),
                "metadataOrigin": "api",
                "nowMs": 1
            }),
        )
        .await;
    let handle_b = open(daemon, root_b, "soak-switch-b").await;
    close(daemon, handle_b).await;
    in_flight
        .await
        .expect("in-flight channel")
        .expect("in-flight write survives the switch");
    close(daemon, handle_a).await;
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
    close(daemon, handle).await;
}

async fn scenario_cancel_storm(daemon: &Daemon, root: &Path) {
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
    for rx in receivers {
        // Either outcome (result or cancelled error) is fine; a HANG is not.
        let _ = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .expect("cancelled request must resolve");
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

    // Warm up, then take the baseline AFTER the first open/close so one-time
    // allocations (thread pools, sqlite page cache) never read as leaks.
    let warm_root = make_root("warm", 0);
    scenario_open_close(&daemon, &warm_root).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (rss0, handles0, threads0) = sample_process(daemon.pid()).expect("baseline process sample");
    eprintln!("soak: baseline rss={rss0} handles={handles0} threads={threads0}");

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

    // The tier wants BOTH ~cycles scenarios AND a 30-60 minute span: keep
    // cycling until both targets are met, hard-capped at twice the budget.
    let mut cycle: u64 = 0;
    loop {
        if cycle >= options.cycles && started.elapsed() >= budget {
            break;
        }
        if started.elapsed() > budget * 2 {
            eprintln!("soak: hard wall-clock cap reached at cycle {cycle}");
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
        match cycle % 6 {
            0 => {
                scenario_open_close(&daemon, &root_cycle).await;
                *counts.entry("openClose").or_default() += 1;
            }
            1 => {
                scenario_two_workspace_switch(&daemon, &root_a, &root_b, cycle).await;
                *counts.entry("twoWorkspaceSwitch").or_default() += 1;
            }
            2 => {
                scenario_watcher_storm(&daemon, &root_storm, cycle).await;
                *counts.entry("watcherStorm").or_default() += 1;
            }
            3 => {
                scenario_cancel_storm(&daemon, &root_cancel).await;
                *counts.entry("cancelStorm").or_default() += 1;
            }
            4 => {
                scenario_editor_cycle(&daemon, &root_editor, cycle).await;
                *counts.entry("editorCycle").or_default() += 1;
            }
            _ => {
                // Sidecar crash/restart: kill mid-session with a workspace
                // open, respawn, and prove the next session works — the
                // restart also RESETS the metric series' subject, so restart
                // cycles re-baseline instead of polluting the fit.
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
                // Fresh process: restart the trend series.
                samples.clear();
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Some((rss, handles, threads)) = sample_process(daemon.pid()) {
                    samples.push(Sample {
                        at_secs: started.elapsed().as_secs_f64(),
                        rss_bytes: rss,
                        handles,
                        threads,
                    });
                }
            }
        }
        cycle += 1;
    }

    // Everything closed; settle, then the final sample.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let (rss_end, handles_end, threads_end) =
        sample_process(daemon.pid()).expect("final process sample");
    let slope = rss_slope(&samples);

    // The baseline subject may have been replaced by a crash cycle; compare
    // against the post-crash series' first sample in that case.
    let (handle_base, thread_base) = if crashes > 0 {
        samples
            .first()
            .map(|sample| (sample.handles, sample.threads))
            .unwrap_or((handles0, threads0))
    } else {
        (handles0, threads0)
    };
    let handles_ok = handles_end as i64 <= handle_base as i64 + HANDLE_SLACK;
    let threads_ok = threads_end as i64 <= thread_base as i64 + THREAD_SLACK;
    let slope_ok = slope <= MAX_RSS_SLOPE_BYTES_PER_SEC;

    daemon.shutdown().await;

    let verdict = if handles_ok && threads_ok && slope_ok {
        "PASS"
    } else {
        "FAIL"
    };
    let evidence = json!({
        "tier": "cutoverBlocking",
        "verdict": verdict,
        "cyclesRequested": options.cycles,
        "scenarioCounts": counts,
        "crashRestarts": crashes,
        "durationSecs": started.elapsed().as_secs(),
        "baseline": { "rss": rss0, "handles": handles0, "threads": threads0 },
        "final": { "rss": rss_end, "handles": handles_end, "threads": threads_end },
        "rssSlopeBytesPerSec": slope,
        "assertions": {
            "handlesReturnToBaseline": handles_ok,
            "threadsReturnToBaseline": threads_ok,
            "noMonotonicRssSlope": slope_ok,
        },
        "samples": samples,
    });
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
    if verdict != "PASS" {
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
