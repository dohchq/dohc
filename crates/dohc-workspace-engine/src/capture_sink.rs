//! Files-reconcile adapter over the actor-owned capture primitives.

use dohc_engine_collab::LeaseRegistry;
use dohc_engine_crypto::{SecretDataKey, create_key_file, load_key_file};
use dohc_engine_domain::{AutomationClaim, DomainError};
use dohc_engine_files::media::is_text_media_type;
use dohc_engine_files::policy::{PathClassification, classify_engine_file_path_normalized};
use dohc_engine_files::{
    BatchIngestResult, CaptureError, CaptureOp, CaptureSink, IngestOutcome, IngestReason,
    MAX_CAPTURE_BINARY_BYTES, MAX_CAPTURE_TEXT_BYTES,
};
use dohc_engine_runtime::search::{
    FilesPolicyRule, SearchPolicySnapshot, read_engine_search_policy, resolve_effective_policy,
};
use dohc_engine_runtime::{
    ActorHandle, CaptureIngest, CaptureIngestBinary, CaptureRetire, CaptureSecret,
    CaptureSecretRetire, MAX_CAPTURE_INGEST_BATCH_BYTES, MAX_CAPTURE_INGEST_BATCH_OPS, NoFaults,
    RuntimeError, WorkspaceRootGuard,
};
use dohc_engine_storage::hex_sha256;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

/// The encrypted store validates origins against the TS `WRITE_ORIGINS` set,
/// which has no "capture" entry; the TS capture path writes secrets with
/// origin "local-file" — mirrored here.
const SECRET_CAPTURE_ORIGIN: &str = "local-file";
const READ_FAILED: CaptureError = CaptureError {
    reason: "capture disk read failed",
};
const INGEST_FAILED: CaptureError = CaptureError {
    reason: "capture text ingest failed",
};
const BINARY_INGEST_FAILED: CaptureError = CaptureError {
    reason: "capture binary ingest failed",
};
const RETIRE_FAILED: CaptureError = CaptureError {
    reason: "capture retire failed",
};
const ESCAPES_ROOT: CaptureError = CaptureError {
    reason: "capture path did not resolve through real ancestors inside the workspace root",
};
const RETIRE_RACED: CaptureError = CaptureError {
    reason: "retire refused: a regular file reappeared at the path",
};
const SECRET_INGEST_FAILED: CaptureError = CaptureError {
    reason: "capture secret ingest failed",
};
const SECRET_RETIRE_FAILED: CaptureError = CaptureError {
    reason: "capture secret retire failed",
};
/// The workspace key could not be loaded or created — a transient/config
/// failure, kept dirty for retry (never silently dropping secret capture).
const POLICY_UNAVAILABLE: CaptureError = CaptureError {
    reason: "files.toml unreadable: ownership unknown, holding for retry",
};
const SECRET_KEY_UNAVAILABLE: CaptureError = CaptureError {
    reason: "workspace secret key unavailable",
};
/// Secure file preparation is I/O-bound on Windows. Eight readers saturate
/// that syscall path on the launch profile without competing with the actor's
/// serialized database writer.
const MAX_ADDED_TEXT_PREPARE_WORKERS: usize = 8;

/// Per-run moment provenance, mirroring the TS capture metadata: a reconcile
/// pass stamps one summary + correlation id across every moment it records
/// ("Reconciled offline edits"); a live watcher batch leaves both unset and
/// each ingest falls back to a per-file "Updated <basename>" summary with no
/// correlation id.
#[derive(Clone, Default)]
pub struct CaptureProvenance {
    pub summary: Option<String>,
    pub correlation_id: Option<String>,
}

/// Single-shot identities of daemon-materialized Y.Doc projections. Capture
/// consumes a matching `(workspace, path, sha)` observation instead of
/// claiming the just-settled head as a new external edit.
#[derive(Clone, Default)]
pub struct SelfWriteSuppression {
    /// Root-path scope prefixed onto every workspace key. The registry is
    /// process-global (multi-service suppression), but two roots can carry
    /// the same workspaceId — an unscoped key would let root A's settle
    /// swallow root B's genuine capture of identical bytes. The global
    /// instance has an empty scope; per-workspace users hold a
    /// [`Self::scoped`] view sharing the same map.
    scope: String,
    /// Per (scoped workspace, path): the ordered pending settle identities.
    /// Two settles can land before capture consumes the first watcher
    /// event; a single-slot map would let the first `Changed` consume the
    /// second sha as a mismatch and ingest the daemon's own write as
    /// external.
    entries: Arc<Mutex<PendingWriteIdentities>>,
}

/// (scoped workspace, path) → ordered pending settle shas.
type PendingWriteIdentities = HashMap<(String, String), Vec<String>>;

impl SelfWriteSuppression {
    /// A view over the same shared registry whose keys are prefixed with
    /// the workspace root, so identical workspace ids under different roots
    /// cannot collide.
    pub fn scoped(&self, root: &std::path::Path) -> SelfWriteSuppression {
        SelfWriteSuppression {
            scope: root.to_string_lossy().into_owned(),
            entries: Arc::clone(&self.entries),
        }
    }

    fn scoped_workspace(&self, workspace_id: &str) -> String {
        // NUL never appears in a path or workspace id — an unambiguous join.
        format!("{}{}{workspace_id}", self.scope, char::from(0))
    }

    pub fn record(&self, workspace_id: &str, path: &str, sha256: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries
                .entry((self.scoped_workspace(workspace_id), path.to_owned()))
                .or_default()
                .push(sha256.to_owned());
        }
    }

    /// Consume on a `Changed` TEXT observation: when the observed sha
    /// matches a pending identity, that identity and every earlier one is
    /// removed (their events were coalesced/superseded) and the observation
    /// suppresses. A non-matching observation is an external edit — every
    /// pending identity clears (none may survive to suppress a later revert)
    /// and the observation ingests.
    fn consume(&self, workspace_id: &str, path: &str, sha256: &str) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let key = (self.scoped_workspace(workspace_id), path.to_owned());
        let Some(pending) = entries.get_mut(&key) else {
            return false;
        };
        let suppressed = match pending.iter().position(|recorded| recorded == sha256) {
            Some(index) => {
                pending.drain(..=index);
                true
            }
            None => {
                pending.clear();
                false
            }
        };
        if pending.is_empty() {
            entries.remove(&key);
        }
        suppressed
    }

    #[cfg(test)]
    pub(crate) fn has_pending(&self, workspace_id: &str, path: &str, sha256: &str) -> bool {
        let Ok(entries) = self.entries.lock() else {
            return false;
        };
        entries
            .get(&(self.scoped_workspace(workspace_id), path.to_owned()))
            .is_some_and(|pending| pending.iter().any(|recorded| recorded == sha256))
    }

    /// Clear every pending identity for a path — a `Changed` observation
    /// that resolves to non-text (binary/untracked/over-cap) means the path
    /// is no longer daemon-settled text; stale identities must not survive
    /// to suppress a later revert.
    fn clear_path(&self, workspace_id: &str, path: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&(self.scoped_workspace(workspace_id), path.to_owned()));
        }
    }

    /// Forget every entry for a workspace — called when the workspace closes
    /// or its handle is evicted; the registry outlives workspaces.
    pub fn clear_workspace(&self, workspace_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            let scoped = self.scoped_workspace(workspace_id);
            entries.retain(|(workspace, _), _| workspace != &scoped);
        }
    }
}

impl dohc_engine_runtime::SelfWriteRecorder for SelfWriteSuppression {
    fn record(&self, workspace_id: &str, path: &str, sha256: &str) {
        SelfWriteSuppression::record(self, workspace_id, path, sha256);
    }

    fn retract(&self, workspace_id: &str, path: &str, sha256: &str) {
        // Remove one matching identity (the failed settle's own) — every
        // other pending settle's entry must survive a stale retract.
        if let Ok(mut entries) = self.entries.lock() {
            let key = (self.scoped_workspace(workspace_id), path.to_owned());
            if let Some(pending) = entries.get_mut(&key) {
                if let Some(index) = pending.iter().rposition(|recorded| recorded == sha256) {
                    pending.remove(index);
                }
                if pending.is_empty() {
                    entries.remove(&key);
                }
            }
        }
    }
}

