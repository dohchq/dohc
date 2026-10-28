use super::*;
use serde_json::{Value, json};
use std::{fs, process::Command, sync::OnceLock};
#[path = "../tests/assets.rs"]
mod assets;
#[path = "../tests/containment.rs"]
mod containment;
#[path = "../tests/real.rs"]
mod real;
pub(super) fn after_hash(config: &Config) {
    assets::after_hash(config);
}
pub(super) fn started(shared: &Shared, pid: u32, cwd: &std::path::Path) {
    let mut s = shared.state.lock().unwrap();
    s.lifecycle.0 += 1;
    s.lifecycle.2 = Some((pid, cwd.into()));
    shared.wake.notify_all();
    drop(s);
    assets::started();
}
pub(super) fn reaped(shared: &Shared) {
    let mut s = shared.state.lock().unwrap();
    s.lifecycle.1 += 1;
    s.lifecycle.2 = None;
    shared.wake.notify_all();
}

fn runtime() -> (PathBuf, Value) {
    static RUNTIME: OnceLock<(PathBuf, Value)> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        // The reader refuses a Node under a linked or shared-writable directory, such as
        // Homebrew's Cellar. The Rust gate stages a pinned Node on macOS and names it here.
        let hint = "set DOHC_READER_TEST_NODE=\"$(node tools/rust-engine-program/reader-test-node.mjs)\"";
        let selected = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
        let output = Command::new(&selected).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output();
        let output = output.unwrap_or_else(|e| panic!("cannot run test Node {selected:?}: {e}; {hint}"));
        assert!(output.status.success());
        let mut v: Value = serde_json::from_slice(&output.stdout).unwrap();
        let node = PathBuf::from(v.as_object_mut().unwrap().remove("path").unwrap().as_str().unwrap());
        let checked = platform::open_asset(&node).map(|_| ());
        assert!(checked.is_ok(), "test Node {} fails the reader's asset checks: {checked:?}; {hint}", node.display());
        v["sha256"] = wire::sha(&fs::read(&node).unwrap()).into();
        (node, v)
    }).clone()
}
fn fixture(mode: &str) -> (tempfile::TempDir, Config) {
    let parent = std::env::current_dir().unwrap();
    let root = std::env::temp_dir();
    // macOS links /var to /private/var, and the reader refuses linked ancestors.
    #[cfg(target_os = "macos")]
    let root = root.canonicalize().unwrap();
    let dir = tempfile::tempdir_in(root).unwrap();
    let (node, runtime) = runtime();
    let identity = json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":parent});
    let script = include_str!("fake.cjs")
        .replace("MANIFEST", &identity.to_string())
        .replace("MODE", &json!(mode).to_string());
    let bundle = dir.path().join("fake.cjs");
    fs::write(&bundle, &script).unwrap();
    let checked = Command::new(&node)
        .arg("--check")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(
        checked.status.success(),
        "{}",
        String::from_utf8_lossy(&checked.stderr)
    );
    let mut manifest = identity;
    manifest["bundleSha256"] = wire::sha(script.as_bytes()).into();
    manifest["sources"] = json!([]);
    let path = dir.path().join("manifest.json");
    fs::write(&path, manifest.to_string()).unwrap();
    (
        dir,
        Config {
            node,
            bundle,
            manifest: path,
        },
    )
}
fn request(path: &str) -> Request {
    Request {
        method: Method::Construct,
        document: Document {
            workspace_id: "w".into(),
            main_version_id: "v".into(),
            object_id: path.into(),
            lineage_claim_id: "l".into(),
        },
        current_path: path.into(),
        source: b"note".to_vec(),
        checkpoint: vec![0, 0],
    }
}

