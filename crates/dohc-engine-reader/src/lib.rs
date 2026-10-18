//! Fixed Markdown reader process. Configuration belongs to trusted engine startup.
mod process;
mod session;
mod wire;
use serde::Serialize;
use std::{
    collections::VecDeque,
    future::Future,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

/// Absolute paths supplied by the host, never a renderer or workspace field.
#[derive(Clone)]
pub struct Config {
    pub node: PathBuf,
    pub bundle: PathBuf,
    pub manifest: PathBuf,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Unavailable,
    TimedOut,
    Overloaded,
    Crashed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub workspace_id: String,
    pub main_version_id: String,
    pub object_id: String,
    pub lineage_claim_id: String,
}
#[derive(Clone, Copy)]
pub enum Method {
    Construct,
    Prove,
}
pub struct Request {
    pub method: Method,
    pub document: Document,
    pub current_path: String,
    pub source: Vec<u8>,
    pub checkpoint: Vec<u8>,
}
impl Request {
    fn retained(&self) -> usize {
        self.source.capacity()
            + self.checkpoint.capacity()
            + self.current_path.capacity()
            + self.document.workspace_id.capacity()
            + self.document.main_version_id.capacity()
            + self.document.object_id.capacity()
            + self.document.lineage_claim_id.capacity()
    }
}
/// Created after a complete, byte-bound success from the journal-validating host.
#[derive(Debug)]
#[non_exhaustive]
pub struct Proof {
    pub source_sha256: String,
    pub source_byte_length: usize,
    pub projection_sha256: String,
    pub state_sha256: String,
}
#[derive(Debug)]
pub enum Outcome {
    Constructed { proof: Proof, delta: Vec<u8> },
    Proved(Proof),
    Refused(String),
}
pub type Result = std::result::Result<Outcome, Failure>;
struct Pending {
    request: Arc<Request>,
    deadline: Instant,
    reply: oneshot::Sender<Result>,
}
#[derive(Default)]
struct State {
    queue: VecDeque<Pending>,
    retained: usize,
    closed: bool,
    #[cfg(test)]
    lifecycle: (usize, usize, Option<(u32, PathBuf)>),
}
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}
#[derive(Clone, Copy)]
struct Deadlines {
    startup: Duration,
    request: Duration,
    queue: Duration,
    idle: Duration,
}
impl Default for Deadlines {
    fn default() -> Self {
        Self {
            startup: Duration::from_secs(5),
            request: Duration::from_secs(10),
            queue: Duration::from_secs(10),
            idle: Duration::from_secs(30),
        }
    }
}
pub struct Reader {
    shared: Arc<Shared>,
    owner: Option<JoinHandle<()>>,
    deadlines: Deadlines,
}
impl Reader {
    /// Creates an idle owner thread; the child starts with the first request.
    pub fn new(config: Option<Config>) -> Self {
        Self::with_deadlines(config, Deadlines::default())
    }
    fn with_deadlines(config: Option<Config>, deadlines: Deadlines) -> Self {
        let shared = Arc::new(Shared::default());
        let owned = shared.clone();
        let owner = thread::Builder::new()
            .name("markdown-reader".into())
            .spawn(move || drive(owned, config, deadlines))
            .ok();
        shared.state.lock().unwrap().closed = owner.is_none();
        Self {
            shared,
            owner,
            deadlines,
        }
    }
    /// Admission is immediate. Dropping the returned future cancels queued work.
    pub fn request(&self, request: Request) -> impl Future<Output = Result> + Send + use<> {
        let (reply, receiver) = oneshot::channel();
        let mut s = self.shared.state.lock().unwrap();
        expire(&mut s);
        let bytes = request.retained();
        let failure = if s.closed {
            Some(Failure::Unavailable)
        } else if request.source.len() > 2 * 1024 * 1024
            || request.checkpoint.len() > wire::UPDATE
            || bytes > 64 * 1024 * 1024
        {
            Some(Failure::Overloaded)
        } else {
            None
        };
        if let Some(failure) = failure {
            let _ = reply.send(Err(failure));
        } else {
            if let Some(i) = s
                .queue
                .iter()
                .position(|p| p.request.document == request.document)
            {
                let old = s.queue.remove(i).unwrap();
                s.retained -= old.request.retained();
                let _ = old.reply.send(Err(Failure::Overloaded));
            }
            if s.queue.len() >= 4 || s.retained + bytes > 64 * 1024 * 1024 {
                let _ = reply.send(Err(Failure::Overloaded));
            } else {
                s.retained += bytes;
                s.queue.push_back(Pending {
                    request: Arc::new(request),
                    deadline: Instant::now() + self.deadlines.queue,
                    reply,
                });
                self.shared.wake.notify_one();
            }
        }
        async move { receiver.await.unwrap_or(Err(Failure::Unavailable)) }
    }
    /// Synchronously kills, reaps, and joins owned pipe threads. No runtime is needed.
    pub fn shutdown(&mut self) {
        self.shared.state.lock().unwrap().closed = true;
        self.shared.wake.notify_one();
        if let Some(owner) = self.owner.take() {
            let _ = owner.join();
        }
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn expire(s: &mut State) {
    let mut i = 0;
    while i < s.queue.len() {
        if s.closed || s.queue[i].reply.is_closed() || s.queue[i].deadline <= Instant::now() {
            let p = s.queue.remove(i).unwrap();
            s.retained -= p.request.retained();
            let _ = p.reply.send(Err(if s.closed {
                Failure::Unavailable
            } else {
                Failure::TimedOut
            }));
        } else {
            i += 1;
        }
    }
}
fn drive(shared: Arc<Shared>, config: Option<Config>, d: Deadlines) {
    let mut worker: Option<process::Worker> = None;
    loop {
        let p = {
            let mut s = shared.state.lock().unwrap();
            expire(&mut s);
            if s.closed {
                break;
            }
            let p = s.queue.pop_front();
            #[cfg(test)]
            shared.wake.notify_all();
            p
        };
        let Some(p) = p else {
            let s = shared.state.lock().unwrap();
            if s.closed || !s.queue.is_empty() {
                continue;
            }
            let (s, idle) = shared.wake.wait_timeout(s, d.idle).unwrap();
            drop(s);
            if idle.timed_out() {
                drop(worker.take());
            }
            continue;
        };
        let result = (|| {
            if worker.is_none() {
                let deadline = Instant::now() + d.startup;
                worker = Some(process::Worker::start(
                    config.as_ref().ok_or(Failure::Unavailable)?,
                    shared.clone(),
                    deadline,
                )?);
                worker.as_ref().unwrap().wait(deadline)?;
            }
            let w = worker.as_ref().unwrap();
            w.send(p.request.clone())?;
            w.wait(Instant::now() + d.request)?.ok_or(Failure::Crashed)
        })();
        if result.is_err() {
            drop(worker.take());
        }
        // Release accounting only after failed I/O has stopped retaining the active request.
        shared.state.lock().unwrap().retained -= p.request.retained();
        let _ = p.reply.send(result);
    }
    drop(worker);
}

#[cfg(test)]
mod tests;