/// The physical directory selected for one reconcile generation.
///
/// A canonical pathname is not an identity: the original root can be renamed
/// and a different directory created at the same pathname. The file id closes
/// that gap. On Unix the open directory handle pins the inode so its number
/// cannot be recycled while this binding is live; Windows file ids do not need
/// that pin, and an open directory handle would prevent the replacement this
/// guard must detect.
pub(crate) struct CapturedRoot {
    canonical_path: PathBuf,
    identity: file_id::FileId,
    #[cfg(unix)]
    _pin: File,
}

impl WorkspaceRootGuard for CapturedRoot {
    fn validate(&self, root_dir: &Path) -> Result<(), RuntimeError> {
        self.still_names(root_dir)
            .then_some(())
            .ok_or(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                source: None,
            })
    }
}

impl CapturedRoot {
    #[cfg(unix)]
    pub(crate) fn bind(root: &Path) -> Result<Self, CaptureError> {
        use std::os::unix::fs::MetadataExt;

        let canonical_path = root.canonicalize().map_err(|_| ESCAPES_ROOT)?;
        let pin = File::open(&canonical_path).map_err(|_| ESCAPES_ROOT)?;
        let metadata = pin.metadata().map_err(|_| ESCAPES_ROOT)?;
        if !metadata.is_dir() {
            return Err(ESCAPES_ROOT);
        }
        Ok(CapturedRoot {
            canonical_path,
            identity: file_id::FileId::new_inode(metadata.dev(), metadata.ino()),
            _pin: pin,
        })
    }

    #[cfg(not(unix))]
    pub(crate) fn bind(root: &Path) -> Result<Self, CaptureError> {
        let canonical_path = root.canonicalize().map_err(|_| ESCAPES_ROOT)?;
        if !canonical_path
            .metadata()
            .map_err(|_| ESCAPES_ROOT)?
            .is_dir()
        {
            return Err(ESCAPES_ROOT);
        }
        let identity = file_id::get_file_id(&canonical_path).map_err(|_| ESCAPES_ROOT)?;
        Ok(CapturedRoot {
            canonical_path,
            identity,
        })
    }

    fn still_names(&self, root: &Path) -> bool {
        file_id::get_file_id(root).is_ok_and(|current| current == self.identity)
    }
}

/// Bridges a files-crate reconcile plan to the actor's domain capture writes.
///
/// The capture driver constructs one per reconcile run and supplies the
/// active version and capture-time provenance; `.dohc/files.toml` is read once at construction, matching
/// the one-policy-snapshot-per-task rule in the TS capture path.
pub struct StoreCaptureSink {
    actor: ActorHandle,
    leases: LeaseRegistry,
    workspace_id: String,
    version_id: String,
    shadow_root: PathBuf,
    /// The root binding is stable for one reconcile generation. Every bind
    /// failure rejects this generation; a later rescan builds a fresh sink and
    /// takes its policy snapshot from the directory it actually binds.
    captured_root: Result<Arc<CapturedRoot>, CaptureError>,
    now_ms: i64,
    author_json: Option<String>,
    search_policy: Arc<SearchPolicySnapshot>,
    files_policy: PolicyState,
    /// Set when any op this run was held on an unreadable policy. The driver
    /// reads it after the apply to arm its policy-recovery trigger — a
    /// deterministic signal from the exact decision point, immune to the
    /// blip being over before any re-read could observe it.
    policy_held: std::cell::Cell<bool>,
    /// Automation claims this run's captures and reconciliations inserted.
    /// The driver announces them after the run.
    automation_claims: std::cell::RefCell<Vec<AutomationClaim>>,
    /// Lazily loaded-or-created on the first secret capture (TS parity:
    /// `loadSecretDataKey` create branch) so workspaces without secrets never
    /// mint a key file.
    secret_key: Option<SecretDataKey>,
    self_writes: SelfWriteSuppression,
    provenance: CaptureProvenance,
}

pub(crate) struct StoreCaptureSinkParams {
    pub(crate) actor: ActorHandle,
    pub(crate) workspace_id: String,
    pub(crate) version_id: String,
    pub(crate) shadow_root: PathBuf,
    /// Bind before construction. A failed binding rejects this sink's generation.
    pub(crate) captured_root: Result<Arc<CapturedRoot>, CaptureError>,
    pub(crate) now_ms: i64,
    pub(crate) author_json: Option<String>,
    pub(crate) leases: LeaseRegistry,
    pub(crate) self_writes: SelfWriteSuppression,
    pub(crate) provenance: CaptureProvenance,
}

#[cfg(test)]
pub(crate) fn bound_sink_params(
    actor: ActorHandle,
    workspace_id: &str,
    version_id: &str,
    shadow_root: impl Into<PathBuf>,
    now_ms: i64,
) -> StoreCaptureSinkParams {
    let shadow_root = shadow_root.into();
    let captured_root = CapturedRoot::bind(&shadow_root).map(Arc::new);
    StoreCaptureSinkParams {
        actor,
        workspace_id: workspace_id.to_owned(),
        version_id: version_id.to_owned(),
        shadow_root,
        captured_root,
        now_ms,
        author_json: None,
        leases: LeaseRegistry::new(),
        self_writes: SelfWriteSuppression::default(),
        provenance: CaptureProvenance::default(),
    }
}

/// Capture's view of `.dohc/files.toml`, split by why there are no rules.
pub(crate) enum PolicyState {
    /// A real answer: absent (default policy), parsed rules, or a MALFORMED
    /// file — the last lands here as `Known(None)` under the ratified WS-F
    /// rule (writes are never dropped for a bad policy; search is where a
    /// broken policy fails closed).
    Known(Option<Vec<FilesPolicyRule>>),
    /// The file exists but could not be read (IO error, symlink refusal,
    /// oversize — possibly a transient editor lock). The narrowing set is
    /// unknown: falling back to floor-only would durably capture paths the
    /// user may have excluded, and the policy-retire branch would delete
    /// heads the policy may still track. Policy-dependent ops hold instead —
    /// fail, stay dirty, retry next cycle — mirroring the driver's
    /// unknown-fingerprint debounce hold.
    Unavailable,
}

impl StoreCaptureSink {
    pub(crate) fn new(params: StoreCaptureSinkParams) -> Self {
        let StoreCaptureSinkParams {
            actor,
            workspace_id,
            version_id,
            shadow_root,
            captured_root,
            now_ms,
            author_json,
            leases,
            self_writes,
            provenance,
        } = params;
        // `.dohc/files.toml` can only narrow engine ownership below the hard
        // floor. See [`PolicyState`] for the absent/malformed/unreadable
        // split: only a file that exists but cannot be read makes ownership
        // unknown; malformed keeps the WS-F floor-only rule.
        let snapshot = Arc::new(read_engine_search_policy(&shadow_root));
        let files_unreadable = snapshot.diagnostics.iter().any(|diagnostic| {
            diagnostic.file == "files.toml"
                && diagnostic.reason == dohc_engine_runtime::search::DiagnosticReason::Unreadable
        });
        let files_policy = if files_unreadable {
            PolicyState::Unavailable
        } else {
            PolicyState::Known(snapshot.files_policy.clone())
        };
        StoreCaptureSink {
            actor,
            leases,
            workspace_id,
            version_id,
            shadow_root,
            captured_root,
            now_ms,
            author_json,
            search_policy: snapshot,
            files_policy,
            policy_held: std::cell::Cell::new(false),
            automation_claims: std::cell::RefCell::new(Vec::new()),
            secret_key: None,
            self_writes,
            provenance,
        }
    }

    fn captured_root(&self) -> Result<&CapturedRoot, CaptureError> {
        let root = self.captured_root.as_deref().map_err(|error| *error)?;
        root.still_names(&self.shadow_root)
            .then_some(root)
            .ok_or(ESCAPES_ROOT)
    }

    fn canonical_shadow_root(&self) -> Result<&Path, CaptureError> {
        self.captured_root()
            .map(|root| root.canonical_path.as_path())
    }

    fn require_captured_root(&self) -> Result<(), CaptureError> {
        self.captured_root().map(|_| ())
    }

    fn root_guard(&self) -> Result<Arc<dyn WorkspaceRootGuard>, CaptureError> {
        match &self.captured_root {
            Ok(root) if root.still_names(&self.shadow_root) => {
                let root = Arc::clone(root);
                Ok(root)
            }
            Ok(_) => Err(ESCAPES_ROOT),
            Err(error) => Err(*error),
        }
    }

