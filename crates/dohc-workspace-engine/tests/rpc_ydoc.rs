//! RPC-C acceptance: daemon-owned Y.Doc sessions over the in-process
//! transport, with real domain writes, materialization, capture, and leases.

use crate::common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::{
    BaseRelayCoordinate, ClaimOutcome, ContentKind, DocKey, Regime, Ydoc, ensure_marker,
};
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::WorkspaceHandle,
};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
use dohc_engine_sync::{AlwaysLive, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use dohc_workspace_engine::EngineService;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

async fn call_ydoc_with_blob(
    service: &EngineService,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> (Value, Vec<u8>) {
    let output = service_call_with_busy_retry(
        service,
        RequestContext::unbounded().with_capability("blobs"),
        request(id, method, Some(handle.clone()), params),
    )
    .await
    .unwrap_or_else(|error| panic!("{method} failed: {error:?}"));
    assert_eq!(output.response.id, id);
    assert!(
        output.response.result.get("initialUpdateBase64").is_none(),
        "{method} must not duplicate the Y.Doc state in JSON"
    );
    let egress = output
        .blob_egress
        .unwrap_or_else(|| panic!("{method} did not return blob egress"));
    assert_eq!(egress.stream_id, id);
    assert_eq!(
        egress.sha256,
        dohc_engine_storage::hex_sha256(&egress.bytes),
        "{method} blob digest"
    );
    (output.response.result, egress.bytes)
}

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    workspace_id: &str,
    id: u64,
) -> WorkspaceHandle {
    open_workspace_with_capture_mode(transport, scratch, workspace_id, id, None).await
}

async fn open_workspace_with_capture_mode(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    workspace_id: &str,
    id: u64,
    capture_mode: Option<&str>,
) -> WorkspaceHandle {
    let opened = call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(
            id,
            "workspace.open",
            None,
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace_id,
                "captureMode": capture_mode,
            }),
        ),
    )
    .await
    .expect("workspace open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle");
    if capture_mode == Some("none") {
        // workspace.open awaits startup replay even when capture is disabled.
        return handle;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut status_id = id.saturating_add(1_000_000);
    loop {
        let status = call_with_busy_retry(
            transport,
            RequestContext::unbounded(),
            request(status_id, "watcher.status", Some(handle.clone()), json!({})),
        )
        .await
        .expect("watcher.status");
        status_id += 1;
        if status.result["phase"] == json!("ready") {
            return handle;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "startup capture never became ready: {}",
            status.result
        );
        tokio::task::yield_now().await;
    }
}

fn plaintext_update(text: &str) -> String {
    let doc = Ydoc::wire();
    base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, text))
}

fn png_crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320_u32 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

fn valid_png_with_text_padding(minimum_bytes: usize) -> Vec<u8> {
    let base = base64::engine::general_purpose::STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        .expect("embedded valid 1x1 PNG");
    let iend = base.len() - 12;
    let mut data = b"dohc-test\0".to_vec();
    data.resize(minimum_bytes.saturating_sub(base.len()) + data.len(), b'x');
    let mut chunk = Vec::with_capacity(data.len() + 12);
    chunk.extend_from_slice(
        &u32::try_from(data.len())
            .expect("PNG chunk length")
            .to_be_bytes(),
    );
    chunk.extend_from_slice(b"tEXt");
    chunk.extend_from_slice(&data);
    chunk.extend_from_slice(&png_crc32(&chunk[4..]).to_be_bytes());
    let mut png = Vec::with_capacity(base.len() + chunk.len());
    png.extend_from_slice(&base[..iend]);
    png.extend_from_slice(&chunk);
    png.extend_from_slice(&base[iend..]);
    assert!(png.len() >= minimum_bytes);
    png
}

