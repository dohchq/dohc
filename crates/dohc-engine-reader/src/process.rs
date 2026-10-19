use crate::{Config, Failure, Outcome, Request, Shared, session::Session, wire::CHUNK};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::File,
    io::{self, Read},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, mpsc},
    thread::{self, JoinHandle},
    time::Instant,
};
pub(super) type Event = std::result::Result<Option<Outcome>, Failure>;
pub(super) struct Worker {
    child: Child,
    input: Option<mpsc::Sender<Request>>,
    pub output: mpsc::Receiver<Event>,
    #[cfg(test)]
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
    cwd: Option<tempfile::TempDir>,
}
impl Worker {
    pub fn start(
        c: &Config,
        shared: Arc<Shared>,
        deadline: Instant,
    ) -> std::result::Result<Self, Failure> {
        let unavailable = |_| Failure::Unavailable;
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
        let mut bytes = Vec::new();
        File::open(&c.manifest)
            .map_err(unavailable)?
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(unavailable)?;
        if bytes.len() > 256 * 1024 {
            return Err(Failure::Unavailable);
        }
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Unavailable)?;
        for (path, expected, cap) in [
            (&c.node, &manifest["runtime"]["sha256"], 256 * 1024 * 1024),
            (&c.bundle, &manifest["bundleSha256"], 16 * 1024 * 1024),
        ] {
            if Some(file_sha(path, cap, deadline)?.as_str()) != expected.as_str() {
                return Err(Failure::Unavailable);
            }
        }
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
        prepare(&mut command);
        let child = command.spawn().map_err(unavailable)?;
        let (input, requests) = mpsc::channel::<Request>();
        let (events, output) = mpsc::channel();
        let mut w = Self {
            child,
            input: Some(input),
            output,
            #[cfg(test)]
            shared: shared.clone(),
            threads: Vec::new(),
            cwd: Some(cwd),
        };
        #[cfg(test)]
        crate::tests::started(&shared, w.child.id(), w.cwd.as_ref().unwrap().path());
        let mut stderr = w.child.stderr.take().unwrap();
        w.threads.push(
            thread::Builder::new()
                .name("reader-stderr".into())
                .spawn(move || {
                    let _ = io::copy(&mut stderr, &mut io::sink());
                })
                .map_err(unavailable)?,
        );
        let mut session = Session::new(
            w.child.stdout.take().unwrap(),
            w.child.stdin.take().unwrap(),
            manifest,
        );
        w.threads.push(
            thread::Builder::new()
                .name("reader-pipes".into())
                .spawn(move || {
                    let send = |event| {
                        let _guard = shared.state.lock().unwrap();
                        let _ = events.send(event);
                        shared.wake.notify_all();
                    };
                    match session.hello() {
                        Ok(()) => send(Ok(None)),
                        Err(_) => {
                            send(Err(Failure::Unavailable));
                            return;
                        }
                    }
                    while let Ok(request) = requests.recv() {
                        let result = session.execute(&request);
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
    pub fn send(&self, r: Request) -> std::result::Result<(), Failure> {
        self.input
            .as_ref()
            .unwrap()
            .send(r)
            .map_err(|_| Failure::Crashed)
    }
}
fn file_sha(path: &Path, cap: u64, deadline: Instant) -> std::result::Result<String, Failure> {
    let mut file = File::open(path)
        .map_err(|_| Failure::Unavailable)?
        .take(cap + 1);
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
        if length > cap || Instant::now() >= deadline {
            return Err(Failure::Unavailable);
        }
        hasher.update(&buffer[..n]);
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        // PR 3c extends this owner with Job/group attach and group termination.
        let _ = self.child.kill();
        let _ = self.child.wait();
        drop(self.input.take());
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
        drop(self.cwd.take());
        #[cfg(test)]
        crate::tests::reaped(&self.shared, &mut self.child);
    }
}
fn prepare(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}
