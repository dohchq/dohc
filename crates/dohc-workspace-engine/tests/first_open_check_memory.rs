//! What one first-open check costs a fresh daemon, for the charge in
//! `live_application_ingress/first_open_check.rs`. Each run starts its own
//! daemon, uploads one candidate in the relay's chunks and reads the daemon's
//! memory before the upload, while the upload is held, and after the answer.
//! On Windows that is committed private bytes (`PagefileUsage`) and their peak
//! (`PeakPagefileUsage`) through `Get-Process`; on Linux, resident bytes
//! (`VmRSS`) and their peak (`VmHWM`) from `/proc/<pid>/status`.
//!
//! The relay's seeds come from `firstOpenBase.test.ts`:
//! `pnpm --filter @dohc/sync-relay exec vitest run src/firstOpenBase.test.ts --mode first-open-dense`,
//! then
//! `cargo test -p dohc-workspace-engine --test first_open_check_memory -- --ignored --nocapture`
#![cfg(any(windows, target_os = "linux"))]

use base64::Engine as _;
use dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
use dohc_engine_collab::live_update_application::{
    FirstOpenCandidate, FirstOpenCandidateRefusal, FirstOpenCandidateVerdict,
    check_first_open_candidate, first_open_dense_small_blocks,
};
use dohc_engine_collab::{ContentKind, Ydoc};
use dohc_engine_protocol::frame::encode_blob_chunk_frame;
use dohc_engine_protocol::limits::WireLimits;
use dohc_engine_protocol::wire::{
    BlobStart, Envelope, Hello, PROTOCOL_VERSION, Request, WorkspaceHandle, decode_control,
    encode_control,
};
use dohc_engine_storage::hex_sha256;
use dohc_engine_testkit::ScratchDir;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::Instant;

/// The ingress's largest chunk.
const CHUNK: usize = 256 * 1024;
const RUNS: usize = 5;

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Daemon {
    fn write(&mut self, bytes: &[u8]) {
        self.0.stdin.as_mut().unwrap().write_all(bytes).unwrap();
    }
    fn send(&mut self, envelope: Envelope) {
        self.write(&encode_control(&envelope, &WireLimits::default()).unwrap());
    }
    fn chunk(&mut self, stream: u64, fin: bool, bytes: &[u8]) {
        self.write(&encode_blob_chunk_frame(stream, fin, bytes, &WireLimits::default()).unwrap());
    }
    /// The next answer, skipping events.
    fn answer(&mut self) -> Envelope {
        loop {
            let output = self.0.stdout.as_mut().unwrap();
            let mut header = [0; 12];
            output.read_exact(&mut header).unwrap();
            let length = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
            let mut payload = vec![0; length];
            output.read_exact(&mut payload).unwrap();
            let envelope = decode_control(&payload, &WireLimits::default()).unwrap();
            if !matches!(envelope, Envelope::Event(_)) {
                return envelope;
            }
        }
    }
    fn request(
        &mut self,
        id: u64,
        method: &str,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) {
        self.send(Envelope::Request(Request {
            id,
            method: method.into(),
            workspace,
            deadline_ms: Some(600_000),
            idempotency_key: None,
            progress: false,
            params,
        }));
    }
    fn result(&mut self, id: u64) -> Value {
        match self.answer() {
            Envelope::Response(response) if response.id == id => response.result,
            other => panic!("request {id}: {other:?}"),
        }
    }
    /// Committed private bytes now and at their peak.
    #[cfg(windows)]
    fn memory(&self) -> (u64, u64) {
        let script = format!(
            "$p = Get-Process -Id {}; '{{0}} {{1}}' -f $p.PagedMemorySize64, $p.PeakPagedMemorySize64",
            self.0.id()
        );
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .unwrap();
        let text = String::from_utf8(output.stdout).unwrap();
        let mut values = text.split_whitespace().map(|v| v.parse().unwrap());
        (values.next().unwrap(), values.next().unwrap())
    }
    /// Resident bytes now and at their peak.
    #[cfg(target_os = "linux")]
    fn memory(&self) -> (u64, u64) {
        let status = std::fs::read_to_string(format!("/proc/{}/status", self.0.id())).unwrap();
        let kib = |field: &str| -> u64 {
            let line = status.lines().find(|line| line.starts_with(field)).unwrap();
            line[field.len()..]
                .trim()
                .trim_end_matches("kB")
                .trim()
                .parse::<u64>()
                .unwrap()
                * 1024
        };
        (kib("VmRSS:"), kib("VmHWM:"))
    }
}