fn image_scene_update_with_asset_record(
    asset_id: &str,
    mime_type: &str,
    asset_ref: &str,
    sha256: &str,
) -> String {
    let portable = serde_json::to_string(&json!({
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [{
            "id": "image-element",
            "type": "image",
            "version": 1,
            "versionNonce": 1,
            "isDeleted": false,
            "index": "a0",
            "fileId": asset_id
        }],
        "appState": {},
        "files": {
            (asset_id): {
                "id": asset_id,
                "mimeType": mime_type,
                "dataURL": format!("data:{mime_type};base64,AQIDBA=="),
                "created": 12
            }
        }
    }))
    .expect("portable image scene");
    let imported = dohc_engine_collab::import_portable_scene(&portable).expect("scene import");
    let mut records = BTreeMap::new();
    records.insert(
        asset_id.to_owned(),
        serde_json::to_string(&json!({
            "created": 12,
            "id": asset_id,
            "mimeType": mime_type,
            "ref": asset_ref,
            "sha256": sha256
        }))
        .expect("asset record"),
    );
    let assets = dohc_engine_collab::encode_scene_asset_records(&records).expect("asset update");
    base64::engine::general_purpose::STANDARD.encode(
        dohc_engine_collab::merge_updates(&[imported.initial_update, assets])
            .expect("merged scene update"),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn default_close_settles_and_releases_a_seeded_image_scene_after_an_edit() {
    let scratch = ScratchDir::new().expect("scratch");
    let image_bytes = valid_png_with_text_padding(512);
    let image_base64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
    let scene = |version: u64, background: &str| {
        serde_json::to_string(&json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": [{
                "id": "image-element",
                "type": "image",
                "version": version,
                "versionNonce": version,
                "isDeleted": false,
                "index": "a0",
                "fileId": "image-file"
            }],
            "appState": { "viewBackgroundColor": background },
            "files": {
                "image-file": {
                    "id": "image-file",
                    "mimeType": "image/png",
                    "dataURL": format!("data:image/png;base64,{image_base64}"),
                    "created": 12
                }
            }
        }))
        .expect("portable image scene")
    };
    write_file(
        scratch.path(),
        "drawings/close.excalidraw",
        scene(1, "#ffffff").as_bytes(),
    );

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-scene-close", 71).await;
    let opened = call(
        &transport,
        &handle,
        72,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "drawings/close.excalidraw",
            "contentKind": "scene",
            "seedFromArtifact": true
        }),
    )
    .await;
    let edited = dohc_engine_collab::import_portable_scene(&scene(2, "#eeeeee"))
        .expect("edited scene import");
    call(
        &transport,
        &handle,
        73,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": opened["lineageClaimId"],
            "sessionId": opened["sessionId"],
            "updateBase64": base64::engine::general_purpose::STANDARD
                .encode(edited.initial_update)
        }),
    )
    .await;

    call(
        &transport,
        &handle,
        74,
        "ydoc.close",
        json!({ "sessionId": opened["sessionId"] }),
    )
    .await;
    let settled: Value = serde_json::from_slice(
        &std::fs::read(scratch.path().join("drawings/close.excalidraw"))
            .expect("settled scene artifact"),
    )
    .expect("settled portable JSON");
    assert_eq!(settled["elements"][0]["version"], json!(2));
    assert_eq!(
        settled["files"]["image-file"]["dataURL"],
        json!(format!("data:image/png;base64,{image_base64}"))
    );
    let reopened = call(
        &transport,
        &handle,
        75,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "drawings/close.excalidraw",
            "contentKind": "scene",
            "seedFromArtifact": true
        }),
    )
    .await;
    assert_eq!(reopened["lineage"], json!("existing"));
    assert_eq!(reopened["artifactAssets"][0]["id"], json!("image-file"));
    call(
        &transport,
        &handle,
        76,
        "ydoc.evict",
        json!({ "sessionId": reopened["sessionId"] }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_a_scene_retires_only_its_owned_assets_and_rollback_restores_them() {
    let scratch = ScratchDir::new().expect("scratch");
    let image_bytes = valid_png_with_text_padding(2048);
    let image_base64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
    let artifact = serde_json::to_string(&json!({
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [{
            "id": "image-element", "type": "image", "version": 1,
            "versionNonce": 1, "isDeleted": false, "index": "a0",
            "fileId": "image-file"
        }],
        "appState": {},
        "files": { "image-file": {
            "id": "image-file", "mimeType": "image/png", "created": 12,
            "dataURL": format!("data:image/png;base64,{image_base64}")
        }}
    }))
    .expect("portable scene");
    for path in ["drawings/delete.excalidraw", "drawings/keep.excalidraw"] {
        write_file(scratch.path(), path, artifact.as_bytes());
    }

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-scene-asset-delete", 1).await;
    call(&transport, &handle, 2, "capture.flush", json!({})).await;
    let deleted_object_id = dohc_engine_domain::derive_capture_object_id(
        "ws-scene-asset-delete",
        "main",
        "drawings/delete.excalidraw",
    );
    let mut store = EngineStore::open(&engine_db_path(&scratch).expect("engine database"), 2)
        .expect("open marker store");
    ensure_marker(
        &mut store,
        &DocKey::new("ws-scene-asset-delete", "main", &deleted_object_id).expect("drawing key"),
        ContentKind::Scene,
        Regime::Replicated,
        &NoFaults,
        2,
    )
    .expect("ensure replicated drawing marker");
    drop(store);
    let deleted_drawing = call(
        &transport,
        &handle,
        3,
        "ydoc.open",
        json!({ "versionId": "main", "path": "drawings/delete.excalidraw",
            "contentKind": "scene", "seedFromArtifact": true }),
    )
    .await;
    let deleted_asset = deleted_drawing["artifactAssets"][0]["ref"]
        .as_str()
        .expect("deleted asset ref")
        .to_owned();
    call(
        &transport,
        &handle,
        4,
        "ydoc.close",
        json!({ "sessionId": deleted_drawing["sessionId"] }),
    )
    .await;
    let kept_drawing = call(
        &transport,
        &handle,
        5,
        "ydoc.open",
        json!({ "versionId": "main", "path": "drawings/keep.excalidraw",
            "contentKind": "scene", "seedFromArtifact": true }),
    )
    .await;
    let kept_asset = kept_drawing["artifactAssets"][0]["ref"]
        .as_str()
        .expect("kept asset ref")
        .to_owned();
    call(
        &transport,
        &handle,
        6,
        "ydoc.close",
        json!({ "sessionId": kept_drawing["sessionId"] }),
    )
    .await;

    let owner_directory = deleted_asset.rsplit_once('/').expect("owner directory").0;
    let adjacent_bytes = b"user-owned-adjacent-file";
    let adjacent_sha = dohc_engine_storage::hex_sha256(adjacent_bytes);
    let adjacent_path = format!("{owner_directory}/{adjacent_sha}.png");
    call(
        &transport,
        &handle,
        7,
        "versionedBinary.write",
        json!({ "versionId": "main", "path": adjacent_path,
            "bytes": adjacent_bytes, "origin": "local-file" }),
    )
    .await;

    let deleted = call_keyed(
        &transport,
        &handle,
        8,
        "versionedText.delete",
        "delete-drawing-assets",
        json!({ "versionId": "main", "path": "drawings/delete.excalidraw",
            "origin": "api" }),
    )
    .await;
    assert!(!scratch.path().join(&deleted_asset).exists());
    assert_eq!(
        std::fs::read(scratch.path().join(&kept_asset)).expect("sibling asset"),
        image_bytes
    );
    assert_eq!(
        std::fs::read(scratch.path().join(&adjacent_path)).expect("adjacent user asset"),
        adjacent_bytes
    );
    std::fs::remove_file(scratch.path().join("drawings/delete.excalidraw"))
        .expect("simulate the desktop trash move");

    call(&transport, &handle, 9, "workspace.close", json!({})).await;
    drop(transport);
    let restarted = InProcessTransport::new(Arc::new(EngineService::new()));
    let restarted_handle = open_workspace(&restarted, &scratch, "ws-scene-asset-delete", 10).await;
    assert!(!scratch.path().join(&deleted_asset).exists());
    call(
        &restarted,
        &restarted_handle,
        11,
        "versionedText.rollback",
        json!({ "versionId": "main", "path": "drawings/delete.excalidraw",
            "mutationMomentId": deleted["moment"]["momentId"], "origin": "restore" }),
    )
    .await;
    let restored = call(
        &restarted,
        &restarted_handle,
        12,
        "ydoc.open",
        json!({ "versionId": "main", "path": "drawings/delete.excalidraw",
            "contentKind": "scene", "seedFromArtifact": false }),
    )
    .await;
    assert_eq!(restored["lineage"], json!("existing"));
    assert_eq!(restored["artifactAssets"][0]["ref"], json!(deleted_asset));
    assert_eq!(
        std::fs::read(scratch.path().join(&deleted_asset)).expect("restored asset"),
        image_bytes
    );
    assert_eq!(
        std::fs::read(scratch.path().join(&kept_asset)).expect("sibling asset after restore"),
        image_bytes
    );
    assert_eq!(
        std::fs::read(scratch.path().join(&adjacent_path))
            .expect("adjacent user asset after restore"),
        adjacent_bytes
    );
    call(
        &restarted,
        &restarted_handle,
        13,
        "ydoc.evict",
        json!({ "sessionId": restored["sessionId"] }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scene_open_rejects_forged_asset_namespace_without_a_writable_fallback() {
    let scratch = ScratchDir::new().expect("scratch");
    let artifact = serde_json::to_string(&json!({
        "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
        "elements": [], "appState": {}, "files": {}
    }))
    .expect("portable scene");
    write_file(scratch.path(), "forged.excalidraw", artifact.as_bytes());
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-scene-forged", 121).await;
    let opened = call(
        &transport,
        &handle,
        122,
        "ydoc.open",
        json!({
            "versionId": "main", "path": "forged.excalidraw",
            "contentKind": "scene", "seedFromArtifact": false
        }),
    )
    .await;
    let sha256 = dohc_engine_storage::hex_sha256(&[1_u8, 2, 3, 4]);
    call(
        &transport,
        &handle,
        123,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": opened["lineageClaimId"],
            "sessionId": opened["sessionId"],
            "updateBase64": image_scene_update_with_asset_record(
                "image-file", "image/png", "unrelated/user-image.png", &sha256
            )
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        124,
        "ydoc.evict",
        json!({ "sessionId": opened["sessionId"] }),
    )
    .await;
    let invalid = call_error(
        &transport,
        &handle,
        125,
        "ydoc.open",
        json!({
            "versionId": "main", "path": "forged.excalidraw",
            "contentKind": "scene", "seedFromArtifact": false
        }),
    )
    .await;
    assert_eq!(invalid.code, ErrorCode::Internal);
    assert_eq!(invalid.message, "ydoc-artifact-assets-invalid");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scene_seed_omits_deleted_and_unused_native_files() {
    let scratch = ScratchDir::new().expect("scratch");
    let artifact = serde_json::to_string(&json!({
        "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
        "elements": [{
            "id": "deleted-image", "type": "image", "version": 1,
            "versionNonce": 1, "isDeleted": true, "index": "a0", "fileId": "deleted"
        }],
        "appState": {},
        "files": {
            "deleted": { "id": "deleted", "mimeType": "image/png", "created": 1,
                "dataURL": "data:image/png;base64,AQIDBA==" },
            "unused": { "id": "unused", "mimeType": "image/png", "created": 2,
                "dataURL": "data:image/png;base64,BQYHCA==" }
        }
    }))
    .expect("portable scene");
    write_file(scratch.path(), "privacy.excalidraw", artifact.as_bytes());
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-scene-privacy", 131).await;
    let opened = call(
        &transport,
        &handle,
        132,
        "ydoc.open",
        json!({
            "versionId": "main", "path": "privacy.excalidraw",
            "contentKind": "scene", "seedFromArtifact": true
        }),
    )
    .await;
    assert!(opened.get("artifactAssets").is_none());
    assert!(!scratch.path().join("assets/excalidraw").exists());
    call(
        &transport,
        &handle,
        133,
        "ydoc.settle",
        json!({ "sessionId": opened["sessionId"] }),
    )
    .await;
    let settled: Value = serde_json::from_slice(
        &std::fs::read(scratch.path().join("privacy.excalidraw")).expect("settled scene"),
    )
    .expect("settled JSON");
    assert_eq!(settled["elements"], json!([]));
    assert_eq!(settled["files"], json!({}));
}

/// Stage the interleaving: a 0-byte artifact on disk that capture has not
/// yet ingested, with a live session opened over it. Returns the path it
/// staged and the open result.
///
/// The order is verified, not assumed. Writing the file and opening straight
/// after relies on the open beating the watcher's settle window, and this
/// machine has shown 3.5x slowdowns under suite load — a paused task lets
/// capture ingest first, `seedContent` comes back "" instead of null, and the
/// test false-fails without ever staging the race it exists to cover.
///
/// The capture probe cannot enforce it either: its seam holds the driver after
/// `reconcile_if_dirty` reports Completed, so the head is already minted by the
/// time it pauses. There is no pre-apply seam, and this is not worth adding new
/// engine surface for. So an attempt that lost the race is detected and retried
/// on a path capture has never seen, and exhausting the attempts fails rather
/// than proceeding over an unstaged interleaving.
async fn stage_headless_session_over_an_empty_artifact(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    scratch: &ScratchDir,
    stem: &str,
) -> (String, Value) {
    for attempt in 0..8 {
        let path = format!("notes/{stem}-{attempt}.md");
        write_file(scratch.path(), &path, b"");
        let opened = call(
            transport,
            handle,
            1_000 + attempt,
            "ydoc.open",
            json!({
                "versionId": "main",
                "path": path,
                "contentKind": "plaintext"
            }),
        )
        .await;
        if opened["seedContent"] == Value::Null {
            // The seed comes from the HEAD, not from disk, so a null seed IS
            // the proof that no head exists yet.
            assert_eq!(opened["lineage"], json!("absent"));
            // ...and the open reports that absence in its own right, which is
            // what the desktop's absent-head contract reads to tell a
            // creation apart from a path the version does not have.
            assert_eq!(opened["head"], json!("absent"));
            return (path, opened);
        }
        // Capture won the race. Drop this session and stage again elsewhere;
        // the lineage carries no durable state, so the prune-close is clean.
        let session_id = opened["sessionId"].as_str().expect("session id");
        call(
            transport,
            handle,
            2_000 + attempt,
            "ydoc.close",
            json!({ "sessionId": session_id, "settle": false }),
        )
        .await;
    }
    panic!("could not open a session before capture ingested the empty artifact in 8 attempts");
}

/// Wait until capture has observed a disk change but cannot apply it because
/// this test still holds the document lease.
async fn wait_for_capture_to_defer_under_live_session(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    path: &str,
    id_base: u64,
) {
    let mut last_flush = Value::Null;
    let mut last_status = Value::Null;
    for attempt in 0..40 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        last_flush = call(
            transport,
            handle,
            id_base + attempt * 2,
            "capture.flush",
            json!({}),
        )
        .await;
        last_status = call(
            transport,
            handle,
            id_base + attempt * 2 + 1,
            "watcher.status",
            json!({}),
        )
        .await;
        if last_flush["settled"] == json!(true)
            && last_flush["degraded"] == json!(false)
            && last_status["deferredWrites"]
                .as_array()
                .is_some_and(|paths| paths.iter().any(|entry| entry.as_str() == Some(path)))
        {
            return;
        }
    }
    panic!(
        "capture did not report its healthy deferred live-session write: {last_flush}; {last_status}"
    );
}

async fn moment_count_for_object(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    object_id: &str,
) -> usize {
    call(
        transport,
        handle,
        id,
        "moments.list",
        json!({ "objectId": object_id, "limit": 100 }),
    )
    .await["moments"]
        .as_array()
        .expect("moments")
        .len()
}

#[derive(Debug, PartialEq, Eq)]
struct TableFingerprint {
    name: &'static str,
    rows: Vec<Vec<String>>,
}

#[derive(Debug, PartialEq, Eq)]
struct SettleFingerprint(Vec<TableFingerprint>);

fn settle_fingerprint(scratch: &ScratchDir, workspace_id: &str) -> SettleFingerprint {
    let connection =
        rusqlite::Connection::open(engine_db_path(scratch).expect("engine database path"))
            .expect("open engine database");
    let rows = |table: &'static str, workspace_scoped: bool| {
        let sql = if workspace_scoped {
            format!("SELECT * FROM {table} WHERE workspace_id=?1 ORDER BY rowid")
        } else {
            format!("SELECT * FROM {table} ORDER BY rowid")
        };
        let mut statement = connection.prepare(&sql).expect("prepare fingerprint query");
        let column_count = statement.column_count();
        let mut query = if workspace_scoped {
            statement
                .query([workspace_id])
                .expect("query workspace rows")
        } else {
            statement.query([]).expect("query global rows")
        };
        let mut result = Vec::new();
        while let Some(row) = query.next().expect("read fingerprint row") {
            let mut values = Vec::with_capacity(column_count);
            for column in 0..column_count {
                let value = match row.get_ref(column).expect("read fingerprint value") {
                    rusqlite::types::ValueRef::Null => "null".to_owned(),
                    rusqlite::types::ValueRef::Integer(value) => format!("integer:{value}"),
                    rusqlite::types::ValueRef::Real(value) => format!("real:{value}"),
                    rusqlite::types::ValueRef::Text(value) => {
                        format!("text:{}", String::from_utf8_lossy(value))
                    }
                    rusqlite::types::ValueRef::Blob(value) => format!("blob:{value:?}"),
                };
                values.push(value);
            }
            result.push(values);
        }
        TableFingerprint {
            name: table,
            rows: result,
        }
    };

    SettleFingerprint(
        [
            ("file_objects", true),
            ("path_aliases", true),
            ("blobs", false),
            ("binary_blobs", false),
            ("snapshots", true),
            ("moments", true),
            ("replication_log", true),
            ("engine_search_files_fts", true),
            ("materialization_jobs", true),
            ("engine_requests", false),
            ("ydoc_docs", true),
            ("ydoc_updates", true),
            ("ydoc_snapshots", true),
            ("ydoc_deferred_updates", true),
            ("ydoc_base_relay_candidates", true),
            ("ydoc_inactive_lineages", true),
            ("ydoc_recovery_decisions", true),
        ]
        .into_iter()
        .map(|(table, scoped)| rows(table, scoped))
        .collect(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ydoc_open_rejects_secret_paths() {
    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), ".env.local", b"TOKEN=secret\n");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-secret", 1).await;

    let error = transport
        .call(
            RequestContext::unbounded(),
            request(
                2,
                "ydoc.open",
                Some(handle),
                json!({
                    "versionId": "main",
                    "path": ".env.local",
                    "contentKind": "plaintext"
                }),
            ),
        )
        .await
        .expect_err("a secret path must never enter a plaintext Y.Doc session");

    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert_eq!(error.message, "invalid Y.Doc path");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_ydoc_sessions_settle_suppress_capture_and_roundtrip() {
    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), "notes/live.md", b"before");
    write_file(scratch.path(), "notes/race.md", b"race base");
    write_file(
        scratch.path(),
        "binary.png",
        &[0x89, 0x50, 0x4e, 0x47, 0x00, 0xff],
    );

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/live.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    assert_eq!(opened["lineage"], json!("absent"));
    // A captured file: no CRDT lineage yet, but the version has a snapshot for
    // the path. The open consumer keys its refusal on `head`, not on `lineage`
    // — reading `lineage` here would refuse every ordinary first open.
    assert_eq!(opened["head"], json!("present"));
    assert_eq!(opened["seedContent"], json!("before"));
    let session_id = opened["sessionId"].as_str().expect("session id");
    let object_id = opened["objectId"].as_str().expect("object id");
    assert!(session_id.starts_with("ydoc-"));
    // ydoc-<pid:x>-<boot_ms:x>-<seq:016x>: the epoch keeps ids unique
    // across daemon lifetimes (they seed persisted idempotency keys).
    assert!(
        session_id
            .rsplit('-')
            .next()
            .is_some_and(|seq| seq.len() == 16 && seq.chars().all(|c| c.is_ascii_hexdigit()))
    );

    let busy = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "ydoc.open",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "notes/live.md" }),
            ),
        )
        .await
        .expect_err("a second live lease must refuse");
    assert_eq!(busy.code, ErrorCode::InvalidParams);
    assert_eq!(busy.message, "ydoc-session-busy");

    let before_moments = moment_count_for_object(&transport, &handle, 5, object_id).await;
    let recorded = call(
        &transport,
        &handle,
        6,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": null,
            "sessionId": session_id,
            "updateBase64": plaintext_update("settled text")
        }),
    )
    .await;
    assert_eq!(recorded["seq"], json!(1));
    assert_eq!(recorded["deduped"], json!(false));
    let settled = call(
        &transport,
        &handle,
        7,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "RPC-C settle" }),
    )
    .await;
    assert_eq!(settled["content"], json!("settled text"));
    assert_eq!(settled["projection"]["contentKind"], json!("plaintext"));
    assert_eq!(settled["projection"]["destructive"], json!(false));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/live.md")).expect("materialized"),
        "settled text"
    );
    assert!(
        std::fs::read_dir(scratch.path().join("notes"))
            .expect("notes dir")
            .all(|entry| !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".conflict")),
        "settling over an existing file must not create a spurious conflict"
    );
    let fetched = call(
        &transport,
        &handle,
        8,
        "moments.get",
        json!({ "momentId": settled["momentId"] }),
    )
    .await;
    assert_eq!(fetched["afterText"], json!("settled text"));

    // Keep the watcher's pre-settle manifest so it observes the Changed write.
    write_file(
        scratch.path(),
        "notes/scan-confirmed.md",
        b"capture barrier",
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut id = 2_000_000;
    let flushed = loop {
        id += 1;
        let flushed = call(&transport, &handle, id, "capture.flush", json!({})).await;
        id += 1;
        let listed = call(
            &transport,
            &handle,
            id,
            "versionedText.list",
            json!({ "versionId": "main" }),
        )
        .await;
        if listed["files"]
            .as_array()
            .expect("files")
            .iter()
            .any(|file| file["path"] == json!("notes/scan-confirmed.md"))
            && flushed["settled"] == json!(true)
        {
            break flushed;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "capture never settled after observing the post-settle sibling"
        );
        tokio::task::yield_now().await;
    };
    assert_eq!(flushed["settled"], json!(true));
    let after_moments = moment_count_for_object(&transport, &handle, 10, object_id).await;
    assert_eq!(after_moments, before_moments + 1);
    // Without settlement's suppression registration, the live lease defers
    // the Changed ingest and capture cannot settle at the barrier above.
    // Successful suppression must also preserve the Y.Doc's ownership.
    let head = call(
        &transport,
        &handle,
        91,
        "versionedText.read",
        json!({ "versionId": "main", "path": "notes/live.md" }),
    )
    .await;
    assert_eq!(
        head["metadataOrigin"],
        json!("ydoc"),
        "capture must not claim the daemon's own settlement write"
    );

    call(
        &transport,
        &handle,
        11,
        "ydoc.close",
        json!({ "sessionId": session_id, "settle": false }),
    )
    .await;
    let reopened = call(
        &transport,
        &handle,
        12,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/live.md" }),
    )
    .await;
    // The local-only close pruned the CRDT cache to the bare marker
    // (the workspace file is the artifact), so the reopen must not claim an existing
    // lineage — that would hand the client an empty doc with nothing to seed
    // from, and its next settle would clobber the settled file. Instead the
    // artifact re-seeds the cache: lineage absent + seedContent carrying the
    // settled content.
    assert_eq!(reopened["lineage"], json!("absent"));
    assert_eq!(reopened["seedContent"], json!("settled text"));
    let reopened_session = reopened["sessionId"].as_str().expect("reopened session");
    let reseeded = call(
        &transport,
        &handle,
        13,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": null,
            "sessionId": reopened_session,
            "updateBase64": plaintext_update("settled text")
        }),
    )
    .await;
    assert_eq!(reseeded["seq"], json!(1));
    let (_resync, resync_state) = call_ydoc_with_blob(
        service.as_ref(),
        &handle,
        32,
        "ydoc.resync",
        json!({ "sessionId": reopened_session }),
    )
    .await;
    // Apply the resync state to prove the durable lineage now carries the
    // re-seeded settled content. Equality with an empty state cannot pass.
    let resynced_doc = Ydoc::wire();
    resynced_doc
        .apply(&resync_state)
        .expect("resync state applies");
    assert_eq!(resynced_doc.plaintext_string(), "settled text");
    call(
        &transport,
        &handle,
        14,
        "ydoc.close",
        json!({ "sessionId": reopened_session }),
    )
    .await;

    let rich = call(
        &transport,
        &handle,
        15,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/rich.md",
            "contentKind": "richdoc"
        }),
    )
    .await;
    let rich_session = rich["sessionId"].as_str().expect("rich session");
    // Richdoc settles since the full-fidelity projection landed (R15-3): the
    // body fragment projects to markdown, and the settle materializes the .md
    // like plaintext does. (The C1-era refusal was a stale guard — the desktop
    // editor could journal rich edits that never reached the file.)
    let rich_update = {
        let doc = Ydoc::wire();
        base64::engine::general_purpose::STANDARD
            .encode(doc.richdoc_append_paragraph("Rich settled body."))
    };
    let recorded = call(
        &transport,
        &handle,
        16,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": rich_session, "updateBase64": rich_update }),
    )
    .await;
    assert_eq!(recorded["seq"], json!(1));
    let rich_settled = call(
        &transport,
        &handle,
        17,
        "ydoc.settle",
        json!({ "sessionId": rich_session }),
    )
    .await;
    let rich_markdown = rich_settled["content"].as_str().expect("rich markdown");
    assert!(
        rich_markdown.contains("Rich settled body."),
        "richdoc settle must project the body fragment, got {rich_markdown:?}"
    );
    let rich_on_disk = std::fs::read_to_string(scratch.path().join("notes/rich.md"))
        .expect("richdoc settle materializes notes/rich.md");
    assert!(
        rich_on_disk.contains("Rich settled body."),
        "materialized .md must carry the settled body, got {rich_on_disk:?}"
    );
    call(
        &transport,
        &handle,
        19,
        "ydoc.close",
        json!({ "sessionId": rich_session }),
    )
    .await;
    // The default close settled the richdoc, so the local-only lineage prunes
    // exactly like plaintext (the workspace file is the artifact): a reopen must reseed
    // from the settled markdown, not resume a persisted CRDT — a persisted
    // closed CRDT would shadow any external .md edit made while closed.
    let rich_reopened = call(
        &transport,
        &handle,
        20,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/rich.md",
            "contentKind": "richdoc"
        }),
    )
    .await;
    assert_eq!(rich_reopened["lineage"], json!("absent"));
    let reseed = rich_reopened["seedContent"].as_str().expect("rich reseed");
    assert!(
        reseed.contains("Rich settled body."),
        "reopen must reseed from the settled artifact, got {reseed:?}"
    );
    call(
        &transport,
        &handle,
        21,
        "ydoc.close",
        json!({ "sessionId": rich_reopened["sessionId"].as_str().expect("reopened session") }),
    )
    .await;

    // A bare local marker does not own its content kind: a kindless open
    // (plaintext default) whose session settled and pruned leaves only a
    // remembered default behind — the 2026-07 desktop outage minted exactly
    // these for rich .md paths. An explicit richdoc reopen must win and
    // rewrite the marker, or the poisoned default silently rebinds the doc
    // to plaintext forever (empty editor over a non-empty file).
    let poisoned = call(
        &transport,
        &handle,
        22,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/poisoned.md" }),
    )
    .await;
    assert_eq!(poisoned["contentKind"], json!("plaintext"));
    let poisoned_session = poisoned["sessionId"].as_str().expect("poisoned session");
    call(
        &transport,
        &handle,
        23,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": null,
            "sessionId": poisoned_session,
            "updateBase64": plaintext_update("poisoned default body")
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        24,
        "ydoc.settle",
        json!({ "sessionId": poisoned_session }),
    )
    .await;
    call(
        &transport,
        &handle,
        25,
        "ydoc.close",
        json!({ "sessionId": poisoned_session }),
    )
    .await;
    let recovered = call(
        &transport,
        &handle,
        26,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/poisoned.md",
            "contentKind": "richdoc"
        }),
    )
    .await;
    assert_eq!(
        recovered["contentKind"],
        json!("richdoc"),
        "an explicit kind must override a bare marker's remembered default"
    );
    assert_eq!(recovered["lineage"], json!("absent"));
    assert_eq!(recovered["seedContent"], json!("poisoned default body"));
    call(
        &transport,
        &handle,
        27,
        "ydoc.close",
        json!({ "sessionId": recovered["sessionId"].as_str().expect("recovered session") }),
    )
    .await;

    let binary = transport
        .call(
            RequestContext::unbounded(),
            request(
                18,
                "ydoc.open",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "binary.png" }),
            ),
        )
        .await
        .expect_err("binary heads cannot open as Y.Doc text");
    assert_eq!(binary.code, ErrorCode::InvalidParams);

    let isolated = call(
        &transport,
        &handle,
        23,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/isolated.md" }),
    )
    .await;
    let isolated_session = isolated["sessionId"].as_str().expect("isolated session");
    let other = ScratchDir::new().expect("other scratch");
    write_file(other.path(), "bootstrap.md", b"other");
    let other_handle = open_workspace(&transport, &other, "ws-rpc-ydoc-other", 24).await;
    let cross_workspace = transport
        .call(
            RequestContext::unbounded(),
            request(
                25,
                "ydoc.resync",
                Some(other_handle.clone()),
                json!({ "sessionId": isolated_session }),
            ),
        )
        .await
        .expect_err("session ids are workspace scoped");
    assert_eq!(cross_workspace.message, "ydoc-session-not-found");
    // workspace.close drops every bound session and therefore its lease.
    call(&transport, &handle, 26, "workspace.close", json!({})).await;
    let reopened_handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc", 27).await;
    let after_workspace_close = call(
        &transport,
        &reopened_handle,
        28,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/isolated.md" }),
    )
    .await;
    call(
        &transport,
        &reopened_handle,
        29,
        "ydoc.close",
        json!({ "sessionId": after_workspace_close["sessionId"] }),
    )
    .await;
    call(
        &transport,
        &reopened_handle,
        30,
        "workspace.close",
        json!({}),
    )
    .await;
    call(&transport, &other_handle, 31, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_ingesting_content_under_a_headless_session_still_refuses() {
    // The inverse of the test above, and the guard on its fix: the empty
    // artifact is adopted because it IS the session's base. Content is not.
    // Here something writes real bytes to the path after the session opened
    // headless, and capture ingests them. Settling would overwrite bytes the
    // user never saw, so it must still refuse.
    //
    // Mutation check: drop the empty-artifact test from the expectation
    // adoption in `ydoc_settle_on_store` and this settle succeeds, silently
    // destroying the ingested content.
    let scratch = ScratchDir::new().expect("scratch");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-rival", 1).await;

    let (path, opened) =
        stage_headless_session_over_an_empty_artifact(&transport, &handle, &scratch, "rival").await;
    let session_id = opened["sessionId"].as_str().expect("session id");

    // Content the session never saw lands on the path. Capture observes it,
    // but the live lease keeps the head unchanged until the session ends.
    write_file(scratch.path(), &path, b"written by something else\n");
    wait_for_capture_to_defer_under_live_session(&transport, &handle, &path, 100).await;
    let ingested = call(
        &transport,
        &handle,
        200,
        "versionedText.read",
        json!({ "versionId": "main", "path": path }),
    )
    .await;
    assert_eq!(
        ingested["text"],
        Value::Null,
        "capture must not advance the head under a live session"
    );

    call(
        &transport,
        &handle,
        4,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": null,
            "sessionId": session_id,
            "updateBase64": plaintext_update("typed over the rival")
        }),
    )
    .await;
    let before_refusal = settle_fingerprint(&scratch, "ws-rpc-ydoc-rival");
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                5,
                "ydoc.settle",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "summary": "type" }),
            ),
        )
        .await
        .expect_err("a settle over ingested content must refuse");
    assert_eq!(refused.message, "conflict-stale-target");
    assert_eq!(
        settle_fingerprint(&scratch, "ws-rpc-ydoc-rival"),
        before_refusal,
        "a stale disk preimage must refuse before any domain, Y.Doc, outbox, or request row changes"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(&path)).expect("intact"),
        "written by something else\n",
        "the refused settle must leave the ingested bytes intact"
    );

    // Release the lease without settling the stale draft. The queued capture
    // can now ingest the rival bytes it already observed.
    call(
        &transport,
        &handle,
        6,
        "ydoc.evict",
        json!({ "sessionId": session_id }),
    )
    .await;
    let captured = wait_for_captured_head(
        &transport,
        &handle,
        &path,
        "written by something else\n",
        300,
    )
    .await;
    assert_eq!(captured["metadataOrigin"], json!("capture"));

    // The client lost that session and now reopens it: the retained draft
    // lineage, not a fresh seed. Capture folded that lineage to the ingested
    // bytes and recorded them as its settled file, so the next keystroke
    // settles on top of them and never writes the draft back over them.
    let (reopened, reopened_state) = call_ydoc_with_blob(
        service.as_ref(),
        &handle,
        8,
        "ydoc.open",
        json!({ "versionId": "main", "path": path, "contentKind": "plaintext" }),
    )
    .await;
    assert_eq!(reopened["lineage"], json!("existing"));
    assert_eq!(reopened["seedContent"], Value::Null);
    // The keystroke is typed into the reopened document, at its end.
    let client = Ydoc::wire();
    client.apply(&reopened_state).expect("reopened state");
    let before_key = client
        .project(ContentKind::Plaintext)
        .expect("reopened projection")
        .content;
    assert_eq!(before_key, "written by something else\n");
    let end = u32::try_from(before_key.encode_utf16().count()).expect("small text");
    let keystroke = base64::engine::general_purpose::STANDARD
        .encode(client.plaintext_insert(end, " and one more key"));
    let reopened_id = reopened["sessionId"].as_str().expect("session id");
    call(
        &transport,
        &handle,
        9,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": null,
            "sessionId": reopened_id,
            "updateBase64": keystroke
        }),
    )
    .await;
    let settled = call(
        &transport,
        &handle,
        10,
        "ydoc.settle",
        json!({ "sessionId": reopened_id, "summary": "type" }),
    )
    .await;
    let on_disk = std::fs::read_to_string(scratch.path().join(&path)).expect("file");
    assert_eq!(
        on_disk, "written by something else\n and one more key",
        "the keystroke lands on the ingested bytes, and the refused draft is not written"
    );
    assert_eq!(settled["content"], json!(on_disk));
    call(
        &transport,
        &handle,
        11,
        "ydoc.close",
        json!({ "sessionId": reopened_id, "settle": false }),
    )
    .await;

    call(&transport, &handle, 7, "workspace.close", json!({})).await;
}

