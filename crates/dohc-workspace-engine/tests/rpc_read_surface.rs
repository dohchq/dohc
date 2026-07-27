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
    write_file(scratch.path(), "notes/big.md", &vec![b'x'; 64 * 1024]);
    write_file(
        scratch.path(),
        "img.png",
        &[0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0x01],
    );
    // Binary over the in-band cap (48 KiB): PNG magic + 64 KiB total.
    let mut big_png = vec![0x89, 0x50, 0x4E, 0x47];
    big_png.resize(64 * 1024, 0xAB);
    write_file(scratch.path(), "img-big.png", &big_png);
    write_file(scratch.path(), ".env", b"TOKEN=rpc-read");
    // Secret over the in-band cap: 64 KiB of env content.
    let big_secret = format!(
        "BIG={}
",
        "v".repeat(64 * 1024)
    );
    write_file(scratch.path(), "big.env", big_secret.as_bytes());

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
    assert_eq!(active["id"], json!("main"));
    assert_eq!(active["kind"], json!("main"));

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

    // Capture accepts text through 128 KiB, and the text-read endpoint passes
    // that same cap to the one-query hydrator. The unrelated 48 KiB
    // binary/history cap must not truncate this captured body.
    id += 1;
    let large_text = call(
        &transport,
        &handle,
        id,
        "versionedText.read",
        json!({ "versionId": "main", "path": "notes/big.md" }),
    )
    .await;
    assert_eq!(
        large_text["text"].as_str().map(str::len),
        Some(64 * 1024),
        "captured text between 48 KiB and 128 KiB must hydrate"
    );

    // The listing pages by path with a keyset cursor — metadata only, so
    // no page can outgrow the wire frame.
    id += 1;
    let page1 = call(
        &transport,
        &handle,
        id,
        "versionedText.list",
        json!({ "versionId": "main", "limit": 2 }),
    )
    .await;
    let page1_paths: Vec<&str> = page1["files"]
        .as_array()
        .expect("page1 files")
        .iter()
        .map(|file| file["path"].as_str().expect("path"))
        .collect();
    assert_eq!(page1_paths.len(), 2, "limit must bound the page");
    let cursor = page1["nextAfterPath"].as_str().expect("cursor").to_owned();
    assert_eq!(cursor, *page1_paths.last().expect("last"));
    id += 1;
    let page2 = call(
        &transport,
        &handle,
        id,
        "versionedText.list",
        json!({ "versionId": "main", "limit": 50, "afterPath": cursor }),
    )
    .await;
    let page2_paths: Vec<&str> = page2["files"]
        .as_array()
        .expect("page2 files")
        .iter()
        .map(|file| file["path"].as_str().expect("path"))
        .collect();
    assert!(!page2_paths.is_empty(), "the tail page holds the rest");
    assert!(
        page2["nextAfterPath"].is_null(),
        "the final page carries no cursor"
    );
    assert!(
        page1_paths.iter().all(|path| !page2_paths.contains(path)),
        "pages must not overlap"
    );

    // versionedBinary.read returns the exact bytes; a TEXT head is not a
    // binary value and therefore answers null.
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
    let text_as_binary = call(
        &transport,
        &handle,
        id,
        "versionedBinary.read",
        json!({ "versionId": "main", "path": "notes/a.md" }),
    )
    .await;
    assert!(text_as_binary.is_null());

    // A blob over the in-band cap answers METADATA with a null body — the
    // DOP1 string limit makes full bytes unencodable, and a silent failure
    // at encode (after the read) would be strictly worse.
    id += 1;
    let big = call(
        &transport,
        &handle,
        id,
        "versionedBinary.read",
        json!({ "versionId": "main", "path": "img-big.png" }),
    )
    .await;
    assert_eq!(big["byteLength"], json!(64 * 1024));
    assert!(
        big["bytesBase64"].is_null(),
        "over-cap bytes stay out-of-band"
    );
    assert_eq!(big["inbandLimitBytes"], json!(48 * 1024));
    assert!(big["sha256"].is_string());

    // An unknown version fails closed on the listing too — a typo'd id must
    // never masquerade as an empty version.
    id += 1;
    let unknown_version = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "versionedText.list",
                Some(handle.clone()),
                json!({ "versionId": "no-such-version" }),
            ),
        )
        .await;
    assert!(
        unknown_version.is_err(),
        "listing an unknown version must refuse, not read as empty"
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

    // Capture-sized text remains fully hydratable for desktop restores.
    let big_text_moment = moment_list
        .iter()
        .find(|moment| moment["path"] == "notes/big.md")
        .expect("large captured text moment");
    assert_eq!(
        big_text_moment["afterText"].as_str().map(str::len),
        Some(64 * 1024)
    );
    assert!(big_text_moment["afterInbandLimitBytes"].is_null());
    id += 1;
    let big_text_fetched = call(
        &transport,
        &handle,
        id,
        "moments.get",
        json!({ "momentId": big_text_moment["momentId"] }),
    )
    .await;
    assert_eq!(
        big_text_fetched["afterText"].as_str().map(str::len),
        Some(64 * 1024)
    );
    assert!(big_text_fetched["afterInbandLimitBytes"].is_null());

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
    assert_eq!(secret_paths, vec![".env", "big.env"]);
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
    // A percent-disguised spelling classifies and resolves through the same
    // canonical path. Secret identity cannot retain an alias that disk
    // materialization would collapse onto the same plaintext file.
    id += 1;
    let disguised = call(
        &transport,
        &handle,
        id,
        "secrets.materialize",
        json!({ "versionId": "main", "path": "%2eenv" }),
    )
    .await;
    // MUTATION: classify normalized but key by the verbatim spelling -> this
    // becomes null and recreates the alias/clobber split.
    assert_eq!(disguised["text"], json!("TOKEN=rpc-read"));
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

    // Protected plaintext is hydratable throughout the oracle's accepted
    // secret-file range.
    id += 1;
    let big = call(
        &transport,
        &handle,
        id,
        "secrets.materialize",
        json!({ "versionId": "main", "path": "big.env" }),
    )
    .await;
    assert_eq!(big["text"], json!(big_secret));

    // FAIL CLOSED: live secret state with a MISSING key file is
    // corrupt/misrestored — materialize must error, never read as empty.
    std::fs::remove_file(
        scratch
            .path()
            .join(dohc_engine_crypto::SECRET_KEY_FILE_RELATIVE),
    )
    .expect("remove key file");
    id += 1;
    let keyless = transport
        .call(
            RequestContext::unbounded(),
            request(
                id,
                "secrets.materialize",
                Some(handle.clone()),
                json!({ "versionId": "main", "path": ".env" }),
            ),
        )
        .await;
    assert!(
        keyless.is_err(),
        "secret state without a key must fail closed"
    );

    id += 1;
    transport
        .call(
            RequestContext::unbounded(),
            request(id, "workspace.close", Some(handle), json!({})),
        )
        .await
        .expect("close");

    // A BRAND-NEW workspace: nothing captured, nothing versioned, no key.
    // versions.active answers null when neither active nor main resolves;
    // keyless materialize still answers null when no secret state exists.
    let fresh = ScratchDir::new().expect("fresh scratch");
    write_shadow_marker_for_harness(fresh.path(), TOKEN).expect("marker");
    let opened = transport
        .call(
            RequestContext::unbounded(),
            request(
                id + 1,
                "workspace.open",
                None,
                json!({
                    "rootDir": fresh.path().to_string_lossy(),
                    "workspaceId": "rpc-read-fresh",
                }),
            ),
        )
        .await
        .expect("fresh open");
    let fresh_handle: WorkspaceHandle =
        serde_json::from_value(opened.result["workspace"].clone()).expect("fresh handle");
    // MUTATION: synthesize main or map WorkspaceNotFound to state-corrupt -> this is not null.
    let active = call(
        &transport,
        &fresh_handle,
        id + 2,
        "versions.active",
        json!({}),
    )
    .await;
    assert!(active.is_null());
    // With NO versions at all, materialize refuses like every sibling
    // read — the error surface must not depend on whether a key exists.
    let no_version = transport
        .call(
            RequestContext::unbounded(),
            request(
                id + 3,
                "secrets.materialize",
                Some(fresh_handle.clone()),
                json!({ "versionId": "main", "path": ".env" }),
            ),
        )
        .await;
    assert!(
        no_version.is_err(),
        "an unknown version refuses even keyless-and-stateless"
    );
    // Once a version exists (text write; no key ever minted), keyless +
    // stateless materialize answers null.
    call(
        &transport,
        &fresh_handle,
        id + 4,
        "versionedText.write",
        json!({
            "versionId": "main",
            "objectId": "fresh-object",
            "path": "fresh.md",
            "text": "fresh",
            "momentId": "fresh-moment",
            "metadataOrigin": "api",
            "nowMs": 7
        }),
    )
    .await;
    let no_state = call(
        &transport,
        &fresh_handle,
        id + 5,
        "secrets.materialize",
        json!({ "versionId": "main", "path": ".env" }),
    )
    .await;
    assert!(no_state.is_null(), "no key + no state materializes to null");
    transport
        .call(
            RequestContext::unbounded(),
            request(id + 6, "workspace.close", Some(fresh_handle), json!({})),
        )
        .await
        .expect("fresh close");
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