#[test]
fn identity_mismatch_stays_unavailable_without_rehashing() {
    let (_directory, config) = fixture("ok");
    let original = fs::read(&config.bundle).unwrap();
    fs::write(&config.bundle, b"wrong build").unwrap();
    let mut reader = Reader::new(Some(config.clone()));
    assert!(matches!(
        run(reader.request(request("note.md"))),
        Err(Failure::Unavailable)
    ));
    fs::write(&config.bundle, original).unwrap();
    assert!(matches!(
        run(reader.request(request("note.md"))),
        Err(Failure::Unavailable)
    ));
    finish(&mut reader);
}
#[test]
fn markdown_witness_pipe_checks_identities_and_carries_no_checkpoint() {
    for (mode, expected) in [
        ("ok", Some(true)),
        ("witness-unsafe", Some(false)),
        ("witness-source-mismatch", None),
        ("witness-projection-mismatch", None),
        ("witness-over-cap", None),
    ] {
        let (_directory, config) = fixture(mode);
        let mut reader = Reader::new(Some(config));
        let request = CheckMarkdownWitness {
            source: b"source only".to_vec(),
            source_sha256: wire::sha(b"source only"),
            projection_sha256: wire::sha(b"projection"),
        };
        let result = run(reader.check_markdown_witness(request.clone()));
        if let Some(expected) = expected {
            match result.unwrap() {
                Outcome::WitnessChecked {
                    source_sha256,
                    projection_sha256,
                    checker_identity,
                    keeps_meaning,
                } => {
                    assert_eq!(source_sha256, request.source_sha256);
                    assert_eq!(projection_sha256, request.projection_sha256);
                    assert_eq!(Some(checker_identity), reader.checker_identity());
                    assert_eq!(keeps_meaning, expected);
                }
                _ => panic!("expected a checked witness"),
            }
        } else {
            assert!(result.is_err());
        }
        finish(&mut reader);
    }
}

#[test]
fn markdown_witness_source_cap_is_two_megabytes_and_invalid_inputs_start_no_child() {
    let (_directory, config) = fixture("ok");
    let mut reader = Reader::new(Some(config));
    for fault in [
        "over-cap",
        "source-digest",
        "projection-digest",
        "source-bytes",
    ] {
        let source = if fault == "over-cap" {
            vec![b'x'; 2 * 1024 * 1024 + 1]
        } else {
            b"source".to_vec()
        };
        let mut request = CheckMarkdownWitness {
            source_sha256: wire::sha(&source),
            source,
            projection_sha256: wire::sha(b"projection"),
        };
        match fault {
            "source-digest" => request.source_sha256 = "invalid".into(),
            "projection-digest" => request.projection_sha256 = "g".repeat(64),
            "source-bytes" => request.source_sha256 = wire::sha(b"other source"),
            _ => {}
        }
        fail(
            run(reader.check_markdown_witness(request)),
            Failure::TooLarge,
        );
    }
    assert_eq!(reader.shared.state.lock().unwrap().lifecycle.0, 0);
    let source = vec![b'x'; 2 * 1024 * 1024];
    assert!(matches!(
        run(reader.check_markdown_witness(CheckMarkdownWitness {
            source_sha256: wire::sha(&source),
            source,
            projection_sha256: wire::sha(b"projection"),
        })),
        Ok(Outcome::WitnessChecked {
            keeps_meaning: true,
            ..
        })
    ));
    finish(&mut reader);
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG and DOHC_READER_FIXTURES for the real staged bundle"]
fn markdown_witness_real_pipe_agrees_with_the_commonmark_meaning_controls() {
    let config =
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    let checkpoint = fs::read(
        PathBuf::from(std::env::var_os("DOHC_READER_FIXTURES").unwrap()).join("note.checkpoint"),
    )
    .unwrap();
    let examples: Value = serde_json::from_str(include_str!(
        "../../../packages/ydoc-projection/src/fixtures/commonmark-edit-meaning.json"
    ))
    .unwrap();
    let mut sources = vec![("# Safe\n\nPlain paragraph.\n".to_owned(), true)];
    sources.extend([148, 161, 192, 193, 572, 575, 577].map(|number| {
        let example = examples["examples"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["example"] == number)
            .unwrap();
        (example["markdown"].as_str().unwrap().to_owned(), false)
    }));
    let mut reader = Reader::new(Some(config));
    for (source, expected) in sources {
        let mut input = request("note.md");
        input.document.main_version_id = "main".into();
        input.document.object_id = "fixture".into();
        input.source = source.as_bytes().to_vec();
        input.checkpoint = checkpoint.clone();
        let Outcome::Constructed { proof, .. } = run(reader.request(input)).unwrap() else {
            panic!("the real reader must import the meaning control");
        };
        let input = CheckMarkdownWitness {
            source: source.into_bytes(),
            source_sha256: proof.source_sha256,
            projection_sha256: proof.projection_sha256,
        };
        let Outcome::WitnessChecked {
            keeps_meaning,
            checker_identity,
            ..
        } = run(reader.check_markdown_witness(input.clone())).unwrap()
        else {
            panic!("the real pipe must answer the witness request");
        };
        assert_eq!(keeps_meaning, expected);
        assert_eq!(Some(checker_identity), reader.checker_identity());
        let wrong = CheckMarkdownWitness {
            projection_sha256: wire::sha(b"different projection"),
            ..input
        };
        assert!(matches!(
            run(reader.check_markdown_witness(wrong)),
            Ok(Outcome::WitnessChecked {
                keeps_meaning: false,
                ..
            })
        ));
    }
    finish(&mut reader);
}

fn wait(reader: &Reader, predicate: impl Fn(&State) -> bool) {
    let end = Instant::now() + Duration::from_secs(15);
    let mut s = reader.shared.state.lock().unwrap();
    while !predicate(&s) {
        let (state, timed) = reader
            .shared
            .wake
            .wait_timeout(s, end.saturating_duration_since(Instant::now()))
            .unwrap();
        s = state;
        if timed.timed_out() && !predicate(&s) {
            drop(s);
            panic!("condition deadline");
        }
    }
}
fn finish(reader: &mut Reader) {
    let cwd = reader
        .shared
        .state
        .lock()
        .unwrap()
        .lifecycle
        .2
        .as_ref()
        .map(|(_, p)| p.clone());
    reader.shutdown();
    let s = reader.shared.state.lock().unwrap();
    assert_eq!(
        s.lifecycle.0, s.lifecycle.1,
        "each started child was waited"
    );
    assert!(s.lifecycle.2.is_none());
    assert_eq!(s.retained, 0);
    assert!(s.queue.is_empty());
    if let Some(cwd) = cwd {
        assert!(!cwd.exists());
    }
}
fn run(future: impl Future<Output = Result>) -> Result {
    // The production owner uses no Tokio runtime. A tiny test executor drives oneshots.
    use std::task::{Context, Poll, Wake, Waker};
    struct Unpark(thread::Thread);
    impl Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Unpark(thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(r) => return r,
            Poll::Pending => thread::park(),
        }
    }
}
fn fail(result: Result, expected: Failure) {
    assert!(
        matches!(result, Err(e) if e == expected),
        "expected {expected:?}, got {result:?}"
    );
}
fn assert_pending(future: std::pin::Pin<&mut impl Future<Output = Result>>) {
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(
        future.poll(&mut cx).is_pending(),
        "active request completed before queued deadline"
    );
}