/// Settle `session_id` and require the engine to refuse it without writing
/// `path`, which was deleted outside dohc.
async fn assert_settle_refuses_over_deleted_file(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    scratch: &ScratchDir,
    id: u64,
    path: &str,
    session_id: &str,
) {
    let refused = call_with_busy_retry(
        transport,
        RequestContext::unbounded(),
        request(
            id,
            "ydoc.settle",
            Some(handle.clone()),
            json!({ "sessionId": session_id, "summary": "type" }),
        ),
    )
    .await
    .expect_err("a settle over a file deleted outside dohc must refuse");
    assert_eq!(refused.message, "conflict-stale-target", "{path}");
    assert!(
        !scratch.path().join(path).exists(),
        "the refused settle must not write {path} back"
    );
}

/// Open a session that continues `object_id` at `path`, as the desktop's
/// replacement does after the engine restarts, and type into it. The
/// replacement finds no head: capture retires a recorded head once no session
/// holds it, and New File's head was never recorded.
async fn open_continuation_and_type(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    path: &str,
    object_id: &Value,
) -> String {
    let opened = call(
        transport,
        handle,
        id,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": path,
            "contentKind": "plaintext",
            "expectedObjectId": object_id
        }),
    )
    .await;
    assert_eq!(opened["head"], json!("absent"), "{path}");
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    call(
        transport,
        handle,
        id + 1,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": null,
            "sessionId": session_id,
            "updateBase64": plaintext_update("typed after the restart ")
        }),
    )
    .await;
    session_id
}

