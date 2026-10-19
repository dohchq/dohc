use super::*;

thread_local! {
    static REPLACE: std::cell::Cell<usize> = const { std::cell::Cell::new(usize::MAX) };
    static START_REPLACE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    #[cfg(windows)]
    static DIRECTORY_REPLACE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
pub(super) fn started() {
    if let Some(path) = START_REPLACE.take() {
        fs::rename(&path, path.with_extension("old")).unwrap();
        fs::copy(path.with_extension("old"), &path).unwrap();
    }
}
pub(super) fn after_hash(config: &Config) {
    #[cfg(windows)]
    if DIRECTORY_REPLACE.replace(false) {
        let directory = config.bundle.parent().unwrap();
        let old = directory.with_extension("old");
        if fs::rename(directory, &old).is_ok() {
            fs::create_dir(directory).unwrap();
            for name in fs::read_dir(&old).unwrap() {
                let path = name.unwrap().path();
                let replacement = directory.join(path.file_name().unwrap());
                fs::copy(&path, &replacement).unwrap();
                let modified = fs::metadata(path).unwrap().modified().unwrap();
                fs::File::options()
                    .write(true)
                    .open(replacement)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(modified))
                    .unwrap();
            }
        }
    }
    let index = REPLACE.replace(usize::MAX);
    if index == usize::MAX {
        return;
    }
    let path = [&config.node, &config.bundle, &config.manifest][index];
    #[cfg(windows)]
    {
        if index != 0 {
            assert!(fs::write(path, "changed after hash").is_err());
        }
        assert!(fs::rename(path, path.with_extension("old")).is_err());
    }
    #[cfg(unix)]
    {
        fs::rename(path, path.with_extension("old")).unwrap();
        // The runtime's replacement still runs, so a missing check would start it.
        if index == 0 {
            executable(path, "exit 1");
        } else {
            fs::write(path, "changed after hash").unwrap();
        }
    }
}
#[cfg(unix)]
fn executable(path: &std::path::Path, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    fs::write(path, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn post_hello_asset_replacement_is_unavailable() {
    let (_dir, c) = fixture("ok");
    START_REPLACE.set(Some(c.manifest.clone()));
    let worker = process::Worker::start(
        &c,
        Arc::new(Shared::default()),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    START_REPLACE.with_borrow(|path| assert!(path.is_none(), "started hook must run"));
    // The fake reader embeds its manifest, so replacing this file cannot break hello.
    assert!(matches!(
        worker.output.recv_timeout(Duration::from_secs(10)).unwrap(),
        Err(Failure::Unavailable)
    ));
}

#[cfg(windows)]
#[test]
fn renamed_generation_or_compiler_directory_is_blocked_or_detected() {
    for runtime in [false, true] {
        let (dir, mut c) = fixture("ok");
        let directory = dir.path().join(if runtime {
            "app-compiler"
        } else {
            "generation"
        });
        fs::create_dir(&directory).unwrap();
        if runtime {
            let node = directory.join("node.exe");
            fs::copy(&c.node, &node).unwrap();
            c.node = node;
            // The hook selects this parent, irrespective of which asset lives there.
            fs::rename(&c.bundle, directory.join("fake.cjs")).unwrap();
            c.bundle = directory.join("fake.cjs");
        } else {
            for path in [&mut c.bundle, &mut c.manifest] {
                let target = directory.join(path.file_name().unwrap());
                fs::rename(&*path, &target).unwrap();
                *path = target;
            }
        }
        DIRECTORY_REPLACE.set(true);
        let result = process::Worker::start(
            &c,
            Arc::new(Shared::default()),
            Instant::now() + Duration::from_secs(30),
        );
        assert!(!DIRECTORY_REPLACE.get());
        if directory.with_extension("old").exists() {
            assert!(matches!(result, Err(Failure::Unavailable)));
        } else {
            assert!(result.is_ok(), "OS denied directory replacement");
        }
        drop(result);
    }
}

#[cfg(unix)]
#[test]
fn writable_ancestor_is_refused_even_with_a_protected_generation() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, mut c) = fixture("ok");
    let generation = dir.path().join("generation");
    fs::create_dir(&generation).unwrap();
    for path in [&mut c.bundle, &mut c.manifest] {
        let target = generation.join(path.file_name().unwrap());
        fs::rename(&*path, &target).unwrap();
        *path = target;
    }
    for mode in [0o770, 0o1770] {
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(mode)).unwrap();
        assert!(matches!(
            process::Worker::start(
                &c,
                Arc::new(Shared::default()),
                Instant::now() + Duration::from_secs(30)
            ),
            Err(Failure::Unavailable)
        ));
    }
}