    fn path_containment(&self, rel_path: &str) -> Containment {
        if self
            .captured_root
            .as_ref()
            .is_ok_and(|root| !root.still_names(&self.shadow_root))
        {
            return Containment::Escaped;
        }
        path_containment_with_root(&self.shadow_root, rel_path, || self.canonical_shadow_root())
    }

    fn ensure_secret_key(&mut self) -> Result<&SecretDataKey, CaptureError> {
        if self.secret_key.is_none() {
            // Key I/O is workspace-scoped state, not a best-effort read. Check
            // the physical root before and after every path-based operation so
            // a renamed-and-recreated workspace cannot supply or receive this
            // workspace's encryption key.
            self.require_captured_root()?;
            let loaded = load_key_file(&self.shadow_root).map_err(|_| SECRET_KEY_UNAVAILABLE)?;
            self.require_captured_root()?;
            let key = match loaded {
                Some(key) => key,
                None => {
                    // Never mint over existing encrypted state: a missing key
                    // file with live secret rows (a backup restored without
                    // the key, an accidental deletion) must fail closed and
                    // stay dirty for retry — silently minting would strand
                    // the whole history under a fresh key (TS parity:
                    // `loadSecretDataKey` checks protected rows first).
                    let has_state = self
                        .actor
                        .secret_state_exists_blocking(self.workspace_id.clone())
                        .map_err(|_| SECRET_KEY_UNAVAILABLE)?;
                    if has_state {
                        return Err(SECRET_KEY_UNAVAILABLE);
                    }
                    self.require_captured_root()?;
                    let key =
                        create_key_file(&self.shadow_root).map_err(|_| SECRET_KEY_UNAVAILABLE)?;
                    self.require_captured_root()?;
                    key
                }
            };
            self.secret_key = Some(key);
        }
        Ok(self.secret_key.as_ref().expect("key just ensured"))
    }

    /// Whether any op this run was held on an unreadable policy.
    pub fn policy_held(&self) -> bool {
        self.policy_held.get()
    }

    /// Take the automation claims this run inserted so far.
    pub(crate) fn take_automation_claims(&self) -> Vec<AutomationClaim> {
        self.automation_claims.take()
    }

    /// Refresh collection detection and record bindings after a clean capture
    /// pass. Adoption uses the runtime's ordinary Y.Doc update + settle path,
    /// including durable replication journaling and self-write suppression.
    pub(crate) fn reconcile_collections(&self) -> Result<Vec<String>, RuntimeError> {
        let root_guard = self.root_guard().map_err(|_| RuntimeError::Identity {
            reason: "workspace root changed during capture",
            source: None,
        })?;
        let reconciliation = self.actor.reconcile_collections_blocking_guarded(
            self.workspace_id.clone(),
            self.version_id.clone(),
            self.shadow_root.clone(),
            self.leases.clone(),
            Arc::new(self.self_writes.clone()),
            self.now_ms,
            Arc::new(NoFaults),
            root_guard,
        )?;
        self.automation_claims
            .borrow_mut()
            .extend(reconciliation.automation_claims);
        Ok(reconciliation.changed_paths)
    }

    /// Check only the changed collection records offered by this capture
    /// pass. The actor compares their now-durable canonical Markdown against
    /// the existing id binding before the driver schedules reconciliation.
    pub(crate) fn collection_record_id_mismatch(
        &self,
        paths: Vec<String>,
    ) -> Result<bool, RuntimeError> {
        self.actor.collection_record_id_mismatch_blocking(
            self.workspace_id.clone(),
            self.version_id.clone(),
            paths,
        )
    }

    fn policy_tracks(&self, path: &str) -> Result<bool, CaptureError> {
        match &self.files_policy {
            PolicyState::Known(None) => Ok(true),
            PolicyState::Known(Some(rules)) => {
                Ok(resolve_effective_policy(path, Some(rules.as_slice()), None).tracked)
            }
            // Unknown narrowing: neither capture (may widen over an
            // exclusion) nor retire (may destroy a tracked head). Hold.
            PolicyState::Unavailable => {
                self.policy_held.set(true);
                Err(POLICY_UNAVAILABLE)
            }
        }
    }

    /// Re-read the current disk state for a planned ingest, mirroring the TS
    /// oracle's `readDiskTextState`: lstat-refuse symlink leaves, route by
    /// media type before UTF-8 sniffing, and apply the text/binary caps. The
    /// reopen itself must not follow symlinks (a swap between the lstat and
    /// the open would otherwise read outside the workspace), and a symlinked
    /// ancestor directory must not carry the read off-root.
    ///
    /// Race coverage, honestly stated: the LEAF swap race is closed (the
    /// no-follow open is bound to the descriptor), an at-rest symlinked
    /// ancestor is refused by the pre-open containment check, and an ancestor
    /// swapped mid-window is caught by the POST-open recheck
    /// ([`verify_opened_containment`]): the re-canonicalize sees the swapped
    /// link, and on Unix a swap-BACK is additionally caught by comparing the
    /// descriptor's (dev, ino) against the re-resolved path. The Windows
    /// residual is a double-swap timed inside the open window (needs symlink
    /// privilege; identity-by-handle needs APIs std does not expose) —
    /// candidate hardening for the composition driver.
    fn read_current(&self, path: &str, media_type: &str) -> Result<CurrentContent, CaptureError> {
        match self.path_containment(path) {
            Containment::Contained => {}
            Containment::Absent => return Ok(CurrentContent::Absent),
            Containment::Escaped => return Err(ESCAPES_ROOT),
        }
        let captured_root = self.captured_root()?;
        let content = read_contained_current(
            &self.shadow_root,
            &captured_root.canonical_path,
            path,
            media_type,
        )?;
        captured_root
            .still_names(&self.shadow_root)
            .then_some(content)
            .ok_or(ESCAPES_ROOT)
    }

    // The blocking actor calls below carry no timeout. The capture driver runs
    // this sink on its own thread and cancels between operations, not inside
    // one.
    fn ingest_text(
        &self,
        path: &str,
        text: String,
        claim_foreign_head: bool,
    ) -> Result<DomainIngest, CaptureError> {
        match self.actor.capture_ingest_with_search_policy_blocking(
            CaptureIngest {
                workspace_id: self.workspace_id.clone(),
                version_id: self.version_id.clone(),
                path: path.to_owned(),
                text,
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: self.provenance.summary.clone(),
                metadata_correlation_id: self.provenance.correlation_id.clone(),
                author_json: self.author_json.clone(),
                now_ms: self.now_ms,
                request_id: None,
                claim_foreign_head,
            },
            Arc::clone(&self.search_policy),
            self.leases.clone(),
            Arc::new(NoFaults),
        ) {
            Ok(result) => {
                self.automation_claims
                    .borrow_mut()
                    .extend(result.automation_claims);
                Ok(DomainIngest::Persisted)
            }
            // The store's admission gate is stricter than the scan floor
            // (e.g. `..` substrings, byte-1 colons). A name the store refuses
            // is settled — retrying can never succeed, and one legal on-disk
            // filename must not poison every capture run as degraded.
            Err(RuntimeError::Domain(DomainError::InvalidPath { .. })) => {
                Ok(DomainIngest::NameRefused)
            }
            // The head belongs to another writer (RPC/replication): capture
            // does not own it, so it stops tracking the path rather than
            // overwriting content that may have no disk counterpart.
            Err(RuntimeError::Domain(DomainError::CaptureNotOwned)) => {
                Ok(DomainIngest::ForeignHead)
            }
            Err(error) if held_as_new_file(&error) => Ok(DomainIngest::HeldAsNewFile),
            Err(_) => Err(INGEST_FAILED),
        }
    }