/// Require that capture has retired `path`, deleted outside dohc.
async fn assert_retired(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    path: &str,
) {
    // The watcher reports ready only after the startup scan's changes have
    // applied, and that scan retires a file deleted while the engine was down.
    let retired = call(
        transport,
        handle,
        id,
        "versionedText.read",
        json!({ "versionId": "main", "path": path }),
    )
    .await;
    assert_eq!(retired["text"], Value::Null, "capture must retire {path}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_replacement_after_a_restart_does_not_recreate_a_file_whose_write_went_unreported() {
    // dohc#2311. Documents with no file. One's first save writes the file,
    // and the engine dies before its answer reaches the desktop. Another's
    // close writes it, and the close's answer is lost or says nothing. The
    // desktop never learns either file existed. Both files are deleted
    // outside dohc while the engine is down, and capture retires them. The
    // replacements must not write them back: the engine's moments say they
    // existed. A drawing's retire keeps its Y.Doc rows, so even a fresh
    // open resumes it, as a close debt's payment or a reopen does, and must
    // not write it back either. A document that never had a file still gets
    // one from its replacement, and a fresh open at a path whose file was
    // deleted and retired is a new document, whose first save creates the
    // file.
    const WS: &str = "ws-rpc-ydoc-unreported-write";
    const SETTLED: &str = "notes/settled.md";
    const CLOSED: &str = "notes/closed.md";
    const DRAFT: &str = "notes/draft.md";
    const RETIRED: &str = "notes/retired.md";
    const DRAWING: &str = "drawings/kept.excalidraw";
    let scratch = ScratchDir::new().expect("scratch");
    let drawing = serde_json::to_string(&json!({
        "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
        "elements": [{ "id": "box", "type": "rectangle", "version": 1, "versionNonce": 1,
            "isDeleted": false, "x": 0, "y": 0, "width": 10, "height": 10, "index": "a0" }],
        "appState": {},
        "files": {}
    }))
    .expect("scene");
    write_file(scratch.path(), DRAWING, drawing.as_bytes());
    let open_drawing = json!({ "versionId": "main", "path": DRAWING, "contentKind": "scene",
        "seedFromArtifact": true });
    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&transport, &scratch, WS, 1).await;

    let mut sessions = BTreeMap::new();
    for (id, path) in (10..).step_by(10).zip([SETTLED, CLOSED, DRAFT, RETIRED]) {
        let opened = call(
            &transport,
            &handle,
            id,
            "ydoc.open",
            json!({ "versionId": "main", "path": path, "contentKind": "plaintext" }),
        )
        .await;
        assert_eq!(opened["head"], json!("absent"), "{path}");
        assert_eq!(opened["lineage"], json!("absent"), "{path}");
        call(
            &transport,
            &handle,
            id + 1,
            "ydoc.recordUpdate",
            json!({
                "expectedLineageClaimId": null,
                "sessionId": opened["sessionId"],
                "updateBase64": plaintext_update("typed before the restart ")
            }),
        )
        .await;
        sessions.insert(path, opened);
    }
    for (id, path) in (100..).zip([SETTLED, RETIRED]) {
        let written = call(
            &transport,
            &handle,
            id,
            "ydoc.settle",
            json!({ "sessionId": sessions[path]["sessionId"], "summary": "type" }),
        )
        .await;
        assert_eq!(written["materialized"], json!(true), "{path}");
    }
    call(
        &transport,
        &handle,
        110,
        "ydoc.close",
        json!({ "sessionId": sessions[CLOSED]["sessionId"] }),
    )
    .await;
    for (id, path) in (120..).zip([SETTLED, DRAFT, RETIRED]) {
        call(
            &transport,
            &handle,
            id,
            "ydoc.evict",
            json!({ "sessionId": sessions[path]["sessionId"] }),
        )
        .await;
    }
    let drawn = call(&transport, &handle, 130, "ydoc.open", open_drawing.clone()).await;
    assert_eq!(drawn["head"], json!("present"));
    call(
        &transport,
        &handle,
        131,
        "ydoc.evict",
        json!({ "sessionId": drawn["sessionId"] }),
    )
    .await;
    call(&transport, &handle, 140, "workspace.close", json!({})).await;
    drop(transport);
    let written = [SETTLED, CLOSED, RETIRED, DRAWING];
    for path in written {
        std::fs::remove_file(scratch.path().join(path)).expect("delete while dohc is down");
    }

    let restarted = InProcessTransport::new(Arc::new(EngineService::new()));
    let handle = open_workspace(&restarted, &scratch, WS, 200).await;
    for (id, path) in (300..).zip(written) {
        assert_retired(&restarted, &handle, id, path).await;
    }

    for (id, path) in (400..).step_by(10).zip([SETTLED, CLOSED]) {
        let session_id =
            open_continuation_and_type(&restarted, &handle, id, path, &sessions[path]["objectId"])
                .await;
        assert_settle_refuses_over_deleted_file(
            &restarted,
            &handle,
            &scratch,
            id + 2,
            path,
            &session_id,
        )
        .await;
        call(
            &restarted,
            &handle,
            id + 3,
            "ydoc.evict",
            json!({ "sessionId": session_id }),
        )
        .await;
    }

    let resumed = call(&restarted, &handle, 450, "ydoc.open", open_drawing).await;
    assert_eq!(resumed["head"], json!("absent"));
    assert_eq!(resumed["lineage"], json!("existing"));
    let resumed = resumed["sessionId"].as_str().expect("session id");
    assert_settle_refuses_over_deleted_file(&restarted, &handle, &scratch, 451, DRAWING, resumed)
        .await;
    call(
        &restarted,
        &handle,
        452,
        "ydoc.evict",
        json!({ "sessionId": resumed }),
    )
    .await;

    let draft = open_continuation_and_type(
        &restarted,
        &handle,
        500,
        DRAFT,
        &sessions[DRAFT]["objectId"],
    )
    .await;
    let fresh = call(
        &restarted,
        &handle,
        510,
        "ydoc.open",
        json!({ "versionId": "main", "path": RETIRED, "contentKind": "plaintext" }),
    )
    .await;
    assert_eq!(fresh["head"], json!("absent"));
    assert_eq!(fresh["lineage"], json!("absent"));
    let fresh = fresh["sessionId"].as_str().expect("session id");
    call(
        &restarted,
        &handle,
        511,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": null,
            "sessionId": fresh,
            "updateBase64": plaintext_update("a new document ")
        }),
    )
    .await;
    for (id, (path, session_id)) in (520..)
        .step_by(10)
        .zip([(DRAFT, draft.as_str()), (RETIRED, fresh)])
    {
        let created = call(
            &restarted,
            &handle,
            id,
            "ydoc.settle",
            json!({ "sessionId": session_id, "summary": "type" }),
        )
        .await;
        assert_eq!(created["materialized"], json!(true), "{path}");
        assert!(scratch.path().join(path).exists(), "{path} was created");
        call(
            &restarted,
            &handle,
            id + 1,
            "ydoc.close",
            json!({ "sessionId": session_id }),
        )
        .await;
    }
    call(&restarted, &handle, 600, "workspace.close", json!({})).await;
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn settle_recovers_after_a_transient_replace_failure() {
    use std::os::windows::fs::OpenOptionsExt;

    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-transient", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/locked.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id");

    let doc = Ydoc::wire();
    let first =
        base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "locked v1"));
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": first }),
    )
    .await;
    call(
        &transport,
        &handle,
        4,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "v1" }),
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/locked.md")).expect("v1 on disk"),
        "locked v1"
    );

    // Hold the target with NO sharing: the settle's atomic replace hits
    // sharing violations until its bounded retry budget exhausts (FileLocked),
    // after the settle transaction committed the new head.
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(scratch.path().join("notes/locked.md"))
        .expect("exclusive lock");

    let second = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "v2 "));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": second }),
    )
    .await;
    let failed = transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "ydoc.settle",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "summary": "v2 blocked" }),
            ),
        )
        .await
        .expect_err("a locked target must fail the settle");
    // The wire names the lock and carries the retry contract: the
    // client retries this settle with backoff, so the write lands when the
    // external handle releases instead of on the next unrelated settle.
    assert_eq!(failed.code, ErrorCode::Overloaded);
    assert_eq!(failed.message, "file-locked");
    // The settle committed (marker matches the projection) but the job is
    // still pending and the disk holds the old bytes: a prune-close now
    // would discard the CRDT with the artifact never replaced. Mutation
    // check: drop the pending-job probe from `close_session`'s prune guard
    // — this close succeeds and the retry below fails on a dead session.
    let prune_refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                60,
                "ydoc.close",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "settle": false }),
            ),
        )
        .await
        .expect_err("prune-close must refuse while the settle job is pending");
    assert_eq!(prune_refused.code, ErrorCode::InvalidParams);
    assert_eq!(prune_refused.message, "ydoc-unsettled-close");
    drop(lock);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/locked.md")).expect("still v1"),
        "locked v1",
        "the failed replace must leave the old bytes"
    );

    // Mutation check: restore the prior-marker rollback (settle_seq/
    // last_settled_sha = prior) in ydoc_settle_on_store's transient-Err arm to
    // bring the bug back — the durable expectation then trails the committed
    // head and this retry refuses ConflictStaleTarget forever.
    let retried = call(
        &transport,
        &handle,
        7,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "v2 retry" }),
    )
    .await;
    assert_eq!(retried["content"], json!("v2 locked v1"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/locked.md")).expect("v2 on disk"),
        "v2 locked v1",
        "the retry must replay the pending materialization"
    );

    call(
        &transport,
        &handle,
        8,
        "ydoc.close",
        json!({ "sessionId": session_id }),
    )
    .await;
    call(&transport, &handle, 9, "workspace.close", json!({})).await;
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_inactive_versions_delete_does_not_cancel_the_active_versions_pending_job() {
    // Follow-up: `cancel_pending_jobs_for_path` is path-keyed
    // but materialization jobs carry no version identity — they mirror the
    // active version's working tree only (the same gate `enqueue_binary_delete`
    // applies to its own job). A delete in a named, inactive version must not
    // touch `main`'s own pending job for a same-named path.
    use std::os::windows::fs::OpenOptionsExt;

    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let workspace_id = "ws-rpc-ydoc-inactive-delete-preserves-active";
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, workspace_id, 1).await;

    // The named version forks main first, before main ever has anything
    // pending: `versions.createNamed` reconciles its source version's disk
    // projection as part of the fork, so forking while a job is stuck behind
    // a lock fails the fork itself rather than leaving the fork clean of it.
    let feature = call(
        &transport,
        &handle,
        2,
        "versions.createNamed",
        json!({
            "workspaceId": workspace_id,
            "name": "feature",
            "fromVersionId": "main",
        }),
    )
    .await["id"]
        .as_str()
        .expect("feature id")
        .to_owned();
    // Feature gets its own, independently-written "notes/shared.md" — not
    // main's, so deleting it can never race main's later lock.
    call_keyed(
        &transport,
        &handle,
        3,
        "versionedText.write",
        "feature-seed",
        json!({
            "versionId": feature,
            "path": "notes/shared.md",
            "text": "feature copy",
            "origin": "api",
        }),
    )
    .await;

    // main: settle v1, then lock and leave a pending v2 job — same shape as
    // the sibling pin above.
    let opened = call(
        &transport,
        &handle,
        4,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/shared.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    let doc = Ydoc::wire();
    let first = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "v1"));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": first }),
    )
    .await;
    call(
        &transport,
        &handle,
        6,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "v1" }),
    )
    .await;

    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(scratch.path().join("notes/shared.md"))
        .expect("exclusive lock");
    let second = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "v2 "));
    call(
        &transport,
        &handle,
        7,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": second }),
    )
    .await;
    transport
        .call(
            RequestContext::unbounded(),
            request(
                8,
                "ydoc.settle",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "summary": "v2 blocked" }),
            ),
        )
        .await
        .expect_err("a locked target must fail the settle");
    drop(lock);
    call(
        &transport,
        &handle,
        9,
        "ydoc.evict",
        json!({ "sessionId": session_id }),
    )
    .await;

    // Deletes feature's own "notes/shared.md" — a different object at the
    // same path string in a different, inactive version. This must never
    // reach main's own pending job.
    call_keyed(
        &transport,
        &handle,
        10,
        "versionedText.delete",
        "inactive-delete",
        json!({
            "versionId": feature,
            "path": "notes/shared.md",
            "origin": "api",
        }),
    )
    .await;

    call(&transport, &handle, 11, "workspace.close", json!({})).await;
    drop(transport);

    let restarted_service = Arc::new(EngineService::new());
    let restarted_transport = InProcessTransport::new(restarted_service);
    let restarted_handle = open_workspace(&restarted_transport, &scratch, workspace_id, 1).await;

    // RED (bug): the inactive version's delete cancels main's pending job by
    // path alone, so replay never applies it — disk stays "v1".
    //
    // GREEN (fix): the cancel only runs for an ACTIVE-version delete, so
    // main's job is untouched and replay applies it normally.
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/shared.md")).expect("v2 after replay"),
        "v2 v1",
        "an inactive version's delete must not cancel the active version's own pending job"
    );

    call(
        &restarted_transport,
        &restarted_handle,
        2,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_a_committed_renames_locked_destination_still_lets_its_paired_source_delete_run() {
    // Follow-up: a binary rename enqueues a paired job pair —
    // a write for the new path, a delete for the old one — and startup replay
    // (and the rollback post-commit path) refuses to run the paired delete
    // until the write proves complete, so the old path is never removed
    // before the new one is proven durable. Cancelling the write (this PR's
    // #739 fix, when the new path is deleted before it ever materializes)
    // must not read as the same "abandon the pair" signal `Conflict` is: the
    // delete already resolved the destination, so the paired delete (the old
    // path) must still run — or that path is stranded on disk forever.
    use std::os::windows::fs::OpenOptionsExt;

    let scratch = ScratchDir::new().expect("scratch");

    let workspace_id = "ws-rpc-ydoc-rename-pair-not-stranded";
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    // Capture could re-import old.bin while its paired delete is pending.
    let handle =
        open_workspace_with_capture_mode(&transport, &scratch, workspace_id, 1, Some("none")).await;
    call(&transport, &handle, 2, "versions.ensureMain", json!({})).await;

    let bytes: &[u8] = &[4, 8, 15, 16, 23, 42];
    call(
        &transport,
        &handle,
        3,
        "versionedBinary.write",
        json!({ "versionId": "main", "path": "old.bin", "bytes": bytes, "origin": "api" }),
    )
    .await;
    assert!(scratch.path().join("old.bin").exists());

    // An untracked raw file plants a lockable target at the rename's
    // destination — the engine's own occupancy check reads `path_aliases`,
    // not disk, so this does not refuse the rename. Matching bytes keeps its
    // own later cleanup (the fresh delete job `versionedText.delete` below
    // enqueues) preimage-clean instead of spuriously conflicting.
    std::fs::write(scratch.path().join("new.bin"), bytes).expect("plant destination");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(scratch.path().join("new.bin"))
        .expect("exclusive lock");

    // The rename commits (moment + path_aliases move to new.bin), but the
    // destination write's post-commit materialize hits the lock and stays
    // pending — so the paired old.bin delete is never attempted either
    // (`write_ready` false).
    let renamed = call_keyed(
        &transport,
        &handle,
        4,
        "versionedText.rename",
        "rename-pair-not-stranded",
        json!({
            "versionId": "main",
            "fromPath": "old.bin",
            "toPath": "new.bin",
            "origin": "api",
        }),
    )
    .await;
    assert_eq!(renamed["moment"]["operation"], "rename");
    // Neither side materialized yet: the write is locked out, and the
    // delete never got its turn.
    assert!(scratch.path().join("old.bin").exists());

    // Delete the renamed destination while its write job is still pending —
    // the cancellation this PR adds fires here.
    call_keyed(
        &transport,
        &handle,
        5,
        "versionedText.delete",
        "delete-locked-rename-destination",
        json!({
            "versionId": "main",
            "path": "new.bin",
            "origin": "api",
        }),
    )
    .await;
    drop(lock);

    call(&transport, &handle, 6, "workspace.close", json!({})).await;
    drop(transport);

    let restarted_service = Arc::new(EngineService::new());
    let restarted_transport = InProcessTransport::new(restarted_service);
    let restarted_handle = open_workspace_with_capture_mode(
        &restarted_transport,
        &scratch,
        workspace_id,
        1,
        Some("none"),
    )
    .await;

    // RED (bug): the replay's rename-pair check treats the write's cancelled
    // status like Conflict — it marks the paired old.bin delete conflict too
    // and abandons it, so old.bin survives on disk forever, stranded.
    //
    // GREEN (fix): cancelled lets the paired delete proceed like complete
    // would, so old.bin is removed.
    assert!(
        !scratch.path().join("old.bin").exists(),
        "the rename's paired source delete must still run when its destination write was cancelled, not stranded"
    );
    // No resurrection either: the destination's own cancelled write, and its
    // own (separately enqueued) delete, never left new.bin behind.
    assert!(!scratch.path().join("new.bin").exists());

    call(
        &restarted_transport,
        &restarted_handle,
        2,
        "workspace.close",
        json!({}),
    )
    .await;
}

/// Poll capture until the head for `path` holds exactly `text`. One sleep plus
/// one flush cannot carry that proof: a watcher that has not queued the write
/// yet makes the flush report quiescence.
async fn wait_for_captured_head(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    path: &str,
    text: &str,
    id_base: u64,
) -> Value {
    let mut head = Value::Null;
    for attempt in 0..40 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        call(
            transport,
            handle,
            id_base + attempt * 2,
            "capture.flush",
            json!({}),
        )
        .await;
        head = call(
            transport,
            handle,
            id_base + attempt * 2 + 1,
            "versionedText.read",
            json!({ "versionId": "main", "path": path }),
        )
        .await;
        if head["text"] == json!(text) {
            return head;
        }
    }
    panic!("capture never ingested {path} as {text:?}; last head: {head}");
}

