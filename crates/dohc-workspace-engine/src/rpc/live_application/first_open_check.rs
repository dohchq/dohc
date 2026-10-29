//! `liveApplication.checkFirstOpenCandidate`: the engine checks the first live
//! version the relay built for an ordinary Markdown file, before the relay
//! publishes it. The check opens no store and leaves nothing behind.

use super::*;
use dohc_engine_collab::limits::{MAX_PUBLIC_MARKDOWN_BYTES, MAX_YDOC_UPDATE_BYTES};
use dohc_engine_collab::live_update_application::{
    FirstOpenCandidate, FirstOpenCandidateVerdict, FirstOpenCheckError, check_first_open_candidate,
};
use serde::Serialize;

pub(crate) const METHOD: &str = "liveApplication.checkFirstOpenCandidate";
pub(crate) const CONTRACT_VERSION: u32 = 1;

/// What the relay declares about one candidate and the file it must settle
/// to. The answer repeats it, so the relay can bind the verdict to its own
/// preparation. The version is always main.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FirstOpenCandidateBinding {
    pub object_id: String,
    pub path: String,
    pub source_moment_id: String,
    pub source_sha256: String,
    pub source_byte_length: usize,
    pub candidate_sha256: String,
    pub candidate_byte_length: usize,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub max_full_state_bytes: usize,
}

impl FirstOpenCandidateBinding {
    /// The bundle's length, once every declared bound holds.
    pub(crate) fn bundle_byte_length(&self) -> Result<usize, WireError> {
        let text = |value: &str| !value.is_empty() && value.len() <= 4096 && !value.contains('\0');
        let digest = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if ![
            &self.object_id,
            &self.path,
            &self.source_moment_id,
            &self.replication_epoch,
            &self.stream_identity,
        ]
        .into_iter()
        .all(|value| text(value))
            || !digest(&self.source_sha256)
            || !digest(&self.candidate_sha256)
            || self.source_byte_length > MAX_PUBLIC_MARKDOWN_BYTES
            || !(2..=MAX_YDOC_UPDATE_BYTES).contains(&self.candidate_byte_length)
            || !(2..=MAX_YDOC_UPDATE_BYTES).contains(&self.max_full_state_bytes)
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-first-open-candidate-bounds",
            ));
        }
        Ok(self.candidate_byte_length + self.source_byte_length)
    }
}

/// The candidate's bytes followed by the source's, as uploaded.
#[doc(hidden)]
#[derive(Clone)]
pub struct FirstOpenCheckInput {
    pub(crate) host: Arc<Host>,
    pub(crate) binding: FirstOpenCandidateBinding,
    pub(crate) bundle: Vec<u8>,
    pub(crate) reservation: Arc<dyn Send + Sync>,
}

/// Run the check on a blocking thread. The upload's reservation moves with
/// it, so its capacity stays charged until the check returns, even when the
/// caller stops waiting first.
pub(crate) fn spawn_check(
    input: FirstOpenCheckInput,
    stopped: impl Fn() -> bool + Send + 'static,
) -> tokio::task::JoinHandle<Result<FirstOpenCandidateVerdict, FirstOpenCheckError>> {
    tokio::task::spawn_blocking(move || {
        let FirstOpenCheckInput {
            binding,
            bundle,
            reservation,
            ..
        } = input;
        let _reservation = reservation;
        let (candidate, source) = bundle.split_at(binding.candidate_byte_length);
        check_first_open_candidate(
            FirstOpenCandidate {
                candidate,
                candidate_sha256: &binding.candidate_sha256,
                source,
                source_sha256: &binding.source_sha256,
                max_full_state_bytes: binding.max_full_state_bytes,
            },
            &stopped,
        )
    })
}

/// Withholds a finished check's answer once its host retires or detaches or
/// its deadline passes, but not when its caller cancels: the relay already
/// withholds the answer from a cancelled caller, and needs it to free its slot.
#[derive(Debug)]
struct AnswerGuard {
    host: Arc<Host>,
    deadline: Option<Instant>,
}