    fn ingest_binary(
        &self,
        path: &str,
        bytes: Vec<u8>,
        claim_foreign_head: bool,
    ) -> Result<DomainIngest, CaptureError> {
        match self.actor.capture_ingest_binary_blocking(
            CaptureIngestBinary {
                workspace_id: self.workspace_id.clone(),
                version_id: self.version_id.clone(),
                path: path.to_owned(),
                bytes,
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: self.provenance.summary.clone(),
                metadata_correlation_id: self.provenance.correlation_id.clone(),
                author_json: self.author_json.clone(),
                now_ms: self.now_ms,
                request_id: None,
                claim_foreign_head,
            },
            self.leases.clone(),
            Arc::new(NoFaults),
        ) {
            Ok(_) => Ok(DomainIngest::Persisted),
            // Same settled-refusal rule as text: the store's admission gate is
            // stricter than the scan floor, and a refused name can never
            // succeed on retry.
            Err(RuntimeError::Domain(DomainError::InvalidPath { .. })) => {
                Ok(DomainIngest::NameRefused)
            }
            Err(RuntimeError::Domain(DomainError::CaptureNotOwned)) => {
                Ok(DomainIngest::ForeignHead)
            }
            Err(error) if held_as_new_file(&error) => Ok(DomainIngest::HeldAsNewFile),
            Err(_) => Err(BINARY_INGEST_FAILED),
        }
    }

    /// Capture one secret path: read the current plaintext (mirroring the TS
    /// oracle's `readDiskSecretState` — text rules without the media-type
    /// heuristic; non-UTF-8 is untracked, never binary) and write it through
    /// the encrypted store. The workspace key is loaded-or-created on first
    /// use.
    fn ingest_secret(
        &mut self,
        path: &str,
        claim_foreign_head: bool,
        suppress_self_write: bool,
    ) -> Result<IngestOutcome, CaptureError> {
        let content = self.read_current_secret(path)?;
        self.ingest_secret_content(path, claim_foreign_head, suppress_self_write, content)
    }

    fn ingest_secret_content(
        &mut self,
        path: &str,
        claim_foreign_head: bool,
        suppress_self_write: bool,
        content: SecretContent,
    ) -> Result<IngestOutcome, CaptureError> {
        self.require_captured_root()?;
        match content {
            SecretContent::Text(text) => {
                let size = text.len() as u64;
                let sha256 = hex_sha256(text.as_bytes());
                if suppress_self_write
                    && self.self_writes.consume(&self.workspace_id, path, &sha256)
                {
                    return Ok(IngestOutcome::Captured { size, sha256 });
                }
                self.ensure_secret_key()?;
                let key = self.secret_key.clone().expect("key ensured just above");
                self.require_captured_root()?;
                match self.actor.capture_secret_blocking(
                    CaptureSecret {
                        workspace_id: self.workspace_id.clone(),
                        version_id: self.version_id.clone(),
                        path: path.to_owned(),
                        text,
                        metadata_origin: SECRET_CAPTURE_ORIGIN.to_owned(),
                        metadata_correlation_id: self.provenance.correlation_id.clone(),
                        now_ms: self.now_ms,
                        claim_foreign_head,
                    },
                    key,
                    Arc::new(NoFaults),
                ) {
                    Ok(_) => Ok(IngestOutcome::Captured { size, sha256 }),
                    Err(RuntimeError::Domain(DomainError::InvalidPath { .. })) => {
                        Ok(IngestOutcome::NotOwned)
                    }
                    // Foreign tip left intact; track the disk identity so the
                    // next observed edit arrives as `Changed` and captures.
                    Err(RuntimeError::Domain(DomainError::CaptureNotOwned)) => {
                        Ok(IngestOutcome::Captured { size, sha256 })
                    }
                    Err(_) => Err(SECRET_INGEST_FAILED),
                }
            }
            SecretContent::Untracked => {
                if suppress_self_write {
                    self.self_writes.clear_path(&self.workspace_id, path);
                }
                // No longer capturable secret text (absent, symlink, binary in
                // disguise, over cap): retire the encrypted tip so protected
                // state never goes stale-but-authoritative (TS parity), and
                // settle as NotOwned so the manifest forgets the path.
                self.retire_secret(path)?;
                Ok(IngestOutcome::NotOwned)
            }
        }
    }

    /// `readDiskSecretState` mirror: same containment/no-follow defenses as
    /// the text read, text-cap bound, UTF-8-or-untracked (no binary route).
    fn read_current_secret(&self, path: &str) -> Result<SecretContent, CaptureError> {
        let absolute = self.shadow_root.join(path);
        match self.path_containment(path) {
            Containment::Contained => {}
            Containment::Absent => return Ok(SecretContent::Untracked),
            Containment::Escaped => return Err(ESCAPES_ROOT),
        }
        let captured_root = self.captured_root()?;
        let content = (|| -> Result<SecretContent, CaptureError> {
            match std::fs::symlink_metadata(&absolute) {
                Ok(metadata) if !metadata.file_type().is_file() => {
                    return Ok(SecretContent::Untracked);
                }
                Ok(_) => {}
                Err(err) if absent_error(&err) => return Ok(SecretContent::Untracked),
                Err(_) => return Err(READ_FAILED),
            }
            let file = match open_no_follow(&absolute) {
                NoFollowOpen::Opened(file) => file,
                NoFollowOpen::Refused | NoFollowOpen::Absent => {
                    return Ok(SecretContent::Untracked);
                }
                NoFollowOpen::Failed => return Err(READ_FAILED),
            };
            verify_opened_containment(
                &self.shadow_root,
                &captured_root.canonical_path,
                path,
                &file,
            )?;
            let metadata = file.metadata().map_err(|_| READ_FAILED)?;
            if !metadata.file_type().is_file() || metadata.len() > MAX_CAPTURE_TEXT_BYTES {
                return Ok(SecretContent::Untracked);
            }
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            file.take(MAX_CAPTURE_TEXT_BYTES.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|_| READ_FAILED)?;
            if bytes.len() as u64 > MAX_CAPTURE_TEXT_BYTES {
                return Ok(SecretContent::Untracked);
            }
            match String::from_utf8(bytes) {
                Ok(text) => Ok(SecretContent::Text(text)),
                Err(_) => Ok(SecretContent::Untracked),
            }
        })()?;
        captured_root
            .still_names(&self.shadow_root)
            .then_some(content)
            .ok_or(ESCAPES_ROOT)
    }

    fn retire_secret(&self, path: &str) -> Result<(), CaptureError> {
        let root_guard = self.root_guard()?;
        match self.actor.capture_secret_retire_blocking_guarded(
            CaptureSecretRetire {
                workspace_id: self.workspace_id.clone(),
                version_id: self.version_id.clone(),
                path: path.to_owned(),
                metadata_origin: SECRET_CAPTURE_ORIGIN.to_owned(),
                metadata_correlation_id: self.provenance.correlation_id.clone(),
                now_ms: self.now_ms,
                only_if_own_origin: true,
            },
            self.shadow_root.clone(),
            Arc::new(NoFaults),
            root_guard,
        ) {
            Ok(_) => Ok(()),
            Err(RuntimeError::Domain(DomainError::InvalidPath { .. })) => Ok(()),
            Err(_) => Err(SECRET_RETIRE_FAILED),
        }
    }

    /// Retire a head this sink OWNS. `only_if_capture_origin` is always set:
    /// a head written by RPC or replication may legitimately have no disk
    /// counterpart, so a disk-driven retire must never destroy it.
    /// `summary` is the delete moment's honest label (the pass summary for a
    /// reconcile delete, an ownership reason for policy/non-ownable retires,
    /// None for a plain live delete); the pass correlation id always rides so
    /// a mid-pass delete cannot split the history group.
    fn retire_head(
        &self,
        path: &str,
        only_if_text_head: bool,
        summary: Option<String>,
    ) -> Result<(), CaptureError> {
        self.retire_head_with(path, only_if_text_head, summary, true)
    }

    fn retire_head_with(
        &self,
        path: &str,
        only_if_text_head: bool,
        summary: Option<String>,
        allow_ydoc_origin: bool,
    ) -> Result<(), CaptureError> {
        let root_guard = self.root_guard()?;
        match self.actor.capture_retire_materialized_blocking_guarded(
            CaptureRetire {
                workspace_id: self.workspace_id.clone(),
                version_id: self.version_id.clone(),
                path: path.to_owned(),
                metadata_summary: summary,
                metadata_correlation_id: self.provenance.correlation_id.clone(),
                now_ms: self.now_ms,
                request_id: None,
                only_if_text_head,
                only_if_capture_origin: true,
                allow_ydoc_origin,
            },
            self.shadow_root.clone(),
            Arc::new(self.self_writes.clone()),
            self.leases.clone(),
            Arc::new(NoFaults),
            root_guard,
        ) {
            Ok(_) => Ok(()),
            // A name the store refuses to address can never hold a head;
            // there is nothing to retire.
            Err(RuntimeError::Domain(DomainError::InvalidPath { .. })) => Ok(()),
            Err(_) => Err(RETIRE_FAILED),
        }
    }
}