#[test]
fn oversized_metadata_is_refused_before_starting_a_child() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    for field in 0..5 {
        let mut r = request("ok");
        let value = "x".repeat(8193);
        match field {
            0 => r.current_path = value,
            1 => r.document.workspace_id = value,
            2 => r.document.main_version_id = value,
            3 => r.document.object_id = value,
            _ => r.document.lineage_claim_id = value,
        }
        fail(run(reader.request(r)), Failure::TooLarge);
    }
    let mut r = request("ok");
    r.current_path = "\0".repeat(4096);
    r.document.object_id = "\0".repeat(4096);
    r.document.workspace_id = "\0".repeat(4096);
    fail(run(reader.request(r)), Failure::TooLarge);
    let starts = reader.shared.state.lock().unwrap().lifecycle.0;
    assert_eq!(starts, 0);
    finish(&mut reader);
}

#[test]
fn metadata_at_the_combined_limit_is_admitted() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    let mut r = request("ok");
    // Four document fields consume five bytes; exercise worst-case JSON escaping.
    r.current_path = "\0".repeat(8192 - 5);
    assert!(run(reader.request(r)).is_ok());
    finish(&mut reader);
}

#[test]
fn closed_supervisor_does_not_start_a_child() {
    let (_dir, c) = fixture("ok");
    let shared = Arc::new(Shared::default());
    shared.state.lock().unwrap().closed = true;
    let result =
        process::Worker::start(&c, shared.clone(), Instant::now() + Duration::from_secs(5));
    let refused = matches!(result, Err(Failure::Unavailable));
    drop(result);
    assert!(refused);
    assert_eq!(shared.state.lock().unwrap().lifecycle.0, 0);
}

