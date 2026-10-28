use crate::{Config, Failure, Outcome, PreparationRequest, Shared, session::Session, wire::CHUNK};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::File,
    io::{self, Read},
    process::{Command, Stdio},
    sync::{Arc, mpsc},
    thread::{self, JoinHandle},
    time::Instant,
};
pub(super) type Event = std::result::Result<Option<Outcome>, Failure>;
pub(super) struct Worker {
    child: crate::platform::Process,
    input: Option<mpsc::Sender<PreparationRequest>>,
    pub output: mpsc::Receiver<Event>,
    #[cfg(test)]
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
    cwd: Option<tempfile::TempDir>,
    _assets: Arc<Vec<(std::path::PathBuf, File, std::fs::Metadata)>>,
}
impl Worker {
    pub fn start(
        c: &Config,
        shared: Arc<Shared>,
        deadline: Instant,
    ) -> std::result::Result<Self, Failure> {
        let unavailable = |_| Failure::Unavailable;
        if shared.state.lock().unwrap().closed {
            return Err(Failure::Unavailable);
        }
        if [&c.node, &c.bundle, &c.manifest]
            .iter()
            .any(|p| !p.is_absolute())
        {
            return Err(Failure::Unavailable);
        }
        #[cfg(windows)]
        if c.node
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|s| !s.eq_ignore_ascii_case("exe"))
        {
            return Err(Failure::Unavailable);
        }
        let mut assets = [&c.node, &c.bundle, &c.manifest]
            .into_iter()
            .map(|path| {
                let file = crate::platform::open_asset(path)?;
                let identity = file.metadata()?;
                Ok((path.clone(), file, identity))
            })
            .collect::<io::Result<Vec<_>>>()
            .map_err(unavailable)?;
        let mut bytes = Vec::new();
        (&assets[2].1)
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(unavailable)?;
        if bytes.len() > 256 * 1024 {
            return Err(Failure::Unavailable);
        }
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Unavailable)?;
        {
            let digest =
                crate::wire::sha(&serde_json::to_vec(&manifest).map_err(|_| Failure::Unavailable)?);
            let mut state = shared.state.lock().unwrap();
            if state
                .build_digest
                .as_ref()
                .is_some_and(|held| held != &digest)
            {
                return Err(Failure::Unavailable);
            }
            state.build_digest = Some(digest);
        }
        for (index, expected, cap) in [
            (0, &manifest["runtime"]["sha256"], 256 * 1024 * 1024),
            (1, &manifest["bundleSha256"], 16 * 1024 * 1024),
        ] {
            if Some(file_sha(&mut assets[index].1, cap, deadline)?.as_str()) != expected.as_str() {
                return Err(Failure::Unavailable);
            }
        }
        #[cfg(test)]
        crate::tests::after_hash(c);
        check_assets(&assets)?;
        let assets = Arc::new(assets);
        let checked_assets = assets.clone();
        let cwd = tempfile::tempdir().map_err(unavailable)?;
        let mut command = Command::new(&c.node);
        let mut read_grant = OsString::from("--allow-fs-read=");
        read_grant.push(&c.bundle);
        // Windows OpenSSL needs SystemRoot to initialize its OS entropy provider.
        command
            .env_clear()
            .current_dir(cwd.path())
            .arg("--permission")
            .arg(read_grant)
            .arg("--max-old-space-size=256")
            .arg(&c.bundle)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.env(
            "SystemRoot",
            std::env::var_os("SystemRoot").ok_or(Failure::Unavailable)?,
        );
        let (child, stdout, stdin, mut stderr) =
            crate::platform::spawn(&mut command).map_err(unavailable)?;
        let (input, requests) = mpsc::channel::<PreparationRequest>();
        let (events, output) = mpsc::channel();
        let mut w = Self {
            child,
            input: Some(input),
            output,
            #[cfg(test)]
            shared: shared.clone(),
            threads: Vec::new(),
            cwd: Some(cwd),
            _assets: assets,
        };
        #[cfg(test)]
        crate::tests::started(&shared, w.child.id(), w.cwd.as_ref().unwrap().path());
        w.threads.push(
            thread::Builder::new()
                .name("reader-stderr".into())
                .spawn(move || {
                    let _ = io::copy(&mut stderr, &mut io::sink());
                })
                .map_err(unavailable)?,
        );
        let mut session = Session::new(stdout, stdin, manifest);
        w.threads.push(
            thread::Builder::new()
                .name("reader-pipes".into())
                .spawn(move || {
                    let send = |event| {
                        let _guard = shared.state.lock().unwrap();
                        let _ = events.send(event);
                        shared.wake.notify_all();
                    };
                    match session.hello().and_then(|()| check_assets(&checked_assets)) {
                        Ok(()) => send(Ok(None)),
                        Err(failure) => {
                            send(Err(failure));
                            return;
                        }
                    }
                    while let Ok(request) = requests.recv() {
                        let result = session.prepare(&request);
                        drop(request);
                        let failed = result.is_err();
                        send(result.map(Some));
                        if failed {
                            break;
                        }
                    }
                })
                .map_err(unavailable)?,
        );
        Ok(w)
    }
    pub fn send(&self, r: PreparationRequest) -> std::result::Result<(), Failure> {
        self.input
            .as_ref()
            .unwrap()
            .send(r)
            .map_err(|_| Failure::Crashed)
    }
}
fn file_sha(file: &mut File, cap: u64, deadline: Instant) -> std::result::Result<String, Failure> {
    let mut file = file.take(cap + 1);
    let mut hasher = Sha256::new();
    let mut buffer = [0; CHUNK];
    let mut length = 0;
    loop {
        let n = file.read(&mut buffer).map_err(|_| Failure::Unavailable)?;
        if n == 0 {
            return Ok(hasher
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect());
        }
        length += n as u64;
        if length > cap {
            return Err(Failure::Unavailable);
        }
        if Instant::now() >= deadline {
            return Err(Failure::TimedOut);
        }
        hasher.update(&buffer[..n]);
    }
}
#[cfg(test)]
#[test]
fn asset_hash_timeout_is_transient_but_an_oversized_asset_is_unavailable() {
    use std::io::{Seek, Write};
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(b"asset").unwrap();
    file.rewind().unwrap();
    assert_eq!(file_sha(&mut file, 5, Instant::now()), Err(Failure::TimedOut));
    file.rewind().unwrap();
    assert_eq!(
        file_sha(&mut file, 4, Instant::now()),
        Err(Failure::Unavailable)
    );
}
fn check_assets(
    assets: &[(std::path::PathBuf, File, std::fs::Metadata)],
) -> std::result::Result<(), Failure> {
    for (path, _file, held) in assets {
        let current_file = crate::platform::open_asset(path).map_err(|_| Failure::Unavailable)?;
        let current = current_file.metadata().map_err(|_| Failure::Unavailable)?;
        #[cfg(windows)]
        if crate::platform::asset_identity(_file).map_err(|_| Failure::Unavailable)?
            != crate::platform::asset_identity(&current_file).map_err(|_| Failure::Unavailable)?
        {
            return Err(Failure::Unavailable);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if (held.dev(), held.ino(), held.ctime(), held.ctime_nsec())
                != (
                    current.dev(),
                    current.ino(),
                    current.ctime(),
                    current.ctime_nsec(),
                )
            {
                return Err(Failure::Unavailable);
            }
        }
        if held.len() != current.len() || held.modified().ok() != current.modified().ok() {
            return Err(Failure::Unavailable);
        }
    }
    Ok(())
}
#[cfg(all(test, windows))]
#[test]
fn equal_metadata_cannot_hide_a_different_file_identity() {
    let directory = tempfile::tempdir().unwrap();
    let held_path = directory.path().join("held");
    let current_path = directory.path().join("current");
    let modified =
        std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    for path in [&held_path, &current_path] {
        std::fs::write(path, "same bytes").unwrap();
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }
    let file = crate::platform::open_asset(&held_path).unwrap();
    let held = file.metadata().unwrap();
    let current = std::fs::metadata(&current_path).unwrap();
    assert_eq!(held.len(), current.len());
    assert_eq!(held.modified().unwrap(), current.modified().unwrap());
    assert!(matches!(
        check_assets(&[(current_path, file, held)]),
        Err(Failure::Unavailable)
    ));
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.child.terminate();
        drop(self.input.take());
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
        drop(self.cwd.take());
        #[cfg(test)]
        crate::tests::reaped(&self.shared);
    }
}
