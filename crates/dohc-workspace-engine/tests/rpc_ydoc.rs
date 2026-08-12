//! RPC-C acceptance: daemon-owned Y.Doc sessions over the in-process
//! transport, with real domain writes, materialization, capture, and leases.

use base64::Engine as _;
use dohc_engine_collab::Ydoc;
use dohc_engine_protocol::{
    error::ErrorCode,
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

async fn call(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    transport
        .call(
            RequestContext::unbounded(),
            request(id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"))
        .result
}

async fn open_workspace(
    transport: &InProcessTransport<EngineService>,
    scratch: &ScratchDir,
    workspace_id: &str,
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
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            ),
        )
        .await
        .expect("workspace open");
    serde_json::from_value(opened.result["workspace"].clone()).expect("workspace handle")
}

fn write_file(root: &Path, path: &str, bytes: &[u8]) {
    let absolute = root.join(path);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(absolute, bytes).expect("write file");
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

async fn call_error(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: u64,
    method: &str,
    params: Value,
) -> dohc_engine_protocol::error::WireError {
    transport
        .call(
            RequestContext::unbounded(),
            request(id, method, Some(handle.clone()), params),
        )
        .await
        .unwrap_err()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scene_open_seeds_large_embedded_assets_in_the_engine_and_rehydrates_on_settle() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let image_bytes = valid_png_with_text_padding(49 * 1024);
    let image_base64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
    let artifact = serde_json::to_string(&json!({
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
            "fileId": "image-file"
        }],
        "appState": { "viewBackgroundColor": "#ffffff" },
        "files": {
            "image-file": {
                "id": "image-file",
                "mimeType": "image/png",
                "dataURL": format!("data:image/png;base64,{image_base64}"),
                "created": 12,
                "lastRetrieved": 13,
                "version": 1
            }
        }
    }))
    .expect("portable scene");
    assert!(
        artifact.len() > 48 * 1024,
        "fixture must exceed the old seedContent cap"
    );
    write_file(
        scratch.path(),
        "drawings/large.excalidraw",
        artifact.as_bytes(),
    );

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-scene-seed", 1).await;
    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "drawings/large.excalidraw",
            "contentKind": "scene",
            "seedFromArtifact": true
        }),
    )
    .await;

    assert_eq!(opened["head"], json!("present"));
    assert_eq!(opened["lineage"], json!("existing"));
    assert!(opened.get("seedContent").is_none());
    let initial = base64::engine::general_purpose::STANDARD
        .decode(
            opened["initialUpdateBase64"]
                .as_str()
                .expect("initial update"),
        )
        .expect("base64 update");
    assert!(
        !initial
            .windows(image_base64.len())
            .any(|window| window == image_base64.as_bytes()),
        "embedded file bytes must not enter the canonical Y.Doc"
    );
    let doc = Ydoc::wire();
    doc.apply(&initial).expect("seeded state applies");
    let folded = doc.fold_scene();
    assert_eq!(folded.elements.len(), 1);
    assert_eq!(folded.assets.len(), 1);

    let descriptor = &opened["artifactAssets"][0];
    assert_eq!(descriptor["id"], json!("image-file"));
    assert_eq!(descriptor["mimeType"], json!("image/png"));
    let asset_path = descriptor["ref"].as_str().expect("asset ref");
    assert!(asset_path.starts_with("assets/excalidraw/"));
    assert!(asset_path.ends_with(".png"));
    assert_eq!(
        std::fs::read(scratch.path().join(asset_path)).expect("materialized asset"),
        image_bytes,
    );

    let settled = call(
        &transport,
        &handle,
        3,
        "ydoc.settle",
        json!({ "sessionId": opened["sessionId"] }),
    )
    .await;
    assert_eq!(settled["materialized"], json!(true));
    assert_eq!(settled["content"], Value::Null);
    let portable: Value = serde_json::from_slice(
        &std::fs::read(scratch.path().join("drawings/large.excalidraw"))
            .expect("materialized scene"),
    )
    .expect("settled portable JSON");
    assert_eq!(
        portable["files"]["image-file"]["dataURL"],
        json!(format!("data:image/png;base64,{image_base64}")),
    );
    assert!(portable["files"]["image-file"].get("ref").is_none());
    assert!(portable["files"]["image-file"].get("sha256").is_none());

    call(
        &transport,
        &handle,
        4,
        "ydoc.evict",
        json!({ "sessionId": opened["sessionId"] }),
    )
    .await;
    // Simulate a committed open whose response was lost: the retry asks to
    // seed again, but resumes the one durable lineage and one asset moment.
    let retry = call(
        &transport,
        &handle,
        5,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "drawings/large.excalidraw",
            "contentKind": "scene",
            "seedFromArtifact": true
        }),
    )
    .await;
    assert_eq!(retry["lineage"], "existing");
    assert_eq!(retry["objectId"], opened["objectId"]);
    assert_eq!(retry["artifactAssets"], opened["artifactAssets"]);
    call(
        &transport,
        &handle,
        6,
        "ydoc.evict",
        json!({ "sessionId": retry["sessionId"] }),
    )
    .await;
    call(&transport, &handle, 7, "workspace.close", json!({})).await;
    let conn = rusqlite::Connection::open(
        scratch
            .path()
            .join(".dohc")
            .join("engine")
            .join("engine.db"),
    )
    .expect("open committed store");
    let asset_moments: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM moments WHERE workspace_id=?1 AND path=?2",
            rusqlite::params!["ws-rpc-scene-seed", asset_path],
            |row| row.get(0),
        )
        .expect("asset moment count");
    assert_eq!(asset_moments, 1, "lost-response retry must not seed twice");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn default_close_settles_and_releases_a_seeded_image_scene_after_an_edit() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
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
async fn scene_rebind_with_seed_disabled_never_resurrects_the_portable_artifact() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let artifact = serde_json::to_string(&json!({
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [{
            "id": "stale-image", "type": "image", "version": 1,
            "versionNonce": 1, "isDeleted": false, "index": "a0",
            "fileId": "stale-file"
        }],
        "appState": { "viewBackgroundColor": "#ff0000" },
        "files": {
            "stale-file": {
                "id": "stale-file", "mimeType": "image/png", "created": 1,
                "dataURL": "data:image/png;base64,AQIDBA=="
            }
        }
    }))
    .expect("portable scene");
    write_file(
        scratch.path(),
        "replacement.excalidraw",
        artifact.as_bytes(),
    );
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-scene-no-reseed", 81).await;

    for request_id in [82, 84] {
        let opened = call(
            &transport,
            &handle,
            request_id,
            "ydoc.open",
            json!({
                "versionId": "main",
                "path": "replacement.excalidraw",
                "contentKind": "scene",
                "seedFromArtifact": false
            }),
        )
        .await;
        assert_eq!(opened["lineage"], "absent");
        assert!(opened.get("artifactAssets").is_none());
        let update = base64::engine::general_purpose::STANDARD
            .decode(
                opened["initialUpdateBase64"]
                    .as_str()
                    .expect("initial update"),
            )
            .expect("base64 update");
        let doc = Ydoc::wire();
        doc.apply(&update).expect("empty state applies");
        let folded = doc.fold_scene();
        assert!(folded.elements.is_empty());
        assert!(folded.app_state.is_empty());
        assert!(folded.assets.is_empty());
        call(
            &transport,
            &handle,
            request_id + 1,
            "ydoc.close",
            json!({ "sessionId": opened["sessionId"], "settle": false }),
        )
        .await;
    }

    assert!(
        !scratch.path().join("assets/excalidraw").exists(),
        "replacement and reconnect opens must not extract stale portable files"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scene_open_defers_missing_authoritative_asset_then_recovers_and_survives_rename() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let artifact = serde_json::to_string(&json!({
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [],
        "appState": {},
        "files": {}
    }))
    .expect("portable scene");
    write_file(
        scratch.path(),
        "drawings/missing.excalidraw",
        artifact.as_bytes(),
    );
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-scene-missing", 101).await;
    let opened = call(
        &transport,
        &handle,
        102,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "drawings/missing.excalidraw",
            "contentKind": "scene",
            "seedFromArtifact": false
        }),
    )
    .await;
    assert_eq!(opened["lineage"], "absent");
    let object_id = opened["objectId"].as_str().expect("object id");
    let bytes = vec![1_u8, 2, 3, 4];
    let sha256 = dohc_engine_storage::hex_sha256(&bytes);
    let asset_ref = dohc_engine_collab::scene_asset_ref(
        "ws-rpc-scene-missing",
        "main",
        object_id,
        &sha256,
        "image/png",
    )
    .expect("asset ref");
    let recorded = call(
        &transport,
        &handle,
        103,
        "ydoc.recordUpdate",
        json!({
            "sessionId": opened["sessionId"],
            "updateBase64": image_scene_update_with_asset_record(
                "image-file",
                "image/png",
                &asset_ref,
                &sha256
            )
        }),
    )
    .await;
    assert_eq!(recorded["seq"], 1);
    call(
        &transport,
        &handle,
        104,
        "ydoc.evict",
        json!({ "sessionId": opened["sessionId"] }),
    )
    .await;

    for id in [105, 106] {
        let pending = call_error(
            &transport,
            &handle,
            id,
            "ydoc.open",
            json!({
                "versionId": "main",
                "path": "drawings/missing.excalidraw",
                "contentKind": "scene",
                "seedFromArtifact": false
            }),
        )
        .await;
        assert_eq!(pending.code, ErrorCode::Overloaded);
        assert_eq!(pending.message, "ydoc-artifact-assets-pending");
    }

    call(
        &transport,
        &handle,
        107,
        "versionedBinary.write",
        json!({
            "versionId": "main",
            "path": asset_ref,
            "bytes": bytes,
            "origin": "api"
        }),
    )
    .await;
    let recovered = call(
        &transport,
        &handle,
        108,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "drawings/missing.excalidraw",
            "contentKind": "scene",
            "seedFromArtifact": false
        }),
    )
    .await;
    assert_eq!(recovered["lineage"], "existing");
    assert_eq!(recovered["artifactAssets"][0]["ref"], asset_ref);
    call(
        &transport,
        &handle,
        109,
        "ydoc.settle",
        json!({ "sessionId": recovered["sessionId"] }),
    )
    .await;
    call(
        &transport,
        &handle,
        110,
        "ydoc.evict",
        json!({ "sessionId": recovered["sessionId"] }),
    )
    .await;
    call(
        &transport,
        &handle,
        111,
        "versionedText.rename",
        json!({
            "versionId": "main",
            "fromPath": "drawings/missing.excalidraw",
            "toPath": "moved/renamed.excalidraw",
            "origin": "api"
        }),
    )
    .await;
    let renamed = call(
        &transport,
        &handle,
        112,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "moved/renamed.excalidraw",
            "contentKind": "scene",
            "seedFromArtifact": false
        }),
    )
    .await;
    assert_eq!(renamed["objectId"], object_id);
    assert_eq!(renamed["artifactAssets"][0]["ref"], asset_ref);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scene_open_rejects_forged_asset_namespace_without_a_writable_fallback() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
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
async fn scene_open_rejects_text_sha_and_mime_asset_authority_without_a_writable_fallback() {
    for (case, record_mime) in [
        ("text-head", "image/png"),
        ("sha-mismatch", "image/png"),
        ("mime-mismatch", "image/jpeg"),
    ] {
        let scratch = ScratchDir::new().expect("scratch");
        write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
        let drawing_path = format!("{case}.excalidraw");
        write_file(
            scratch.path(),
            &drawing_path,
            br#"{"type":"excalidraw","elements":[],"appState":{},"files":{}}"#,
        );
        let service = Arc::new(EngineService::new());
        let transport = InProcessTransport::new(service);
        let workspace_id = format!("ws-rpc-scene-{case}");
        let handle = open_workspace(&transport, &scratch, &workspace_id, 160).await;
        let opened = call(
            &transport,
            &handle,
            161,
            "ydoc.open",
            json!({
                "versionId": "main", "path": drawing_path,
                "contentKind": "scene", "seedFromArtifact": false
            }),
        )
        .await;
        let object_id = opened["objectId"].as_str().expect("object id");
        let expected_bytes = [1_u8, 2, 3, 4];
        let expected_sha = dohc_engine_storage::hex_sha256(&expected_bytes);
        let asset_ref = dohc_engine_collab::scene_asset_ref(
            &workspace_id,
            "main",
            object_id,
            &expected_sha,
            "image/png",
        )
        .expect("owned asset ref");
        call(
            &transport,
            &handle,
            162,
            "ydoc.recordUpdate",
            json!({
                "sessionId": opened["sessionId"],
                "updateBase64": image_scene_update_with_asset_record(
                    "image-file", record_mime, &asset_ref, &expected_sha
                )
            }),
        )
        .await;
        call(
            &transport,
            &handle,
            163,
            "ydoc.evict",
            json!({ "sessionId": opened["sessionId"] }),
        )
        .await;

        match case {
            "text-head" => {
                call(
                    &transport,
                    &handle,
                    164,
                    "versionedText.write",
                    json!({
                        "versionId": "main", "path": asset_ref,
                        "text": "not binary image data", "origin": "api"
                    }),
                )
                .await;
            }
            "sha-mismatch" => {
                call(
                    &transport,
                    &handle,
                    164,
                    "versionedBinary.write",
                    json!({
                        "versionId": "main", "path": asset_ref,
                        "bytes": [9, 9, 9, 9], "origin": "api"
                    }),
                )
                .await;
            }
            "mime-mismatch" => {}
            _ => unreachable!(),
        }

        let invalid = call_error(
            &transport,
            &handle,
            165,
            "ydoc.open",
            json!({
                "versionId": "main", "path": drawing_path,
                "contentKind": "scene", "seedFromArtifact": false
            }),
        )
        .await;
        assert_eq!(invalid.code, ErrorCode::Internal, "{case}");
        assert_eq!(invalid.message, "ydoc-artifact-assets-invalid", "{case}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scene_seed_omits_deleted_and_unused_native_files() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scene_seed_refuses_a_preexisting_different_asset_at_its_owned_ref() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let image_bytes = vec![1_u8, 2, 3, 4];
    let image_base64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
    let artifact = serde_json::to_string(&json!({
        "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
        "elements": [{ "id": "image", "type": "image", "version": 1,
            "versionNonce": 1, "isDeleted": false, "index": "a0", "fileId": "file" }],
        "appState": {},
        "files": { "file": { "id": "file", "mimeType": "image/png", "created": 1,
            "dataURL": format!("data:image/png;base64,{image_base64}") } }
    }))
    .expect("portable scene");
    let drawing_path = "collision.excalidraw";
    write_file(scratch.path(), drawing_path, artifact.as_bytes());
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let workspace_id = "ws-rpc-scene-collision";
    let handle = open_workspace(&transport, &scratch, workspace_id, 141).await;
    let object_id =
        dohc_engine_domain::derive_capture_object_id(workspace_id, "main", drawing_path);
    let sha256 = dohc_engine_storage::hex_sha256(&image_bytes);
    let asset_ref =
        dohc_engine_collab::scene_asset_ref(workspace_id, "main", &object_id, &sha256, "image/png")
            .expect("owned ref");
    call(
        &transport,
        &handle,
        142,
        "versionedBinary.write",
        json!({
            "versionId": "main", "path": asset_ref,
            "bytes": [9, 9, 9, 9], "origin": "api"
        }),
    )
    .await;
    let refused = call_error(
        &transport,
        &handle,
        143,
        "ydoc.open",
        json!({
            "versionId": "main", "path": drawing_path,
            "contentKind": "scene", "seedFromArtifact": true
        }),
    )
    .await;
    assert_eq!(refused.code, ErrorCode::Internal);
    assert_eq!(
        std::fs::read(scratch.path().join(&asset_ref)).expect("collision survives"),
        [9, 9, 9, 9]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scene_seed_names_the_existing_binary_ceiling_before_commit() {
    // Pinned Excalidraw v0.18.0 commit 817d8c553c3389650f8b4503984a6d4a5d2f0c11
    // defines MAX_ALLOWED_FILE_BYTES as 4 MiB (constants.ts:314) and refuses
    // larger inserted images (App.tsx:9763-9767). The engine's existing 5 MiB
    // binary ceiling is beyond that measured healthy native range.
    assert_eq!(dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES, 5_242_880);
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    let observed = dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES + 1;
    let bytes = vec![0x5a; observed];
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let artifact = serde_json::to_string(&json!({
        "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
        "elements": [{ "id": "image", "type": "image", "version": 1,
            "versionNonce": 1, "isDeleted": false, "index": "a0", "fileId": "file" }],
        "appState": {},
        "files": { "file": { "id": "file", "mimeType": "image/png", "created": 1,
            "dataURL": format!("data:image/png;base64,{encoded}") } }
    }))
    .expect("portable scene");
    assert!(artifact.len() < dohc_engine_domain::MAX_TEXT_BYTES);
    write_file(
        scratch.path(),
        "over-binary.excalidraw",
        artifact.as_bytes(),
    );
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-scene-binary-cap", 151).await;
    let refused = call_error(
        &transport,
        &handle,
        152,
        "ydoc.open",
        json!({
            "versionId": "main", "path": "over-binary.excalidraw",
            "contentKind": "scene", "seedFromArtifact": true
        }),
    )
    .await;
    assert_eq!(refused.code, ErrorCode::PayloadTooLarge);
    assert!(refused.message.contains("MAX_CAPTURE_BINARY_FILE_BYTES"));
    assert!(refused.message.contains("5242880 bytes"));
    assert!(refused.message.contains("5242881 bytes"));
}

/// Stage the #346 interleaving: a 0-byte artifact on disk that capture has NOT
/// yet ingested, with a live session opened over it. Returns the path it
/// staged and the open result.
///
/// The order is VERIFIED, not assumed. Writing the file and opening straight
/// after relies on the open beating the watcher's settle window, and this
/// machine has shown 3.5x slowdowns under suite load — a paused task lets
/// capture ingest first, `seedContent` comes back "" instead of null, and the
/// test false-fails without ever staging the race it exists to cover.
///
/// The capture probe cannot enforce it either: its seam holds the driver AFTER
/// `reconcile_if_dirty` reports Completed, so the head is already minted by the
/// time it pauses. There is no pre-apply seam, and this is not worth adding new
/// engine surface for. So an attempt that lost the race is detected and retried
/// on a path capture has never seen, and exhausting the attempts FAILS rather
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
            // what the desktop's absent-head contract (#534) reads to tell a
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ydoc_open_rejects_secret_paths() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
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
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/live.md", b"before");
    write_file(scratch.path(), "notes/race.md", b"race base");
    write_file(
        scratch.path(),
        "binary.png",
        &[0x89, 0x50, 0x4e, 0x47, 0x00, 0xff],
    );

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
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
    // A CAPTURED file: no CRDT lineage yet, but the version HAS a snapshot for
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

    let external = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "ydoc.applyExternalMarkdownEdit",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "markdown": "external" }),
            ),
        )
        .await
        .expect_err("live external edit is a C1 refusal");
    assert_eq!(external.code, ErrorCode::InvalidParams);
    assert_eq!(external.message, "external-edit-unsupported-live");

    let before_moments = moment_count_for_object(&transport, &handle, 5, object_id).await;
    let recorded = call(
        &transport,
        &handle,
        6,
        "ydoc.recordUpdate",
        json!({
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

    tokio::time::sleep(Duration::from_millis(800)).await;
    let flushed = call(&transport, &handle, 9, "capture.flush", json!({})).await;
    assert_eq!(flushed["settled"], json!(true));
    let after_moments = moment_count_for_object(&transport, &handle, 10, object_id).await;
    assert_eq!(after_moments, before_moments + 1);
    // Mutation check: disable the SelfWriteSuppression::record call after
    // settlement to restore the bug. Identical-content ingest is a deduped
    // no-op moment-wise, so the count above stays +1 either way — the real
    // damage is the CLAIMED dedupe transferring ownership: capture's Changed
    // observation flips the settled head's metadata origin from "ydoc" to the
    // capture origin. This assertion fails under that mutation.
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
    // The local-only close PRUNED the CRDT cache to the bare marker
    // (the workspace file is the artifact), so the reopen must NOT claim an existing
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
            "sessionId": reopened_session,
            "updateBase64": plaintext_update("settled text")
        }),
    )
    .await;
    assert_eq!(reseeded["seq"], json!(1));
    let resync = call(
        &transport,
        &handle,
        32,
        "ydoc.resync",
        json!({ "sessionId": reopened_session }),
    )
    .await;
    // Decode the resync state and prove the durable lineage now carries the
    // re-seeded settled content — equality with an empty state can't pass.
    let resync_state = base64::engine::general_purpose::STANDARD
        .decode(
            resync["initialUpdateBase64"]
                .as_str()
                .expect("resync state"),
        )
        .expect("resync state decodes");
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
        json!({ "sessionId": rich_session, "updateBase64": rich_update }),
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
    // The default close SETTLED the richdoc, so the local-only lineage prunes
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

    // A BARE local marker does not own its content kind: a kindless open
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

    let race = call(
        &transport,
        &handle,
        19,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/race.md" }),
    )
    .await;
    assert_eq!(race["lineage"], json!("absent"));
    let race_session = race["sessionId"].as_str().expect("race session");
    // The legacy append path cannot advance the CRDT behind a live editor:
    // the session's lease is single-writer, so the old raced-seed scenario
    // (apply a durable head under an open absent session) is refused at the
    // door. The recordUpdate seed guard stays as actor-level defense-in-depth.
    let busy_apply = transport
        .call(
            RequestContext::unbounded(),
            request(
                20,
                "ydoc.apply",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": race["objectId"],
                    "contentKind": "plaintext",
                    "updateBase64": plaintext_update("winner")
                }),
            ),
        )
        .await
        .expect_err("a leased doc refuses legacy appends");
    assert_eq!(busy_apply.message, "ydoc-session-busy");
    // An untouched absent session closes without settling (nothing durable
    // exists to project) and releases the lease.
    call(
        &transport,
        &handle,
        21,
        "ydoc.close",
        json!({ "sessionId": race_session }),
    )
    .await;
    call(
        &transport,
        &handle,
        22,
        "ydoc.apply",
        json!({
            "versionId": "main",
            "objectId": race["objectId"],
            "contentKind": "plaintext",
            "updateBase64": plaintext_update("winner")
        }),
    )
    .await;
    let reraced = call(
        &transport,
        &handle,
        33,
        "ydoc.open",
        json!({ "versionId": "main", "path": "notes/race.md" }),
    )
    .await;
    assert_eq!(
        reraced["lineage"],
        json!("existing"),
        "a lineage created after the lease released is existing on reopen"
    );
    // Default close settles the raced winner over its captured base and
    // prunes cleanly.
    call(
        &transport,
        &handle,
        34,
        "ydoc.close",
        json!({ "sessionId": reraced["sessionId"] }),
    )
    .await;

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
    write_shadow_marker_for_harness(other.path(), TOKEN).expect("other marker");
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
async fn settle_without_a_seeded_lineage_refuses_and_leaves_the_file_intact() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/precious.md", b"precious content");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-noseed", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/precious.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    assert_eq!(opened["lineage"], json!("absent"));
    let session_id = opened["sessionId"].as_str().expect("session id");

    // Mutation check: restore `None => Ydoc::wire()` in ydoc_settle_on_store's
    // load_persisted match to bring the bug back — the settle then projects an
    // EMPTY doc over the existing file and both assertions below fail.
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "ydoc.settle",
                Some(handle.clone()),
                json!({ "sessionId": session_id, "summary": "no seed" }),
            ),
        )
        .await
        .expect_err("settling an un-seeded lineage must refuse");
    assert_eq!(refused.code, ErrorCode::InvalidParams);

    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/precious.md"))
            .expect("file still readable"),
        "precious content",
        "a refused settle must not touch the file"
    );
    let head = call(
        &transport,
        &handle,
        4,
        "versionedText.read",
        json!({ "versionId": "main", "path": "notes/precious.md" }),
    )
    .await;
    assert_eq!(head["text"], json!("precious content"));

    call(
        &transport,
        &handle,
        5,
        "ydoc.close",
        json!({ "sessionId": session_id, "settle": false }),
    )
    .await;
    call(&transport, &handle, 6, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rival_write_on_a_live_session_path_refuses_session_busy() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-owner", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/claimed.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    assert_eq!(opened["lineage"], json!("absent"));
    let session_id = opened["sessionId"].as_str().expect("session id");
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update("session text")
        }),
    )
    .await;

    // RPC-D's lease rule closed the old rival-claim window: a
    // versionedText.write against a path whose derived object a live
    // session leases now refuses instead of silently changing the owner
    // under the editor. (Settle-time ownership over a REBOUND head stays
    // covered by the runtime rebind test.) Mutation check: drop the lease
    // guard from the versionedText.write arm — this write succeeds and the
    // refusal assertion fails.
    let rival = transport
        .call(
            RequestContext::unbounded(),
            request(
                4,
                "versionedText.write",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "objectId": "other-object",
                    "path": "notes/claimed.md",
                    "text": "the other owner's content",
                    "momentId": "moment-other-owner",
                    "metadataOrigin": "agent"
                }),
            ),
        )
        .await
        .expect_err("a rival write on a live session's path must refuse");
    assert_eq!(rival.code, ErrorCode::InvalidParams);
    assert_eq!(rival.message, "ydoc-session-busy");

    // The session settles cleanly - nothing changed the path under it.
    let settled = call(
        &transport,
        &handle,
        5,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "still owned" }),
    )
    .await;
    assert_eq!(settled["content"], json!("session text"));

    call(&transport, &handle, 6, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_settle_past_the_inband_cap_still_lands_on_disk_and_reports_no_content() {
    // AUDIT-SILENTSAVE. Three dogfood journeys watched a doc read "Saved" in
    // the editor while its .md sat at ZERO BYTES: the settle refused
    // pre-commit on every debounce because the RESPONSE could not carry the
    // markdown as one wire string. The cap belongs to the wire, not to
    // durability — the daemon materializes from the projection it already
    // holds, so the file must land and the response must say `content: null`.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-overcap", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "load/big.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id");

    // Past BOTH the 48 KiB in-band response cap and the desktop capture
    // layer's 128 KiB text cap — the size journey 1 actually pasted into
    // load-test.md was 131,442 bytes, and both limits sit under it.
    let huge = "pasted load-test paragraph.\n".repeat(5_000);
    assert!(
        huge.len() > 128 * 1024,
        "fixture must exceed both the in-band cap and the capture text cap"
    );

    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update(&huge)
        }),
    )
    .await;
    let settled = call(
        &transport,
        &handle,
        4,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "paste" }),
    )
    .await;

    // The response omits the body (it cannot cross as one string) but the
    // settle COMMITTED: a moment id, a sha, and the real bytes on disk.
    assert_eq!(settled["content"], Value::Null);
    assert!(
        settled["momentId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "an over-cap settle must still mint a moment: {settled}"
    );
    let on_disk = std::fs::read_to_string(scratch.path().join("load/big.md"))
        .expect("the over-cap settle must write the .md");
    assert_eq!(on_disk, huge, "disk must hold every byte the CRDT holds");

    // Not a one-shot: a further edit settles and reaches disk too (the bug
    // refused on EVERY debounced settle, so one green write proves little).
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update("APPENDED TAIL\n")
        }),
    )
    .await;
    let resettled = call(
        &transport,
        &handle,
        6,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "paste again" }),
    )
    .await;
    assert_eq!(resettled["content"], Value::Null);
    let on_disk = std::fs::read_to_string(scratch.path().join("load/big.md"))
        .expect("the second over-cap settle must write the .md");
    assert!(
        on_disk.contains("APPENDED TAIL"),
        "the second settle must reach disk as well"
    );

    call(
        &transport,
        &handle,
        7,
        "ydoc.close",
        json!({ "sessionId": session_id }),
    )
    .await;
    call(&transport, &handle, 8, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_must_not_retire_the_settled_head_of_an_over_cap_ydoc() {
    // AUDIT-SILENTSAVE round 5. This is the race that made
    // `a_settle_past_the_inband_cap…` fail under `cargo test --workspace`
    // while passing in isolation — the capture pass only gets scheduled
    // between the settle and the close under load.
    //
    // A settled Y.Doc past MAX_CAPTURE_TEXT_BYTES (10 MiB) reads as
    // "no longer engine-ownable" to the capture sink, which retires the head.
    // Self-write suppression cannot help: it matches a WRITE by sha, and this
    // is a retire taken on a size classification. The next settle — including
    // the one ydoc.close performs by default — then sees a changed target and
    // fails ConflictStaleTarget.
    //
    // Driven deterministically here (sleep past the debounce + capture.flush)
    // rather than by hoping the scheduler interleaves.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-capture", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({ "versionId": "main", "path": "load/big.md", "contentKind": "plaintext" }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id");

    // Past the capture text cap, like the dogfood journey's 131,442 bytes.
    let huge = "pasted load-test paragraph.\n".repeat(5_000);
    assert!(
        huge.len() > 128 * 1024,
        "fixture must exceed the capture cap"
    );
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": plaintext_update(&huge) }),
    )
    .await;
    call(
        &transport,
        &handle,
        4,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "paste" }),
    )
    .await;

    // Let the watcher observe the settle's own materialized write and settle
    // its batch — exactly what happens under load between settle and close.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let flushed = call(&transport, &handle, 5, "capture.flush", json!({})).await;
    assert_eq!(flushed["settled"], json!(true));

    // THE load-bearing assertion: the head survived, still owned by the
    // Y.Doc. Before the fix this listing came back EMPTY — capture had
    // retired the record for a document the user had just saved.
    let listed = call(
        &transport,
        &handle,
        6,
        "versionedText.list",
        json!({ "versionId": "main" }),
    )
    .await;
    let head = listed["files"]
        .as_array()
        .expect("files")
        .iter()
        .find(|file| file["path"] == json!("load/big.md"));
    assert!(
        head.is_some(),
        "capture retired the settled over-cap head: {}",
        listed["files"]
    );
    let head = head.expect("head");
    assert_eq!(head["metadataOrigin"], json!("ydoc"));
    assert_eq!(head["byteLength"], json!(140_000));

    // And the close — which settles by default — succeeds instead of failing
    // ConflictStaleTarget against a head capture moved underneath it.
    call(
        &transport,
        &handle,
        7,
        "ydoc.close",
        json!({ "sessionId": session_id }),
    )
    .await;
    call(&transport, &handle, 8, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_zero_byte_precreated_file_settles_the_first_typed_edit_to_disk() {
    // The shape the desktop's New File IPC actually leaves behind, which no
    // test covered: a ZERO-BYTE file already on disk, with no engine head and
    // no lineage. `creating_a_new_file_through_a_ydoc_session_settles_to_disk`
    // below covers the file-absent-everywhere shape the app never produces.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "baseline/alpha.md", b"");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-zero", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "baseline/alpha.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    // The empty file IS the seed: the lineage is absent and seeds from "".
    assert_eq!(opened["lineage"], json!("absent"));
    assert_eq!(opened["seedContent"], json!(""));
    let session_id = opened["sessionId"].as_str().expect("session id");

    let typed = "Baseline alpha persisted normally.";
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update(typed)
        }),
    )
    .await;
    let settled = call(
        &transport,
        &handle,
        4,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "type" }),
    )
    .await;
    assert_eq!(settled["content"], json!(typed));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("baseline/alpha.md")).expect("settled"),
        typed,
        "the first typed edit over a zero-byte file must replace it on disk"
    );

    call(
        &transport,
        &handle,
        5,
        "ydoc.close",
        json!({ "sessionId": session_id }),
    )
    .await;
    call(&transport, &handle, 6, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_ingesting_a_new_files_empty_artifact_must_not_wedge_its_session() {
    // Issue #346. The desktop's New File writes "" straight to disk with no
    // engine write, so the artifact exists with NO head. The interleaving that
    // wedges the document — which the file-already-on-disk-at-open test above
    // cannot reach, because nothing ingests the artifact there:
    //
    //   1. workspace.open starts the capture driver and its watcher.
    //   2. createFile writes a 0-byte artifact. The watcher queues the create.
    //   3. ydoc.open runs BEFORE that batch's debounce elapses: no head yet,
    //      so the session's open-time head expectation is None.
    //   4. capture ingests the 0-byte artifact and mints a head at sha("").
    //   5. The user types; settle expects None, probes sha("") — conflict.
    //   6. The failed settle never sets last_settled_sha, so the expectation
    //      stays None and EVERY later settle conflicts. The document is
    //      wedged for the life of the session.
    //
    // Driven deterministically (sleep past the debounce + capture.flush)
    // rather than by hoping the scheduler interleaves.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-newfile", 1).await;

    // Steps 2 and 3: New File exactly as `createFile` leaves it, with the
    // session opened before capture ingests it. `a_zero_byte_precreated_file…`
    // above writes its file before workspace.open, so its opening reconcile
    // ingests the artifact first and its session opens with a head expectation
    // that already matches — which is why that test never reached this bug.
    let (path, opened) =
        stage_headless_session_over_an_empty_artifact(&transport, &handle, &scratch, "untitled")
            .await;
    let session_id = opened["sessionId"].as_str().expect("session id");

    // Step 4: capture ingests the empty artifact under the open session.
    // POLL until the empty head is provably there. It is what the settle must
    // adopt, so without the proof a flush that ingested nothing would leave
    // the expectation matching an absent head and every assertion below would
    // pass with the adoption path never running. One sleep plus a single
    // flush cannot carry that proof either way: a watcher that has not yet
    // queued the create makes the flush report quiescence, and the read then
    // returns null and FALSE-FAILS a correct implementation.
    let mut ingested = Value::Null;
    for attempt in 0..40 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        call(
            &transport,
            &handle,
            100 + attempt,
            "capture.flush",
            json!({}),
        )
        .await;
        ingested = call(
            &transport,
            &handle,
            200 + attempt,
            "versionedText.read",
            json!({ "versionId": "main", "path": path }),
        )
        .await;
        if ingested["text"] == json!("") {
            break;
        }
    }
    assert_eq!(
        ingested["text"],
        json!(""),
        "capture must mint an EMPTY head"
    );
    assert_eq!(
        ingested["objectId"], opened["objectId"],
        "and mint it on the object the session holds"
    );

    // Step 5: the first typed edit must still reach disk.
    let typed = "The first thing typed into a brand-new document.";
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update(typed)
        }),
    )
    .await;
    let settled = call(
        &transport,
        &handle,
        6,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "type" }),
    )
    .await;
    assert_eq!(settled["content"], json!(typed));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(&path)).expect("settled"),
        typed,
        "the first typed edit into a new document must replace its empty artifact"
    );

    // Step 6: and the session is not wedged — a second edit settles too.
    call(
        &transport,
        &handle,
        7,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update("More typing. ")
        }),
    )
    .await;
    let resettled = call(
        &transport,
        &handle,
        8,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "type more" }),
    )
    .await;
    let resettled = resettled["content"].as_str().expect("content");
    // BOTH edits, not just the newest: a second settlement that dropped the
    // first would otherwise satisfy every assertion here. Order is not
    // asserted — two independent client ids inserting at offset 0 order by
    // client id, which is not fixed across runs — so the disk comparison
    // below uses what the settle REPORTED rather than a concatenation.
    assert!(resettled.contains("More typing. "), "{resettled}");
    assert!(resettled.contains(typed), "{resettled}");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(&path)).expect("resettled"),
        resettled,
        "every later edit must reach disk as well"
    );

    call(
        &transport,
        &handle,
        9,
        "ydoc.close",
        json!({ "sessionId": session_id }),
    )
    .await;
    call(&transport, &handle, 10, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_ingesting_content_under_a_headless_session_still_refuses() {
    // The inverse of the test above, and the guard on its fix: the empty
    // artifact is adopted because it IS the session's base. Content is not.
    // Here something writes REAL bytes to the path after the session opened
    // headless, and capture ingests them. Settling would overwrite bytes the
    // user never saw, so it must still refuse.
    //
    // Mutation check: drop the empty-artifact test from the expectation
    // adoption in `ydoc_settle_on_store` and this settle succeeds, silently
    // destroying the ingested content.
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-rival", 1).await;

    let (path, opened) =
        stage_headless_session_over_an_empty_artifact(&transport, &handle, &scratch, "rival").await;
    let session_id = opened["sessionId"].as_str().expect("session id");

    // Content the session never saw lands on the path, and capture ingests it.
    write_file(scratch.path(), &path, b"written by something else\n");
    // POLL until the rival content is provably the head. One sleep plus a
    // flush is not enough: a watcher that has not yet queued the write makes
    // the flush report quiescence with no head minted, and the settle below
    // then refuses through the materialization preimage instead — passing
    // without ever reaching the predicate this test exists to hold.
    let mut ingested = Value::Null;
    for attempt in 0..40 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        call(
            &transport,
            &handle,
            100 + attempt,
            "capture.flush",
            json!({}),
        )
        .await;
        ingested = call(
            &transport,
            &handle,
            200 + attempt,
            "versionedText.read",
            json!({ "versionId": "main", "path": path }),
        )
        .await;
        if ingested["text"] == json!("written by something else\n") {
            break;
        }
    }
    assert_eq!(
        ingested["text"],
        json!("written by something else\n"),
        "capture must mint the RIVAL head before the settle is meaningful"
    );

    call(
        &transport,
        &handle,
        4,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update("typed over the rival")
        }),
    )
    .await;
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
        std::fs::read_to_string(scratch.path().join(&path)).expect("intact"),
        "written by something else\n",
        "the refused settle must leave the ingested bytes intact"
    );

    // No ydoc.close: a wedged draft cannot be pruned (`ydoc-unsettled-close`)
    // and settling it is what this test just refused. The workspace teardown
    // takes the session down with it.
    call(&transport, &handle, 6, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn creating_a_new_file_through_a_ydoc_session_settles_to_disk() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-create", 1).await;

    // notes/created.md exists NOWHERE: not on disk, no head, no lineage. The
    // seed path pre-creates the file_objects row for the marker FK; the
    // settle's projected write must accept that preallocated object instead
    // of refusing "already bound".
    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/created.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    assert_eq!(opened["lineage"], json!("absent"));
    assert_eq!(opened["seedContent"], Value::Null);
    let session_id = opened["sessionId"].as_str().expect("session id");

    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({
            "sessionId": session_id,
            "updateBase64": plaintext_update("fresh content")
        }),
    )
    .await;
    let settled = call(
        &transport,
        &handle,
        4,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "create" }),
    )
    .await;
    assert_eq!(settled["content"], json!("fresh content"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/created.md")).expect("created"),
        "fresh content"
    );
    let head = call(
        &transport,
        &handle,
        5,
        "versionedText.read",
        json!({ "versionId": "main", "path": "notes/created.md" }),
    )
    .await;
    assert_eq!(head["text"], json!("fresh content"));
    assert_eq!(head["objectId"], opened["objectId"]);
    assert_eq!(head["metadataOrigin"], json!("ydoc"));

    call(
        &transport,
        &handle,
        6,
        "ydoc.close",
        json!({ "sessionId": session_id }),
    )
    .await;
    call(&transport, &handle, 7, "workspace.close", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn opening_an_absent_path_whose_derived_object_lives_elsewhere_refuses() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-alias", 1).await;

    // Plant notes/old.md's DERIVED object id at a different alias — the state a
    // rename leaves behind: the deterministic id is live at notes/new.md while
    // notes/old.md itself is absent.
    let derived =
        dohc_engine_domain::derive_capture_object_id("ws-rpc-ydoc-alias", "main", "notes/old.md");
    call(
        &transport,
        &handle,
        2,
        "versionedText.write",
        json!({
            "versionId": "main",
            "objectId": derived,
            "path": "notes/new.md",
            "text": "moved content",
            "momentId": "moment-planted",
            "metadataOrigin": "agent"
        }),
    )
    .await;

    // Mutation check: drop the object_has_live_alias probe in
    // ydoc_open_state_on_store's absent branch (reuse the derived id
    // unconditionally) to restore the bug — the open then succeeds and grafts
    // a new document onto notes/new.md's lineage, failing this refusal.
    let refused = transport
        .call(
            RequestContext::unbounded(),
            request(
                3,
                "ydoc.open",
                Some(handle.clone()),
                json!({
                    "versionId": "main",
                    "path": "notes/old.md",
                    "contentKind": "plaintext"
                }),
            ),
        )
        .await
        .expect_err("opening the absent path over a migrated derived id must refuse");
    assert_eq!(refused.code, ErrorCode::InvalidParams);
    assert_eq!(refused.message, "ydoc-object-alias-collision");

    // The refusal must leave the migrated file untouched.
    let head = call(
        &transport,
        &handle,
        4,
        "versionedText.read",
        json!({ "versionId": "main", "path": "notes/new.md" }),
    )
    .await;
    assert_eq!(head["text"], json!("moved content"));

    call(&transport, &handle, 5, "workspace.close", json!({})).await;
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn settle_recovers_after_a_transient_replace_failure() {
    use std::os::windows::fs::OpenOptionsExt;

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
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
        json!({ "sessionId": session_id, "updateBase64": first }),
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
    // AFTER the settle transaction committed the new head.
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
        json!({ "sessionId": session_id, "updateBase64": second }),
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
    // The wire names the lock and carries the retry contract (#554): the
    // client retries this settle with backoff, so the write lands when the
    // external handle releases instead of on the next unrelated settle.
    assert_eq!(failed.code, ErrorCode::Overloaded);
    assert_eq!(failed.message, "file-locked");
    // The settle COMMITTED (marker matches the projection) but the job is
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
async fn changed_settle_replays_the_pending_job_left_by_a_transient_failure() {
    use std::os::windows::fs::OpenOptionsExt;

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-rpc-ydoc-changed", 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/changed.md",
            "contentKind": "plaintext"
        }),
    )
    .await;
    let session_id = opened["sessionId"].as_str().expect("session id");

    let doc = Ydoc::wire();
    let first = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "v1"));
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": first }),
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

    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(scratch.path().join("notes/changed.md"))
        .expect("exclusive lock");
    let second = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "v2 "));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": second }),
    )
    .await;
    transport
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
    drop(lock);

    // The user KEEPS EDITING: the retry settles a CHANGED projection, so it
    // takes the full write path, whose new job's preimage is the v2 head that
    // never reached disk. Mutation check: re-scope the pending-job replay in
    // ydoc_settle_on_store back to the unchanged-projection branch only —
    // this settle then hits a materialization conflict and both assertions
    // below fail.
    let third = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "v3 "));
    call(
        &transport,
        &handle,
        7,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": third }),
    )
    .await;
    let settled = call(
        &transport,
        &handle,
        8,
        "ydoc.settle",
        json!({ "sessionId": session_id, "summary": "v3 after replay" }),
    )
    .await;
    assert_eq!(settled["content"], json!("v3 v2 v1"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/changed.md")).expect("on disk"),
        "v3 v2 v1"
    );

    call(
        &transport,
        &handle,
        9,
        "ydoc.close",
        json!({ "sessionId": session_id }),
    )
    .await;
    call(&transport, &handle, 10, "workspace.close", json!({})).await;
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_delete_cancels_the_paths_pending_job_so_replay_cannot_resurrect_it() {
    use std::os::windows::fs::OpenOptionsExt;

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let workspace_id = "ws-rpc-ydoc-delete-cancels-pending";
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, workspace_id, 1).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({
            "versionId": "main",
            "path": "notes/deleted.md",
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
        3,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": first }),
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
        std::fs::read_to_string(scratch.path().join("notes/deleted.md")).expect("v1 on disk"),
        "v1"
    );

    // Hold the target with NO sharing, exactly like the transient-failure
    // siblings above: the next settle commits its head but its replace
    // fails, leaving a job PENDING with the v1 bytes as its expected
    // preimage.
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(scratch.path().join("notes/deleted.md"))
        .expect("exclusive lock");
    let second = base64::engine::general_purpose::STANDARD.encode(doc.plaintext_insert(0, "v2 "));
    call(
        &transport,
        &handle,
        5,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": second }),
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
    assert_eq!(failed.code, ErrorCode::Overloaded);
    assert_eq!(failed.message, "file-locked");
    drop(lock);

    // The user's desktop, having seen the settle fail, gives up on the
    // session rather than retrying the settle — the daemon-side twin of the
    // JS "detached debt" issue #739 names — and evicts it (#665's third
    // exit: the lease is dropped, the pending job is untouched) before
    // deleting the path outright.
    let evicted = call(
        &transport,
        &handle,
        7,
        "ydoc.evict",
        json!({ "sessionId": session_id }),
    )
    .await;
    assert_eq!(evicted["evicted"], json!(true));

    call(
        &transport,
        &handle,
        8,
        "versionedText.delete",
        json!({
            "versionId": "main",
            "path": "notes/deleted.md",
            "origin": "api",
            "requestId": "delete-with-pending-job",
        }),
    )
    .await;
    call(&transport, &handle, 9, "workspace.close", json!({})).await;
    drop(transport);

    // Simulate a daemon restart against the same on-disk database: a fresh
    // service, a fresh transport, reopening the same workspace root.
    let restarted_service = Arc::new(EngineService::new());
    let restarted_transport = InProcessTransport::new(restarted_service);
    let restarted_handle = open_workspace(&restarted_transport, &scratch, workspace_id, 1).await;

    // RED (pre-#739): the stale pending job survives the delete, its
    // preimage still matches the untouched v1 bytes, and startup replay
    // (`workspace.open` -> `materialize_replay_pending`) materializes it —
    // the deleted path comes back with "v2 v1" on a path the registry no
    // longer tracks.
    //
    // GREEN (#739): the delete cancelled the job in the same transaction, so
    // replay finds nothing pending for this path and the bytes stay exactly
    // as the delete left them.
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/deleted.md")).expect("unchanged"),
        "v1",
        "a stale pending job replayed and resurrected a path the delete removed"
    );

    call(
        &restarted_transport,
        &restarted_handle,
        3,
        "workspace.close",
        json!({}),
    )
    .await;
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_inactive_versions_delete_does_not_cancel_the_active_versions_pending_job() {
    // #739 follow-up (codex P1): `cancel_pending_jobs_for_path` is path-keyed
    // but materialization jobs carry no version identity — they mirror the
    // ACTIVE version's working tree only (the same gate `enqueue_binary_delete`
    // applies to its own job). A delete in a NAMED, inactive version must not
    // touch `main`'s own pending job for a same-named path.
    use std::os::windows::fs::OpenOptionsExt;

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let workspace_id = "ws-rpc-ydoc-inactive-delete-preserves-active";
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, workspace_id, 1).await;

    // The named version forks main FIRST, before main ever has anything
    // pending: `versions.createNamed` reconciles its source version's disk
    // projection as part of the fork, so forking WHILE a job is stuck behind
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
    // Feature gets its OWN, independently-written "notes/shared.md" — not
    // main's, so deleting it can never race main's later lock.
    call(
        &transport,
        &handle,
        3,
        "versionedText.write",
        json!({
            "versionId": feature,
            "path": "notes/shared.md",
            "text": "feature copy",
            "origin": "api",
            "requestId": "feature-seed",
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
        json!({ "sessionId": session_id, "updateBase64": first }),
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
        json!({ "sessionId": session_id, "updateBase64": second }),
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

    // Deletes feature's OWN "notes/shared.md" — a different object at the
    // same path string in a different, inactive version. This must never
    // reach main's own pending job.
    call(
        &transport,
        &handle,
        10,
        "versionedText.delete",
        json!({
            "versionId": feature,
            "path": "notes/shared.md",
            "origin": "api",
            "requestId": "inactive-delete",
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
    // #739 follow-up (codex P1): a binary rename enqueues a PAIRED job pair —
    // a write for the new path, a delete for the old one — and startup replay
    // (and the rollback post-commit path) refuses to run the paired delete
    // until the write proves COMPLETE, so the old path is never removed
    // before the new one is proven durable. Cancelling the write (this PR's
    // #739 fix, when the new path is deleted before it ever materializes)
    // must not read as the SAME "abandon the pair" signal `Conflict` is: the
    // delete already resolved the destination, so the paired delete (the old
    // path) must still run — or that path is stranded on disk forever.
    use std::os::windows::fs::OpenOptionsExt;

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), "notes/seed.md", b"seed");

    let workspace_id = "ws-rpc-ydoc-rename-pair-not-stranded";
    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, workspace_id, 1).await;

    let bytes: &[u8] = &[4, 8, 15, 16, 23, 42];
    call(
        &transport,
        &handle,
        2,
        "versionedBinary.write",
        json!({ "versionId": "main", "path": "old.bin", "bytes": bytes, "origin": "api" }),
    )
    .await;
    assert!(scratch.path().join("old.bin").exists());

    // An untracked raw file plants a lockable target at the rename's
    // destination — the engine's own occupancy check reads `path_aliases`,
    // not disk, so this does not refuse the rename. Matching bytes keeps its
    // OWN later cleanup (the fresh delete job `versionedText.delete` below
    // enqueues) preimage-clean instead of spuriously conflicting.
    std::fs::write(scratch.path().join("new.bin"), bytes).expect("plant destination");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(scratch.path().join("new.bin"))
        .expect("exclusive lock");

    // The rename commits (moment + path_aliases move to new.bin), but the
    // destination write's post-commit materialize hits the lock and stays
    // PENDING — so the paired old.bin delete is never attempted either
    // (`write_ready` false).
    let renamed = call(
        &transport,
        &handle,
        3,
        "versionedText.rename",
        json!({
            "versionId": "main",
            "fromPath": "old.bin",
            "toPath": "new.bin",
            "origin": "api",
            "requestId": "rename-pair-not-stranded",
        }),
    )
    .await;
    assert_eq!(renamed["moment"]["operation"], "rename");
    // Neither side materialized yet: the write is locked out, and the
    // delete never got its turn.
    assert!(scratch.path().join("old.bin").exists());

    // Delete the renamed destination while its write job is still pending —
    // the #739 cancellation this PR adds fires here.
    call(
        &transport,
        &handle,
        4,
        "versionedText.delete",
        json!({
            "versionId": "main",
            "path": "new.bin",
            "origin": "api",
            "requestId": "delete-locked-rename-destination",
        }),
    )
    .await;
    drop(lock);

    call(&transport, &handle, 5, "workspace.close", json!({})).await;
    drop(transport);

    let restarted_service = Arc::new(EngineService::new());
    let restarted_transport = InProcessTransport::new(restarted_service);
    let restarted_handle = open_workspace(&restarted_transport, &scratch, workspace_id, 1).await;

    // RED (bug): the replay's rename-pair check treats the write's CANCELLED
    // status like Conflict — it marks the paired old.bin delete conflict too
    // and abandons it, so old.bin survives on disk forever, stranded.
    //
    // GREEN (fix): CANCELLED lets the paired delete proceed like COMPLETE
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

/// #665, part A: capture -> discharge -> open CONVERGES.
///
/// The probe on `probe/665-convergence` staged this exact sequence and recorded
/// a closed loop: the prune guard read `last_settled_sha`, only a settle writes
/// that column, and so a capture that put the document's own projection into
/// the head still refused the discharge. Every lap answered the same refusals
/// and the document stayed read-only until the daemon restarted.
///
/// This is the same sequence with the answers a working discharge gives.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_captured_head_discharges_a_dirty_local_only_session() {
    const PATH: &str = "notes/converge.md";
    const TYPED: &str = "what the user typed";

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    write_file(scratch.path(), PATH, b"base");

    let service = Arc::new(EngineService::new());
    let transport = InProcessTransport::new(service);
    let handle = open_workspace(&transport, &scratch, "ws-665-a", 1).await;

    // The opening reconcile ingests the artifact, so the path has a head.
    wait_for_captured_head(&transport, &handle, PATH, "base", 1_000).await;

    let opened = call(
        &transport,
        &handle,
        2,
        "ydoc.open",
        json!({ "versionId": "main", "path": PATH, "contentKind": "plaintext" }),
    )
    .await;
    assert_eq!(opened["head"], json!("present"));
    assert_eq!(opened["seedContent"], json!("base"));
    let session_id = opened["sessionId"].as_str().expect("session id").to_owned();

    // Dirty the lineage and never settle it: `head_update_seq > 0` with
    // `last_settled_sha` NULL — the crashed never-settled draft #665 names.
    call(
        &transport,
        &handle,
        3,
        "ydoc.recordUpdate",
        json!({ "sessionId": session_id, "updateBase64": plaintext_update(TYPED) }),
    )
    .await;

    // A CAPTURE, not a settle, carries the content: the disk gets the doc's
    // exact projection and the watcher ingests it.
    write_file(scratch.path(), PATH, TYPED.as_bytes());
    let captured = wait_for_captured_head(&transport, &handle, PATH, TYPED, 2_000).await;
    assert_eq!(
        captured["objectId"], opened["objectId"],
        "the capture must mint the head on the object the session holds"
    );

    // MUTATION: drop the head comparison from the prune guard in
    // `crates/dohc-engine-collab/src/durable.rs` — this close refuses
    // `ydoc-unsettled-close` and the call below panics.
    call(
        &transport,
        &handle,
        4,
        "ydoc.close",
        json!({ "sessionId": session_id, "settle": false }),
    )
    .await;

    // The loop's exit: the discharge released the lease, so the retry's open
    // binds instead of answering `ydoc-session-busy`, and it seeds from the
    // captured head.
    let reopened = call(
        &transport,
        &handle,
        5,
        "ydoc.open",
        json!({ "versionId": "main", "path": PATH, "contentKind": "plaintext" }),
    )
    .await;
    assert_eq!(reopened["head"], json!("present"));
    assert_eq!(reopened["seedContent"], json!(TYPED));
    assert_eq!(
        reopened["lineage"],
        json!("absent"),
        "the discharge pruned the CRDT cache, so this open reseeds from the head"
    );

    call(
        &transport,
        &handle,
        6,
        "ydoc.close",
        json!({
            "sessionId": reopened["sessionId"].as_str().expect("session id"),
            "settle": false,
        }),
    )
    .await;
    call(&transport, &handle, 7, "workspace.close", json!({})).await;
}

/// #665, part B: a session that can neither settle nor prune EVICTS, and the
/// reopen resurrects its edits.
///
/// The desktop reaches this on two populations `captureOnePath` never captures
/// — a policy-excluded path, and a file between the 128 KiB capture limit and
/// the 2 MiB editor limit. The daemon has no policy notion at `ydoc.open`, so
/// this stages the state those two share and nothing else: a dirty local-only
/// lineage whose head does NOT hold its bytes, which no capture will ever fix.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_uncoverable_dirty_session_evicts_and_the_reopen_resurrects_it() {
    const PATH: &str = "notes/evict.md";

    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
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
        json!({ "sessionId": session_id, "updateBase64": plaintext_update("what the user typed") }),
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

    // MUTATION: make `ydoc_evict` skip its `sessions.remove` — the open below
    // answers `ydoc-session-busy` and its `call` panics.
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
