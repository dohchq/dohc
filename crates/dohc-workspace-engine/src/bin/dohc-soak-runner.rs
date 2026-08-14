//! The cutoverBlocking SOAK RUNNER (GATE6 evidence), with an explicit
//! `--quick` smoke mode that cannot produce cutoverBlocking evidence.
//!
//! Drives the REAL daemon binary over DOP1 stdio through the scenario mix
//! `tools/rust-engine-program/soak-config.json` specifies for the
//! `cutoverBlocking` tier — open/close cycling, sidecar crash/restart loops,
//! two-workspace switches with in-flight requests, watcher storms,
//! cancellation storms, and editor (Y.Doc) cycles — while sampling the
//! daemon process's RSS / handle count / thread count, then stops work for an
//! unaided idle drain before combining the workload RSS trend, drain
//! reclamation, and return-to-baseline handle/thread checks.
//!
//! Harness-only by construction (`required-features = ["harness"]`): the
//! runner writes shadow markers, so production builds never compile it.
//!
//!   cargo run --features harness --bin dohc-soak-runner -- \
//!       [--minutes 60] [--cycles 1000] [--quick] [--daemon <path>] \
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
/// Once the workload stops, keep the same daemon alive and observe what its
/// allocator returns to the OS without pressure-relief or purge calls.
const DRAIN_WINDOW: Duration = Duration::from_secs(120);
/// A start, an end, and enough interior observations to reject a one-sample
/// blip. The normal 120s / 5s cadence produces 25 samples.
const MIN_DRAIN_SAMPLES: usize = 5;
/// "Near the pre-run plateau" means no more than one quarter of the run's RSS
/// growth remains at the end of the unaided drain.
const DRAIN_RECLAIMED_MIN_FRACTION: f64 = 0.75;
/// Windows handle counts are noisy (thread pools, timers); the assertion is
/// "returns to baseline plus a documented constant", and this is the
/// documented constant.
const HANDLE_SLACK: i64 = 48;
const THREAD_SLACK: i64 = 8;
/// A true leak over a 30–90 minute run dwarfs this; transient allocator
/// behavior does not.
const MAX_RSS_SLOPE_BYTES_PER_SEC: f64 = 20.0 * 1024.0;
/// A trend fit is only evidence with enough samples behind it.
const MIN_TREND_SAMPLES: usize = 24;
/// A fit also needs enough WALL-CLOCK span: a short window cannot distinguish
/// cache warmup from a leak (a 3-minute quick run measures ~80 KiB/s of
/// page-cache fill on a healthy daemon). Below this span the trend is
/// reported as NOT EVALUATED — never as leak evidence in either direction.
const MIN_TREND_SPAN_SECS: f64 = 900.0;
const DEFAULT_FULL_SOAK_MINUTES: u64 = 60;
/// How many distinct object/path identities each phase-2 scenario rotates
/// through. Keying identities on the raw cycle counter made every cycle mint a
/// NEW permanent object, path, blob and FTS entry, so the workspace grew
/// without bound and the RSS trend measured that growth rather than any leak.
/// A ring keeps the scenarios' shape — several concurrent identities, real
/// content changes on every write — while bounding the durable content the
/// workload can ever create.
const IDENTITY_RING: u64 = 8;
/// How many scenarios the phase-2 loop rotates through (`cycle % 5`). The
/// content discriminator below divides by this, so a scenario's successive
/// visits are what alternate — deriving it from IDENTITY_RING instead made
/// the property depend on `gcd(scenarios, ring)` being right, a coupling
/// between two constants a thousand lines apart that nothing asserted.
const SCENARIO_ROTATION: u64 = 5;
/// Distinct content variants per identity. Two would be enough to keep
/// successive writes from being byte-identical, but a read that is stale by
/// TWO visits would then carry the expected bytes and pass. Four means a
/// probe only accepts content at most three visits old, while still bounding
/// the workload to `IDENTITY_RING * CONTENT_VARIANTS` distinct payloads.
const CONTENT_VARIANTS: u64 = 4;
/// How much the phase-2 LIVE WORKING SET may grow, in user files across all
/// phase-2 roots.
///
/// Not a byte budget. Durable bytes grow no matter what the workload does:
/// `moments` is append-only, every write needs a fresh `momentId` (reusing
/// one is short-circuited as a replay), and nothing prunes history — so
/// demanding that bytes stop growing would demand the workload stop working.
/// Bytes also do not drive RSS: no `cache_size` pragma is set, so SQLite's
/// page cache stays at its 2 MB default and a larger database does not become
/// a larger process.
///
/// What DOES drive RSS is the live working set, because opening a workspace
/// loads a manifest of every captured entry. The old workload grew that set
/// by 25 files per storm cycle, past 57,000 files, so each reopen allocated a
/// manifest proportional to a linearly growing tree and the allocator's high
/// water mark tracked it. That is a structural bound, independent of machine
/// speed and run length, which an absolute byte cap could never be.
const MAX_WORKING_SET_FILE_GROWTH: u64 = 64;

/// The identity this cycle writes to, and a content discriminator that
/// advances on each successive visit to that identity. Without it, every
/// write to a rotating path would carry byte-identical content, and a store
/// that short-circuits unchanged writes would turn the scenario into a no-op
/// that still counted cycles.
fn identity_slot(n: u64) -> (u64, u64) {
    (
        n % IDENTITY_RING,
        (n / SCENARIO_ROTATION) % CONTENT_VARIANTS,
    )
}

/// What the phase-2 roots hold: user files (the live working set that every
/// workspace open builds a manifest from) counted separately from total bytes
/// on disk (diagnostic only — see MAX_WORKING_SET_FILE_GROWTH for why bytes
/// are not the bound).
///
/// This exists because an RSS slope is only leak evidence if the thing that
/// drives RSS stays bounded. It turns that from an assumption into recorded,
/// checkable evidence. Note both counts are taken with the daemon LIVE, so
/// databases are open and their WAL is uncheckpointed at both endpoints.
#[derive(Clone, Copy, Default)]
struct WorkingSet {
    user_files: u64,
    total_bytes: u64,
}

fn working_set(roots: &[&Path]) -> WorkingSet {
    fn walk(dir: &Path, in_engine_dir: bool, set: &mut WorkingSet) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            // `file_type` does not follow links on either platform, so a
            // directory symlink or junction reports false for is_dir and no
            // cycle is reachable.
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => {
                    let engine = in_engine_dir || entry.file_name() == ".dohc";
                    walk(&entry.path(), engine, set);
                }
                Ok(file_type) if file_type.is_file() => {
                    if !in_engine_dir {
                        set.user_files = set.user_files.saturating_add(1);
                    }
                    if let Ok(metadata) = entry.metadata() {
                        set.total_bytes = set.total_bytes.saturating_add(metadata.len());
                    }
                }
                _ => {}
            }
        }
    }
    let mut set = WorkingSet::default();
    for root in roots {
        walk(root, false, &mut set);
    }
    set
}

struct Options {
    minutes: u64,
    cycles: u64,
    daemon: PathBuf,
    evidence: PathBuf,
    /// The caller ASKED for a smoke: PASS-SCENARIOS-ONLY is then a
    /// successful exit. A full run that degrades to it is not.
    quick: bool,
}

struct SoakTimeline {
    run_started: Instant,
    workload_started: Option<Instant>,
}

impl SoakTimeline {
    fn new() -> Self {
        Self {
            run_started: Instant::now(),
            workload_started: None,
        }
    }

    fn begin_workload(&mut self) {
        self.workload_started = Some(Instant::now());
    }

    fn run_elapsed(&self) -> Duration {
        self.run_elapsed_at(Instant::now())
    }

    fn workload_elapsed(&self) -> Duration {
        self.workload_elapsed_at(Instant::now())
    }

    // Elapsed against an EXPLICIT now, so a test can state "the run has been
    // going 40 minutes" by moving `now` forward instead of moving the start
    // backward. `Instant` counts from boot, so `Instant::now() - 40min` panics
    // outright on a machine with less uptime than that.
    fn run_elapsed_at(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.run_started)
    }

    fn workload_elapsed_at(&self, now: Instant) -> Duration {
        now.saturating_duration_since(
            self.workload_started
                .expect("phase-2 workload clock has started"),
        )
    }
}