fn spawn(scratch: &ScratchDir) -> (Daemon, WorkspaceHandle) {
    let root = scratch.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let path = scratch.path().join("host.json");
    let config = json!({
        "version": 1, "relayNamespace": "relay",
        "host": {"hostId": "host", "hostEpoch": 1, "instanceId": "instance", "connectionId": "connection"},
        "workspaces": [{"root": root, "workspaceId": "ordinary", "maxRegistrations": 4,
            "relay": {"baseUrl": "https://relay.example", "bearerToken": "owner-credential"}}],
        // Accounting only: large enough that every measured check is admitted.
        "ingress": {"aggregateBytes": 4u64 << 30, "applicationWorkingReserveBytes": 8 * 1024 * 1024,
            "maxUploads": 2, "uploadDeadlineMs": 600_000}
    });
    std::fs::write(&path, config.to_string()).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_dohc-workspace-engine"));
    command
        .env("DOHC_ENGINE_AUTH_TOKEN", "memory-test-secret")
        .env("DOHC_ENGINE_LIVE_HOST_CONFIG", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);
    let mut daemon = Daemon(command.spawn().unwrap());
    daemon.send(Envelope::Hello(Hello {
        protocol_version: PROTOCOL_VERSION,
        auth_token: "memory-test-secret".into(),
        capabilities: vec!["blobs".into()],
        last_session_generation: None,
        max_frame_bytes: None,
    }));
    assert!(matches!(daemon.answer(), Envelope::HelloAck(_)));
    daemon.request(1, "liveApplication.hosts", None, json!({}));
    let hosts = daemon.result(1);
    let workspace =
        serde_json::from_value(hosts["workspaces"][0]["workspaceHandle"].clone()).unwrap();
    (daemon, workspace)
}

fn verdict(markdown: &str, candidate: &[u8]) -> FirstOpenCandidateVerdict {
    let source = markdown.as_bytes();
    check_first_open_candidate(
        FirstOpenCandidate {
            candidate,
            candidate_sha256: &hex_sha256(candidate),
            source,
            source_sha256: &hex_sha256(source),
            max_full_state_bytes: MAX_YDOC_UPDATE_BYTES,
        },
        &|| false,
    )
    .unwrap()
}

/// Whether settling `candidate` rebuilds a document from its source witness:
/// it carries one, and the source is not its projection.
fn rebuilds(markdown: &str, candidate: &[u8]) -> bool {
    let doc = Ydoc::wire();
    doc.apply(candidate).unwrap();
    let projection = doc.project(ContentKind::Richdoc).unwrap().content;
    doc.markdown_source_reference().is_some() && projection != markdown
}

/// Checks `candidate` against `markdown` in fresh daemons, capped at the full
/// state the engine measures for it, the tightest cap it still accepts. A
/// candidate refused once decoded is capped at its own length.
fn measure(name: &str, markdown: &str, candidate: &[u8]) {
    let source = markdown.as_bytes();
    let (candidate_sha256, source_sha256) = (hex_sha256(candidate), hex_sha256(source));
    let (status, cap) = match verdict(markdown, candidate) {
        FirstOpenCandidateVerdict::Checked(evidence) => {
            ("checked", evidence.full_state_byte_length)
        }
        FirstOpenCandidateVerdict::Refused(FirstOpenCandidateRefusal::InvalidPublicBaseline) => {
            ("refused", candidate.len())
        }
        other => panic!("{name}: {other:?}"),
    };
    let staged = status == "checked" && rebuilds(markdown, candidate);
    let bundle = [candidate, source].concat();
    let params = json!({
        "contractVersion": 1, "streamId": 1, "byteLength": bundle.len(), "digest": hex_sha256(&bundle),
        "binding": {"objectId": "object", "path": "notes/a.md", "sourceMomentId": "moment",
            "sourceSha256": source_sha256, "sourceByteLength": source.len(),
            "candidateSha256": candidate_sha256, "candidateByteLength": candidate.len(),
            "replicationEpoch": "epoch", "streamIdentity": "stream", "maxFullStateBytes": cap},
    });
    let mut above = Vec::new();
    for run in 1..=RUNS {
        let scratch = ScratchDir::new().unwrap();
        let (mut daemon, workspace) = spawn(&scratch);
        let (baseline, startup_peak) = daemon.memory();
        let started = Instant::now();
        daemon.request(
            2,
            "liveApplication.checkFirstOpenCandidate",
            Some(workspace),
            params.clone(),
        );
        daemon.send(Envelope::BlobStart(BlobStart {
            request_id: 2,
            stream_id: 1,
            total_bytes: Some(bundle.len() as u64),
            sha256: Some(hex_sha256(&bundle)),
        }));
        let chunks: Vec<&[u8]> = bundle.chunks(CHUNK).collect();
        let (last, held) = chunks.split_last().unwrap();
        for chunk in held {
            daemon.chunk(1, false, chunk);
        }
        // Answered only once the frames before it are read.
        daemon.request(3, "liveApplication.hosts", None, json!({}));
        daemon.result(3);
        let (uploading, _) = daemon.memory();
        daemon.chunk(1, true, last);
        let answer = daemon.result(2);
        let seconds = started.elapsed().as_secs_f64();
        let (_, peak) = daemon.memory();
        assert_eq!(answer["status"], status, "{name}: {answer}");
        if status == "checked" {
            assert_eq!(answer["fullStateByteLength"], cap);
        }
        above.push(peak - baseline);
        println!(
            "{}",
            json!({
                "fixture": name, "run": run, "sourceBytes": source.len(), "candidateBytes": candidate.len(),
                "maxFullStateBytes": cap, "staged": staged, "status": answer["status"], "seconds": seconds,
                "baseline": baseline, "startupPeak": startup_peak, "uploading": uploading,
                "peak": peak, "peakAboveBaseline": peak - baseline,
                "uploadRetained": uploading - baseline, "workAboveUpload": peak - uploading,
            })
        );
    }
    println!(
        "{}",
        json!({"fixture": name, "runs": RUNS, "sourceBytes": source.len(), "candidateBytes": candidate.len(),
            "maxFullStateBytes": cap, "staged": staged,
            "minPeakAboveBaseline": above.iter().min(), "maxPeakAboveBaseline": above.iter().max()})
    );
}