/// #665, part B: a session that can neither settle nor prune evicts, and the
/// reopen resurrects its edits.
///
/// The desktop reaches this on two populations `captureOnePath` never captures
/// — a policy-excluded path, and a file between the 128 KiB capture limit and
/// the 2 MiB editor limit. The daemon has no policy notion at `ydoc.open`, so
/// this stages the state those two share and nothing else: a dirty local-only
/// lineage whose head does not hold its bytes, which no capture will ever fix.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_uncoverable_dirty_session_evicts_and_the_reopen_resurrects_it() {
    const PATH: &str = "notes/evict.md";

    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), PATH, b"base");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-665-b", 1).await;
    wait_for_captured_head(&transport, &handle, PATH, "base", 1_000).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({ "versionId": "main", "path": PATH, "contentKind": "plaintext" }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "expectedLineageClaimId": null, "sessionId": session_id, "updateBase64": plaintext_update("what the user typed") }),
    )
    .await;

    // The prune still refuses, and it must: the head holds "base" and the
    // document holds what the user typed, so pruning would discard the only
    // copy of it. Part A widened the guard's PROOF, not its verdict.
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "ydoc.close",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "settle": false }),
            ),
        )
        .await
        .expect_err("a head holding other bytes cannot cover this prune");
    assert_eq!(refused.message, "ydoc-unsettled-close");

    // And the refused close reinserted the session, so the retry's open is
    // still locked out. Without an evict this is where the document stays.
    let busy = transport
        .call(
            RequestContext::unbounded(),
            request(
                5,
                "ydoc.open",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": PATH, "contentKind": "plaintext" }),
            ),
        )
        .await
        .expect_err("the refused close holds the lease");
    assert_eq!(busy.message, "ydoc-session-busy");

    let evicted = call(
        &transport,
        &handle,
        6,
        "ydoc.evict",
        json!({ "sessionId": session_id }),
    )
    .await;
    assert_eq!(evicted["evicted"], json!(true));

    // An id the daemon does not hold is still a refusal, so a caller can never
    // read "evicted" for a session that is somebody else's.
    let unknown = transport
        .call(
            RequestContext::unbounded(),
            request(
                7,
                "ydoc.evict",
                Some(handle.clone()),
                json!({ "sessionId": "no-such-session" }),
            ),
        )
        .await
        .expect_err("an unknown session id must refuse");
    assert_eq!(unknown.code, ErrorCode::InvalidParams);
    assert_eq!(unknown.message, "ydoc-session-not-found");

    // Nothing was written and nothing was discarded: the lineage resurrects
    // with the user's edits, and it can now be settled.
    let reopened = call(
        &transport,
        &handle,
        8,
        "ydoc.open",
        json!({ "versionId": "main", "path": PATH, "contentKind": "plaintext" }),
    )
    .await;
    assert_eq!(
        reopened["lineage"],
        json!("existing"),
        "the evicted lineage survives — an evict settles nothing and prunes nothing"
    );
    let settled = call(
        &transport,
        &handle,
        9,
        "ydoc.settle",
        json!({
            "sessionId": reopened["sessionId"].as_str().expect("session id"),
            "summary": "after the evict",
        }),
    )
    .await;
    assert_eq!(settled["content"], json!("what the user typed"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("on disk"),
        "what the user typed"
    );

    call(
        &transport,
        &handle,
        10,
        "ydoc.close",
        json!({
            "sessionId": reopened["sessionId"].as_str().expect("session id"),
            "settle": false,
        }),
    )
    .await;
    call(&transport, &handle, 11, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn record_update_refuses_a_replaced_lineage_until_resync_refreshes_the_session_claim() {
    const WORKSPACE_ID: &str = "ws-rpc-ydoc-lineage-claim";
    const PATH: &str = "notes/lineage.md";

    let scratch = ScratchDir::new().expect("scratch");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, WORKSPACE_ID, 1).await;
    let db_path = engine_db_path(&scratch).expect("engine database path");
    let connection = rusqlite::Connection::open(&db_path).expect("open engine database");
    connection
        .execute(
            "INSERT INTO sync_identity \
             (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
             VALUES (?1, 'local-origin', 'epoch', 'stream', 1)",
            [WORKSPACE_ID],
        )
        .expect("seed sync identity");
    connection
        .execute(
            "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
             VALUES (?1, 'local-origin', 0)",
            [WORKSPACE_ID],
        )
        .expect("enable sync");

    // Create durable Y.Doc state, then release only the session and retain the
    // lineage. This gives the next open an existing marker to bind.
    let created = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({ "versionId": "main", "path": PATH, "contentKind": "plaintext" }),
    )
    .await;
    let created_session = created["sessionId"].as_str().expect("created session");
    let originated = call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": created["lineageClaimId"],
            "sessionId": created_session,
            "updateBase64": plaintext_update("base"),
        }),
    )
    .await;
    let first_claim = originated["lineageClaimId"]
        .as_str()
        .expect("the first local record returns its server-observed claim")
        .to_owned();
    call(
        &transport,
        &handle,
        4,
        "ydoc.evict",
        json!({ "sessionId": created_session }),
    )
    .await;

    let opened = call(
        &transport,
        &handle,
        5,
        "ydoc.open",
        json!({ "versionId": "main", "path": PATH, "contentKind": "plaintext" }),
    )
    .await;
    assert_eq!(opened["lineageClaimId"], json!(first_claim.clone()));
    let session_id = opened["sessionId"].as_str().expect("session id");

    let object_id = opened["objectId"].as_str().expect("object id");
    let foreign_doc = Ydoc::wire();
    foreign_doc.plaintext_insert(0, "foreign base");
    let foreign_base = foreign_doc.encode_full_state();
    let store = EngineStore::open(&db_path, 2).expect("open fixture store");
    let replacement_claim = store
        .put_binary_blob(&foreign_base)
        .expect("store foreign base");
    drop(store);
    connection
        .execute(
            "UPDATE ydoc_docs SET lineage_claim_id=?4 \
             WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
            rusqlite::params![WORKSPACE_ID, "main", PATH, &replacement_claim],
        )
        .expect("replace durable lineage claim");
    let foreign = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WORKSPACE_ID.to_owned(),
        origin_id: "foreign-origin".to_owned(),
        origin_seq: 0,
        relay_seq: Some(1),
        op_kind: "ydoc.update".to_owned(),
        payload: json!({
            "versionId": "main",
            "objectId": object_id,
            "path": PATH,
            "contentKind": "plaintext",
            "updateBlobSha256": replacement_claim.clone(),
            "lineageClaimId": replacement_claim.clone(),
            "isBaseState": true,
        }),
        recorded_at_ms: 2,
    };
    let mut store = EngineStore::open(&db_path, 3).expect("reopen fixture store");
    apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &foreign,
        &NoFaults,
        &AlwaysLive,
    )
    .expect("queue foreign base behind live session");
    drop(store);
    let deferred_count = || {
        connection
            .query_row(
                "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE workspace_id=?1",
                [WORKSPACE_ID],
                |row| row.get::<_, i64>(0),
            )
            .expect("count deferred Y.Doc updates")
    };
    assert_eq!(deferred_count(), 1, "the foreign base starts queued");
    let before_stale_record = settle_fingerprint(&scratch, WORKSPACE_ID);

    let stale = transport
        .call(
            RequestContext::unbounded(),
            request(
                6,
                "ydoc.recordUpdate",
                Some(handle.clone()),
                json!({
                    "expectedLineageClaimId": first_claim,
                    "sessionId": session_id,
                    "updateBase64": plaintext_update(" stale"),
                }),
            ),
        )
        .await
        .expect_err("a stale session claim must refuse before mutation");
    assert_eq!(stale.code, ErrorCode::InvalidParams);
    assert_eq!(stale.message, "ydoc-lineage-stale");
    assert_eq!(
        settle_fingerprint(&scratch, WORKSPACE_ID),
        before_stale_record,
        "the stale record refusal must not mutate durable state"
    );

    let resynced = call(
        &transport,
        &handle,
        7,
        "ydoc.resync",
        json!({ "sessionId": session_id }),
    )
    .await;
    assert_eq!(resynced["lineageClaimId"], json!(replacement_claim.clone()));
    assert_eq!(resynced["recoveredPaths"], json!([]));
    assert_eq!(resynced["artifactAssets"], json!([]));
    assert_eq!(
        deferred_count(),
        1,
        "mismatch resync must not consume the queued foreign base"
    );

    // The resync moved the session to the replacement. An edit made on the
    // document of the claim it replaced still cannot enter it.
    let before_old_client_record = settle_fingerprint(&scratch, WORKSPACE_ID);
    let old_client = transport
        .call(
            RequestContext::unbounded(),
            request(
                12,
                "ydoc.recordUpdate",
                Some(handle.clone()),
                json!({
                    "expectedLineageClaimId": first_claim,
                    "sessionId": session_id,
                    "updateBase64": plaintext_update(" old client"),
                }),
            ),
        )
        .await
        .expect_err("an edit on the replaced claim must refuse after resync");
    assert_eq!(old_client.code, ErrorCode::InvalidParams);
    assert_eq!(old_client.message, "ydoc-lineage-stale");
    assert_eq!(
        settle_fingerprint(&scratch, WORKSPACE_ID),
        before_old_client_record,
        "the refusal must not mutate durable state"
    );

    let recorded = call(
        &transport,
        &handle,
        8,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": replacement_claim,
            "sessionId": session_id,
            "updateBase64": plaintext_update(" fresh"),
        }),
    )
    .await;
    assert_eq!(recorded["lineageClaimId"], json!(replacement_claim.clone()));

    let client_claim = transport
        .call(
            RequestContext::unbounded(),
            request(
                9,
                "ydoc.recordUpdate",
                Some(handle.clone()),
                json!({
                    "expectedLineageClaimId": replacement_claim,
                    "sessionId": session_id,
                    "updateBase64": plaintext_update(" forged"),
                    "lineageClaimId": first_claim,
                }),
            ),
        )
        .await
        .expect_err("recordUpdate must not accept a client lineage claim");
    assert_eq!(client_claim.code, ErrorCode::InvalidParams);

    call(
        &transport,
        &handle,
        10,
        "ydoc.evict",
        json!({ "sessionId": session_id }),
    )
    .await;
    call(&transport, &handle, 11, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_preserves_divergent_deferred_lineages_for_review_before_returning() {
    assert_close_drains_deferred_winning_lineage("winner from A", true).await;
}

const CLOSE_WINNER_WORKSPACE_ID: &str = "ws-rpc-ydoc-close-winner";
const CLOSE_WINNER_PATH: &str = "notes/shared.md";

/// A settled note whose lineage another device replaced while its session
/// was open: that device's base and an edit on it wait behind the session.
struct QueuedWinner {
    scratch: ScratchDir,
    transport: InProcessTransport<EngineService>,
    handle: WorkspaceHandle,
    connection: rusqlite::Connection,
    db_path: std::path::PathBuf,
    session_id: String,
    key: DocKey,
    winner: Ydoc,
    winner_claim: String,
}

async fn queue_winning_lineage_behind_session(winner_seed: &str) -> QueuedWinner {
    const WORKSPACE_ID: &str = CLOSE_WINNER_WORKSPACE_ID;
    const PATH: &str = CLOSE_WINNER_PATH;

    let scratch = ScratchDir::new().expect("scratch");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, WORKSPACE_ID, 1).await;
    let db_path = engine_db_path(&scratch).expect("engine database path");
    let connection = rusqlite::Connection::open(&db_path).expect("open engine database");
    connection
        .execute(
            "INSERT INTO sync_identity \
             (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
             VALUES (?1, 'local-origin', 'epoch', 'stream', 1)",
            [WORKSPACE_ID],
        )
        .expect("seed sync identity");
    connection
        .execute(
            "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
             VALUES (?1, 'local-origin', 0)",
            [WORKSPACE_ID],
        )
        .expect("enable sync");

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({ "versionId": "main", "path": PATH, "contentKind": "plaintext" }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id");
    let object_id = opened["objectId"].as_str().expect("object id");
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({
            "expectedLineageClaimId": null,
            "sessionId": session_id,
            "updateBase64": plaintext_update("loser from B"),
        }),
    )
    .await;
    call(
        &transport,
        &handle,
        4,
        "ydoc.settle",
        json!({ "sessionId": session_id }),
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("loser on disk"),
        "loser from B"
    );

    let key = DocKey::new(WORKSPACE_ID, "main", object_id).expect("document key");
    let mut store = EngineStore::open(&db_path, 2).expect("open fixture store");
    let persisted = dohc_engine_collab::load_persisted(&store, &key)
        .expect("load losing lineage")
        .expect("losing lineage exists");
    let loser_base = persisted.doc.encode_full_state();
    let loser_origin = persisted.marker.base_origin_id.expect("local base origin");
    let loser_seq = persisted
        .marker
        .base_origin_seq
        .expect("local base sequence");
    assert!(matches!(
        dohc_engine_collab::claim_base_at_relay(
            &mut store,
            &key,
            ContentKind::Plaintext,
            &loser_base,
            &BaseRelayCoordinate::new(loser_origin, loser_seq, 20).expect("loser coordinate"),
            &NoFaults,
            20,
        ),
        Ok(TxnOutcome::Committed(ClaimOutcome::Resumed))
    ));

    let winner = Ydoc::wire();
    winner.plaintext_insert(0, winner_seed);
    let winner_base = winner.encode_full_state();
    let winner_claim = store.put_binary_blob(&winner_base).expect("winner blob");
    let foreign = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WORKSPACE_ID.to_owned(),
        origin_id: "winner-origin".to_owned(),
        origin_seq: 0,
        relay_seq: Some(10),
        op_kind: "ydoc.update".to_owned(),
        payload: json!({
            "versionId": "main",
            "objectId": object_id,
            "path": PATH,
            "contentKind": "plaintext",
            "updateBlobSha256": winner_claim.clone(),
            "lineageClaimId": winner_claim.clone(),
            "isBaseState": true,
        }),
        recorded_at_ms: 30,
    };
    let applied = apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &foreign,
        &NoFaults,
        &AlwaysLive,
    )
    .expect("queue winning base behind live session");
    assert!(
        matches!(applied, dohc_engine_sync::ApplyOutcome { primary: dohc_engine_sync::ApplyDisposition::Applied(result), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (result.deferred)),
        "the winning base must start deferred behind the live session"
    );
    // Equal seeds can replace a lineage without a conflict. Its queued edit
    // must still change the file before close returns.
    let delta = winner.plaintext_insert(winner_seed.len() as u32, " plus remote edit");
    let delta_sha = store.put_binary_blob(&delta).expect("winner delta blob");
    let mut update = foreign.clone();
    update.origin_seq = 1;
    update.relay_seq = Some(11);
    update.payload["updateBlobSha256"] = json!(delta_sha);
    update.payload["isBaseState"] = json!(false);
    let applied = apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &update,
        &NoFaults,
        &AlwaysLive,
    )
    .expect("queue winning delta behind live session");
    assert!(matches!(
        applied,
        dohc_engine_sync::ApplyOutcome {
            primary: dohc_engine_sync::ApplyDisposition::Applied(result),
            ref refusals,
            ref sharing_declined,
        } if result.deferred && refusals.is_empty() && sharing_declined.is_empty()
    ));
    drop(store);
    QueuedWinner {
        scratch,
        transport,
        handle,
        connection,
        db_path,
        session_id: session_id.to_owned(),
        key,
        winner,
        winner_claim,
    }
}

