pub fn fake_reader(
    scratch: &dohc_engine_testkit::ScratchDir,
    mode: &str,
) -> dohc_engine_reader::Config {
    use dohc_engine_storage::hex_sha256;
    use serde_json::json;
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = std::path::PathBuf::from(
        runtime
            .as_object_mut()
            .unwrap()
            .remove("path")
            .unwrap()
            .as_str()
            .unwrap(),
    );
    runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string())
        .replace("MODE", &serde_json::to_string(mode).unwrap());
    static NEXT_READER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = NEXT_READER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let bundle = scratch.path().join(format!("reader-{id}.cjs"));
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = json!([]);
    let manifest_path = scratch.path().join(format!("reader-{id}-manifest.json"));
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: manifest_path,
    }
}

pub fn witness_reader(
    scratch: &dohc_engine_testkit::ScratchDir,
) -> std::sync::Arc<dohc_engine_collab::reader_resolver::ReaderResolver> {
    use std::sync::Arc;
    Arc::new(dohc_engine_collab::reader_resolver::ReaderResolver::new(
        Arc::new(dohc_engine_reader::Reader::new(Some(fake_reader(
            scratch,
            "witness-safe",
        )))),
    ))
}

pub async fn configure_witness_reader(
    actor: &dohc_engine_runtime::ActorHandle,
    scratch: &dohc_engine_testkit::ScratchDir,
) {
    actor
        .configure_reader_resolver(witness_reader(scratch))
        .await
        .unwrap();
}
