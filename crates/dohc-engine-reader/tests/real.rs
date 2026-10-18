// Included by the unit harness for lifecycle assertions; not a separate test target.
use super::*;
fn directory() -> PathBuf {
    std::env::var_os("DOHC_READER_FIXTURES")
        .expect("run tests/prepare.mjs; set DOHC_READER_FIXTURES")
        .into()
}
fn config() -> Config {
    Config {
        node: runtime().0,
        bundle: directory().join("bundle/reader.cjs"),
        manifest: directory().join("bundle/manifest.json"),
    }
}
fn input(name: &str, proof: bool) -> Request {
    let mut r = request("note.md");
    r.document.main_version_id = "main".into();
    r.document.object_id = "fixture".into();
    r.source = fs::read(directory().join(format!("{name}.source"))).unwrap();
    r.checkpoint = fs::read(directory().join(format!(
        "{name}.{}",
        if proof { "proof" } else { "checkpoint" }
    )))
    .unwrap();
    r.method = if proof {
        Method::Prove
    } else {
        Method::Construct
    };
    r
}
#[test]
#[ignore = "requires the built bundle and generated fixtures"]
fn real_boundaries() {
    let mut reader = Reader::new(Some(config()));
    for name in ["note", "bom", "warm", "largest"] {
        let r = input(name, false);
        let length = r.source.len();
        let sha = wire::sha(&r.source);
        let result = run(reader.request(r));
        let Ok(Outcome::Constructed { proof, delta }) = result else {
            panic!("{name}: {result:?}")
        };
        assert_eq!(proof.source_sha256, sha);
        assert_eq!(proof.source_byte_length, length);
        assert!(!delta.is_empty());
        let result = run(reader.request(input(name, true)));
        let Ok(Outcome::Proved(proof)) = result else {
            panic!("{name}: {result:?}")
        };
        assert_eq!(proof.source_sha256, sha);
        assert_eq!(proof.source_byte_length, length);
    }
    let mut forged = input("note", true);
    forged.checkpoint = fs::read(directory().join("note.forged")).unwrap();
    assert!(matches!(
        run(reader.request(forged)),
        Ok(Outcome::Refused(_))
    ));
    let mut invalid = input("note", false);
    invalid.source = vec![255];
    assert!(
        matches!(run(reader.request(invalid)),Ok(Outcome::Refused(reason)) if reason=="invalid-source")
    );
    finish(&mut reader);
}
#[test]
#[ignore = "release startup-check and real idle-retirement measurement"]
fn checks_and_retirement() {
    affinity();
    use std::io::Read;
    let c = config();
    let mut checks = Vec::new();
    // Mirror the startup reads/hashes without spawning a child. No production instrumentation.
    for _ in 0..31 {
        let start = Instant::now();
        let mut bytes = Vec::new();
        fs::File::open(&c.manifest)
            .unwrap()
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        let manifest: Value = serde_json::from_slice(&bytes).unwrap();
        for (path, expected, cap) in [
            (&c.node, &manifest["runtime"]["sha256"], 256 * 1024 * 1024),
            (&c.bundle, &manifest["bundleSha256"], 16 * 1024 * 1024),
        ] {
            bytes.clear();
            fs::File::open(path)
                .unwrap()
                .take(cap + 1)
                .read_to_end(&mut bytes)
                .unwrap();
            assert_eq!(wire::sha(&bytes), expected.as_str().unwrap());
        }
        checks.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let mut reader = Reader::new(Some(c));
    assert!(run(reader.request(input("note", false))).is_ok());
    let start = Instant::now();
    let (pid, cwd) = reader
        .shared
        .state
        .lock()
        .unwrap()
        .lifecycle
        .2
        .clone()
        .unwrap();
    let mut s = reader.shared.state.lock().unwrap();
    while s.lifecycle.2.is_some() {
        let (next, timed) = reader
            .shared
            .wake
            .wait_timeout(s, Duration::from_secs(40))
            .unwrap();
        s = next;
        assert!(!timed.timed_out() || s.lifecycle.2.is_none());
    }
    drop(s);
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    assert!(!cwd.exists());
    #[cfg(windows)]
    {
        let output = Command::new(
            PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        )
        .args([
            "-NoProfile",
            "-Command",
            &format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }}"),
        ])
        .output()
        .unwrap();
        assert!(output.status.success());
    }
    finish(&mut reader);
    fs::write(directory().join("checks-retirement.json"),serde_json::to_vec_pretty(&json!({"checksMs":checks,"retiredMs":elapsed,"reapedPid":pid,"childCpuAfterRetirement":0,"childMemoryAfterRetirement":0})).unwrap()).unwrap();
}
#[test]
#[ignore = "release measurement; requires the built bundle and generated fixtures"]
fn measure() {
    affinity();
    let config = config();
    let mut cold = Vec::new();
    for _ in 0..31 {
        let shared = Arc::new(Shared::default());
        let start = Instant::now();
        let worker =
            process::Worker::start(&config, shared.clone(), start + Duration::from_secs(5))
                .unwrap();
        assert!(
            worker
                .wait(start + Duration::from_secs(5))
                .unwrap()
                .is_none()
        );
        cold.push(start.elapsed().as_secs_f64() * 1000.0);
        drop(worker);
        assert_eq!(shared.state.lock().unwrap().lifecycle.1, 1);
    }
    let mut reader = Reader::new(Some(config));
    let mut construct = Vec::new();
    let mut prove = Vec::new();
    let mut largest = Vec::new();
    let mut error = Vec::new();
    let mut saturation = Vec::new();
    // Warm the bundle and JIT before alternating construct and prove.
    for _ in 0..3 {
        assert!(run(reader.request(input("warm", false))).is_ok());
        assert!(run(reader.request(input("warm", true))).is_ok());
    }
    for round in 0..31 {
        for proof in if round % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let r = input("warm", proof);
            let start = Instant::now();
            let result = run(reader.request(r));
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            assert!(matches!(
                result,
                Ok(Outcome::Constructed { .. }) | Ok(Outcome::Proved(_))
            ));
            if proof {
                prove.push(ms)
            } else {
                construct.push(ms)
            }
        }
        let r = input("largest", false);
        let start = Instant::now();
        let result = run(reader.request(r));
        assert!(
            matches!(result, Ok(Outcome::Constructed { .. })),
            "{result:?}"
        );
        largest.push(start.elapsed().as_secs_f64() * 1000.0);
        let mut r = input("note", false);
        r.source = vec![255];
        let start = Instant::now();
        assert!(matches!(run(reader.request(r)), Ok(Outcome::Refused(_))));
        error.push(start.elapsed().as_secs_f64() * 1000.0);
        let start = Instant::now();
        let active = reader.request(input("warm", false));
        wait(&reader, |s| s.queue.is_empty());
        let mut queued = Vec::new();
        for i in 0..4 {
            let mut r = input("warm", false);
            r.document.object_id = format!("queue{i}");
            queued.push(reader.request(r));
        }
        let mut extra = input("warm", false);
        extra.document.object_id = "extra".into();
        fail(run(reader.request(extra)), Failure::Overloaded);
        assert!(run(active).is_ok());
        for q in queued {
            assert!(run(q).is_ok());
        }
        saturation.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    finish(&mut reader);
    let all = json!({"cold":cold,"construct":construct,"prove":prove,"largest":largest,"error":error,"saturation":saturation});
    fs::write(
        directory().join("measurements.json"),
        serde_json::to_vec_pretty(&all).unwrap(),
    )
    .unwrap();
    for (name, values) in all.as_object().unwrap() {
        let mut v: Vec<f64> = values
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        v.sort_by(f64::total_cmp);
        println!(
            "{name}: n={} median={:.3} p95={:.3} ms",
            v.len(),
            v[v.len() / 2],
            v[(v.len() * 95).div_ceil(100) - 1]
        );
    }
}

fn affinity() {
    #[cfg(windows)]
    assert!(
        Command::new(
            PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe")
        )
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "(Get-Process -Id {}).ProcessorAffinity = 3840",
                std::process::id()
            )
        ])
        .status()
        .unwrap()
        .success()
    );
}