/// How the domain store disposed of a capture write.
enum DomainIngest {
    Persisted,
    /// The store's admission gate refused the name (settled, not retryable).
    NameRefused,
    /// The head belongs to another writer and this observation was not a
    /// disk transition capture witnessed, so nothing was written.
    ForeignHead,
    /// A live session holds a file the store has no head for. See
    /// [`held_new_file_outcome`] for when that defers.
    HeldAsNewFile,
}

/// A live session holds a file the store has no head for yet. Capture defers
/// it only while the file is still empty, as a new file is when an editor
/// opens it: the session's first settle writes the head and the file together.
/// Any bytes on disk before then came from outside the session, and its settle
/// would refuse them as a stale target, so nothing would ever record them.
/// That stays a failed ingest, so capture stays unsettled and keeps the
/// writer's author until the lease is released and capture records it.
fn held_new_file_outcome(size: u64) -> Result<IngestOutcome, CaptureError> {
    if size == 0 {
        Ok(IngestOutcome::Deferred)
    } else {
        Err(INGEST_FAILED)
    }
}

/// The store refuses to capture a path whose document a live session holds.
/// For a file the store has no head for, the session owns the content and its
/// settle creates the head, whether capture sees the file for the first time
/// or saw an earlier file at the path whose head was since deleted; see
/// [`held_new_file_outcome`]. Every other refusal stays a failure, so disk
/// text nothing records keeps the layer unsettled.
fn held_as_new_file(error: &RuntimeError) -> bool {
    matches!(
        error,
        RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState { reason })
            if *reason == dohc_engine_runtime::CAPTURE_NEW_FILE_LIVE
    )
}

struct PreparedTextCapture {
    input: CaptureIngest,
    size: u64,
    sha256: String,
}

#[derive(Clone, Copy)]
struct AddedTextCandidate<'a> {
    path: &'a str,
    media_type: &'static str,
}

struct PreparedTextContent {
    text: String,
    size: u64,
    sha256: String,
}

enum PreparedTextPrefix {
    Ready(Vec<PreparedTextContent>),
    FallbackFirst,
    RootMismatch { attempted: usize },
}

enum PreparedCandidate {
    Text(PreparedTextContent),
    Fallback,
    RootMismatch,
}

