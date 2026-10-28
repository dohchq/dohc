//! Fixed Markdown reader process. Configuration belongs to trusted engine startup.
#[allow(unsafe_code)]
mod platform;
mod process;
mod session;
mod wire;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fmt,
    future::Future,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

/// Absolute paths supplied by the host, never a renderer or workspace field.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
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
    Superseded,
    TooLarge,
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
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Construct,
    ConstructFold,
    Prove,
}
#[derive(Clone)]
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
#[derive(Clone)]
pub struct CheckMarkdownWitness {
    pub source: Vec<u8>,
    pub source_sha256: String,
    pub projection_sha256: String,
}

#[derive(Clone)]
pub(crate) enum PreparationRequest {
    Projection(Request),
    Witness(CheckMarkdownWitness),
}
impl PreparationRequest {
    fn retained(&self) -> usize {
        match self {
            Self::Projection(request) => request.retained(),
            Self::Witness(request) => {
                request.source.capacity()
                    + request.source_sha256.capacity()
                    + request.projection_sha256.capacity()
            }
        }
    }
    fn supersedes(&self, prior: &Self) -> bool {
        match (self, prior) {
            (Self::Projection(a), Self::Projection(b)) => {
                a.document == b.document && a.method == b.method
            }
            (Self::Witness(a), Self::Witness(b)) => {
                a.source_sha256 == b.source_sha256 && a.projection_sha256 == b.projection_sha256
            }
            _ => false,
        }
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
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RefusalReason {
    InvalidSource,
    InvalidUpdate,
    InvalidSchema,
    WitnessMismatch,
    ReadingMismatch,
    CapacityRefused,
    JournalRefused,
}
pub enum Outcome {
    WitnessChecked {
        source_sha256: String,
        projection_sha256: String,
        checker_identity: String,
        keeps_meaning: bool,
    },
    Constructed {
        proof: Proof,
        delta: Vec<u8>,
        checkpoint_sha256: String,
    },
    Proved {
        proof: Proof,
        checkpoint_sha256: String,
    },
    Expired {
        proof: Proof,
        checkpoint_sha256: String,
    },
    Refused {
        reason: RefusalReason,
        checkpoint_sha256: String,
    },
}
impl fmt::Debug for Outcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WitnessChecked { .. } => f.write_str("WitnessChecked"),
            Self::Constructed { delta, .. } => f
                .debug_struct("Constructed")
                .field("delta_bytes", &delta.len())
                .finish(),
            Self::Proved { .. } => f.write_str("Proved"),
            Self::Expired { .. } => f.write_str("Expired"),
            Self::Refused { reason, .. } => f.debug_tuple("Refused").field(reason).finish(),
        }
    }
}
pub type Result = std::result::Result<Outcome, Failure>;
struct Pending {
    request: PreparationRequest,
    retained: usize,
    deadline: Instant,
    reply: oneshot::Sender<Result>,
}
#[derive(Default)]
struct State {
    build_digest: Option<String>,
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
    #[cfg(any(test, feature = "test-support"))]
    dispatches: std::sync::atomic::AtomicU64,
}
impl Reader {
    #[cfg(any(test, feature = "test-support"))]
    pub fn dispatch_count(&self) -> u64 {
        self.dispatches.load(std::sync::atomic::Ordering::SeqCst)
    }
    /// Configured readers own an idle thread; the child starts with the first request.
    pub fn new(config: Option<Config>) -> Self {
        Self::with_deadlines(config, Deadlines::default())
    }
    fn with_deadlines(config: Option<Config>, deadlines: Deadlines) -> Self {
        let shared = Arc::new(Shared::default());
        let owned = shared.clone();
        let owner = config.and_then(|config| {
            thread::Builder::new()
                .name("markdown-reader".into())
                .spawn(move || drive(owned, config, deadlines))
                .ok()
        });
        shared.state.lock().unwrap().closed = owner.is_none();
        Self {
            shared,
            owner,
            deadlines,
            #[cfg(any(test, feature = "test-support"))]
            dispatches: std::sync::atomic::AtomicU64::new(0),
        }
    }
    /// Admission is immediate. Dropping the returned future cancels queued work.
    pub fn request(&self, request: Request) -> impl Future<Output = Result> + Send + use<> {
        self.enqueue(PreparationRequest::Projection(request))
    }
    pub fn check_markdown_witness(
        &self,
        request: CheckMarkdownWitness,
    ) -> impl Future<Output = Result> + Send + use<> {
        self.enqueue(PreparationRequest::Witness(request))
    }
    pub fn checker_identity(&self) -> Option<String> {
        self.shared.state.lock().unwrap().build_digest.clone()
    }
    fn enqueue(&self, request: PreparationRequest) -> impl Future<Output = Result> + Send + use<> {
        #[cfg(any(test, feature = "test-support"))]
        self.dispatches
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (reply, receiver) = oneshot::channel();
        let mut s = self.shared.state.lock().unwrap();
        expire(&mut s);
        let bytes = request.retained();
        let too_large = match &request {
            PreparationRequest::Projection(request) => {
                let metadata = [
                    &request.current_path,
                    &request.document.workspace_id,
                    &request.document.main_version_id,
                    &request.document.object_id,
                    &request.document.lineage_claim_id,
                ];
                request.source.len() > 2 * 1024 * 1024
                    || request.checkpoint.len() > wire::UPDATE
                    || metadata.iter().map(|s| s.len()).sum::<usize>() > 8192
            }
            PreparationRequest::Witness(request) => {
                request.source.len() > 2 * 1024 * 1024
                    || !wire::valid_sha(&request.source_sha256)
                    || !wire::valid_sha(&request.projection_sha256)
                    || wire::sha(&request.source) != request.source_sha256
            }
        };
        let failure = if s.closed {
            Some(Failure::Unavailable)
        } else if too_large || bytes > 64 * 1024 * 1024 {
            Some(Failure::TooLarge)
        } else {
            None
        };
        if let Some(failure) = failure {
            let _ = reply.send(Err(failure));
        } else {
            let replaced = s.queue.iter().position(|p| request.supersedes(&p.request));
            let previous = replaced.map_or(0, |i| s.queue[i].retained);
            if (replaced.is_none() && s.queue.len() >= 4)
                || s.retained - previous + bytes > 64 * 1024 * 1024
            {
                let _ = reply.send(Err(Failure::Overloaded));
            } else {
                if let Some(i) = replaced {
                    let old = s.queue.remove(i).unwrap();
                    s.retained -= old.retained;
                    let _ = old.reply.send(Err(Failure::Superseded));
                }
                s.retained += bytes;
                s.queue.push_back(Pending {
                    request,
                    retained: bytes,
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
            s.retained -= p.retained;
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
fn drive(shared: Arc<Shared>, config: Config, d: Deadlines) {
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
        let started = Instant::now();
        let mut phase = "startup";
        let result = (|| {
            if worker.is_none() {
                let deadline = Instant::now() + d.startup;
                let startup = process::Worker::start(&config, shared.clone(), deadline);
                match startup {
                    Ok(started) => worker = Some(started),
                    Err(failure) => {
                        if failure == Failure::Unavailable {
                            shared.state.lock().unwrap().closed = true;
                        }
                        return Err(failure);
                    }
                }
                phase = "hello";
                if let Err(failure) = wait_event(worker.as_ref().unwrap(), &shared, deadline) {
                    if failure == Failure::Unavailable {
                        shared.state.lock().unwrap().closed = true;
                    }
                    return Err(failure);
                }
            }
            let w = worker.as_ref().unwrap();
            phase = "send";
            w.send(p.request)?;
            phase = "response";
            wait_event(w, &shared, Instant::now() + d.request)?.ok_or(Failure::Crashed)
        })();
        if let Err(failure) = &result {
            eprintln!(
                "engine: Markdown reader {phase} failed: {failure:?} after {} ms",
                started.elapsed().as_millis()
            );
            drop(worker.take());
        }
        // Release accounting only after failed I/O has stopped retaining the active request.
        shared.state.lock().unwrap().retained -= p.retained;
        let _ = p.reply.send(result);
    }
    drop(worker);
}

fn wait_event(w: &process::Worker, shared: &Shared, deadline: Instant) -> process::Event {
    let mut s = shared.state.lock().unwrap();
    loop {
        expire(&mut s);
        if s.closed {
            return Err(Failure::Unavailable);
        }
        if Instant::now() >= deadline {
            return Err(Failure::TimedOut);
        }
        match w.output.try_recv() {
            Ok(event) => return event,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => return Err(Failure::Crashed),
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
        }
        let until = s
            .queue
            .iter()
            .map(|p| p.deadline)
            .min()
            .unwrap_or(deadline)
            .min(deadline);
        s = shared
            .wake
            .wait_timeout(s, until.saturating_duration_since(Instant::now()))
            .unwrap()
            .0;
    }
}

#[cfg(test)]
mod tests;