async fn assert_close_drains_deferred_winning_lineage(winner_seed: &str, expect_conflict: bool) {
    const WORKSPACE_ID: &str = CLOSE_WINNER_WORKSPACE_ID;
    const PATH: &str = CLOSE_WINNER_PATH;
    let QueuedWinner {
        scratch,
        transport,
        handle,
        connection,
        db_path,
        session_id,
        key,
        winner,
        winner_claim,
    } = queue_winning_lineage_behind_session(winner_seed).await;
    call(
        &transport,
        &handle,
        5,
        "ydoc.close",
        json!({ "sessionId": session_id, "settle": false }),
    )
    .await;

    let visible_at_close =
        std::fs::read_to_string(scratch.path().join(PATH)).expect("text at close");
    let expected_winner = winner.plaintext_string();
    let store = EngineStore::open_read_only(&db_path).expect("inspect closed lineage");
    let persisted = dohc_engine_collab::load_persisted(&store, &key)
        .expect("load closed lineage")
        .expect("winning lineage remains durable");
    assert_eq!(
        persisted.marker.lineage_claim_id.as_deref(),
        Some(winner_claim.as_str())
    );
    assert_eq!(persisted.doc.plaintext_string(), expected_winner);
    let queued: i64 = connection
        .query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
            row.get(0)
        })
        .expect("deferred row count");
    assert_eq!(queued, 0, "close must drain both the base and its edit");

    let listed = call(
        &transport,
        &handle,
        6,
        "conflicts.list",
        json!({ "status": "open" }),
    )
    .await;
    let conflicts = listed["conflicts"].as_array().expect("conflict list");
    if expect_conflict {
        assert_eq!(conflicts.len(), 1, "divergent seeds require review");
        let sides: (String, String) = connection
            .query_row(
                "SELECT current.text, incoming.text FROM conflicts c \
             JOIN blobs current ON current.sha256=c.current_blob_sha256 \
             JOIN blobs incoming ON incoming.sha256=c.incoming_blob_sha256 \
             WHERE c.workspace_id=?1 AND c.conflict_id=?2",
                rusqlite::params![
                    WORKSPACE_ID,
                    conflicts[0]["id"].as_str().expect("conflict id")
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("both conflict sides are durable");
        assert_eq!(sides, ("loser from B".to_owned(), expected_winner));
        assert_eq!(
            visible_at_close, "loser from B",
            "close must preserve the visible local side until review"
        );
    } else {
        assert!(conflicts.is_empty(), "equal seeds need no review");
        assert_eq!(
            visible_at_close, expected_winner,
            "close must materialize the winning lineage and its edit before it returns"
        );
    }
    call(&transport, &handle, 7, "workspace.close", json!({})).await;
}

fn richdoc_update(doc: &Ydoc, paragraph: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(doc.richdoc_append_paragraph(paragraph))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reseeded_engine_heads_require_materialized_unchanged_seed_content_before_pruning() {
    for missing_proof in [
        "disk-changed",
        "head-moved",
        "seed-missing",
        "pending-job",
        "failed-job",
        "new-edit",
    ] {
        let scratch = ScratchDir::new().expect("scratch");
        let path = "notes/reopen.md";
        write_file(scratch.path(), path, b"Original paragraph.\n");
        let transport = InProcessTransport::new(Arc::new(EngineService::new()));
        let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-reseed-proof", 1).await;
        let opened = call(
            &transport,
            &handle,
            2,
            "ydoc.open",
            json!({
                "versionId": "main", "path": path, "contentKind": "richdoc"
            }),
        )
        .await;
        let session = opened["sessionId"].as_str().expect("session");
        let object = opened["objectId"].as_str().expect("object");
        let doc = Ydoc::wire();
        call(&transport, &handle, 3, "ydoc.recordUpdate", json!({
            "expectedLineageClaimId": null,
            "sessionId": session, "updateBase64": richdoc_update(&doc, "Original paragraph."), "seed": true
        })).await;
        call(
            &transport,
            &handle,
            4,
            "ydoc.recordUpdate",
            json!({
                "expectedLineageClaimId": null,
                "sessionId": session, "updateBase64": richdoc_update(&doc, "Saved edit.")
            }),
        )
        .await;
        call(
            &transport,
            &handle,
            5,
            "ydoc.close",
            json!({ "sessionId": session }),
        )
        .await;
        let reopened = call(
            &transport,
            &handle,
            6,
            "ydoc.open",
            json!({
                "versionId": "main", "path": path, "contentKind": "richdoc"
            }),
        )
        .await;
        let session = reopened["sessionId"].as_str().expect("reopened session");
        call(&transport, &handle, 7, "ydoc.recordUpdate", json!({
            "expectedLineageClaimId": null,
            "sessionId": session, "updateBase64": base64::engine::general_purpose::STANDARD.encode(doc.encode_full_state()), "seed": true
        })).await;
        let connection = rusqlite::Connection::open(engine_db_path(&scratch).expect("db path"))
            .expect("connection");
        match missing_proof {
            "disk-changed" => write_file(scratch.path(), path, b"External work.\n"),
            "head-moved" => {
                connection
                    .execute(
                        "UPDATE snapshots SET path = 'notes/moved.md' WHERE object_id = ?1",
                        [object],
                    )
                    .expect("move head");
            }
            "seed-missing" => {
                connection
                    .execute(
                        "UPDATE ydoc_docs SET seed_source_sha256 = NULL WHERE object_id = ?1",
                        [object],
                    )
                    .expect("remove seed proof");
            }
            "pending-job" => {
                connection.execute("UPDATE materialization_jobs SET status = 'pending', completed_at_ms = NULL WHERE target_path = ?1", [path]).expect("pending job");
            }
            "failed-job" => {
                connection.execute("UPDATE materialization_jobs SET status = 'conflict' WHERE target_path = ?1", [path]).expect("failed job");
                write_file(scratch.path(), path, b"External work.\n");
            }
            "new-edit" => {
                call(
                    &transport,
                    &handle,
                    8,
                    "ydoc.recordUpdate",
                    json!({
                        "expectedLineageClaimId": null,
                        "sessionId": session, "updateBase64": richdoc_update(&doc, "Still unsaved.")
                    }),
                )
                .await;
            }
            _ => unreachable!(),
        }
        let before = std::fs::read(scratch.path().join(path)).expect("before refused close");
        let refused = call_error(
            &transport,
            &handle,
            9,
            "ydoc.close",
            json!({
                "sessionId": session, "settle": false
            }),
        )
        .await;
        assert_eq!(refused.message, "ydoc-unsettled-close", "{missing_proof}");
        assert_eq!(
            std::fs::read(scratch.path().join(path)).expect("after refused close"),
            before,
            "{missing_proof}"
        );
        let updates: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ydoc_updates WHERE object_id = ?1",
                [object],
                |row| row.get(0),
            )
            .expect("retained updates");
        assert!(
            updates > 0,
            "{missing_proof}: refusal must retain durable edits"
        );
        drop(connection);
        call(
            &transport,
            &handle,
            10,
            "ydoc.evict",
            json!({ "sessionId": session }),
        )
        .await;
        call(&transport, &handle, 11, "workspace.close", json!({})).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn author_threshold_queues_settlement_after_admission_without_explicit_settle() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(Arc::clone(&service));
    let handle =
        open_workspace_with_capture_mode(&transport, &scratch, "queued-authors", 1, Some("none"))
            .await;
    let opened = call(&transport, &handle, 2, "ydoc.open", json!({"versionId":"main","path":"authors.txt","contentKind":"plaintext","seedFromArtifact":false})).await;
    let doc = Ydoc::wire();
    call(&transport, &handle, 3, "ydoc.recordUpdate", json!({ "expectedLineageClaimId": opened["lineageClaimId"], "sessionId":opened["sessionId"],"updateBase64":base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0,"a")),"actorOriginId":"first","attribution":{"actorKind":"agent","onBehalfOf":"person","depth":0}})).await;
    let raw = rusqlite::Connection::open(&db).expect("coverage fixture");
    let mut folded = vec![json!({"kind":"agent","agentId":"first","onBehalfOf":"person"})];
    while json!(&folded).to_string().len()
        < dohc_engine_collab::author_coverage::SETTLE_AUTHOR_BYTE_THRESHOLD
    {
        folded.push(json!({"kind":"automation","automationId":format!("folded-{:04}-{}", folded.len(), "x".repeat(480)),"onBehalfOf":"person","depth":64}));
    }
    let expected_authors = folded.len() + 1;
    raw.execute(
        "UPDATE ydoc_docs SET pending_authors_json=?1",
        [json!(folded).to_string()],
    )
    .expect("folded interval fixture");
    drop(raw);
    call(&transport, &handle, 4, "ydoc.recordUpdate", json!({ "expectedLineageClaimId": opened["lineageClaimId"], "sessionId":opened["sessionId"],"updateBase64":base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(1,"b")),"actorOriginId":"threshold","attribution":{"actorKind":"agent","onBehalfOf":"person","depth":0}})).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let raw = rusqlite::Connection::open(&db).expect("inspect");
        let covered:bool=raw.query_row("SELECT settled_update_seq=head_update_seq AND settle_prior_update_seq IS NULL AND pending_authors_json='[]' FROM ydoc_docs", [], |r|r.get(0)).expect("coverage");
        drop(raw);
        if covered {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "queued settlement did not complete"
        );
        tokio::task::yield_now().await;
    }
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("authors.txt")).expect("artifact"),
        "ab"
    );
    let page = call(
        &transport,
        &handle,
        5,
        "moments.list",
        json!({"versionId":"main","limit":10}),
    )
    .await;
    assert_eq!(page["moments"].as_array().expect("moments").len(), 1);
    assert_eq!(
        page["moments"][0]["authors"]
            .as_array()
            .expect("authors")
            .len(),
        expected_authors
    );
    call(&transport, &handle, 6, "workspace.close", json!({})).await;
}