#[test]
fn replacement_after_hash_is_blocked_or_refused_before_spawn() {
    for index in 0..3 {
        let (dir, mut c) = fixture("ok");
        if index == 0 {
            let alias = dir.path().join("runtime.exe");
            // Not a link to this test's executable on Unix: macOS Gatekeeper kills a test that
            // starts while such a link is renamed or removed.
            #[cfg(windows)]
            fs::hard_link(std::env::current_exe().unwrap(), &alias).unwrap();
            #[cfg(unix)]
            executable(&alias, "exit 0");
            let mut manifest: Value =
                serde_json::from_slice(&fs::read(&c.manifest).unwrap()).unwrap();
            manifest["runtime"]["sha256"] = wire::sha(&fs::read(&alias).unwrap()).into();
            fs::write(&c.manifest, manifest.to_string()).unwrap();
            c.node = alias;
        }
        let shared = Arc::new(Shared::default());
        REPLACE.set(index);
        let worker =
            process::Worker::start(&c, shared.clone(), Instant::now() + Duration::from_secs(30));
        assert_eq!(REPLACE.get(), usize::MAX, "the after-hash fault must run");
        #[cfg(windows)]
        assert!(worker.is_ok());
        #[cfg(unix)]
        {
            assert!(matches!(worker, Err(Failure::Unavailable)));
            assert_eq!(shared.state.lock().unwrap().lifecycle.0, 0);
        }
        drop(worker);
    }
}

#[test]
fn closure_rejects_directory_and_missing_assets_before_spawn() {
    for asset in 0..3 {
        for directory in [false, true] {
            let (dir, mut c) = fixture("ok");
            let bad = dir.path().join("absent.exe");
            if directory {
                fs::create_dir(&bad).unwrap();
            }
            match asset {
                0 => c.node = bad,
                1 => c.bundle = bad,
                _ => c.manifest = bad,
            }
            let shared = Arc::new(Shared::default());
            assert!(matches!(
                process::Worker::start(
                    &c,
                    shared.clone(),
                    Instant::now() + Duration::from_secs(30)
                ),
                Err(Failure::Unavailable)
            ));
            assert_eq!(shared.state.lock().unwrap().lifecycle.0, 0);
        }
    }
}

#[cfg(unix)]
#[test]
fn closure_rejects_symlinks_before_spawn() {
    for asset in 0..3 {
        let (dir, mut c) = fixture("ok");
        let path = [&c.node, &c.bundle, &c.manifest][asset];
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(path, &link).unwrap();
        match asset {
            0 => c.node = link,
            1 => c.bundle = link,
            _ => c.manifest = link,
        }
        let shared = Arc::new(Shared::default());
        assert!(matches!(
            process::Worker::start(&c, shared.clone(), Instant::now() + Duration::from_secs(30)),
            Err(Failure::Unavailable)
        ));
        assert_eq!(shared.state.lock().unwrap().lifecycle.0, 0);
    }
}

#[cfg(unix)]
#[test]
fn closure_rejects_fifo_and_device_before_spawn() {
    for asset in 0..3 {
        for fifo in [false, true] {
            let (dir, mut c) = fixture("ok");
            let bad = if fifo {
                dir.path().join("fifo")
            } else {
                PathBuf::from("/dev/null")
            };
            if fifo {
                assert!(Command::new("mkfifo").arg(&bad).status().unwrap().success());
            }
            match asset {
                0 => c.node = bad,
                1 => c.bundle = bad,
                _ => c.manifest = bad,
            }
            let shared = Arc::new(Shared::default());
            let start = Instant::now();
            assert!(matches!(
                process::Worker::start(&c, shared.clone(), start + Duration::from_secs(30)),
                Err(Failure::Unavailable)
            ));
            assert!(start.elapsed() < Duration::from_secs(1));
            assert_eq!(shared.state.lock().unwrap().lifecycle.0, 0);
        }
    }
}

#[cfg(unix)]
#[test]
fn closure_rejects_untrusted_writers_before_spawn() {
    use std::os::unix::fs::PermissionsExt;
    for directory in [false, true] {
        let (dir, c) = fixture("ok");
        let path = if directory { dir.path() } else { &c.bundle };
        fs::set_permissions(path, fs::Permissions::from_mode(0o777)).unwrap();
        let shared = Arc::new(Shared::default());
        assert!(matches!(
            process::Worker::start(&c, shared.clone(), Instant::now() + Duration::from_secs(30)),
            Err(Failure::Unavailable)
        ));
        assert_eq!(shared.state.lock().unwrap().lifecycle.0, 0);
    }
}

#[test]
fn closure_rejects_a_linked_parent_before_spawn() {
    let (dir, mut c) = fixture("ok");
    let link = dir.path().join("linked");
    #[cfg(windows)]
    assert!(
        Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(dir.path())
            .output()
            .unwrap()
            .status
            .success()
    );
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir.path(), &link).unwrap();
    c.bundle = link.join("fake.cjs");
    let shared = Arc::new(Shared::default());
    assert!(matches!(
        process::Worker::start(&c, shared.clone(), Instant::now() + Duration::from_secs(30)),
        Err(Failure::Unavailable)
    ));
    assert_eq!(shared.state.lock().unwrap().lifecycle.0, 0);
}
