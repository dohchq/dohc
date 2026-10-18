use crate::{Config, Failure, Outcome, Request, Shared, expire, session::Session, wire::sha};
use serde_json::Value;
use std::{
    fs::File,
    io::Read,
    process::{Child, Command, Stdio},
    sync::{Arc, mpsc},
    thread::{self, JoinHandle},
    time::Instant,
};
type Event = std::result::Result<Option<Outcome>, Failure>;
pub(super) struct Worker {
    child: Child,
    input: Option<mpsc::Sender<Arc<Request>>>,
    output: mpsc::Receiver<Event>,
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
            bytes.clear();
            File::open(path)
                .map_err(unavailable)?
                .take(cap + 1)
                .read_to_end(&mut bytes)
                .map_err(unavailable)?;
            if bytes.len() as u64 > cap || Some(sha(&bytes).as_str()) != expected.as_str() {
                return Err(Failure::Unavailable);
            }
            if Instant::now() >= deadline {
                return Err(Failure::TimedOut);
            }
        }
        let cwd = tempfile::tempdir().map_err(unavailable)?;
        let mut command = Command::new(&c.node);
        // Windows OpenSSL needs SystemRoot to initialize its OS entropy provider.
        command
            .env_clear()
            .current_dir(cwd.path())
            .arg("--permission")
            .arg(format!("--allow-fs-read={}", c.bundle.display()))
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
        let (input, requests) = mpsc::channel::<Arc<Request>>();
        let (events, output) = mpsc::channel();
        let mut w = Self {
            child,
            input: Some(input),
            output,
            shared: shared.clone(),
            threads: Vec::new(),
            cwd: Some(cwd),
        };
        #[cfg(test)]
        {
            let mut s = shared.state.lock().unwrap();
            s.lifecycle.0 += 1;
            s.lifecycle.2 = Some((w.child.id(), w.cwd.as_ref().unwrap().path().into()));
            shared.wake.notify_all();
        }
        let mut stderr = w.child.stderr.take().unwrap();
        w.threads.push(
            thread::Builder::new()
                .name("reader-stderr".into())
                .spawn(move || {
                    let mut captured = Vec::new();
                    let mut buffer = [0; 4096];
                    while let Ok(n) = stderr.read(&mut buffer) {
                        if n == 0 {
                            break;
                        }
                        captured.extend_from_slice(&buffer[..n.min(16384 - captured.len())]);
                    }
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
    pub fn send(&self, r: Arc<Request>) -> std::result::Result<(), Failure> {
        self.input
            .as_ref()
            .unwrap()
            .send(r)
            .map_err(|_| Failure::Crashed)
    }
    pub fn wait(&self, deadline: Instant) -> Event {
        let mut s = self.shared.state.lock().unwrap();
        loop {
            expire(&mut s);
            if s.closed {
                return Err(Failure::Unavailable);
            }
            if Instant::now() >= deadline {
                return Err(Failure::TimedOut);
            }
            match self.output.try_recv() {
                Ok(event) => return event,
                Err(mpsc::TryRecvError::Disconnected) => return Err(Failure::Crashed),
                Err(mpsc::TryRecvError::Empty) => {}
            }
            let until = s
                .queue
                .iter()
                .map(|p| p.deadline)
                .min()
                .unwrap_or(deadline)
                .min(deadline);
            s = self
                .shared
                .wake
                .wait_timeout(s, until.saturating_duration_since(Instant::now()))
                .unwrap()
                .0;
        }
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
        {
            assert!(self.child.try_wait().unwrap().is_some());
            let mut s = self.shared.state.lock().unwrap();
            s.lifecycle.1 += 1;
            s.lifecycle.2 = None;
            self.shared.wake.notify_all();
        }
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
