//! The Rust side of the E-shard capture DIFFERENTIAL: replay the shared
//! fixtures against the REAL daemon (workspace.open → autonomous capture →
//! capture.flush → workspace.close) and compare normalized per-path state
//! against the goldens the TypeScript oracle emitted
//! (`apps/desktop/src/workspaces/captureOracleGoldens.test.ts`).
//!
//! Projection rules mirror the TS emitter exactly: ids/timestamps excluded;
//! text = { text, sha256(utf8), byteLength }; binary = { sha256, byteLength };
//! secret = { byteLength } only; absence carries `everTracked` (any
//! moments/secret_moments rows) so RETIRED and NEVER-TRACKED stay distinct.
//!
//! Fixtures are DISK-DRIVEN only — the ratified delta: TS `writeIfChanged`
//! ignores `metadata_origin` (safe there because the desktop materializes API
//! writes to disk), while this daemon enforces capture ownership. RPC-vs-disk
//! interleavings are covered by Rust-only acceptance tests instead.

use base64::Engine as _;
use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WORKSPACE_ID: &str = "capture-differential-rust";
/// Generous: watcher settle + drive interval + scan/hash time per step.
const WAIT: Duration = Duration::from_secs(20);

const FIXTURES: &str = include_str!("../../../tools/rust-engine-program/capture-fixtures.json");
const GOLDENS: &str = include_str!("../../../tools/rust-engine-program/capture-goldens.json");

#[derive(Deserialize)]
struct Fixtures {
    scenarios: Vec<Scenario>,
}
#[derive(Deserialize)]
struct Scenario {
    name: String,
    steps: Vec<Step>,
    offline: Vec<Step>,
    watch: Vec<String>,
}
#[derive(Deserialize)]
struct Step {
    op: String,
    path: String,
    text: Option<String>,
    #[serde(rename = "bytesBase64")]
    bytes_base64: Option<String>,
}

#[derive(Deserialize)]
struct Goldens {
    scenarios: BTreeMap<String, BTreeMap<String, Projection>>,
}
/// One path's normalized state. `PartialEq` drives the differential compare.
#[derive(Debug, PartialEq, Deserialize)]
struct Projection {
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default, rename = "byteLength")]
    byte_length: Option<u64>,
    #[serde(rename = "everTracked")]
    ever_tracked: bool,
}

fn request(id: u64, method: &str, workspace: Option<WorkspaceHandle>, params: Value) -> Request {
    Request {
        id,
        method: method.to_owned(),
        workspace,
        deadline_ms: None,
        idempotency_key: None,
        params,
    }
}

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    root: &Path,
    id: u64,
) -> WorkspaceHandle {
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "workspace.open",
                None,
                json!({
                    "rootDir": root.to_string_lossy(),
                    "workspaceId": WORKSPACE_ID,
                }),
            ),
        )
        .await
        .expect("workspace open");
    serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
}

