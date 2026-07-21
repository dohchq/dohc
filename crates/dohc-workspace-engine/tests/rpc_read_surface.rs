//! RPC-A acceptance: the read surface (versions/moments/text-list/binary/
//! secrets) end to end through the transport, against state produced by the
//! REAL write paths (RPC writes + autonomous capture) — never by seeding the
//! DB directly, so the RPCs are proven against the daemon's own semantics.

use dohc_engine_protocol::{
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WORKSPACE_ID: &str = "ws-rpc-read-surface";
const WAIT: Duration = Duration::from_secs(20);

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

fn write_file(root: &Path, path: &str, bytes: &[u8]) {
    let absolute = root.join(path);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(absolute, bytes).expect("write file");
}

/// Flush until the given path's captured state satisfies `check`.
async fn flush_until(
    transport: &InProcessTransport<EngineService>,
    handle: &WorkspaceHandle,
    id: &mut u64,
    what: &str,
    mut check: impl AsyncFnMut(&mut u64) -> bool,
) {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        *id += 1;
        let flushed = call(transport, handle, *id, "capture.flush", json!({})).await;
        assert_eq!(flushed["settled"], json!(true), "flush must settle");
        if check(id).await {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_read_surface_reflects_rpc_writes_and_autonomous_capture() {
    let scratch = ScratchDir::new().expect("scratch");
    write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
    // Pre-open disk content: the startup baseline captures text, binary and
    // a secret before the first read RPC ever runs.
    write_file(scratch.path(), "notes/a.md", b"captured text");
    write_file(
        scratch.path(),
        "img.png",
        &[0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0x01],
    );
    write_file(scratch.path(), ".env", b"TOKEN=rpc-read");

    let transport = InProcessTransport::new(Arc::new(EngineService::new()));
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                1,
                "workspace.open",
                None,
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": WORKSPACE_ID,
                }),
            ),
        )
        .await
        .expect("open");
    let handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("handle");
    let mut id: u64 = 10;

    // versions.active resolves to main on a fresh workspace.
    let active = call(&transport, &handle, 2, "versions.active", json!({})).await;
    assert_eq!(active["versionId"], json!("main"));

    // versions.list contains it.
    let versions = call(&transport, &handle, 3, "versions.list", json!({})).await;
    let listed: Vec<&str> = versions["versions"]
        .as_array()
        .expect("versions array")
        .iter()
        .map(|version| version["versionId"].as_str().expect("id"))
        .collect();
    assert!(listed.contains(&"main"), "main missing from {listed:?}");

    // An RPC write joins the surface alongside captured content.
    call(
        &transport,
        &handle,
        4,
        "versionedText.write",
        json!({
            "versionId": "main",
            "objectId": "rpc-object-1",
            "path": "rpc/written.md",
            "text": "written via rpc",
            "momentId": "rpc-moment-1",
            "metadataOrigin": "api",
            "nowMs": 5
        }),
    )
    .await;

    // versionedText.list eventually shows all three text-surface paths with
    // the right kinds (the baseline capture is asynchronous).
    let transport_ref = &transport;
    let handle_ref = &handle;
    flush_until(
        &transport,
        &handle,
        &mut id,
        "text list to contain captured + rpc + binary heads",
        async |id: &mut u64| {
            *id += 1;
            let files = call(
                transport_ref,
                handle_ref,
                *id,
                "versionedText.list",
                json!({ "versionId": "main" }),
            )
            .await;
            let by_path: Vec<(String, String)> = files["files"]
                .as_array()
                .expect("files array")
                .iter()
                .map(|file| {
                    (
                        file["path"].as_str().expect("path").to_owned(),
                        file["contentKind"].as_str().expect("kind").to_owned(),
                    )
                })
                .collect();
            by_path.contains(&("notes/a.md".to_owned(), "text".to_owned()))
                && by_path.contains(&("rpc/written.md".to_owned(), "text".to_owned()))
                && by_path.contains(&("img.png".to_owned(), "binary".to_owned()))
        },
    )
    .await;

    // versionedBinary.read returns the exact bytes; on a TEXT head it errors
    // (asked the wrong question) rather than returning empty bytes.
    id += 1;
    let binary = call(
        &transport,
        &handle,
        id,
        "versionedBinary.read",
        json!({ "versionId": "main", "path": "img.png" }),
    )
    .await;
    assert_eq!(binary["byteLength"], json!(7));
    assert_eq!(
        binary["bytesBase64"],
        json!(base64_encode(&[0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0x01]))
    );
    id += 1;
    let text_as_binary = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "versionedBinary.read",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": "notes/a.md" }),
            ),
        )
        .await;
    assert!(
        text_as_binary.is_err(),
        "a text head must refuse binary read"
    );

    // moments.list pages newest-first and moments.get roundtrips one.
    id += 1;
    let moments = call(
        &transport,
        &handle,
        id,
        "moments.list",
        json!({ "versionId": "main", "limit": 10 }),
    )
    .await;
    let moment_list = moments["moments"].as_array().expect("moments array");
    assert!(
        !moment_list.is_empty(),
        "captured + rpc writes must have recorded moments"
    );
    let newest = &moment_list[0];
    assert!(
        moment_list
            .windows(2)
            .all(|pair| pair[0]["momentOrder"].as_i64() >= pair[1]["momentOrder"].as_i64()),
        "moments must page newest first"
    );
    id += 1;
    let fetched = call(
        &transport,
        &handle,
        id,
        "moments.get",
        json!({ "momentId": newest["momentId"] }),
    )
    .await;
    assert_eq!(fetched["momentId"], newest["momentId"]);
    assert_eq!(fetched["path"], newest["path"]);

    // secrets.list exposes metadata only; secrets.materialize is the single
    // plaintext accessor and roundtrips the captured secret.
    id += 1;
    let secrets = call(
        &transport,
        &handle,
        id,
        "secrets.list",
        json!({ "versionId": "main" }),
    )
    .await;
    let secret_paths: Vec<&str> = secrets["secrets"]
        .as_array()
        .expect("secrets array")
        .iter()
        .map(|stat| stat["path"].as_str().expect("path"))
        .collect();
    assert_eq!(secret_paths, vec![".env"]);
    assert!(
        secrets["secrets"][0].get("text").is_none(),
        "the listing must never carry plaintext"
    );
    id += 1;
    let plaintext = call(
        &transport,
        &handle,
        id,
        "secrets.materialize",
        json!({ "versionId": "main", "path": ".env" }),
    )
    .await;
    assert_eq!(plaintext["text"], json!("TOKEN=rpc-read"));
    id += 1;
    let absent = call(
        &transport,
        &handle,
        id,
        "secrets.materialize",
        json!({ "versionId": "main", "path": ".env.absent" }),
    )
    .await;
    assert!(absent.is_null(), "an absent secret materializes to null");

    id += 1;
    transport
        .call(
            RequestContext::unbounded(),
            request(id, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