fn parse_options() -> Options {
    let mut minutes = DEFAULT_FULL_SOAK_MINUTES;
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

// ---------------------------------------------------------------- provenance

/// The exact question asked of git, recorded beside the answer: untracked
/// files (build logs, the evidence file itself) are deliberately not what
/// "dirty" means here.
const DIRTY_CHECK: &str = "git status --porcelain --untracked-files=no";
/// What the commit reads when git could not answer. Never a fabricated sha.
const UNKNOWN_COMMIT: &str = "unknown";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Invocation {
    argv: Vec<String>,
    tier: &'static str,
    minutes: u64,
    cycles: u64,
    quick: bool,
    evidence_path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonFingerprint {
    path: String,
    size_bytes: Option<u64>,
    modified_unix_ms: Option<u64>,
}

/// Which tree, which invocation and which binary produced this artifact.
/// Without it the same PASS payload can be re-banked under any commit, and an
/// older run's numbers can stand in for a tree that was never soaked.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Provenance {
    commit: String,
    /// `None` when git could not answer — a clean tree is never assumed.
    tree_dirty: Option<bool>,
    dirty_check: &'static str,
    invocation: Invocation,
    daemon: DaemonFingerprint,
}

fn git_output(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn daemon_fingerprint(path: &Path) -> DaemonFingerprint {
    let metadata = std::fs::metadata(path).ok();
    DaemonFingerprint {
        path: path.display().to_string(),
        size_bytes: metadata.as_ref().map(|metadata| metadata.len()),
        modified_unix_ms: metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|since_epoch| since_epoch.as_millis() as u64),
    }
}

fn collect_provenance(options: &Options, tier: &'static str) -> Provenance {
    Provenance {
        commit: git_output(&["rev-parse", "HEAD"])
            .map(|sha| sha.trim().to_owned())
            .filter(|sha| !sha.is_empty())
            .unwrap_or_else(|| UNKNOWN_COMMIT.to_owned()),
        tree_dirty: git_output(&["status", "--porcelain", "--untracked-files=no"])
            .map(|status| !status.trim().is_empty()),
        dirty_check: DIRTY_CHECK,
        invocation: Invocation {
            argv: std::env::args().collect(),
            tier,
            minutes: options.minutes,
            cycles: options.cycles,
            quick: options.quick,
            evidence_path: options.evidence.display().to_string(),
        },
        daemon: daemon_fingerprint(&options.daemon),
    }
}

/// The rule applied to the ARTIFACT, so a reader checks exactly what the
/// runner checked: every provenance field present and concrete.
fn provenance_is_complete(provenance: &Value) -> bool {
    let commit_is_a_real_sha = provenance["commit"].as_str().is_some_and(|commit| {
        (40..=64).contains(&commit.len()) && commit.chars().all(|digit| digit.is_ascii_hexdigit())
    });
    let clean_tree = provenance["treeDirty"] == json!(false);
    let invocation = &provenance["invocation"];
    let invocation_recorded = invocation["argv"]
        .as_array()
        .is_some_and(|argv| !argv.is_empty())
        && invocation["tier"]
            .as_str()
            .is_some_and(|tier| !tier.is_empty());
    let daemon = &provenance["daemon"];
    let daemon_fingerprinted = daemon["path"].as_str().is_some_and(|path| !path.is_empty())
        && daemon["sizeBytes"].as_u64().is_some()
        && daemon["modifiedUnixMs"].as_u64().is_some();
    commit_is_a_real_sha && clean_tree && invocation_recorded && daemon_fingerprinted
}

impl Provenance {
    fn attributable(&self) -> bool {
        provenance_is_complete(&serde_json::to_value(self).expect("serialize provenance"))
    }

    fn summary(&self) -> String {
        format!(
            "commit={} tree={}",
            self.commit,
            match self.tree_dirty {
                Some(false) => "clean",
                Some(true) => "dirty",
                None => "unknown",
            }
        )
    }
}

/// The last gate before the artifact exists: a verdict that claims a PASS is a
/// claim ABOUT A TREE, so it may only be written with provenance a reader can
/// check it against. A FAIL or an INVALID is recorded either way — discarding
/// a failing run's samples would help nobody.
fn write_evidence(path: &Path, evidence: &Value) -> Result<(), String> {
    let verdict = evidence["verdict"].as_str().unwrap_or_default();
    if verdict.starts_with("PASS") && !provenance_is_complete(&evidence["provenance"]) {
        return Err(format!(
            "refusing to write {verdict} evidence to {}: provenance is incomplete — {}",
            path.display(),
            serde_json::to_string(&evidence["provenance"]).unwrap_or_default()
        ));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create evidence directory: {error}"))?;
        }
    }
    let document = serde_json::to_string_pretty(evidence)
        .map_err(|error| format!("serialize evidence: {error}"))?;
    std::fs::write(path, document).map_err(|error| format!("write evidence: {error}"))
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
    cycles_completed: u64,
    rss_bytes: u64,
    handles: u64,
    threads: u64,
}