impl OutputGuard for AnswerGuard {
    /// A fresh signal on every call, so a late cancel reaches nothing.
    fn cancel_signal(&self) -> CancelSignal {
        CancelSignal::new()
    }
    fn retirement_signal(&self) -> CancelSignal {
        self.host.retired.clone()
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn is_current_ignoring_cancel(&self) -> bool {
        self.host.current(&self.host.connection)
            && self
                .deadline
                .is_none_or(|deadline| Instant::now() < deadline)
    }
    fn with_current(&self, _cancellable: bool, action: &mut dyn FnMut()) -> bool {
        let _fence = lock(&self.host.output_fence);
        if !self.is_current_ignoring_cancel() {
            return false;
        }
        action();
        true
    }
}

fn stopped(guard: &RestoreFenceOutputGuard) -> WireError {
    if guard.cancel.is_cancelled() {
        WireError::new(ErrorCode::Cancelled, "first-open check cancelled")
    } else if guard
        .deadline
        .is_some_and(|deadline| Instant::now() >= deadline)
    {
        WireError::new(
            ErrorCode::DeadlineExceeded,
            "first-open check deadline elapsed",
        )
    } else {
        workspace_unavailable()
    }
}

fn answer(binding: &FirstOpenCandidateBinding, verdict: FirstOpenCandidateVerdict) -> Value {
    match verdict {
        FirstOpenCandidateVerdict::Checked(evidence) => json!({
            "status": "checked", "contractVersion": CONTRACT_VERSION, "binding": binding,
            "settledSourceSha256": evidence.settled_source_sha256,
            "settledSourceByteLength": evidence.settled_source_byte_length,
            "fullStateSha256": evidence.full_state_sha256,
            "fullStateByteLength": evidence.full_state_byte_length,
        }),
        FirstOpenCandidateVerdict::Refused(cause) => json!({
            "status": "refused", "contractVersion": CONTRACT_VERSION, "binding": binding,
            "cause": cause.as_str(),
        }),
        FirstOpenCandidateVerdict::TooLarge { limit } => json!({
            "status": "too-large", "contractVersion": CONTRACT_VERSION, "binding": binding,
            "bound": "full-state-encoding", "limit": limit,
        }),
    }
}

impl EngineService {
    pub(crate) async fn live_application_check_first_open(
        &self,
        ctx: RequestContext,
        request: Request,
        input: FirstOpenCheckInput,
    ) -> Result<ServiceResponse, WireError> {
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let host = input.host.clone();
        let authorized = || {
            self.first_open_check_host(connection, request.workspace.as_ref())
                .is_ok_and(|current| Arc::ptr_eq(&current, &host))
        };
        if request.method != METHOD || request.idempotency_key.is_some() || !authorized() {
            return Err(workspace_unavailable());
        }
        let guard = Arc::new(RestoreFenceOutputGuard {
            host: host.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
        });
        if !guard.is_current() {
            return Err(stopped(&guard));
        }
        let binding = input.binding.clone();
        let current = guard.clone();
        let outcome = spawn_check(input, move || !current.is_current())
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "first-open check interrupted"))?;
        // A late answer is withheld once the caller or its standing is gone.
        if !guard.is_current() || !authorized() {
            return Err(stopped(&guard));
        }
        let verdict = outcome.map_err(|error| match error {
            FirstOpenCheckError::InvalidBounds => WireError::new(
                ErrorCode::InvalidParams,
                "invalid-first-open-candidate-bounds",
            ),
            FirstOpenCheckError::Integrity => {
                WireError::new(ErrorCode::BlobInvalid, "first-open-candidate-integrity")
            }
            FirstOpenCheckError::Stopped => stopped(&guard),
        })?;
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: answer(&binding, verdict),
            },
            blob_egress: None,
            output_guard: Some(Arc::new(AnswerGuard {
                host,
                deadline: ctx.deadline,
            })),
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::live_application_ingress::LiveApplicationIngress;
    use dohc_engine_collab::{ContentKind, Ydoc};
    use dohc_engine_protocol::transport::{ConnectionOwner, EngineService as _};
    use dohc_engine_storage::hex_sha256;
    use dohc_engine_testkit::ScratchDir;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::{Path, PathBuf};

    /// A configured host with one ordinary workspace and one private one.
    pub(crate) struct Fixture {
        pub(crate) ordinary_root: ScratchDir,
        _private_root: ScratchDir,
        pub(crate) service: Arc<EngineService>,
        pub(crate) owner: ConnectionOwner,
        pub(crate) ingress: LiveApplicationIngress,
        pub(crate) ordinary: WorkspaceHandle,
        pub(crate) private: WorkspaceHandle,
    }

    impl Fixture {
        pub(crate) async fn new() -> Self {
            Self::with(json!({})).await
        }

        /// A host also configured with each of `extra`'s sections, such as
        /// `restore`, `sync` or `settlement`.
        pub(crate) async fn with(extra: Value) -> Self {
            let ordinary_root = ScratchDir::new().unwrap();
            let private_root = ScratchDir::new().unwrap();
            let mut config = json!({
                "version": 1, "relayNamespace": "relay",
                "host": {"hostId": "host", "hostEpoch": 1, "instanceId": "instance", "connectionId": "connection"},
                "workspaces": [
                    {"root": ordinary_root.path(), "workspaceId": "ordinary", "maxRegistrations": 4,
                        "relay": {"baseUrl": "https://relay.example", "bearerToken": "owner-credential"}},
                    {"root": private_root.path(), "workspaceId": "private", "maxRegistrations": 4}
                ],
                "ingress": {"aggregateBytes": 512 * 1024 * 1024, "applicationWorkingReserveBytes": 8 * 1024 * 1024,
                    "maxUploads": 2, "uploadDeadlineMs": 30_000}
            });
            for (section, value) in extra.as_object().unwrap() {
                config[section.as_str()] = value.clone();
            }
            let config = serde_json::from_value(config).unwrap();
            let (service, owner, ingress) =
                EngineService::configured_live_host(config).await.unwrap();
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            let hosts = service
                .call(
                    ctx,
                    Request {
                        id: 1,
                        method: "liveApplication.hosts".into(),
                        workspace: None,
                        deadline_ms: None,
                        idempotency_key: None,
                        progress: false,
                        params: json!({}),
                    },
                )
                .await
                .unwrap();
            let handle = |id: &str| -> WorkspaceHandle {
                let entry = hosts.response.result["workspaces"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|entry| entry["workspaceId"] == id)
                    .unwrap();
                serde_json::from_value(entry["workspaceHandle"].clone()).unwrap()
            };
            let (ordinary, private) = (handle("ordinary"), handle("private"));
            Self {
                ordinary_root,
                _private_root: private_root,
                service,
                owner,
                ingress,
                ordinary,
                private,
            }
        }

        pub(crate) fn context(&self) -> RequestContext {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(self.owner.handle());
            ctx
        }

        pub(crate) async fn detach(
            &self,
            workspace: &WorkspaceHandle,
        ) -> Result<ServiceResponse, WireError> {
            self.service
                .call(
                    self.context(),
                    Request {
                        id: 999,
                        method: "liveApplication.detachWorkspace".into(),
                        workspace: Some(workspace.clone()),
                        deadline_ms: None,
                        idempotency_key: None,
                        progress: false,
                        params: json!({}),
                    },
                )
                .await
        }

        /// Close what is still open, even after the owner retired, so no
        /// workspace outlives its root.
        pub(crate) async fn close(self) {
            let Self {
                ordinary_root: _ordinary_root,
                _private_root,
                mut service,
                ingress,
                ordinary,
                private,
                ..
            } = self;
            drop(ingress);
            Arc::get_mut(&mut service)
                .unwrap()
                .configured_live_host
                .take();
            for workspace in [ordinary, private] {
                let _ = service
                    .call(
                        RequestContext::unbounded(),
                        Request {
                            id: 1000,
                            method: "workspace.close".into(),
                            workspace: Some(workspace),
                            deadline_ms: None,
                            idempotency_key: None,
                            progress: false,
                            params: Value::Null,
                        },
                    )
                    .await;
            }
        }
    }

    /// A first live version the engine itself seeds for `markdown`.
    pub(crate) fn candidate(markdown: &str) -> Vec<u8> {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, markdown)
            .unwrap();
        doc.encode_full_state()
    }

    pub(crate) fn binding(
        candidate: &[u8],
        source: &[u8],
        cap: usize,
    ) -> FirstOpenCandidateBinding {
        FirstOpenCandidateBinding {
            object_id: "object".into(),
            path: "notes/a.md".into(),
            source_moment_id: "moment".into(),
            source_sha256: hex_sha256(source),
            source_byte_length: source.len(),
            candidate_sha256: hex_sha256(candidate),
            candidate_byte_length: candidate.len(),
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            max_full_state_bytes: cap,
        }
    }

    /// Live document sessions and live registrations, which hold no rows.
    pub(crate) fn live_state(service: &EngineService) -> (usize, usize) {
        (
            lock(&service.sessions).len(),
            lock(&service.live_applications).registrations.len(),
        )
    }

    /// Every table's row count in the workspace store, and every file
    /// outside the engine's own directory.
    pub(crate) fn inventory(root: &Path) -> (BTreeMap<String, i64>, BTreeSet<PathBuf>) {
        let db = rusqlite::Connection::open(root.join(".dohc/engine/engine.db")).unwrap();
        let tables: Vec<String> = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let rows = tables
            .into_iter()
            .map(|table| {
                let count = db
                    .query_row(&format!("SELECT count(*) FROM \"{table}\""), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                (table, count)
            })
            .collect();
        fn walk(dir: &Path, root: &Path, files: &mut BTreeSet<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.starts_with(root.join(".dohc/engine")) {
                    continue;
                }
                if path.is_dir() {
                    walk(&path, root, files);
                } else {
                    files.insert(path);
                }
            }
        }
        let mut files = BTreeSet::new();
        walk(root, root, &mut files);
        (rows, files)
    }

    /// A finished answer is withheld once its deadline passes.
    #[tokio::test]
    async fn the_answer_guard_keeps_the_deadline() {
        let f = Fixture::new().await;
        let host = f
            .service
            .first_open_check_host(&f.owner.handle(), Some(&f.ordinary))
            .unwrap();
        let guard = AnswerGuard {
            host,
            deadline: Some(Instant::now()),
        };
        assert!(!guard.is_current());
        assert!(!guard.with_current(true, &mut || ()));
        assert!(!guard.with_current(false, &mut || ()));
        drop(guard);
        f.close().await;
    }

    /// The check stops when its caller cancels or its host loses standing
    /// while the work is held, and the reservation it carries stays charged
    /// until the check itself returns, even after its join handle is aborted.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_reservation_outlives_its_caller_until_the_check_exits() {
        for detach in [false, true] {
            let f = Fixture::new().await;
            let markdown = "Title\n=====\n\nBody\n";
            let bytes = candidate(markdown);
            let budget = Arc::new(tokio::sync::Semaphore::new(1));
            let host = f
                .service
                .first_open_check_host(&f.owner.handle(), Some(&f.ordinary))
                .unwrap();
            let cancel = CancelSignal::new();
            let guard = Arc::new(RestoreFenceOutputGuard {
                host: host.clone(),
                cancel: cancel.clone(),
                deadline: None,
            });
            let input = FirstOpenCheckInput {
                host,
                binding: binding(&bytes, markdown.as_bytes(), MAX_YDOC_UPDATE_BYTES),
                bundle: [bytes.as_slice(), markdown.as_bytes()].concat(),
                reservation: Arc::new(budget.clone().try_acquire_owned().unwrap()),
            };
            let (entered, entering) = std::sync::mpsc::channel();
            let (release, released) = std::sync::mpsc::channel::<()>();
            let current = guard.clone();
            let work = spawn_check(input, move || {
                let _ = entered.send(());
                let _ = released.recv();
                !current.is_current()
            });
            entering.recv().unwrap();
            work.abort();
            assert_eq!(budget.available_permits(), 0);
            if detach {
                f.detach(&f.ordinary).await.unwrap();
            } else {
                cancel.cancel();
            }
            assert!(!guard.is_current());
            assert_eq!(budget.available_permits(), 0);
            release.send(()).unwrap();
            assert!(matches!(work.await, Ok(Err(FirstOpenCheckError::Stopped))));
            // The caller hears why the work stopped, not a verdict.
            let expected = if detach {
                ErrorCode::WorkspaceUnavailable
            } else {
                ErrorCode::Cancelled
            };
            assert_eq!(stopped(&guard).code, expected);
            assert_eq!(budget.available_permits(), 1);
            f.close().await;
        }
    }
}