#[test]
fn invalid_configuration_or_identity_is_unavailable() {
    for fault in [
        "none",
        "relative",
        "runtime",
        "bundle",
        "manifest",
        "hash",
        "bundle-hash",
        "runtime-hash",
        "json",
        "hello",
        "runtime-version",
        "runtime-platform",
        "runtime-arch",
        "runtime-unicode",
        "protocol",
        "schema",
        "embedded-identity",
    ] {
        let (dir, mut c) = fixture(fault);
        match fault {
            "relative" => {
                let mut relative = PathBuf::new();
                for component in std::env::current_dir().unwrap().components() {
                    if matches!(component, std::path::Component::Normal(_)) {
                        relative.push("..");
                    }
                }
                for component in c.manifest.components() {
                    if let std::path::Component::Normal(name) = component {
                        relative.push(name);
                    }
                }
                assert!(relative.exists());
                c.manifest = relative;
            }
            "runtime" => c.node = dir.path().join("absent.exe"),
            "bundle" => fs::remove_file(&c.bundle).unwrap(),
            "manifest" => fs::remove_file(&c.manifest).unwrap(),
            "hash" => fs::write(&c.bundle, "wrong").unwrap(),
            "runtime-hash" => {
                let mut m: Value = serde_json::from_slice(&fs::read(&c.manifest).unwrap()).unwrap();
                m["runtime"]["sha256"] = "wrong".into();
                fs::write(&c.manifest, m.to_string()).unwrap();
            }
            "bundle-hash" => {
                let mut m: Value = serde_json::from_slice(&fs::read(&c.manifest).unwrap()).unwrap();
                m["bundleSha256"] = "0".repeat(64).into();
                fs::write(&c.manifest, m.to_string()).unwrap();
            }
            "json" => fs::write(&c.manifest, "{").unwrap(),
            _ => {}
        }
        let mut reader = Reader::new((fault != "none").then_some(c));
        fail(run(reader.request(request("ok"))), Failure::Unavailable);
        finish(&mut reader);
    }
}
#[test]
fn startup_crashes_allow_a_fresh_fenced_retry() {
    let (_dir, config) = fixture("startup-crash");
    let mut reader = Reader::new(Some(config));
    for _ in 0..2 {
        fail(run(reader.request(request("ok"))), Failure::Crashed);
    }
    assert_eq!(reader.shared.state.lock().unwrap().lifecycle.0, 2);
    finish(&mut reader);
}
#[test]
fn crashes_and_restarts() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    for fault in [
        "crash",
        "sha",
        "length",
        "obsolete-flag",
        "eof-delta",
        "truncated-delta",
        "eof-end",
        "truncated-end",
        "end-id",
        "malformed",
        "oversize",
        "id",
        "kind",
        "extra",
        "delta",
        "declaration",
    ] {
        fail(run(reader.request(request(fault))), Failure::Crashed);
        assert!(matches!(
            run(reader.request(request("ok"))),
            Ok(Outcome::Constructed { .. })
        ));
    }
    assert!(matches!(
        run(reader.request(request("stderr"))),
        Ok(Outcome::Constructed { .. })
    ));
    finish(&mut reader);
}
// Separate filters make each integrity guard usable as a red/green fault probe.
macro_rules! reply_fault {
    ($test:ident, $fault:literal) => {
        #[test]
        fn $test() {
            let (_dir, c) = fixture("ok");
            let mut reader = Reader::new(Some(c));
            fail(run(reader.request(request($fault))), Failure::Crashed);
            finish(&mut reader);
        }
    };
}
reply_fault!(wrong_source_digest_crashes_reader, "sha");
reply_fault!(wrong_source_length_crashes_reader, "length");
reply_fault!(obsolete_flag_rejected, "obsolete-flag");
reply_fault!(eof_before_delta_crashes_reader, "eof-delta");
reply_fault!(truncated_delta_crashes_reader, "truncated-delta");
reply_fault!(eof_before_end_crashes_reader, "eof-end");
reply_fault!(truncated_end_crashes_reader, "truncated-end");
reply_fault!(wrong_end_id_crashes_reader, "end-id");
reply_fault!(wrong_response_id_crashes_reader, "id");
reply_fault!(wrong_response_kind_crashes_reader, "kind");
reply_fault!(unknown_response_fields_crash_reader, "extra");
reply_fault!(wrong_delta_digest_crashes_reader, "delta");
reply_fault!(oversized_delta_declaration_crashes_reader, "declaration");
reply_fault!(malformed_frame_crashes_reader, "malformed");
reply_fault!(oversized_frame_crashes_reader, "oversize");
reply_fault!(unknown_refusal_reason_crashes_reader, "refused-reason");
reply_fault!(wrong_refusal_id_crashes_reader, "refused-id");
reply_fault!(malformed_projection_sha_crashes_reader, "projection-sha");
reply_fault!(malformed_state_sha_crashes_reader, "state-sha");