fn push_process_sample(
    samples: &mut Vec<Sample>,
    process_sample: Option<(u64, u64, u64)>,
    at_secs: f64,
    cycles_completed: u64,
) -> bool {
    let Some((rss_bytes, handles, threads)) = process_sample else {
        return false;
    };
    samples.push(Sample {
        at_secs,
        cycles_completed,
        rss_bytes,
        handles,
        threads,
    });
    true
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessSamplingMetadata {
    os: &'static str,
    arch: &'static str,
    rss_bytes_method: &'static str,
    handle_count_method: &'static str,
    thread_count_method: &'static str,
    handle_thread_slack_calibrated_for_platform: bool,
    handle_thread_slack_calibration_note: &'static str,
}

fn process_sampling_metadata() -> ProcessSamplingMetadata {
    #[cfg(windows)]
    {
        ProcessSamplingMetadata {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            rss_bytes_method: "PowerShell Get-Process WorkingSet64",
            handle_count_method: "PowerShell Get-Process HandleCount (Windows OS handle count)",
            thread_count_method: "PowerShell Get-Process Threads.Count (Windows process thread count)",
            handle_thread_slack_calibrated_for_platform: true,
            handle_thread_slack_calibration_note: "handleSlack and threadSlack were calibrated against Windows runtime/OS jitter for these counters.",
        }
    }
    #[cfg(target_os = "linux")]
    {
        ProcessSamplingMetadata {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            rss_bytes_method: "/proc/<pid>/status VmRSS (KiB converted to bytes)",
            handle_count_method: "/proc/<pid>/fd directory entry count (open file-descriptor count; not Windows OS handles)",
            thread_count_method: "/proc/<pid>/status Threads",
            handle_thread_slack_calibrated_for_platform: false,
            handle_thread_slack_calibration_note: "handleSlack and threadSlack are Windows-calibrated and have not been calibrated for Linux /proc counters; within-bound results are observational, not a calibrated resource-leak conclusion.",
        }
    }
    #[cfg(target_os = "macos")]
    {
        ProcessSamplingMetadata {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            rss_bytes_method: "ps -o rss= -p <pid> (KiB converted to bytes)",
            handle_count_method: "lsof -p <pid> data-row count (open files, mapped resources, and sockets; not Windows OS handles)",
            thread_count_method: "ps -M -p <pid> data-row count",
            handle_thread_slack_calibrated_for_platform: false,
            handle_thread_slack_calibration_note: "handleSlack and threadSlack are Windows-calibrated and have not been calibrated for macOS lsof/ps -M counters; within-bound results are observational, not a calibrated resource-leak conclusion.",
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        panic!("soak sampling metadata is not implemented for this platform");
    }
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

fn linear_slope(
    samples: &[Sample],
    x_at: impl Fn(&Sample) -> f64,
    y_at: impl Fn(&Sample) -> f64,
) -> Option<f64> {
    let n = samples.len() as f64;
    if n < 3.0 {
        return None;
    }
    let mean_x = samples.iter().map(&x_at).sum::<f64>() / n;
    let mean_y = samples.iter().map(&y_at).sum::<f64>() / n;
    let mut cov = 0.0;
    let mut var = 0.0;
    for sample in samples {
        let dx = x_at(sample) - mean_x;
        cov += dx * (y_at(sample) - mean_y);
        var += dx * dx;
    }
    (var != 0.0).then_some(cov / var)
}

/// Least-squares slope of RSS over time, bytes/second.
fn rss_slope(samples: &[Sample]) -> Option<f64> {
    linear_slope(
        samples,
        |sample| sample.at_secs,
        |sample| sample.rss_bytes as f64,
    )
}

fn trend_span_secs(samples: &[Sample]) -> f64 {
    match (samples.first(), samples.last()) {
        (Some(first), Some(last)) => last.at_secs - first.at_secs,
        _ => 0.0,
    }
}

fn trend_tail(samples: &[Sample]) -> &[Sample] {
    // A final-half cutoff scales with dispatchable soak durations and only
    // passes after the lower-growth shape persists for half the observations.
    &samples[samples.len() / 2..]
}

fn rss_slopes_by_quarter(samples: &[Sample]) -> Vec<Option<f64>> {
    (0..4)
        .map(|quarter| {
            let start = quarter * samples.len() / 4;
            let end = (quarter + 1) * samples.len() / 4;
            rss_slope(&samples[start..end])
        })
        .collect()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkloadQuarterTrend {
    samples: usize,
    cycles_completed_start: u64,
    cycles_completed_end: u64,
    rss_slope_bytes_per_sec: Option<f64>,
    cycle_rate_per_sec: Option<f64>,
    rss_slope_bytes_per_cycle: Option<f64>,
}

fn workload_trends_by_quarter(samples: &[Sample]) -> Vec<WorkloadQuarterTrend> {
    (0..4)
        .map(|quarter| {
            let start = quarter * samples.len() / 4;
            let end = (quarter + 1) * samples.len() / 4;
            let quarter_samples = &samples[start..end];
            let cycle_rate_per_sec = linear_slope(
                quarter_samples,
                |sample| sample.at_secs,
                |sample| sample.cycles_completed as f64,
            )
            .filter(|rate| *rate > 0.0);
            let rss_slope_bytes_per_cycle = linear_slope(
                quarter_samples,
                |sample| sample.cycles_completed as f64,
                |sample| sample.rss_bytes as f64,
            );
            WorkloadQuarterTrend {
                samples: quarter_samples.len(),
                cycles_completed_start: quarter_samples
                    .first()
                    .map_or(0, |sample| sample.cycles_completed),
                cycles_completed_end: quarter_samples
                    .last()
                    .map_or(0, |sample| sample.cycles_completed),
                rss_slope_bytes_per_sec: rss_slope(quarter_samples),
                cycle_rate_per_sec,
                rss_slope_bytes_per_cycle,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RssTrendDisposition {
    Pass,
    Fail,
    NotEvaluated,
}

#[derive(Debug)]
struct RssTrendClassification {
    disposition: RssTrendDisposition,
    whole_run_slope_bytes_per_sec: f64,
    tail_slope_bytes_per_sec: f64,
    tail_samples: usize,
    tail_span_secs: f64,
    warmup_dominated_whole_run_fit: bool,
}

fn classify_rss_trend(samples: &[Sample]) -> RssTrendClassification {
    let whole_run_slope_bytes_per_sec = rss_slope(samples).unwrap_or(0.0);
    let tail = trend_tail(samples);
    let tail_slope_bytes_per_sec = rss_slope(tail).unwrap_or(0.0);
    let tail_span_secs = trend_span_secs(tail);
    let evaluated = tail.len() >= MIN_TREND_SAMPLES && tail_span_secs >= MIN_TREND_SPAN_SECS;
    let disposition = if !evaluated {
        RssTrendDisposition::NotEvaluated
    } else if tail_slope_bytes_per_sec <= MAX_RSS_SLOPE_BYTES_PER_SEC {
        RssTrendDisposition::Pass
    } else {
        RssTrendDisposition::Fail
    };

    RssTrendClassification {
        disposition,
        whole_run_slope_bytes_per_sec,
        tail_slope_bytes_per_sec,
        tail_samples: tail.len(),
        tail_span_secs,
        warmup_dominated_whole_run_fit: disposition == RssTrendDisposition::Pass
            && whole_run_slope_bytes_per_sec > MAX_RSS_SLOPE_BYTES_PER_SEC,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "SCREAMING-KEBAB-CASE")]
enum DrainDisposition {
    Reclaimed,
    Retained,
    NotEvaluated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "SCREAMING-KEBAB-CASE")]
enum RssDisposition {
    Pass,
    Fail,
    NotEvaluated,
    RetainedReclaimed,
}

impl RssDisposition {
    fn from_trend_and_drain(trend: RssTrendDisposition, drain: DrainDisposition) -> RssDisposition {
        match trend {
            RssTrendDisposition::NotEvaluated => RssDisposition::NotEvaluated,
            RssTrendDisposition::Pass => RssDisposition::Pass,
            RssTrendDisposition::Fail if drain == DrainDisposition::Reclaimed => {
                RssDisposition::RetainedReclaimed
            }
            RssTrendDisposition::Fail => RssDisposition::Fail,
        }
    }

    fn is_acceptable(self) -> bool {
        self != RssDisposition::Fail
    }

    fn is_retention_signal(self) -> bool {
        self == RssDisposition::RetainedReclaimed
    }

    fn as_str(self) -> &'static str {
        match self {
            RssDisposition::Pass => "PASS",
            RssDisposition::Fail => "FAIL",
            RssDisposition::NotEvaluated => "NOT-EVALUATED",
            RssDisposition::RetainedReclaimed => "RETAINED-RECLAIMED",
        }
    }
}

fn classify_drain(baseline_rss: u64, samples: &[Sample]) -> DrainDisposition {
    if samples.len() < MIN_DRAIN_SAMPLES {
        return DrainDisposition::NotEvaluated;
    }
    let start_rss = samples.first().expect("drain start").rss_bytes;
    let end_rss = samples.last().expect("drain end").rss_bytes;
    let run_growth = start_rss.saturating_sub(baseline_rss);
    if run_growth == 0 {
        return if end_rss <= baseline_rss {
            DrainDisposition::Reclaimed
        } else {
            DrainDisposition::Retained
        };
    }
    let drop = start_rss.saturating_sub(end_rss);
    if drop as f64 / run_growth as f64 >= DRAIN_RECLAIMED_MIN_FRACTION {
        DrainDisposition::Reclaimed
    } else {
        DrainDisposition::Retained
    }
}

/// Every input the tier verdict depends on, so the precedence between FAIL,
/// the INVALIDs and the qualified PASSes is one function a test can drive.
#[derive(Debug, Clone, Copy)]
struct VerdictInputs {
    daemon_healthy: bool,
    provenance_attributable: bool,
    bounded_working_set: bool,
    hard_capped: bool,
    crash_prelude_complete: bool,
    trend_evaluated: bool,
    retention_signal: bool,
}

fn verdict_for(inputs: VerdictInputs) -> &'static str {
    if !inputs.daemon_healthy {
        // A handle leak, a thread leak or a dirty shutdown are conclusions
        // nothing else in this chain can invalidate.
        "FAIL"
    } else if !inputs.provenance_attributable {
        // Measurements no reader can tie to a tree are not this tier's
        // evidence, however healthy the daemon looked.
        "INVALID(provenance-unattributable)"
    } else if !inputs.bounded_working_set {
        "INVALID(workload-working-set-unbounded)"
    } else if inputs.hard_capped {
        // The requested targets were NOT met — evidence, but not the tier's.
        "PASS-INCOMPLETE(hard-cap)"
    } else if !inputs.crash_prelude_complete {
        "PASS-INCOMPLETE(crash-prelude)"
    } else if !inputs.trend_evaluated {
        "PASS-SCENARIOS-ONLY(trend-not-evaluated)"
    } else if inputs.retention_signal {
        "PASS-RETENTION-SIGNAL(rss-drain-reclaimed)"
    } else {
        "PASS"
    }
}

fn rss_drain_delta(start: Option<u64>, end: Option<u64>) -> Option<i64> {
    start.zip(end).map(|(start, end)| {
        let delta = i128::from(end) - i128::from(start);
        delta.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
    })
}

// ----------------------------------------------------------------- scenarios

fn make_root(tag: &str, seq: u64) -> dohc_test_scratch::ScratchDir {
    let root =
        dohc_test_scratch::ScratchDir::new_named(&format!("soak-{tag}-{seq}")).expect("mkdir root");
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
    // deliberately bulky so it straddles the switch more often than a
    // one-liner would. The binding limit is the desktop capture text cap
    // (MAX_TEXT_BYTES, 10 MiB) -- NOT the DOP1 wire string
    // limit an earlier comment here cited as 64 KiB, which is in fact 8 MiB
    // (WireLimits::SPIKE_DEFAULTS.max_string_bytes).
    let (slot, variant) = identity_slot(n);
    let text = format!("in-flight during switch {slot} variant {variant}\n").repeat(1600);
    let (_, mut in_flight) = daemon
        .begin(
            "versionedText.write",
            Some(handle_a.clone()),
            json!({
                "versionId": "main",
                "objectId": format!("soak-switch-object-{slot}"),
                "path": format!("switch-{slot}.md"),
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
    // The same 25 filenames every cycle, REWRITTEN with changed content. The
    // event volume, debounce pressure and hard-deadline flush this scenario
    // exists to exercise are identical to minting fresh names, but the storm
    // root stays 25 files instead of growing by 25 every cycle — which had it
    // past 57,000 files by the end of a 90-minute run, so each reopen's full
    // enumerate-and-hash reconciliation scanned a linearly growing tree.
    // The body carries the VARIANT, not the raw cycle. Cycle-unique bodies
    // would mint 25 new content-addressed blobs and 25 new moments every
    // cycle; four variants across 25 files bound the workload to 100 distinct
    // payloads that dedupe by hash after the first pass.
    let (_, variant) = identity_slot(n);
    for burst in 0..25 {
        let path = root.join(format!("storm/burst-{burst}.md"));
        let body = format!("storm variant {variant} file {burst}");
        std::fs::write(&path, &body).unwrap_or_else(|_| {
            std::fs::create_dir_all(root.join("storm")).expect("storm dir");
            std::fs::write(&path, &body).expect("storm write");
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
    //
    // The probe path now PERSISTS across cycles, so "reads back non-null" is
    // no longer proof of anything — it was already non-null before this cycle
    // wrote. The probe must match THIS cycle's bytes, exactly as the crash
    // probe does.
    let probe = "storm/burst-0.md".to_owned();
    let expected = format!("storm variant {variant} file 0");
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
        // A missing path reads back as a SUCCESSFUL null, and a stale path
        // reads back the PREVIOUS cycle's bytes — only this cycle's text
        // proves this cycle's burst was ingested.
        if matches!(&answer, Ok(value) if value["text"] == json!(expected)) {
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
async fn scenario_cancel_storm(daemon: &Daemon, root: &Path, n: u64) -> u64 {
    let handle = open(daemon, root, "soak-cancel").await;
    // The seed path PERSISTS across cycles now, so the recovery read below
    // would be satisfied by the previous cycle's bytes. Deriving the path,
    // the written text and the expected text from one place keeps the
    // assertion pinned to THIS cycle's write.
    let (slot, variant) = identity_slot(n);
    let seed_path = format!("cancel-seed-{slot}.md");
    let seed_text = format!("recovery probe {variant}");
    // Seed one real write so the post-storm recovery read proves a genuine
    // round-trip: without it the workspace has no "main" version and even a
    // healthy read errors InvalidParams (version not found), which is
    // indistinguishable from a broken queue.
    daemon
        .call(
            "versionedText.write",
            Some(handle.clone()),
            json!({
                "versionId": "main",
                "objectId": format!("soak-cancel-object-{slot}"),
                "path": seed_path,
                "text": seed_text,
                "momentId": format!("soak-cancel-moment-{n}"),
                "metadataOrigin": "api",
                "nowMs": 1
            }),
        )
        .await;
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
    // The queue must RECOVER: the seeded write must read back after the
    // storm. Any error (Cancelled/Overloaded/unavailable) is a real failed
    // recovery — never swallowed into passing evidence.
    let (_, rx) = daemon
        .begin(
            "versionedText.read",
            Some(handle.clone()),
            json!({ "versionId": "main", "path": seed_path }),
        )
        .await;
    let recovered = tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .expect("post-storm request must resolve")
        .expect("response channel")
        .expect("post-storm recovery read must succeed");
    assert_eq!(
        recovered["text"],
        json!(seed_text),
        "post-storm read must return THIS cycle's seeded content"
    );
    close(daemon, handle).await;
    cancellations_observed
}

async fn scenario_editor_cycle(daemon: &Daemon, root: &Path, n: u64) {
    use dohc_engine_collab::Ydoc;
    let handle = open(daemon, root, "soak-editor").await;
    // A ring of editor objects rather than a fresh one per cycle. Beyond
    // bounding growth this is STRICTLY better coverage: at five updates per
    // cycle against a brand-new object, no document ever reached the
    // 64-update Y.Doc compaction threshold, so the soak never once exercised
    // the compaction path. Revisiting eight objects crosses it repeatedly.
    let (slot, variant) = identity_slot(n);
    daemon
        .call(
            "versionedText.write",
            Some(handle.clone()),
            json!({
                "versionId": "main",
                "objectId": format!("soak-editor-object-{slot}"),
                "path": format!("editor-{slot}.md"),
                "text": format!("seed {variant}"),
                "momentId": format!("soak-editor-seed-{n}"),
                "metadataOrigin": "api",
                "nowMs": 1
            }),
        )
        .await;
    let opened = daemon
        .call(
            "ydoc.open",
            Some(handle.clone()),
            json!({
                "versionId": "main",
                "path": format!("editor-{slot}.md"),
                "contentKind": "plaintext",
            }),
        )
        .await;
    let session_id = opened["sessionId"]
        .as_str()
        .expect("editor session id")
        .to_owned();
    let doc = Ydoc::wire();
    for edit in 0..5 {
        let update = doc.plaintext_insert(0, &format!("edit {n}-{edit} "));
        daemon
            .call(
                "ydoc.recordUpdate",
                Some(handle.clone()),
                json!({
                    "sessionId": session_id,
                    "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
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
    let tier = if options.quick {
        "quick-smoke"
    } else {
        "cutoverBlocking"
    };
    let process_sampling = process_sampling_metadata();
    // Asked BEFORE any work: the runner writes its evidence into the tree, so
    // a dirty check taken later would report on its own output.
    let provenance = collect_provenance(&options, tier);
    let mut timeline = SoakTimeline::new();
    let budget = Duration::from_secs(options.minutes * 60);
    eprintln!(
        "soak: {tier} tier — {} cycles / {} min budget, daemon {}",
        options.cycles,
        options.minutes,
        options.daemon.display()
    );
    eprintln!(
        "soak: provenance — {} ({}) daemon {} bytes; {}",
        provenance.summary(),
        DIRTY_CHECK,
        provenance
            .daemon
            .size_bytes
            .map_or_else(|| "unknown".to_owned(), |bytes| bytes.to_string()),
        if provenance.attributable() {
            "ATTRIBUTABLE"
        } else {
            "UNATTRIBUTABLE — this run cannot produce a PASS verdict"
        }
    );
    eprintln!(
        "soak: handle/thread slack calibration for {}: {} — {}",
        process_sampling.os,
        if process_sampling.handle_thread_slack_calibrated_for_platform {
            "CALIBRATED"
        } else {
            "UNCALIBRATED"
        },
        process_sampling.handle_thread_slack_calibration_note
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
        if timeline.run_elapsed() > budget {
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
            "post-crash reopen must settle"
        );
        // Settling is not the proof — the pre-crash write must be CAPTURED
        // after restart. Whether the kill caught it inside the OS debounce,
        // dirty-but-unacked, or already acked varies by timing; across the
        // cycle series all interleavings occur, and every one must converge
        // to the write being ingested. (A missing path reads back as a
        // successful null, so the probe requires a non-null snapshot.)
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let (_, rx) = daemon
                .begin(
                    "versionedText.read",
                    Some(handle.clone()),
                    json!({ "versionId": "main", "path": "crash-window.md" }),
                )
                .await;
            let answer = tokio::time::timeout(Duration::from_secs(30), rx)
                .await
                .expect("crash probe read resolves")
                .expect("response channel");
            // THIS cycle's bytes, not a stale head from an earlier cycle —
            // every cycle rewrites the same path, so non-null alone could
            // certify recovery while the write under test was lost.
            if matches!(&answer, Ok(value) if value["text"] == json!(format!("cycle {cycle}"))) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "pre-crash write was never captured after restart"
            );
            assert!(
                flush_until_settled(&daemon, &handle, Duration::from_secs(60)).await,
                "post-crash re-flush must settle"
            );
        }
        close(&daemon, handle).await;
        crashes += 1;
        *counts.entry("crashRestart").or_default() += 1;
    }
    // A crash prelude the budget cut short must SHOW: the verdict degrades
    // to PASS-INCOMPLETE rather than silently dropping crash coverage.
    let crash_prelude_complete = crashes == crash_cycles;

    // Phase 2 subject: a FRESH process, then a warmup open/close so one-time
    // allocations never read as trend, then its baseline.
    daemon.kill().await;
    daemon = Daemon::spawn(&options.daemon).await;
    scenario_open_close(&daemon, &root_cycle).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (rss_base, handles_base, threads_base) =
        sample_process(daemon.pid()).expect("phase-2 baseline sample");
    let workload_roots: [&Path; 6] = [
        &root_cycle,
        &root_a,
        &root_b,
        &root_storm,
        &root_cancel,
        &root_editor,
    ];
    // Every phase-2 root is opened once BEFORE the baseline. Warming only
    // root_cycle left the other five without an engine.db, so their one-time
    // schema creation — 40+ tables, indexes and FTS shadow tables apiece —
    // landed inside the measured window and was charged to workload growth.
    for root in workload_roots {
        scenario_open_close(&daemon, root).await;
    }
    let working_base = working_set(&workload_roots);
    timeline.begin_workload();
    eprintln!(
        "soak: phase 2 — leak-trend soak on one process \
         (baseline rss={rss_base} handles={handles_base} threads={threads_base} \
          userFiles={} bytes={})",
        working_base.user_files, working_base.total_bytes
    );
    let mut cycle: u64 = 0;
    let mut hard_capped = false;
    let mut cancellations_observed: u64 = 0;
    loop {
        if cycle >= options.cycles && timeline.workload_elapsed() >= budget {
            break;
        }
        if timeline.workload_elapsed() > budget * 2 {
            eprintln!("soak: hard wall-clock cap reached at cycle {cycle}");
            hard_capped = true;
            break;
        }
        if last_sample.elapsed() >= SAMPLE_EVERY {
            push_process_sample(
                &mut samples,
                sample_process(daemon.pid()),
                timeline.workload_elapsed().as_secs_f64(),
                cycle,
            );
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
                cancellations_observed += scenario_cancel_storm(&daemon, &root_cancel, cycle).await;
                *counts.entry("cancelStorm").or_default() += 1;
            }
            _ => {
                scenario_editor_cycle(&daemon, &root_editor, cycle).await;
                *counts.entry("editorCycle").or_default() += 1;
            }
        }
        cycle += 1;
    }

    // Everything is closed and no more work will be issued. Capture the
    // workload endpoint in the trend series, then keep THIS process alive for
    // an unaided idle drain. The drain samples are deliberately separate:
    // folding them into the workload fit would hide the slope under test.
    let workload_duration_secs = timeline.workload_elapsed().as_secs_f64();
    let working_end = working_set(&workload_roots);
    let working_set_file_growth = working_end
        .user_files
        .saturating_sub(working_base.user_files);
    let durable_growth_bytes = working_end
        .total_bytes
        .saturating_sub(working_base.total_bytes);
    let bounded_working_set = working_set_file_growth <= MAX_WORKING_SET_FILE_GROWTH;
    let mut drain_samples = Vec::new();
    if push_process_sample(
        &mut drain_samples,
        sample_process(daemon.pid()),
        workload_duration_secs,
        cycle,
    ) {
        samples.push(
            drain_samples
                .last()
                .expect("sample was just appended")
                .clone(),
        );
    }
    let trend = classify_rss_trend(&samples);
    let quarter_slopes = rss_slopes_by_quarter(&samples);
    let workload_quarter_trends = workload_trends_by_quarter(&samples);
    eprintln!(
        "soak: phase 3 — {}s unaided idle drain (no allocator release request)",
        DRAIN_WINDOW.as_secs()
    );
    let drain_started = Instant::now();
    while let Some(remaining) = DRAIN_WINDOW.checked_sub(drain_started.elapsed()) {
        if remaining.is_zero() {
            break;
        }
        tokio::time::sleep(remaining.min(SAMPLE_EVERY)).await;
        push_process_sample(
            &mut drain_samples,
            sample_process(daemon.pid()),
            timeline.workload_elapsed().as_secs_f64(),
            cycle,
        );
    }
    let rss_drain_start = drain_samples.first().map(|sample| sample.rss_bytes);
    let rss_end = drain_samples.last().map(|sample| sample.rss_bytes);
    let handles_drain_start = drain_samples.first().map(|sample| sample.handles);
    let handles_end = drain_samples.last().map(|sample| sample.handles);
    let threads_drain_start = drain_samples.first().map(|sample| sample.threads);
    let threads_end = drain_samples.last().map(|sample| sample.threads);
    let rss_drain_min = drain_samples.iter().map(|sample| sample.rss_bytes).min();
    let run_growth_bytes = rss_drain_start.map(|start| start.saturating_sub(rss_base));
    // Signed idle change: positive means RSS GREW while idle, negative means
    // it fell. Keep rssDropBytes for compatible consumers, but never make
    // growth indistinguishable from a flat zero-drop drain.
    let rss_delta_bytes = rss_drain_delta(rss_drain_start, rss_end);
    let rss_drop_bytes = rss_delta_bytes.map(|delta| delta.saturating_neg().max(0) as u64);
    let rss_drop_percent_of_run_growth = run_growth_bytes
        .zip(rss_drop_bytes)
        .and_then(|(growth, drop)| (growth > 0).then(|| 100.0 * drop as f64 / growth as f64));
    let drain_disposition = classify_drain(rss_base, &drain_samples);
    let (handle_base, thread_base) = (handles_base, threads_base);
    let handles_ok = handles_end.is_some_and(|end| end as i64 <= handle_base as i64 + HANDLE_SLACK);
    let threads_ok = threads_end.is_some_and(|end| end as i64 <= thread_base as i64 + THREAD_SLACK);
    // The tail fit is evaluated-and-ok, evaluated-and-over-bound, or NOT
    // EVALUATED. The combined RSS disposition further separates an
    // over-bound tail whose idle drain reclaims most growth.
    let trend_evaluated = trend.disposition != RssTrendDisposition::NotEvaluated;
    let rss_disposition =
        RssDisposition::from_trend_and_drain(trend.disposition, drain_disposition);
    // When the precondition fails the RSS reading is not evidence, so it must
    // not decide FAIL either. It is reported as null below, never as a bare
    // boolean a reader could quote.
    let rss_ok = rss_disposition.is_acceptable() || !bounded_working_set;

    let clean_shutdown = daemon.shutdown().await;

    // A genuine daemon failure is reported as FAIL even when the workload's
    // working set ran away: a handle leak, a thread leak or a dirty shutdown
    // are conclusions the workload cannot invalidate, and burying them under
    // INVALID would invite "fix the workload and re-run" while a real defect
    // went unread. Only the RSS-derived part of the verdict is gated, and
    // rss_ok is forced true below when the precondition fails so it can
    // contribute in neither direction.
    let verdict = verdict_for(VerdictInputs {
        daemon_healthy: handles_ok && threads_ok && rss_ok && clean_shutdown,
        provenance_attributable: provenance.attributable(),
        bounded_working_set,
        hard_capped,
        crash_prelude_complete,
        trend_evaluated,
        retention_signal: rss_disposition.is_retention_signal(),
    });
    let evidence = json!({
        "tier": tier,
        "verdict": verdict,
        // What tree, what invocation and what binary produced this file.
        // Asked of git at startup; `unknown`/`dirty` when it could not be
        // established, never a fabricated attribution.
        "provenance": provenance,
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
        "crashCyclesPlanned": crash_cycles,
        "durationSecs": timeline.run_elapsed().as_secs(),
        "workloadDurationSecs": workload_duration_secs,
        // Platform-specific provenance for every numeric process metric. In
        // particular, a within-slack macOS/Linux result must travel with the
        // fact that the Windows-derived handle/thread bounds are uncalibrated
        // for those different counter populations.
        "processSampling": process_sampling,
        "baseline": { "rss": rss_base, "handles": handles_base, "threads": threads_base },
        "drain": {
            "windowSecs": DRAIN_WINDOW.as_secs(),
            "sampleIntervalSecs": SAMPLE_EVERY.as_secs(),
            "minSamples": MIN_DRAIN_SAMPLES,
            "samplesCollected": drain_samples.len(),
            "reclaimedMinFractionOfRunGrowth": DRAIN_RECLAIMED_MIN_FRACTION,
            "allocatorReleaseRequested": false,
            "allocatorReleasePolicy": "No malloc_zone_pressure_relief, madvise-style purge, or other allocator release request is made; the drain measures the live process unaided.",
            "rssAtStartBytes": rss_drain_start,
            "rssAtEndBytes": rss_end,
            "rssMinBytes": rss_drain_min,
            "runGrowthBytes": run_growth_bytes,
            "rssDropBytes": rss_drop_bytes,
            "rssDeltaBytes": rss_delta_bytes,
            "rssDropPercentOfRunGrowth": rss_drop_percent_of_run_growth,
            "handlesAtStart": handles_drain_start,
            "handlesAtEnd": handles_end,
            "threadsAtStart": threads_drain_start,
            "threadsAtEnd": threads_end,
            "drainDisposition": drain_disposition,
            "samples": drain_samples,
        },
        "trendSamples": samples.len(),
        "minTrendSamples": MIN_TREND_SAMPLES,
        "trendFitSpanSecsWholeRun": trend_span_secs(&samples),
        "trendTailSelection": "final-half-of-workload-samples",
        "trendTailSamples": trend.tail_samples,
        "trendFitSpanSecsTail": trend.tail_span_secs,
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
            "trendTailFraction": 0.5,
            "drainWindowSecs": DRAIN_WINDOW.as_secs(),
            "minDrainSamples": MIN_DRAIN_SAMPLES,
            "drainReclaimedMinFractionOfRunGrowth": DRAIN_RECLAIMED_MIN_FRACTION,
        },
        // An over-bound fit whose unaided drain returns most growth is a
        // retention signal, distinct from both PASS and leak-shaped FAIL.
        // Tri-state, for the same reason the two assertions below are: on a
        // run whose working set ran away this is not a result, and a reader
        // grepping for it must find null rather than "PASS".
        "rssDisposition": if bounded_working_set {
            json!(rss_disposition)
        } else {
            json!(null)
        },
        // The RSS trend's PRECONDITION, recorded rather than assumed: bytes on
        // disk under the phase-2 roots at the start and end of the workload.
        // A workload that permanently accumulates content makes the trend
        // uninterpretable, so this is evidence a reader can check, not a claim.
        "workloadWorkingSet": {
            "boundedWorkingSet": bounded_working_set,
            "userFilesAtWorkloadStart": working_base.user_files,
            "userFilesAtWorkloadEnd": working_end.user_files,
            "userFileGrowth": working_set_file_growth,
            "maxUserFileGrowth": MAX_WORKING_SET_FILE_GROWTH,
            "identityRing": IDENTITY_RING,
            "scenarioRotation": SCENARIO_ROTATION,
            "contentVariants": CONTENT_VARIANTS,
            // Diagnostic ONLY, deliberately not the bound. `moments` is
            // append-only and every write needs a fresh momentId, so durable
            // bytes grow whenever the workload works; and with no cache_size
            // pragma SQLite's page cache stays at its 2 MB default, so a
            // larger database is not a larger process. Both endpoints are
            // sampled with the daemon LIVE and the WAL uncheckpointed.
            "durableBytesAtWorkloadStart": working_base.total_bytes,
            "durableBytesAtWorkloadEnd": working_end.total_bytes,
            "durableGrowthBytes": durable_growth_bytes,
            "durableGrowthBytesPerCycle": if cycle > 0 {
                json!(durable_growth_bytes as f64 / cycle as f64)
            } else {
                json!(null)
            },
            "interpretation": "The RSS trend's precondition. Opening a workspace builds a manifest of every captured entry, so the LIVE WORKING SET -- user files -- is what makes the process larger; the old workload grew it by 25 files per storm cycle past 57,000 files. Each scenario now rotates through identityRing identities and contentVariants payloads, so request volume is undiminished while the working set stays bounded. Growth beyond maxUserFileGrowth means the trend fit measured a growing workload and the RSS fields are reported as null rather than as a result. This bounds what drives RSS; it makes no claim about durable byte growth, which is append-only by design and tracked separately for the postCutoverContinuous tier.",
        },
        "warmupDominatedWholeRunFit": trend.warmup_dominated_whole_run_fit,
        "final": { "rss": rss_end, "handles": handles_end, "threads": threads_end },
        "rssSlopeBytesPerSecWholeRun": trend.whole_run_slope_bytes_per_sec,
        "rssSlopeBytesPerSecTail": trend.tail_slope_bytes_per_sec,
        "rssSlopeBytesPerSecByQuarter": quarter_slopes,
        "workloadTrendByQuarter": workload_quarter_trends,
        "assertions": {
            // The keys SAY what they CHECK: within the recorded slack —
            // never "exactly baseline", which no Windows run can hold.
            "handlesWithinRecordedSlack": handles_ok,
            "threadsWithinRecordedSlack": threads_ok,
            // Deliberately adjacent to the booleans it qualifies: `true`
            // means only "within the numeric bound" when this is false.
            "handleThreadSlackCalibratedForPlatform":
                process_sampling.handle_thread_slack_calibrated_for_platform,
            // Tri-state: null when the trend was not evaluated, so a
            // scenarios-only artifact can never read as leak evidence.
            "workloadWorkingSetBounded": bounded_working_set,
            "rssTailSlopeWithinThreshold": if trend_evaluated && bounded_working_set {
                json!(trend.tail_slope_bytes_per_sec <= MAX_RSS_SLOPE_BYTES_PER_SEC)
            } else {
                json!(null)
            },
            "rssAcceptedByTailSlopeOrDrainReclamation": if trend_evaluated && bounded_working_set {
                json!(rss_ok)
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
    write_evidence(&options.evidence, &evidence).unwrap_or_else(|error| panic!("{error}"));

    println!(
        "- {} | soak-{tier} | {}/{} | {} | {} cycles={} crashes={} durationSecs={} \
         rssDisposition={} rssSlopeWholeB/s={:.1} rssSlopeTailB/s={:.1} \
         warmupDominatedWholeRunFit={} drain={} rssDrain {}->{} min={} \
         drop={} ({}) handles {}->{} threads {}->{} handleThreadSlackCalibration={} \
         workingSetBounded={} userFileGrowth={} durableGrowthBytes={}",
        chrono_like_now(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        verdict,
        // The pasted EXECUTION_LOG line carries the attribution too, so a
        // banked verdict line is checkable without opening the JSON.
        provenance.summary(),
        // Phase-2 workload cycles, same denominator as the evidence JSON —
        // never a sum over counts (supplemental counters like the overlap
        // tally would inflate it).
        cycle,
        crashes,
        timeline.run_elapsed().as_secs(),
        rss_disposition.as_str(),
        trend.whole_run_slope_bytes_per_sec,
        trend.tail_slope_bytes_per_sec,
        trend.warmup_dominated_whole_run_fit,
        match drain_disposition {
            DrainDisposition::Reclaimed => "RECLAIMED",
            DrainDisposition::Retained => "RETAINED",
            DrainDisposition::NotEvaluated => "NOT-EVALUATED",
        },
        rss_drain_start.map_or_else(|| "unavailable".to_owned(), |value| value.to_string()),
        rss_end.map_or_else(|| "unavailable".to_owned(), |value| value.to_string()),
        rss_drain_min.map_or_else(|| "unavailable".to_owned(), |value| value.to_string()),
        rss_drop_bytes.map_or_else(|| "unavailable".to_owned(), |value| value.to_string()),
        rss_drop_percent_of_run_growth
            .map(|percent| format!("{percent:.1}% of run growth"))
            .unwrap_or_else(|| "no positive run growth".to_owned()),
        handle_base,
        handles_end.map_or_else(|| "unavailable".to_owned(), |value| value.to_string()),
        thread_base,
        threads_end.map_or_else(|| "unavailable".to_owned(), |value| value.to_string()),
        if process_sampling.handle_thread_slack_calibrated_for_platform {
            "CALIBRATED"
        } else {
            "UNCALIBRATED"
        },
        bounded_working_set,
        working_set_file_growth,
        durable_growth_bytes,
    );
    // PASS and the explicitly named retention signal exit 0. The latter is
    // not silently collapsed into PASS: it says the slope remained over the
    // bound during work but most growth returned during unaided idle. A
    // REQUESTED smoke (--quick) legitimately reports PASS-SCENARIOS-ONLY and
    // also exits 0. Everything else did not meet its tier's targets.
    let acceptable = verdict == "PASS"
        || verdict == "PASS-RETENTION-SIGNAL(rss-drain-reclaimed)"
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

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_testkit::ScratchDir;

    fn rss_samples(values: &[u64]) -> Vec<Sample> {
        values
            .iter()
            .enumerate()
            .map(|(index, rss_bytes)| Sample {
                at_secs: index as f64 * SAMPLE_EVERY.as_secs_f64(),
                cycles_completed: index as u64,
                rss_bytes: *rss_bytes,
                handles: 10,
                threads: 10,
            })
            .collect()
    }

    fn synthetic_trend(
        count: usize,
        interval_secs: f64,
        rss_at: impl Fn(f64) -> f64,
    ) -> Vec<Sample> {
        (0..count)
            .map(|index| {
                let at_secs = index as f64 * interval_secs;
                Sample {
                    at_secs,
                    cycles_completed: index as u64,
                    rss_bytes: rss_at(at_secs).round() as u64,
                    handles: 10,
                    threads: 10,
                }
            })
            .collect()
    }

    fn complete_provenance() -> Provenance {
        Provenance {
            commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            tree_dirty: Some(false),
            dirty_check: DIRTY_CHECK,
            invocation: Invocation {
                argv: vec![
                    "dohc-soak-runner".to_owned(),
                    "--minutes".to_owned(),
                    "60".to_owned(),
                ],
                tier: "cutoverBlocking",
                minutes: 60,
                cycles: 1_000,
                quick: false,
                evidence_path: "soak-evidence/run.json".to_owned(),
            },
            daemon: DaemonFingerprint {
                path: "target/release/dohc-workspace-engine".to_owned(),
                size_bytes: Some(12_345_678),
                modified_unix_ms: Some(1_784_000_000_000),
            },
        }
    }

    fn passing_inputs() -> VerdictInputs {
        VerdictInputs {
            daemon_healthy: true,
            provenance_attributable: true,
            bounded_working_set: true,
            hard_capped: false,
            crash_prelude_complete: true,
            trend_evaluated: true,
            retention_signal: false,
        }
    }

    /// The whole point of the provenance stamp: a run whose numbers cannot be
    /// tied to a tree may not report a PASS, however healthy the daemon was.
    #[test]
    fn an_unattributable_run_cannot_report_a_pass_verdict() {
        assert_eq!(verdict_for(passing_inputs()), "PASS");
        assert_eq!(
            verdict_for(VerdictInputs {
                provenance_attributable: false,
                ..passing_inputs()
            }),
            "INVALID(provenance-unattributable)"
        );
        // A real daemon failure is still the conclusion — missing provenance
        // must not launder a FAIL into a merely-unattributable run.
        assert_eq!(
            verdict_for(VerdictInputs {
                daemon_healthy: false,
                provenance_attributable: false,
                ..passing_inputs()
            }),
            "FAIL"
        );
    }

    #[test]
    fn provenance_is_attributable_only_from_a_known_commit_and_a_clean_tree() {
        assert!(complete_provenance().attributable());

        let unattributable = [
            Provenance {
                commit: UNKNOWN_COMMIT.to_owned(),
                ..complete_provenance()
            },
            Provenance {
                commit: "deadbeef".to_owned(),
                ..complete_provenance()
            },
            Provenance {
                tree_dirty: Some(true),
                ..complete_provenance()
            },
            Provenance {
                tree_dirty: None,
                ..complete_provenance()
            },
            Provenance {
                daemon: DaemonFingerprint {
                    size_bytes: None,
                    ..complete_provenance().daemon
                },
                ..complete_provenance()
            },
            Provenance {
                daemon: DaemonFingerprint {
                    modified_unix_ms: None,
                    ..complete_provenance().daemon
                },
                ..complete_provenance()
            },
            Provenance {
                invocation: Invocation {
                    argv: Vec::new(),
                    ..complete_provenance().invocation
                },
                ..complete_provenance()
            },
        ];
        for provenance in unattributable {
            assert!(
                !provenance.attributable(),
                "must not be attributable: {provenance:?}"
            );
        }
    }

    #[test]
    fn evidence_write_refuses_a_pass_it_cannot_attribute() {
        let scratch = ScratchDir::new().expect("scratch");
        let path = scratch.path().join("evidence.json");

        let error = write_evidence(
            &path,
            &json!({ "tier": "cutoverBlocking", "verdict": "PASS" }),
        )
        .expect_err("an unstamped PASS must be refused");
        assert!(error.contains("provenance is incomplete"), "{error}");
        assert!(
            !path.exists(),
            "a refused PASS must leave no artifact behind"
        );

        let dirty = serde_json::to_value(Provenance {
            tree_dirty: Some(true),
            ..complete_provenance()
        })
        .expect("serialize provenance");
        let error = write_evidence(&path, &json!({ "verdict": "PASS", "provenance": dirty }))
            .expect_err("a dirty-tree PASS must be refused");
        assert!(error.contains("provenance is incomplete"), "{error}");
        assert!(!path.exists());

        let complete = serde_json::to_value(complete_provenance()).expect("serialize provenance");
        write_evidence(&path, &json!({ "verdict": "PASS", "provenance": complete }))
            .expect("an attributable PASS is written");
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read evidence"))
                .expect("evidence JSON");
        assert_eq!(
            written["provenance"]["commit"],
            json!("0123456789abcdef0123456789abcdef01234567")
        );
    }

    /// Pins the guard to the runner's actual verdict vocabulary: every verdict
    /// the chain can emit that reads as a pass needs provenance, so renaming
    /// or adding one cannot route around the check.
    #[test]
    fn every_passing_verdict_the_runner_can_emit_needs_provenance() {
        let scratch = ScratchDir::new().expect("scratch");
        let passing = [
            verdict_for(passing_inputs()),
            verdict_for(VerdictInputs {
                hard_capped: true,
                ..passing_inputs()
            }),
            verdict_for(VerdictInputs {
                crash_prelude_complete: false,
                ..passing_inputs()
            }),
            verdict_for(VerdictInputs {
                trend_evaluated: false,
                ..passing_inputs()
            }),
            verdict_for(VerdictInputs {
                retention_signal: true,
                ..passing_inputs()
            }),
        ];
        for verdict in passing {
            assert!(verdict.starts_with("PASS"), "{verdict}");
            let path = scratch
                .path()
                .join(format!("{}.json", verdict.replace(['(', ')'], "-")));
            write_evidence(&path, &json!({ "verdict": verdict }))
                .expect_err("a passing verdict without provenance must be refused");
            assert!(!path.exists(), "{verdict} was written unattributed");
        }
    }

    #[test]
    fn a_failing_run_is_still_recorded_without_provenance() {
        let scratch = ScratchDir::new().expect("scratch");
        for verdict in ["FAIL", "INVALID(provenance-unattributable)"] {
            let path = scratch.path().join(format!("{}.json", verdict.len()));
            write_evidence(&path, &json!({ "verdict": verdict }))
                .expect("a non-passing run's samples are still worth keeping");
            assert!(path.exists());
        }
    }

    #[test]
    fn trend_classifier_fails_constant_slope_leak() {
        let samples = synthetic_trend(61, 30.0, |seconds| {
            12_000_000.0 + seconds * (MAX_RSS_SLOPE_BYTES_PER_SEC + 8_192.0)
        });

        let trend = classify_rss_trend(&samples);

        assert_eq!(trend.disposition, RssTrendDisposition::Fail);
        assert!(trend.tail_slope_bytes_per_sec > MAX_RSS_SLOPE_BYTES_PER_SEC);
    }

    #[test]
    fn trend_classifier_passes_decelerating_asymptote() {
        let samples = synthetic_trend(61, 30.0, |seconds| {
            12_000_000.0 + 100_000_000.0 * (1.0 - (-seconds / 300.0).exp())
        });

        let trend = classify_rss_trend(&samples);

        assert_eq!(trend.disposition, RssTrendDisposition::Pass);
        assert!(trend.tail_slope_bytes_per_sec <= MAX_RSS_SLOPE_BYTES_PER_SEC);
        assert!(trend.whole_run_slope_bytes_per_sec > MAX_RSS_SLOPE_BYTES_PER_SEC);
        assert!(trend.warmup_dominated_whole_run_fit);
    }

    #[test]
    fn trend_classifier_passes_flat_series() {
        let samples = synthetic_trend(61, 30.0, |_| 12_000_000.0);

        let trend = classify_rss_trend(&samples);

        assert_eq!(trend.disposition, RssTrendDisposition::Pass);
        assert_eq!(trend.tail_slope_bytes_per_sec, 0.0);
        assert!(!trend.warmup_dominated_whole_run_fit);
    }

    #[test]
    fn trend_classifier_not_evaluated_with_too_few_tail_samples() {
        let samples = synthetic_trend(46, 60.0, |seconds| {
            12_000_000.0 + seconds * (MAX_RSS_SLOPE_BYTES_PER_SEC + 8_192.0)
        });

        let trend = classify_rss_trend(&samples);

        assert_eq!(trend.tail_samples, MIN_TREND_SAMPLES - 1);
        assert!(trend.tail_span_secs >= MIN_TREND_SPAN_SECS);
        assert_eq!(trend.disposition, RssTrendDisposition::NotEvaluated);
    }

    #[test]
    fn trend_classifier_not_evaluated_when_dense_tail_span_is_too_short() {
        let samples = synthetic_trend(48, 30.0, |seconds| {
            12_000_000.0 + seconds * (MAX_RSS_SLOPE_BYTES_PER_SEC + 8_192.0)
        });

        let trend = classify_rss_trend(&samples);

        assert!(trend.tail_samples >= MIN_TREND_SAMPLES);
        assert!(trend.tail_span_secs < MIN_TREND_SPAN_SECS);
        assert_eq!(trend.disposition, RssTrendDisposition::NotEvaluated);
    }

    #[test]
    fn minimum_full_mode_budget_is_bankable_by_phase_two_clock_contract() {
        let workflow = include_str!("../../../../.github/workflows/rust-engine-macos-evidence.yml");
        let local_script = include_str!("../../../../tools/rust-engine-program/macos-evidence.sh");
        let config: Value = serde_json::from_str(include_str!(
            "../../../../tools/rust-engine-program/soak-config.json"
        ))
        .expect("soak config JSON");
        assert!(workflow.contains("default: \"60\""));
        assert!(!workflow.contains("          - \"30\""));
        assert!(local_script.contains("SOAK_ARGS=(--minutes 60 --cycles 1000)"));
        assert_eq!(DEFAULT_FULL_SOAK_MINUTES, 60);
        assert_eq!(
            config["tiers"]["cutoverBlocking"]["durationMinutesRange"],
            json!([60, 90])
        );

        let start = Instant::now();
        let timeline = SoakTimeline {
            run_started: start,
            workload_started: Some(start + Duration::from_secs(10 * 60)),
        };
        let now = start + Duration::from_secs(40 * 60);
        assert!(timeline.workload_elapsed_at(now) < Duration::from_secs(31 * 60));

        // At the minimum dispatchable budget, the final-half window has twice
        // the required span at the normal cadence.
        let samples = synthetic_trend(721, SAMPLE_EVERY.as_secs_f64(), |_| 12_000_000.0);
        let trend = classify_rss_trend(&samples);
        assert!(trend.tail_span_secs >= MIN_TREND_SPAN_SECS);
        assert_eq!(trend.disposition, RssTrendDisposition::Pass);
    }

    #[test]
    fn workload_duration_excludes_warmup_and_crash_prelude() {
        let start = Instant::now();
        let timeline = SoakTimeline {
            run_started: start,
            workload_started: Some(start + Duration::from_secs(600)),
        };
        let now = start + Duration::from_secs(2_400);

        assert!(timeline.run_elapsed_at(now) >= Duration::from_secs(2_400));
        assert!(timeline.workload_elapsed_at(now) >= Duration::from_secs(1_800));
        assert!(timeline.workload_elapsed_at(now) < Duration::from_secs(1_801));
    }

    #[test]
    fn quarter_rss_trends_are_least_squares_fits_not_endpoint_secants() {
        let mut samples = synthetic_trend(16, 1.0, |_| 1_000.0);
        for (offset, rss_bytes) in [1_000, 2_000, 2_100, 999].into_iter().enumerate() {
            samples[8 + offset].rss_bytes = rss_bytes;
        }

        let quarter_slopes = rss_slopes_by_quarter(&samples);

        assert!(samples[11].rss_bytes < samples[8].rss_bytes);
        assert!(quarter_slopes[2].is_some_and(|slope| slope > 0.0));
    }

    #[test]
    fn unfittable_quarter_slopes_serialize_as_null_not_flat_zero() {
        let samples = synthetic_trend(8, 1.0, |seconds| 1_000.0 + seconds * 100.0);

        let quarter_slopes = rss_slopes_by_quarter(&samples);
        let workload_trends = workload_trends_by_quarter(&samples);

        assert!(quarter_slopes.iter().all(Option::is_none));
        assert!(
            workload_trends
                .iter()
                .all(|trend| trend.rss_slope_bytes_per_sec.is_none())
        );
        assert_eq!(
            serde_json::to_value(&quarter_slopes).expect("serialize slopes"),
            json!([null, null, null, null])
        );
    }

    #[test]
    fn quarter_workload_trends_normalize_rss_growth_by_completed_cycles() {
        let samples = (0..16)
            .map(|index| {
                let cycles_completed = (index * index + index) as u64;
                Sample {
                    at_secs: index as f64,
                    cycles_completed,
                    rss_bytes: 1_000_000 + 512 * cycles_completed,
                    handles: 10,
                    threads: 10,
                }
            })
            .collect::<Vec<_>>();

        for trend in workload_trends_by_quarter(&samples) {
            assert!(trend.cycle_rate_per_sec.is_some());
            assert_eq!(trend.rss_slope_bytes_per_cycle, Some(512.0));
        }
    }

    #[test]
    fn drain_classifier_reclaimed_when_most_run_growth_returns() {
        let samples = rss_samples(&[500, 420, 320, 230, 190]);

        assert_eq!(classify_drain(100, &samples), DrainDisposition::Reclaimed);
    }

    #[test]
    fn drain_classifier_retained_when_most_run_growth_holds() {
        let samples = rss_samples(&[500, 470, 430, 390, 350]);

        assert_eq!(classify_drain(100, &samples), DrainDisposition::Retained);
    }

    #[test]
    fn drain_classifier_not_evaluated_with_too_few_samples() {
        let samples = rss_samples(&[500, 350, 250, 100]);

        assert_eq!(
            classify_drain(100, &samples),
            DrainDisposition::NotEvaluated
        );
    }

    #[test]
    fn drain_classifier_uses_end_not_one_transient_minimum() {
        let samples = rss_samples(&[500, 100, 480, 490, 500]);

        assert_eq!(classify_drain(100, &samples), DrainDisposition::Retained);
    }

    #[test]
    fn drain_sampling_skips_transient_failures_without_panicking() {
        let mut samples = Vec::new();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert!(!push_process_sample(&mut samples, None, 1.0, 7));
        }));

        assert!(
            outcome.is_ok(),
            "a missing process sample must degrade evidence, not panic"
        );
        assert!(samples.is_empty());
        assert_eq!(
            classify_drain(100, &samples),
            DrainDisposition::NotEvaluated
        );
    }

    #[test]
    fn drain_rss_delta_preserves_idle_growth_signal() {
        assert_eq!(rss_drain_delta(Some(1_000), Some(1_250)), Some(250));
        assert_eq!(rss_drain_delta(Some(1_250), Some(1_000)), Some(-250));
        assert_eq!(rss_drain_delta(None, Some(1_000)), None);
    }

    /// The property the whole state-neutrality fix rests on: a scenario's
    /// successive visits must carry DIFFERENT content, or a store that
    /// short-circuits an unchanged write turns the scenario into a no-op that
    /// still counts cycles. Each scenario runs at one residue of
    /// SCENARIO_ROTATION, so this walks the actual visit sequence.
    #[test]
    fn every_scenario_sees_a_fresh_variant_on_each_visit_to_an_identity() {
        for scenario in 0..SCENARIO_ROTATION {
            let visits: Vec<(u64, u64)> = (0..400)
                .map(|visit| visit * SCENARIO_ROTATION + scenario)
                .map(identity_slot)
                .collect();
            for pair in visits.windows(2) {
                assert_ne!(
                    pair[0].1, pair[1].1,
                    "scenario {scenario} repeated variant {} on consecutive visits",
                    pair[0].1
                );
            }
            // And the identities themselves stay inside the ring.
            assert!(visits.iter().all(|(slot, _)| *slot < IDENTITY_RING));
            let distinct: std::collections::HashSet<u64> =
                visits.iter().map(|(slot, _)| *slot).collect();
            assert_eq!(
                distinct.len() as u64,
                IDENTITY_RING,
                "scenario {scenario} must exercise the whole ring"
            );
        }
    }

    /// A read stale by k visits carries the variant from k visits ago. With
    /// CONTENT_VARIANTS = 4 a probe rejects anything up to three visits old;
    /// with two variants an every-other-visit staleness would have passed.
    #[test]
    fn a_stale_read_is_rejected_until_the_variants_wrap() {
        let visit_variant = |visit: u64| identity_slot(visit * SCENARIO_ROTATION).1;
        for stale_by in 1..CONTENT_VARIANTS {
            assert_ne!(
                visit_variant(64),
                visit_variant(64 - stale_by),
                "content stale by {stale_by} visit(s) must not satisfy the probe"
            );
        }
        assert_eq!(visit_variant(64), visit_variant(64 - CONTENT_VARIANTS));
    }

    /// The working-set walk must count user files while ignoring the engine's
    /// own database, and must not be fooled into counting `.dohc` content as
    /// user files just because it sits below a nested directory.
    #[test]
    fn working_set_counts_user_files_and_excludes_the_engine_directory() {
        let scratch = ScratchDir::new().expect("scratch");
        let root = scratch.path();
        std::fs::create_dir_all(root.join("storm")).expect("storm dir");
        std::fs::write(root.join("storm/burst-0.md"), "a").expect("user file");
        std::fs::write(root.join("top.md"), "bb").expect("user file");
        std::fs::create_dir_all(root.join(".dohc").join("engine")).expect("engine dir");
        std::fs::write(root.join(".dohc/engine/engine.db"), "cccc").expect("db");

        let set = working_set(&[root]);
        assert_eq!(set.user_files, 2, "only the two user files count");
        assert_eq!(set.total_bytes, 7, "bytes still cover the engine directory");
    }

    #[test]
    fn rss_disposition_enum_drives_acceptance_and_retention_verdicts() {
        assert!(RssDisposition::Pass.is_acceptable());
        assert!(RssDisposition::NotEvaluated.is_acceptable());
        assert!(RssDisposition::RetainedReclaimed.is_acceptable());
        assert!(!RssDisposition::Fail.is_acceptable());
        assert!(RssDisposition::RetainedReclaimed.is_retention_signal());
        assert!(!RssDisposition::Pass.is_retention_signal());
        assert_eq!(
            serde_json::to_value(RssDisposition::RetainedReclaimed)
                .expect("serialize RSS disposition"),
            json!("RETAINED-RECLAIMED")
        );
    }

    #[test]
    fn gate6_packet_tracks_the_resolved_r15_2_decision() {
        let packet = include_str!("../../../../docs/superpowers/plans/rust-engine/GATE6_PACKET.md");

        assert!(packet.contains("RSS growth — **RESOLVED**"));
        assert!(packet.contains("Ice accepted the steady-state tail verdict"));
        assert!(!packet.contains("awaiting Ice's ruling"));
        assert!(!packet.contains("Recorded as an open decision"));
    }
}