/// A note at the projection node limit, with the relay's seed of it and of
/// the same note with one more line.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DenseSeed {
    name: String,
    markdown: String,
    candidate: String,
    over_markdown: String,
    over: String,
}

/// Shapes whose source is not their projection, so settlement must rebuild
/// them. The projection ends without a line break, so a note that ends with
/// one is rebuilt too; each row reports whether it was.
const REBUILT: [&str; 2] = ["paragraphs-spaced", "star-bullets"];
/// The note settlement takes as projected, without rebuilding it.
const PROJECTED: &str = "paragraphs-bare";

#[test]
#[ignore = "manual measurement; see the module comment"]
fn a_first_open_check_in_a_fresh_daemon() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/first-open-dense-seeds.json"
    );
    let seeds: Vec<DenseSeed> = serde_json::from_slice(
        &std::fs::read(path).expect("write the relay's seeds first; see the module comment"),
    )
    .unwrap();
    assert_eq!(seeds[0].name, "paragraphs");
    assert_eq!(seeds[0].markdown, first_open_dense_small_blocks());
    let base64 = base64::engine::general_purpose::STANDARD;
    let expected = |seed: &DenseSeed, candidate: &[u8]| {
        let rebuilt = rebuilds(&seed.markdown, candidate);
        assert!(
            rebuilt || !REBUILT.contains(&seed.name.as_str()),
            "{}",
            seed.name
        );
        assert!(!rebuilt || seed.name != PROJECTED, "{}", seed.name);
    };
    for seed in &seeds {
        let candidate = base64.decode(&seed.candidate).unwrap();
        let over = base64.decode(&seed.over).unwrap();
        // At the limit: one more line does not project.
        assert_eq!(
            verdict(&seed.over_markdown, &over),
            FirstOpenCandidateVerdict::Refused(FirstOpenCandidateRefusal::ProjectionFailed),
            "{}",
            seed.name
        );
        expected(seed, &candidate);
        measure(&format!("{}/relay", seed.name), &seed.markdown, &candidate);
        // What decoding alone costs: a root the public schema refuses is
        // found only after the whole candidate decodes.
        if seed.name == PROJECTED {
            let rogue = Ydoc::wire()
                .rewrite_content_to_markdown(ContentKind::Plaintext, "x")
                .unwrap();
            let decoded = dohc_engine_collab::merge_updates(&[candidate, rogue]).unwrap();
            measure(&format!("{PROJECTED}/decoded"), &seed.markdown, &decoded);
        }
    }
    // The engine keeps a paragraph's hard breaks as text, so its own seed of
    // that note is not dense.
    for seed in seeds.iter().filter(|seed| seed.name != "hard-breaks") {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &seed.markdown)
            .unwrap();
        let candidate = doc.encode_full_state();
        expected(seed, &candidate);
        measure(&format!("{}/engine", seed.name), &seed.markdown, &candidate);
    }
    let bases: Vec<Value> = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/first-open-base/ts-bases.json"
    ))
    .unwrap();
    let float32 = bases
        .iter()
        .find(|base| base["name"] == "float32-integers")
        .unwrap();
    let bytes: Vec<u8> = serde_json::from_value(float32["bytes"].clone()).unwrap();
    measure(
        "float32-integers",
        float32["markdown"].as_str().unwrap(),
        &bytes,
    );
}