#[test]
fn child_receives_only_the_fixed_launch_contract() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    assert!(run(reader.request(request("ok"))).is_ok());
    let cwd = reader
        .shared
        .state
        .lock()
        .unwrap()
        .lifecycle
        .2
        .as_ref()
        .unwrap()
        .1
        .clone();
    assert_ne!(cwd, std::env::current_dir().unwrap());
    assert_eq!(fs::read_dir(cwd).unwrap().count(), 0);
    finish(&mut reader);
}
#[test]
fn missing_configuration_creates_no_owner_thread() {
    let mut reader = Reader::new(None);
    assert!(reader.owner.is_none());
    fail(run(reader.request(request("ok"))), Failure::Unavailable);
    finish(&mut reader);
}
#[test]
fn prove_rejects_a_nonempty_delta() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    let mut r = request("prove-delta");
    r.method = Method::Prove;
    fail(run(reader.request(r)), Failure::Crashed);
    finish(&mut reader);
}
#[test]
fn debug_output_reports_delta_length_without_bytes() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    let result = run(reader.request(request("ok"))).unwrap();
    assert!(!format!("{result:?}").contains("[0, 0]"));
    finish(&mut reader);
}
#[test]
fn construct_and_prove_for_one_document_coexist() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    assert!(run(reader.request(request("ok"))).is_ok());
    let active = reader.request(request("hang"));
    wait(&reader, |s| s.queue.is_empty());
    let old = reader.request(request("same"));
    let mut r = request("same");
    r.method = Method::Prove;
    let prove = reader.request(r);
    let queued = reader.shared.state.lock().unwrap().queue.len();
    assert_eq!(queued, 2);
    finish(&mut reader);
    for f in [active, old, prove] {
        fail(run(f), Failure::Unavailable);
    }
}
#[test]
fn every_outcome_binds_the_sent_checkpoint() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    for bytes in [vec![0, 0], vec![1, 2, 3]] {
        let digest = wire::sha(&bytes);
        for (path, method) in [
            ("ok", Method::Construct),
            ("ok", Method::Prove),
            ("refused", Method::Construct),
        ] {
            let mut r = request(path);
            r.method = method;
            r.checkpoint = bytes.clone();
            let result = run(reader.request(r)).unwrap();
            let actual = match result {
                Outcome::Constructed {
                    checkpoint_sha256, ..
                } if method == Method::Construct && path == "ok" => checkpoint_sha256,
                Outcome::Proved {
                    checkpoint_sha256, ..
                } if method == Method::Prove => checkpoint_sha256,
                Outcome::Refused {
                    reason: RefusalReason::InvalidSource,
                    checkpoint_sha256,
                } if path == "refused" => checkpoint_sha256,
                other => panic!("{other:?}"),
            };
            assert_eq!(actual, digest);
        }
    }
    finish(&mut reader);
}
#[test]
fn rejected_replacement_preserves_the_queued_request() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    assert!(run(reader.request(request("ok"))).is_ok());
    let mut large = request("hang");
    large.source = vec![0; 2 * 1024 * 1024];
    large.checkpoint = vec![0; wire::UPDATE];
    let active = reader.request(large);
    wait(&reader, |s| s.queue.is_empty());
    let mut other = request("other");
    other.source = vec![0; 2 * 1024 * 1024];
    other.checkpoint = vec![0; wire::UPDATE];
    let queued = reader.request(other);
    let mut old = Box::pin(reader.request(request("same")));
    let mut newer = request("same");
    newer.source = vec![0; 2 * 1024 * 1024];
    newer.checkpoint = vec![0; wire::UPDATE];
    fail(run(reader.request(newer)), Failure::Overloaded);
    assert_pending(old.as_mut());
    let queued_count = reader.shared.state.lock().unwrap().queue.len();
    assert_eq!(queued_count, 2);
    finish(&mut reader);
    for f in [Box::pin(active), Box::pin(queued), old] {
        fail(run(f), Failure::Unavailable);
    }
}
#[cfg(windows)]
#[test]
fn extensionless_executable_is_rejected_before_spawn() {
    let (dir, mut c) = fixture("ok");
    let bare = dir.path().join("node");
    let mut allowed = Reader::new(Some(c.clone()));
    assert!(run(allowed.request(request("ok"))).is_ok());
    finish(&mut allowed);
    // Any checked PE executable can expose a missing pre-spawn extension guard.
    // Reuse this test binary; no extra Node distribution is needed.
    let executable = std::env::current_exe().unwrap();
    fs::hard_link(&executable, &bare).unwrap();
    let mut manifest: Value = serde_json::from_slice(&fs::read(&c.manifest).unwrap()).unwrap();
    manifest["runtime"]["sha256"] = wire::sha(&fs::read(executable).unwrap()).into();
    fs::write(&c.manifest, manifest.to_string()).unwrap();
    c.node = bare;
    let mut reader = Reader::new(Some(c));
    fail(run(reader.request(request("ok"))), Failure::Unavailable);
    let starts = reader.shared.state.lock().unwrap().lifecycle.0;
    assert_eq!(
        starts, 0,
        "invalid executable paths must be rejected before spawn"
    );
    finish(&mut reader);
}

