use super::*;
use serde_json::{Value, json};
use std::{fs, process::Command, sync::OnceLock};
#[path = "../tests/real.rs"]
mod real;

fn runtime() -> (PathBuf, Value) {
    static RUNTIME: OnceLock<(PathBuf, Value)> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        let output = Command::new("node").args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
        assert!(output.status.success());
        let mut v: Value = serde_json::from_slice(&output.stdout).unwrap();
        let node = PathBuf::from(v.as_object_mut().unwrap().remove("path").unwrap().as_str().unwrap());
        v["sha256"] = wire::sha(&fs::read(&node).unwrap()).into();
        (node, v)
    }).clone()
}
fn fixture(mode: &str) -> (tempfile::TempDir, Config) {
    let dir = tempfile::tempdir().unwrap();
    let (node, runtime) = runtime();
    let identity = json!({"version":1,"runtime":runtime,"buildSha256":"test"});
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

#[test]
fn missing_and_identity() {
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
        "startup-crash",
    ] {
        let (_dir, mut c) = fixture(fault);
        match fault {
            "relative" => c.bundle = "reader.cjs".into(),
            "runtime" => c.node = c.node.with_extension("absent"),
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
reply_fault!(returned_sha, "sha");
reply_fault!(returned_length, "length");
reply_fault!(obsolete_flag_rejected, "obsolete-flag");
reply_fault!(eof_before_delta, "eof-delta");
reply_fault!(truncated_delta, "truncated-delta");
reply_fault!(eof_before_end, "eof-end");
reply_fault!(truncated_end, "truncated-end");
reply_fault!(end_id, "end-id");
reply_fault!(response_id, "id");
reply_fault!(response_kind, "kind");
reply_fault!(response_fields, "extra");
reply_fault!(delta_digest, "delta");
reply_fault!(delta_limit, "declaration");
reply_fault!(malformed_frame, "malformed");
reply_fault!(oversize_frame, "oversize");

#[test]
fn reviewed_protocol_success() {
    let (_dir, c) = fixture("ok");
    let mut reader = Reader::new(Some(c));
    assert!(matches!(
        run(reader.request(request("ok"))),
        Ok(Outcome::Constructed { .. })
    ));
    let mut prove = request("ok");
    prove.method = Method::Prove;
    assert!(matches!(run(reader.request(prove)), Ok(Outcome::Proved(_))));
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
    let active = reader.request(request("hang"));
    wait(&reader, |s| s.queue.is_empty());
    let old = reader.request(request("same"));
    let newer = reader.request(request("same"));
    fail(run(old), Failure::Overloaded);
    let q2 = reader.request(request("q2"));
    let q3 = reader.request(request("q3"));
    let q4 = reader.request(request("q4"));
    fail(run(reader.request(request("q5"))), Failure::Overloaded);
    for q in [newer, q2, q3, q4] {
        fail(run(q), Failure::TimedOut);
    }
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
    let active = reader.request(request("hang"));
    wait(&reader, |s| s.queue.is_empty());
    let large = |key| {
        let mut r = request(key);
        r.checkpoint = vec![0; wire::UPDATE];
        r.source = vec![0; 2 * 1024 * 1024];
        r
    };
    let q1 = reader.request(large("q1"));
    let q2 = reader.request(large("q2"));
    fail(run(reader.request(large("q3"))), Failure::Overloaded);
    let mut oversized = request("too-large");
    oversized.source = vec![0; 2 * 1024 * 1024 + 1];
    fail(run(reader.request(oversized)), Failure::Overloaded);
    finish(&mut reader);
    for q in [active, q1, q2] {
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