/// Securely prepare an ordered batch prefix with a fixed reader ceiling.
///
/// Workers only reopen and hash files. The actor/database write remains on
/// the caller's thread and preserves plan order. At most one worker window is
/// retained beyond the 4 MiB actor batch, bounding speculative content to
/// `workers * MAX_CAPTURE_TEXT_BYTES` when files grow after the scan.
fn prepare_added_text_prefix_parallel(
    root: &Path,
    captured_root: &CapturedRoot,
    candidates: &[AddedTextCandidate<'_>],
) -> PreparedTextPrefix {
    prepare_added_text_prefix_parallel_with(
        candidates,
        |candidate| {
            read_current_with_canonical_root(
                root,
                captured_root,
                candidate.path,
                candidate.media_type,
            )
        },
        || captured_root.still_names(root),
    )
}

fn prepare_added_text_prefix_parallel_with(
    candidates: &[AddedTextCandidate<'_>],
    read_candidate: impl Fn(AddedTextCandidate<'_>) -> Result<CurrentContent, CaptureError> + Sync,
    root_still_names: impl Fn() -> bool + Sync,
) -> PreparedTextPrefix {
    let workers = std::thread::available_parallelism()
        .map_or(1, std::num::NonZeroUsize::get)
        .min(MAX_ADDED_TEXT_PREPARE_WORKERS)
        .min(candidates.len());
    let mut pending = Vec::with_capacity(candidates.len());
    let mut pending_bytes = 0usize;

    std::thread::scope(|scope| {
        let (result_tx, result_rx) = mpsc::sync_channel::<(usize, PreparedCandidate)>(workers);
        let mut task_txs = Vec::with_capacity(workers);

        for _ in 0..workers {
            let (task_tx, task_rx) = mpsc::sync_channel::<usize>(1);
            task_txs.push(task_tx);
            let result_tx = result_tx.clone();
            let read_candidate = &read_candidate;
            let root_still_names = &root_still_names;
            scope.spawn(move || {
                while let Ok(index) = task_rx.recv() {
                    let candidate = candidates[index];
                    let prepared = match read_candidate(candidate) {
                        Ok(CurrentContent::Text(text)) => {
                            let size = text.len() as u64;
                            let sha256 = hex_sha256(text.as_bytes());
                            PreparedCandidate::Text(PreparedTextContent { text, size, sha256 })
                        }
                        Ok(
                            CurrentContent::Binary(_)
                            | CurrentContent::Absent
                            | CurrentContent::NonOwnable,
                        ) => PreparedCandidate::Fallback,
                        Err(error) if error == ESCAPES_ROOT && !root_still_names() => {
                            PreparedCandidate::RootMismatch
                        }
                        Err(_) => PreparedCandidate::Fallback,
                    };
                    if result_tx.send((index, prepared)).is_err() {
                        return;
                    }
                }
            });
        }
        drop(result_tx);

        'windows: for window_start in (0..candidates.len()).step_by(workers) {
            let window_end = (window_start + workers).min(candidates.len());
            for (task_tx, index) in task_txs.iter().zip(window_start..window_end) {
                if task_tx.send(index).is_err() {
                    return if pending.is_empty() {
                        PreparedTextPrefix::FallbackFirst
                    } else {
                        PreparedTextPrefix::Ready(pending)
                    };
                }
            }

            let mut window = (window_start..window_end)
                .map(|_| None)
                .collect::<Vec<Option<PreparedCandidate>>>();
            for _ in window_start..window_end {
                let Ok((index, prepared)) = result_rx.recv() else {
                    return if pending.is_empty() {
                        PreparedTextPrefix::FallbackFirst
                    } else {
                        PreparedTextPrefix::Ready(pending)
                    };
                };
                window[index - window_start] = Some(prepared);
            }

            if window
                .iter()
                .any(|prepared| matches!(prepared, Some(PreparedCandidate::RootMismatch)))
            {
                return PreparedTextPrefix::RootMismatch {
                    attempted: window_end,
                };
            }

            for prepared in window {
                let Some(PreparedCandidate::Text(prepared)) = prepared else {
                    if pending.is_empty() {
                        return PreparedTextPrefix::FallbackFirst;
                    }
                    break 'windows;
                };
                let text_bytes = prepared.text.len();
                if text_bytes > MAX_CAPTURE_INGEST_BATCH_BYTES {
                    if pending.is_empty() {
                        return PreparedTextPrefix::FallbackFirst;
                    }
                    break 'windows;
                }
                if !pending.is_empty()
                    && (pending.len() >= MAX_CAPTURE_INGEST_BATCH_OPS
                        || pending_bytes.saturating_add(text_bytes)
                            > MAX_CAPTURE_INGEST_BATCH_BYTES)
                {
                    break 'windows;
                }
                pending_bytes = pending_bytes.saturating_add(text_bytes);
                pending.push(prepared);
            }
        }
        drop(task_txs);
        PreparedTextPrefix::Ready(pending)
    })
}

impl StoreCaptureSink {
    fn prepared_text_capture(
        &self,
        candidate: AddedTextCandidate<'_>,
        prepared: PreparedTextContent,
    ) -> PreparedTextCapture {
        PreparedTextCapture {
            input: CaptureIngest {
                workspace_id: self.workspace_id.clone(),
                version_id: self.version_id.clone(),
                path: candidate.path.to_owned(),
                text: prepared.text,
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: self.provenance.summary.clone(),
                metadata_correlation_id: self.provenance.correlation_id.clone(),
                author_json: self.author_json.clone(),
                now_ms: self.now_ms,
                request_id: None,
                claim_foreign_head: false,
            },
            size: prepared.size,
            sha256: prepared.sha256,
        }
    }

    fn ingest_single_added_op(&mut self, op: &CaptureOp) -> BatchIngestResult {
        let CaptureOp::Ingest {
            path,
            size,
            sha256,
            media_type,
            reason,
            ..
        } = op
        else {
            unreachable!("the batch path only receives Added ingests");
        };
        match self.ingest(path, *size, sha256, media_type, *reason) {
            Ok(outcome) => BatchIngestResult::Committed(vec![Ok(outcome)]),
            Err(_) => BatchIngestResult::Uncertain { attempted: 1 },
        }
    }

    fn commit_added_text_batch(&self, batch: Vec<PreparedTextCapture>) -> BatchIngestResult {
        let root_guard = match self.root_guard() {
            Ok(root_guard) => root_guard,
            Err(_) => {
                return BatchIngestResult::Uncertain {
                    attempted: batch.len(),
                };
            }
        };
        let mut inputs = Vec::with_capacity(batch.len());
        let mut identities = Vec::with_capacity(batch.len());
        for prepared in batch {
            inputs.push(prepared.input);
            identities.push((prepared.size, prepared.sha256));
        }
        let results = self.actor.capture_ingest_batch_blocking(
            inputs,
            Arc::clone(&self.search_policy),
            self.leases.clone(),
            Arc::new(NoFaults),
            self.shadow_root.clone(),
            root_guard,
        );
        match results {
            Ok(results) if results.len() == identities.len() => {
                let mut outcomes = Vec::with_capacity(results.len());
                for (result, (size, sha256)) in results.into_iter().zip(identities) {
                    outcomes.push(match result {
                        Ok(result) => {
                            self.automation_claims
                                .borrow_mut()
                                .extend(result.automation_claims);
                            Ok(IngestOutcome::Captured { size, sha256 })
                        }
                        Err(RuntimeError::Domain(DomainError::CaptureNotOwned)) => {
                            Ok(IngestOutcome::Captured { size, sha256 })
                        }
                        Err(RuntimeError::Domain(DomainError::InvalidPath { .. })) => {
                            Ok(IngestOutcome::NotOwned)
                        }
                        Err(error) if held_as_new_file(&error) => held_new_file_outcome(size),
                        Err(_) => Err(INGEST_FAILED),
                    });
                }
                BatchIngestResult::Committed(outcomes)
            }
            Ok(_) | Err(_) => BatchIngestResult::Uncertain {
                attempted: identities.len(),
            },
        }
    }

    /// Retire a path the current policy excludes, without the absence check.
    ///
    /// The driver calls this for `retained_over_cap` paths: they are still on
    /// disk by definition (that is why the scanner retained them), so the
    /// public [`CaptureSink::retire`] would refuse with a reappearance
    /// guard and the narrowed head would survive forever. Policy exclusion is
    /// an OWNERSHIP decision — presence on disk is irrelevant to it — while
    /// the ownership and canonical-name guards still apply.
    pub fn retire_policy_excluded(&mut self, path: &str) -> Result<(), CaptureError> {
        match classify_engine_file_path_normalized(path) {
            (PathClassification::Ignored, _) => Ok(()),
            (PathClassification::Secret, _) => Ok(()),
            (PathClassification::Tracked, Some(normalized)) if normalized == path => {
                self.retire_head(path, false, Some("Stopped tracking by policy".to_owned()))
            }
            (PathClassification::Tracked, _) => Ok(()),
        }
    }
}

impl CaptureSink for StoreCaptureSink {
    fn ingest_batch(&mut self, ops: &[CaptureOp]) -> Option<BatchIngestResult> {
        if ops.len() < 2
            || ops.iter().any(|op| {
                !matches!(
                    op,
                    CaptureOp::Ingest {
                        reason: IngestReason::Added,
                        ..
                    }
                )
            })
        {
            return None;
        }

        let mut candidates = Vec::with_capacity(MAX_CAPTURE_INGEST_BATCH_OPS);
        for op in ops.iter().take(MAX_CAPTURE_INGEST_BATCH_OPS) {
            let CaptureOp::Ingest {
                path, media_type, ..
            } = op
            else {
                unreachable!("all operations were checked as Added ingests");
            };
            if !matches!(
                classify_engine_file_path_normalized(path),
                (PathClassification::Tracked, Some(normalized)) if normalized == path.as_str()
            ) || !self.policy_tracks(path).unwrap_or(false)
            {
                break;
            }
            candidates.push(AddedTextCandidate { path, media_type });
        }
        if candidates.is_empty() {
            return Some(self.ingest_single_added_op(&ops[0]));
        }

        let captured_root = match self.captured_root() {
            Ok(root) => root,
            Err(_) => return Some(self.ingest_single_added_op(&ops[0])),
        };
        let prepared =
            prepare_added_text_prefix_parallel(&self.shadow_root, captured_root, &candidates);
        let prepared = match prepared {
            PreparedTextPrefix::Ready(prepared) => prepared,
            PreparedTextPrefix::FallbackFirst => {
                return Some(self.ingest_single_added_op(&ops[0]));
            }
            PreparedTextPrefix::RootMismatch { attempted } => {
                return Some(BatchIngestResult::Uncertain { attempted });
            }
        };
        debug_assert!(!prepared.is_empty());
        let pending = candidates
            .into_iter()
            .zip(prepared)
            .map(|(candidate, prepared)| self.prepared_text_capture(candidate, prepared))
            .collect();
        Some(self.commit_added_text_batch(pending))
    }

    fn ingest(
        &mut self,
        path: &str,
        _size: u64,
        _sha256: &str,
        media_type: &str,
        reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError> {
        // Capture claims a head written by another origin only when it
        // observed the disk transition (`Changed`). On first sight (`Added`,
        // e.g. a fresh or reset manifest) stale disk bytes are
        // indistinguishable from a genuine edit, so a foreign head is left
        // intact — the path is still tracked (so the next real edit is seen
        // as `Changed` and captured), just not overwritten now.
        let claim_foreign_head = matches!(reason, IngestReason::Changed);
        // Plan hashes and sizes describe the scan observation only. Re-read the
        // path so settled rapid writes coalesce to the latest disk state.
        let normalized = match classify_engine_file_path_normalized(path) {
            (PathClassification::Ignored, _) => return Ok(IngestOutcome::NotOwned),
            // Secret paths route to the encrypted store, never the plaintext
            // one (the secret floor outranks policy — `.dohc` files can never
            // unmark it). Same canonical-key rule as the tracked branch: a
            // scanned name that normalizes differently (a literal `%2eenv`)
            // must not create encrypted heads under an aliased key.
            (PathClassification::Secret, normalized) => {
                if normalized.as_deref() != Some(path) {
                    return Ok(IngestOutcome::NotOwned);
                }
                // Secret switch writes use the same suppression registry as
                // ordinary projections. Consume it before entering the
                // encrypted capture path, where an equal-content dedupe would
                // otherwise stamp the API tip as capture-owned.
                return self.ingest_secret(path, claim_foreign_head, claim_foreign_head);
            }
            (PathClassification::Tracked, normalized) => normalized.ok_or(INGEST_FAILED)?,
        };
        // The domain stores under the CANONICAL relative path. A scanned disk
        // name that normalizes to a different key (e.g. a literal `a%2fb.md`
        // decoding to `a/b.md`) would persist content for a path that does not
        // exist on disk and could clobber the real file at that key. Refuse to
        // capture it — and never retire through it, the canonical key may
        // belong to another live file.
        if normalized != path {
            return Ok(IngestOutcome::NotOwned);
        }
        if !self.policy_tracks(path)? {
            // `.dohc/files.toml` narrowed the path out of engine ownership:
            // retire any stale head (TS: "Stopped tracking by policy") so
            // opted-out content is never left stale-but-authoritative.
            //
            // The driver rebuilds from captured state after a policy change.
            // Narrowed entries get a sentinel hash so unchanged files reach
            // this branch. Retaining those entries also preserves deletion
            // detection for files removed while the workspace was closed.
            //
            // A pending self-write identity must not outlive the exclusion:
            // if the path is tracked again later with the old settled bytes
            // on disk, a stale entry would suppress a genuine external
            // revert.
            self.self_writes.clear_path(&self.workspace_id, path);
            self.retire_head(path, false, Some("Stopped tracking by policy".to_owned()))?;
            return Ok(IngestOutcome::NotOwned);
        }
        // A Changed observation resolves suppression against what the
        // re-read actually contains: a matching TEXT observation suppresses
        // (consuming that identity and its coalesced predecessors), a
        // non-matching one clears every pending identity, and a
        // binary/untracked resolution clears too — an entry left armed by
        // any of those would later suppress a genuine revert.
        let changed = matches!(reason, IngestReason::Changed);
        match self.read_current(path, media_type)? {
            CurrentContent::Text(text) => {
                // Report the identity of the bytes actually captured — the
                // re-read can be newer than the plan's scan observation, and
                // the manifest must record reality or a later revert to the
                // scan-time bytes would diff clean and never re-ingest.
                let size = text.len() as u64;
                let sha256 = hex_sha256(text.as_bytes());
                if changed && self.self_writes.consume(&self.workspace_id, path, &sha256) {
                    return Ok(IngestOutcome::Captured { size, sha256 });
                }
                match self.ingest_text(path, text, claim_foreign_head)? {
                    DomainIngest::Persisted => Ok(IngestOutcome::Captured { size, sha256 }),
                    DomainIngest::NameRefused => Ok(IngestOutcome::NotOwned),
                    // Foreign head left intact: track the disk identity so the
                    // next genuine edit arrives as `Changed` and is captured.
                    DomainIngest::ForeignHead => Ok(IngestOutcome::Captured { size, sha256 }),
                    DomainIngest::HeldAsNewFile => held_new_file_outcome(size),
                }
            }
            CurrentContent::Absent => {
                if changed {
                    self.self_writes.clear_path(&self.workspace_id, path);
                }
                // Raced a delete between scan and re-read: retire like an
                // ordinary delete (pass provenance; no ownership label), and
                // report NotOwned so the manifest forgets the path.
                self.retire_head(path, false, self.provenance.summary.clone())?;
                Ok(IngestOutcome::NotOwned)
            }
            CurrentContent::NonOwnable => {
                if changed {
                    self.self_writes.clear_path(&self.workspace_id, path);
                }
                // Still present but no longer engine-ownable (symlink,
                // non-file, over cap): retire with the honest TS label so no
                // stale snapshot remains, and report NotOwned so the manifest
                // forgets the path instead of recording the planned ingest.
                //
                // A materialized Y.DOC head is exempt. A Y.Doc is bounded by
                // nothing, so its own settled artifact routinely lands past
                // the capture caps and arrives here as "non-ownable" — but it
                // is the engine's own output, not content that stopped being
                // ownable. Retiring it drops a document the user is actively
                // editing out of the engine on every reconcile.
                //
                // NOTE: the desktop capture layer answers the same question
                // with a different instrument — a `ydoc_docs` marker
                // (`hasYdocMarker`) rather than the head's origin. That is
                // deliberate, not drift. Origin is what this layer already
                // has in hand (the retire executor reads the head anyway);
                // the marker is what the TS layer already has (it lists file
                // metadata anyway). Origin is the stricter of the two — it
                // stops protecting as soon as an ordinary capture claims the
                // head — so this layer protects a subset of what TS protects
                // and self-heals rather than latching.
                self.retire_head_with(
                    path,
                    false,
                    Some("Stopped tracking non-text content".to_owned()),
                    false,
                )?;
                Ok(IngestOutcome::NotOwned)
            }
            CurrentContent::Binary(bytes) => {
                if changed {
                    self.self_writes.clear_path(&self.workspace_id, path);
                }
                // Engine-ownable binary content persists as a BINHEAD binary
                // head (a text->binary flip replaces the text head in the
                // same transaction — no separate retire). The receipt carries
                // the bytes' identity, which equals the scanner's hash of the
                // same file bytes.
                let size = bytes.len() as u64;
                let sha256 = hex_sha256(&bytes);
                match self.ingest_binary(path, bytes, claim_foreign_head)? {
                    DomainIngest::Persisted => Ok(IngestOutcome::Captured { size, sha256 }),
                    DomainIngest::NameRefused => Ok(IngestOutcome::NotOwned),
                    DomainIngest::ForeignHead => Ok(IngestOutcome::Captured { size, sha256 }),
                    DomainIngest::HeldAsNewFile => held_new_file_outcome(size),
                }
            }
        }
    }

    fn retire(&mut self, path: &str) -> Result<(), CaptureError> {
        match classify_engine_file_path_normalized(path) {
            (PathClassification::Ignored, _) => Ok(()),
            (PathClassification::Secret, normalized) => {
                // Nothing was ever stored under a non-canonical literal name.
                if normalized.as_deref() != Some(path) {
                    return Ok(());
                }
                // Apply-time absence confirmation, then the KEYLESS secret
                // retire (a delete never decrypts). Mirrors the text arm's
                // reappearance refusal.
                let absolute = self.shadow_root.join(path);
                match self.path_containment(path) {
                    Containment::Contained => {}
                    Containment::Absent => return self.retire_secret(path),
                    Containment::Escaped => return Err(ESCAPES_ROOT),
                }
                match std::fs::symlink_metadata(&absolute) {
                    Ok(metadata) if metadata.file_type().is_file() => Err(RETIRE_RACED),
                    Ok(_) => self.retire_secret(path),
                    Err(err) if absent_error(&err) => self.retire_secret(path),
                    Err(_) => Err(SECRET_RETIRE_FAILED),
                }
            }
            (PathClassification::Tracked, Some(normalized)) if normalized == path => {
                // Apply-time absence confirmation, mirroring both the TS
                // oracle (`pathConfirmedAbsentOnDisk` runs immediately before
                // `deleteIfTracked`) and `StdAbsenceProbe`'s semantics: a
                // regular file that reappeared between scan and apply must not
                // be retired — fail the op so the path stays dirty and the
                // rescan captures the live content instead.
                let absolute = self.shadow_root.join(path);
                // Same ancestor containment as read_current: the probe's
                // verdict must never be based on an off-root file reached
                // through a symlinked ancestor. A missing parent confirms the
                // tracked file gone; an escape retains last-known-good.
                match self.path_containment(path) {
                    Containment::Contained => {}
                    Containment::Absent => {
                        return self.retire_head(path, false, self.provenance.summary.clone());
                    }
                    Containment::Escaped => return Err(ESCAPES_ROOT),
                }
                match std::fs::symlink_metadata(&absolute) {
                    Ok(metadata) if metadata.file_type().is_file() => Err(RETIRE_RACED),
                    // A non-regular replacement confirms the tracked regular
                    // file gone; absence confirms it outright.
                    Ok(_) => self.retire_head(path, false, self.provenance.summary.clone()),
                    Err(err) if absent_error(&err) => {
                        self.retire_head(path, false, self.provenance.summary.clone())
                    }
                    // Indeterminate (permissions, locks): cannot prove
                    // absence — retain last-known-good, fail-safe.
                    Err(_) => Err(RETIRE_FAILED),
                }
            }
            // Nothing was ever stored under a non-canonical literal name.
            (PathClassification::Tracked, _) => Ok(()),
        }
    }
}

enum SecretContent {
    Text(String),
    /// Absent, or present but not capturable secret text at this path.
    Untracked,
}

enum CurrentContent {
    Text(String),
    /// Present, engine-ownable binary bytes.
    Binary(Vec<u8>),
    /// Confirmed absent (raced a delete between scan and re-read).
    Absent,
    /// Present but not engine-ownable at this path (symlink, non-file,
    /// over cap). Split from [`CurrentContent::Absent`] so the retire can
    /// carry the honest TS label ("Stopped tracking non-text content")
    /// without mislabeling a plain raced delete.
    NonOwnable,
}

/// Parallel preparation already owns the generation's canonical root, so it
/// can apply the shared strict parent check without touching
/// `StoreCaptureSink`'s non-`Sync` policy state.
fn read_current_with_canonical_root(
    root: &Path,
    captured_root: &CapturedRoot,
    path: &str,
    media_type: &str,
) -> Result<CurrentContent, CaptureError> {
    if !captured_root.still_names(root) {
        return Err(ESCAPES_ROOT);
    }
    match path_containment_with_root(root, path, || Ok(captured_root.canonical_path.as_path())) {
        Containment::Contained => {
            let content =
                read_contained_current(root, &captured_root.canonical_path, path, media_type)?;
            captured_root
                .still_names(root)
                .then_some(content)
                .ok_or(ESCAPES_ROOT)
        }
        Containment::Absent => Ok(CurrentContent::Absent),
        Containment::Escaped => Err(ESCAPES_ROOT),
    }
}

/// Read a path whose parent has already passed the generation's containment
/// check. Both the ordinary sink path and the bounded parallel preparation
/// path use this exact reopen, post-open containment, type, and size logic.
fn read_contained_current(
    root: &Path,
    canonical_root: &Path,
    path: &str,
    media_type: &str,
) -> Result<CurrentContent, CaptureError> {
    let absolute = root.join(path);
    // Advisory lstat mirror of the TS refusal (symlink leaf and non-file
    // entries are not engine-ownable); the no-follow open below is what
    // actually closes the check-then-open race.
    match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Ok(CurrentContent::NonOwnable);
        }
        Ok(_) => {}
        Err(err) if absent_error(&err) => return Ok(CurrentContent::Absent),
        Err(_) => return Err(READ_FAILED),
    }
    let file = match open_no_follow(&absolute) {
        NoFollowOpen::Opened(file) => file,
        NoFollowOpen::Refused => return Ok(CurrentContent::NonOwnable),
        NoFollowOpen::Absent => return Ok(CurrentContent::Absent),
        NoFollowOpen::Failed => return Err(READ_FAILED),
    };
    verify_opened_containment(root, canonical_root, path, &file)?;
    let metadata = file.metadata().map_err(|_| READ_FAILED)?;
    if !metadata.file_type().is_file() {
        return Ok(CurrentContent::NonOwnable);
    }
    // Between the capture cap and the SCAN cap (64 MiB) the scanner still
    // lists the file, so a grow-past-capture-cap lands here and retires.
    // Past the scan cap the plan classifies it `retained_over_cap` and the
    // sink is never called — deliberately not a retire: the ratified CAL-3
    // delta keeps last-known-good rather than
    // false-deleting live user data behind an operational scan bound.
    let text_media = is_text_media_type(media_type, path);
    let content_cap = if text_media {
        MAX_CAPTURE_TEXT_BYTES
    } else {
        MAX_CAPTURE_BINARY_BYTES
    };
    if metadata.len() > content_cap {
        return Ok(CurrentContent::NonOwnable);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(content_cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| READ_FAILED)?;
    if bytes.len() as u64 > content_cap {
        return Ok(CurrentContent::NonOwnable);
    }
    if !text_media {
        // Non-text media is engine-ownable binary content: the TS oracle
        // routes it to the binary store before any UTF-8 sniffing, so a
        // UTF-8-clean `.png` must never land in the plaintext store.
        return Ok(CurrentContent::Binary(bytes));
    }
    match String::from_utf8(bytes) {
        Ok(text) if text.len() as u64 > MAX_CAPTURE_TEXT_BYTES => {
            // Genuine text over the text cap stays untracked (established TS
            // behavior), even though binary of the same size would be ownable.
            Ok(CurrentContent::NonOwnable)
        }
        Ok(text) => Ok(CurrentContent::Text(text)),
        // A text-suffixed path can be binary in disguise (invalid UTF-8); the
        // store accepts that as binary up to the binary cap.
        Err(err)
            if path.to_ascii_lowercase().ends_with(".excalidraw")
                || err.as_bytes().len() as u64 > MAX_CAPTURE_BINARY_BYTES =>
        {
            Ok(CurrentContent::NonOwnable)
        }
        Err(err) => Ok(CurrentContent::Binary(err.into_bytes())),
    }
}

fn absent_error(err: &std::io::Error) -> bool {
    matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}

enum Containment {
    Contained,
    Absent,
    Escaped,
}

/// Resolve a path's parent before resolving the root. This preserves the
/// established distinction: an absent path settles as absent, while any other
/// resolution error fails closed. The root resolver stays lazy so an absent
/// path does not introduce an unrelated root-resolution failure.
fn path_containment_with_root<'a>(
    root: &Path,
    rel_path: &str,
    canonical_root: impl FnOnce() -> Result<&'a Path, CaptureError>,
) -> Containment {
    let absolute = root.join(rel_path);
    let Some(parent) = absolute.parent() else {
        return Containment::Escaped;
    };
    let canonical_parent = match parent.canonicalize() {
        Ok(real) => real,
        Err(err) if absent_error(&err) => return Containment::Absent,
        Err(_) => return Containment::Escaped,
    };
    let Ok(canonical_root) = canonical_root() else {
        return Containment::Escaped;
    };
    // A root moved behind a symlink now resolves somewhere other than this
    // cached location and is refused. Replacing a directory in place at the
    // same canonical pathname remains indistinguishable by path, the same
    // identity limitation as the previous per-read resolution.
    contained_parent(canonical_root, rel_path, &canonical_parent)
}

/// The canonical location `rel_path` would have if NO ancestor were a
/// symlink: the canonical root joined with the lexical segments. Any symlink
/// anywhere in the chain — even one resolving inside the root — makes the
/// real canonical path differ from this, which is exactly the scanner-parity
/// rule (the `Scanner` never descends symlinked directories, so the sink must
/// never read through one either).
fn expected_absolute(real_root: &Path, rel_path: &str) -> PathBuf {
    let mut out = real_root.to_path_buf();
    for segment in rel_path.split('/') {
        out.push(segment);
    }
    out
}

/// Ancestor guard: the canonicalized parent must equal the canonical root
/// joined with the lexical parent segments — not merely resolve somewhere
/// under the root. Strict equality rejects a symlinked ancestor regardless of
/// where it points (off-root exfiltration and in-root aliasing).
/// Unresolvable-for-any-other-reason fails closed as a refusal.
fn contained_parent(canonical_root: &Path, rel_path: &str, canonical_parent: &Path) -> Containment {
    let parent_rel = rel_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    if canonical_parent == expected_absolute(canonical_root, parent_rel) {
        Containment::Contained
    } else {
        Containment::Escaped
    }
}

/// Post-open containment recheck: re-resolve the opened path and require it
/// equal to its lexical location under the canonical root (same strict rule
/// as [`contained_parent`]). Catches an ancestor swapped to a symlink between
/// the pre-open check and the open. On Unix the opened descriptor's
/// (dev, ino) must also match the re-resolved path, so a swap-back cannot
/// hide a foreign descriptor.
fn verify_opened_containment(
    root: &Path,
    canonical_root: &Path,
    rel_path: &str,
    file: &File,
) -> Result<(), CaptureError> {
    let absolute = root.join(rel_path);
    let real = absolute.canonicalize().map_err(|_| ESCAPES_ROOT)?;
    if real != expected_absolute(canonical_root, rel_path) {
        return Err(ESCAPES_ROOT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let handle = file.metadata().map_err(|_| READ_FAILED)?;
        let resolved = std::fs::metadata(&real).map_err(|_| ESCAPES_ROOT)?;
        if handle.dev() != resolved.dev() || handle.ino() != resolved.ino() {
            return Err(ESCAPES_ROOT);
        }
    }
    #[cfg(windows)]
    {
        let _ = file;
    }
    Ok(())
}

enum NoFollowOpen {
    Opened(File),
    /// The leaf is a symlink/reparse point; not engine-ownable.
    Refused,
    Absent,
    Failed,
}

#[cfg(windows)]
fn open_no_follow(absolute: &Path) -> NoFollowOpen {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    // Open the reparse point itself (never its target), then refuse anything
    // reparse-tagged — symlinks, junctions, and other redirectors alike.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    match OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(absolute)
    {
        Ok(file) => match file.metadata() {
            Ok(metadata) if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
                NoFollowOpen::Refused
            }
            Ok(_) => NoFollowOpen::Opened(file),
            Err(_) => NoFollowOpen::Failed,
        },
        Err(err) if absent_error(&err) => NoFollowOpen::Absent,
        Err(_) => NoFollowOpen::Failed,
    }
}

#[cfg(unix)]
fn open_no_follow(absolute: &Path) -> NoFollowOpen {
    use std::os::unix::fs::OpenOptionsExt;
    // O_NONBLOCK alongside O_NOFOLLOW: opening a FIFO swapped in after the
    // advisory lstat would otherwise BLOCK until a writer appears, hanging
    // the capture worker. A non-blocking open of a FIFO succeeds instantly
    // and the follow-up is_file() check rejects it; regular-file reads are
    // unaffected by the flag.
    match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(absolute)
    {
        Ok(file) => NoFollowOpen::Opened(file),
        Err(err) if err.raw_os_error() == Some(libc::ELOOP) => NoFollowOpen::Refused,
        Err(err) if absent_error(&err) => NoFollowOpen::Absent,
        Err(_) => NoFollowOpen::Failed,
    }
}

#[cfg(test)]
mod tests;