#[test]
fn construct_and_prove_return_checked_success() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    assert!(matches!(
        run(reader.request(request("ok"))),
        Ok(Outcome::Constructed { .. })
    ));
    let mut prove = request("ok");
    prove.method = Method::Prove;
    assert!(matches!(
        run(reader.request(prove)),
        Ok(Outcome::Proved { .. })
    ));
    finish(&mut reader);
}

#[test]
fn expiry_is_a_complete_checkpoint_bound_proof_and_never_a_construction() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    let mut prove = request("expired");
    prove.method = Method::Prove;
    let checkpoint = wire::sha(&prove.checkpoint);
    assert!(
        matches!(run(reader.request(prove)), Ok(Outcome::Expired { checkpoint_sha256, .. }) if checkpoint_sha256 == checkpoint)
    );
    fail(run(reader.request(request("expired"))), Failure::Crashed);
    let mut prove = request("expired-delta");
    prove.method = Method::Prove;
    fail(run(reader.request(prove)), Failure::Crashed);
    finish(&mut reader);
}

#[test]
fn drop_reaps_active_child() {
    let (_dir, c) = fixture("ok");
    let reader = Reader::new(Some(c));
    assert!(run(reader.request(request("ok"))).is_ok());
    let active = reader.request(request("hang"));
    wait(&reader, |s| s.queue.is_empty());
    let shared = reader.shared.clone();
    let cwd = shared
        .state
        .lock()
        .unwrap()
        .lifecycle
        .2
        .as_ref()
        .unwrap()
        .1
        .clone();
    drop(reader);
    fail(run(active), Failure::Unavailable);
    assert!(!cwd.exists());
    let s = shared.state.lock().unwrap();
    assert_eq!(s.lifecycle.0, s.lifecycle.1);
    assert_eq!(s.retained, 0);
}
#[test]
fn timeouts_queue_replacement_and_shutdown() {
    let (_dir, c) = fixture("ok");
    let d = Deadlines {
        request: Duration::from_secs(2),
        queue: Duration::from_millis(200),
        ..Deadlines::default()
    };
    let mut reader = Reader::with_deadlines(Some(c), d);
    // Warm hello so queue deadlines test queueing rather than hash/startup load.
    assert!(run(reader.request(request("ok"))).is_ok());
    let mut active = Box::pin(reader.request(request("hang")));
    wait(&reader, |s| s.queue.is_empty());
    let old = reader.request(request("same"));
    let newer = reader.request(request("same"));
    fail(run(old), Failure::Superseded);
    let q2 = reader.request(request("q2"));
    let q3 = reader.request(request("q3"));
    let q4 = reader.request(request("q4"));
    fail(run(reader.request(request("q5"))), Failure::Overloaded);
    for q in [newer, q2, q3, q4] {
        fail(run(q), Failure::TimedOut);
    }
    assert_pending(active.as_mut());
    fail(run(active), Failure::TimedOut);
    assert!(run(reader.request(request("ok"))).is_ok());
    let active = reader.request(request("hang"));
    wait(&reader, |s| s.queue.is_empty());
    let queued = reader.request(request("queued"));
    finish(&mut reader);
    fail(run(active), Failure::Unavailable);
    fail(run(queued), Failure::Unavailable);
}
#[test]
fn startup_timeout_idle_and_cancel() {
    let (_dir, c) = fixture("startup-hang");
    let d = Deadlines {
        startup: Duration::from_secs(2),
        idle: Duration::from_millis(50),
        ..Deadlines::default()
    };
    let mut reader = Reader::with_deadlines(Some(c), d);
    fail(run(reader.request(request("ok"))), Failure::TimedOut);
    finish(&mut reader);
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::with_deadlines(Some(c), d);
    assert!(run(reader.request(request("ok"))).is_ok());
    wait(&reader, |s| s.lifecycle.1 == 1);
    assert!(run(reader.request(request("ok"))).is_ok());
    assert_eq!(reader.shared.state.lock().unwrap().lifecycle.0, 2);
    let active = reader.request(request("hang"));
    wait(&reader, |s| s.queue.is_empty());
    let cancelled = reader.request(request("cancelled"));
    drop(cancelled);
    // Admission also sweeps cancelled tickets.
    let queued = reader.request(request("queued"));
    assert_eq!(reader.shared.state.lock().unwrap().queue.len(), 1);
    finish(&mut reader);
    fail(run(active), Failure::Unavailable);
    fail(run(queued), Failure::Unavailable);
}
#[test]
fn aggregate_retained_limit() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    assert!(run(reader.request(request("ok"))).is_ok());
    let large = |key| {
        let mut r = request(key);
        r.checkpoint = vec![0; wire::UPDATE];
        r.source = vec![0; 2 * 1024 * 1024];
        r
    };
    let active = reader.request(large("hang"));
    wait(&reader, |s| s.queue.is_empty());
    let q1 = reader.request(large("q1"));
    fail(run(reader.request(large("q2"))), Failure::Overloaded);
    let mut oversized = request("too-large");
    oversized.source = vec![0; 2 * 1024 * 1024 + 1];
    fail(run(reader.request(oversized)), Failure::TooLarge);
    finish(&mut reader);
    for q in [active, q1] {
        fail(run(q), Failure::Unavailable);
    }
}
#[test]
fn maximum_transport_request() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    let mut r = request("maximum");
    r.source = vec![b'x'; 2 * 1024 * 1024];
    r.checkpoint = vec![0; wire::UPDATE];
    assert!(
        matches!(run(reader.request(r)),Ok(Outcome::Constructed{proof,..}) if proof.source_byte_length==2*1024*1024)
    );
    finish(&mut reader);
}
fn deadline_result(
    reader: &mut Reader,
    future: impl Future<Output = Result> + Send + 'static,
) -> Result {
    let (send, receive) = std::sync::mpsc::channel();
    let owner = thread::spawn(move || {
        let _ = send.send(run(future));
    });
    let result = receive.recv_timeout(Duration::from_secs(6));
    if result.is_err() {
        reader.shutdown();
    }
    owner.join().unwrap();
    result.expect("deadline handler did not complete the request; shutdown reaped it")
}
#[test]
fn startup_deadline() {
    let (_dir, c) = fixture("startup-hang");
    let mut reader = Reader::with_deadlines(
        Some(c),
        Deadlines {
            startup: Duration::from_secs(3),
            ..Deadlines::default()
        },
    );
    let future = reader.request(request("ok"));
    fail(deadline_result(&mut reader, future), Failure::TimedOut);
    finish(&mut reader);
}
#[test]
fn request_deadline() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::with_deadlines(
        Some(c),
        Deadlines {
            request: Duration::from_millis(100),
            ..Deadlines::default()
        },
    );
    assert!(run(reader.request(request("ok"))).is_ok());
    let future = reader.request(request("hang"));
    fail(deadline_result(&mut reader, future), Failure::TimedOut);
    finish(&mut reader);
}
