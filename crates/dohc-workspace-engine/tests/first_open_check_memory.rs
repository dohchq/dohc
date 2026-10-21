//! What one first-open check costs a fresh daemon, for the charge in
//! `live_application_ingress/first_open_check.rs`. Each run starts its own
//! daemon, uploads one candidate in the relay's chunks and reads the daemon's
//! committed private bytes (`PagefileUsage`) and their peak
//! (`PeakPagefileUsage`) from Windows through `Get-Process`: before the
//! upload, while the upload is held, and after the answer.
//!
//! `cargo test -p dohc-workspace-engine --test first_open_check_memory -- --ignored --nocapture`
#![cfg(windows)]

use dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
use dohc_engine_collab::live_update_application::{
    FirstOpenCandidate, FirstOpenCandidateVerdict, check_first_open_candidate,
    first_open_dense_small_blocks,
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
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
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
    fn commit(&self) -> (u64, u64) {
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
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
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

/// Checks `candidate` against `markdown` in fresh daemons, capped at the full
/// state the engine measures for it, the tightest cap it still accepts.
fn measure(name: &str, markdown: &str, candidate: &[u8]) {
    let source = markdown.as_bytes();
    let (candidate_sha256, source_sha256) = (hex_sha256(candidate), hex_sha256(source));
    let verdict = check_first_open_candidate(
        FirstOpenCandidate {
            candidate,
            candidate_sha256: &candidate_sha256,
            source,
            source_sha256: &source_sha256,
            max_full_state_bytes: MAX_YDOC_UPDATE_BYTES,
        },
        &|| false,
    )
    .unwrap();
    let FirstOpenCandidateVerdict::Checked(evidence) = verdict else {
        panic!("{name}: {verdict:?}")
    };
    let cap = evidence.full_state_byte_length;
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
        let (baseline, startup_peak) = daemon.commit();
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
        let (uploading, _) = daemon.commit();
        daemon.chunk(1, true, last);
        let answer = daemon.result(2);
        let seconds = started.elapsed().as_secs_f64();
        let (_, peak) = daemon.commit();
        assert_eq!(answer["status"], "checked", "{name}: {answer}");
        assert_eq!(answer["fullStateByteLength"], cap);
        above.push(peak - baseline);
        println!(
            "{}",
            json!({
                "fixture": name, "run": run, "sourceBytes": source.len(), "candidateBytes": candidate.len(),
                "maxFullStateBytes": cap, "status": answer["status"], "seconds": seconds,
                "baselineCommit": baseline, "startupPeakCommit": startup_peak, "uploadingCommit": uploading,
                "peakCommit": peak, "peakAboveBaseline": peak - baseline,
                "uploadRetained": uploading - baseline, "workAboveUpload": peak - uploading,
            })
        );
    }
    println!(
        "{}",
        json!({"fixture": name, "runs": RUNS, "minPeakAboveBaseline": above.iter().min(),
            "maxPeakAboveBaseline": above.iter().max()})
    );
}

#[test]
#[ignore = "manual measurement; Windows; see the module comment"]
fn a_first_open_check_in_a_fresh_daemon() {
    let markdown = first_open_dense_small_blocks();
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &markdown)
        .unwrap();
    measure("dense-small-blocks", &markdown, &doc.encode_full_state());
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
