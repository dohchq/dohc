use super::*;

thread_local! { static REPLACE: std::cell::Cell<usize> = const { std::cell::Cell::new(usize::MAX) }; }
pub(super) fn after_hash(config: &Config) {
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
        if index == 0 {
            fs::hard_link(std::env::current_exe().unwrap(), path).unwrap();
        } else {
            fs::write(path, "changed after hash").unwrap();
        }
    }
}

#[test]
fn replacement_after_hash_is_blocked_or_refused_before_spawn() {
    for index in 0..3 {
        let (dir, mut c) = fixture("ok");
        if index == 0 {
            let alias = dir.path().join("runtime.exe");
            let executable = std::env::current_exe().unwrap();
            fs::hard_link(&executable, &alias).unwrap();
            let mut manifest: Value =
                serde_json::from_slice(&fs::read(&c.manifest).unwrap()).unwrap();
            manifest["runtime"]["sha256"] = wire::sha(&fs::read(&executable).unwrap()).into();
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