async fn close_workspace(
    transport: &InProcessTransport<EngineService>,
    handle: WorkspaceHandle,
    id: u64,
) {
    transport
        .call(
            RequestContext::unbounded(),
            request(id, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("workspace close");
}

async fn flush(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
) -> bool {
    let response = transport
        .call(
            RequestContext::unbounded(),
            request(id, "capture.flush", Some(handle.clone()), json!({})),
        )
        .await
        .expect("capture.flush");
    response.result["settled"] == json!(true)
}

fn apply_to_disk(root: &Path, step: &Step) {
    let absolute = root.join(&step.path);
    if step.op == "delete" {
        std::fs::remove_file(&absolute).expect("delete fixture file");
        return;
    }
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    match step.op.as_str() {
        "write" => std::fs::write(&absolute, step.text.as_deref().unwrap_or("")),
        "write-binary" => std::fs::write(
            &absolute,
            base64::engine::general_purpose::STANDARD
                .decode(step.bytes_base64.as_deref().unwrap_or(""))
                .expect("fixture base64"),
        ),
        other => panic!("unknown fixture op {other}"),
    }
    .expect("write fixture file");
}

/// The state one applied step must become visible as, so steps cannot
/// coalesce (a write must be OBSERVED before its delete lands).
fn expected_after(step: &Step) -> Projection {
    match step.op.as_str() {
        "delete" => Projection {
            kind: "absent".to_owned(),
            text: None,
            sha256: None,
            byte_length: None,
            ever_tracked: true,
        },
        "write" => {
            let text = step.text.clone().unwrap_or_default();
            let bytes = text.as_bytes();
            if is_secret_path(&step.path) {
                Projection {
                    kind: "secret".to_owned(),
                    text: None,
                    sha256: None,
                    byte_length: Some(bytes.len() as u64),
                    ever_tracked: true,
                }
            } else {
                Projection {
                    kind: "text".to_owned(),
                    text: Some(text.clone()),
                    sha256: Some(hex(bytes)),
                    byte_length: Some(bytes.len() as u64),
                    ever_tracked: true,
                }
            }
        }
        "write-binary" => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(step.bytes_base64.as_deref().unwrap_or(""))
                .expect("fixture base64");
            Projection {
                kind: "binary".to_owned(),
                text: None,
                sha256: Some(hex(&bytes)),
                byte_length: Some(bytes.len() as u64),
                ever_tracked: true,
            }
        }
        other => panic!("unknown fixture op {other}"),
    }
}

fn is_secret_path(path: &str) -> bool {
    matches!(
        dohc_engine_files::policy::classify_engine_file_path(path),
        dohc_engine_files::policy::PathClassification::Secret
    )
}

fn hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// (everTracked, secret byte length, head (content_kind, binary sha)).
type RawProjection = (bool, Option<u64>, Option<(String, Option<String>)>);

/// Project one path from the persisted engine.db — the SAME source a fresh
/// process would read, mirroring the TS emitter's projection exactly.
fn project_path(db: &Path, path: &str) -> Projection {
    use rusqlite::OptionalExtension;
    let mut store = EngineStore::open(db, u32::MAX.into()).expect("open engine db");
    let path_owned = path.to_owned();
    let (tracked, secret_len, head): RawProjection = store
        .read_with(|conn| {
            let moments: i64 = conn.query_row(
                "SELECT (SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 AND path = ?2) + \
                 (SELECT COUNT(*) FROM secret_moments WHERE workspace_id = ?1 AND path = ?2)",
                rusqlite::params![WORKSPACE_ID, path_owned],
                |row| row.get(0),
            )?;
            let secret_len: Option<i64> = conn
                .query_row(
                    "SELECT byte_length FROM secret_files WHERE workspace_id = ?1 AND path = ?2",
                    rusqlite::params![WORKSPACE_ID, path_owned],
                    |row| row.get(0),
                )
                .optional()?;
            let head: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT s.content_kind, s.binary_sha256 FROM snapshots s \
                     JOIN path_aliases a ON a.workspace_id = s.workspace_id \
                       AND a.version_id = s.version_id AND a.object_id = s.object_id \
                     WHERE s.workspace_id = ?1 AND a.path = ?2",
                    rusqlite::params![WORKSPACE_ID, path_owned],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            Ok::<_, rusqlite::Error>((moments > 0, secret_len.map(|len| len as u64), head))
        })
        .expect("project query");

    if let Some(byte_length) = secret_len {
        return Projection {
            kind: "secret".to_owned(),
            text: None,
            sha256: None,
            byte_length: Some(byte_length),
            ever_tracked: tracked,
        };
    }
    match head {
        Some((kind, binary_sha)) if kind == "binary" => {
            let sha = binary_sha.expect("binary head carries its sha");
            let byte_length: i64 = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT byte_length FROM binary_blobs WHERE sha256 = ?1",
                        [&sha],
                        |row| row.get(0),
                    )
                })
                .expect("binary blob length");
            Projection {
                kind: "binary".to_owned(),
                text: None,
                sha256: Some(sha),
                byte_length: Some(byte_length as u64),
                ever_tracked: tracked,
            }
        }
        Some(_) => {
            let snapshot = dohc_engine_domain::VersionedTextStore::new(&mut store)
                .read_text(WORKSPACE_ID, "main", path)
                .expect("read text head")
                .expect("text head present");
            let bytes = snapshot.text.as_bytes();
            Projection {
                kind: "text".to_owned(),
                text: Some(snapshot.text.clone()),
                sha256: Some(hex(bytes)),
                byte_length: Some(bytes.len() as u64),
                ever_tracked: tracked,
            }
        }
        None => Projection {
            kind: "absent".to_owned(),
            text: None,
            sha256: None,
            byte_length: None,
            ever_tracked: tracked,
        },
    }
}

/// Drive one step to VISIBILITY: flush until the persisted projection shows
/// the step's effect. The only nondeterminism is the watcher noticing the
/// disk write; once it has, one settled flush suffices — no blind sleeps.
async fn drive_step_to_visibility(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    db: &Path,
    step: &Step,
    id: &mut u64,
    scenario: &str,
) {
    let expected = expected_after(step);
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        *id += 1;
        let settled = flush(transport, handle, *id).await;
        if settled && project_path(db, &step.path) == expected {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "[{scenario}] step {} {} never became visible; wanted {expected:?}, last saw {:?}",
            step.op,
            step.path,
            project_path(db, &step.path)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rust_capture_matches_the_typescript_oracle_goldens() {
    let fixtures: Fixtures = serde_json::from_str(FIXTURES).expect("fixtures parse");
    let goldens: Goldens = serde_json::from_str(GOLDENS).expect("goldens parse");

    // === The freeze, enforced HERE rather than described in a document. ===
    //
    // R16 deletes the TypeScript oracle that produced these goldens. After that
    // the only implementation able to regenerate them is the daemon this test
    // grades, so an unenforced freeze means the daemon can certify itself by
    // editing one file. These hashes are the anchor, and they live in Rust source
    // precisely so that changing either JSON file cannot be a one-file diff.
    //
    // Both files are covered on purpose. Freezing only the goldens leaves the
    // INPUTS mutable, and input coverage can vanish without changing any output:
    // drop the first step of `update-coalesce` and the final projection is
    // identical, so every value assertion passes while the update-transition case
    // is gone.
    //
    // If you are here because one of these failed: do not update the hash to make
    // it pass. Work out which behaviour changed, and why the new answer is right.
    // See tools/rust-engine-program/capture-goldens.provenance.md.
    const FIXTURES_SHA256: &str =
        "2a8649c9b2a7e513e6f7a480569c7ac995b31309bfab48b1bda2cf02fbe92304";
    const GOLDENS_SHA256: &str =
        "246655d8e2f697d069d121c50faec04222f7f45eecc970f1af4e0b4ee64e5292";

    let hash_of = |raw: &str| -> String {
        let mut hasher = Sha256::new();
        hasher.update(raw.as_bytes());
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    assert_eq!(
        hash_of(GOLDENS).as_str(),
        GOLDENS_SHA256,
        "capture-goldens.json changed. The goldens are FROZEN — see \
         capture-goldens.provenance.md. Do not update this constant to silence it \
         without establishing which behaviour changed and why the new value is \
         correct."
    );
    assert_eq!(
        hash_of(FIXTURES).as_str(),
        FIXTURES_SHA256,
        "capture-fixtures.json changed. The input traces are frozen too, because \
         a step can be removed without altering any final projection. See \
         capture-goldens.provenance.md."
    );

    // Scenario IDENTITIES, not counts. Equal lengths prove nothing: delete one
    // fixture scenario and duplicate another and both sides still read 10, while
    // the loop resolves the duplicate twice and the deleted scenario's golden is
    // never read.
    let fixture_names: BTreeSet<&str> =
        fixtures.scenarios.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        fixture_names.len(),
        fixtures.scenarios.len(),
        "capture-fixtures.json has duplicate scenario names; a duplicate hides a \
         deleted scenario behind an unchanged count"
    );
    let golden_names: BTreeSet<&str> =
        goldens.scenarios.keys().map(String::as_str).collect();
    assert_eq!(
        fixture_names, golden_names,
        "capture-fixtures.json and capture-goldens.json cover different scenarios"
    );

    for scenario in &fixtures.scenarios {
        let golden = goldens
            .scenarios
            .get(&scenario.name)
            .unwrap_or_else(|| panic!("no golden for {}", scenario.name));

        let scratch = ScratchDir::new().expect("scratch");
        write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
        let db = scratch.engine_db_path().expect("db path");
        let transport = InProcessTransport::new(Arc::new(EngineService::new()));
        let mut id: u64 = 1;
        let mut handle = open_workspace(&transport, scratch.path(), id).await;

        for step in &scenario.steps {
            apply_to_disk(scratch.path(), step);
            drive_step_to_visibility(&transport, &handle, &db, step, &mut id, &scenario.name).await;
        }
        id += 1;
        close_workspace(&transport, handle.clone(), id).await;

        if !scenario.offline.is_empty() {
            for step in &scenario.offline {
                apply_to_disk(scratch.path(), step);
            }
            // Reopen: the rehydration seed + startup baseline reconcile the
            // offline window — the same contract the TS oracle exercises with
            // a fresh engine's startup pass.
            id += 1;
            handle = open_workspace(&transport, scratch.path(), id).await;
            let deadline = tokio::time::Instant::now() + WAIT;
            loop {
                id += 1;
                if flush(&transport, &handle, id).await {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "[{}] post-offline flush never settled",
                    scenario.name
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            id += 1;
            close_workspace(&transport, handle.clone(), id).await;
        }

        // The DIFFERENTIAL: normalized persisted state vs the TS golden.
        for path in &scenario.watch {
            let produced = project_path(&db, path);
            let expected = golden
                .get(path)
                .unwrap_or_else(|| panic!("[{}] no golden for path {path}", scenario.name));
            assert_eq!(
                &produced, expected,
                "[{}] divergence at {path}",
                scenario.name
            );
        }
    }
}
