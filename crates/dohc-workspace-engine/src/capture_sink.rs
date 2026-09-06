//! Files-reconcile adapter over the actor-owned capture primitives.

use dohc_engine_collab::LeaseRegistry;
use dohc_engine_crypto::{SecretDataKey, create_key_file, load_key_file};
use dohc_engine_domain::{COLLECTION_SCHEMA_FILENAME, DomainError};
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
    /// Lazily loaded-or-created on the first secret capture (TS parity:
    /// `loadSecretDataKey` create branch) so workspaces without secrets never
    /// mint a key file.
    secret_key: Option<SecretDataKey>,
    self_writes: SelfWriteSuppression,
    provenance: CaptureProvenance,
}

/// The sink's view of `.dohc/files.toml`, split by why there are no rules.
enum PolicyState {
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
    #[cfg(test)]
    pub(crate) fn new(
        actor: ActorHandle,
        workspace_id: impl Into<String>,
        version_id: impl Into<String>,
        shadow_root: impl Into<PathBuf>,
        now_ms: i64,
        author_json: Option<String>,
    ) -> Self {
        Self::new_with_self_writes(
            actor,
            workspace_id,
            version_id,
            shadow_root,
            now_ms,
            author_json,
            LeaseRegistry::new(),
            SelfWriteSuppression::default(),
            CaptureProvenance::default(),
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_with_self_writes(
        actor: ActorHandle,
        workspace_id: impl Into<String>,
        version_id: impl Into<String>,
        shadow_root: impl Into<PathBuf>,
        now_ms: i64,
        author_json: Option<String>,
        leases: LeaseRegistry,
        self_writes: SelfWriteSuppression,
        provenance: CaptureProvenance,
    ) -> Self {
        let shadow_root = shadow_root.into();
        // Bind before reading any root-scoped policy. A failed bind rejects
        // this generation instead of letting a later directory inherit the
        // absent root's default policy snapshot.
        let captured_root = CapturedRoot::bind(&shadow_root).map(Arc::new);
        Self::new_with_captured_root(
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
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_with_bound_root(
        actor: ActorHandle,
        workspace_id: impl Into<String>,
        version_id: impl Into<String>,
        shadow_root: impl Into<PathBuf>,
        captured_root: Arc<CapturedRoot>,
        now_ms: i64,
        author_json: Option<String>,
        leases: LeaseRegistry,
        self_writes: SelfWriteSuppression,
        provenance: CaptureProvenance,
    ) -> Self {
        Self::new_with_captured_root(
            actor,
            workspace_id,
            version_id,
            shadow_root.into(),
            Ok(captured_root),
            now_ms,
            author_json,
            leases,
            self_writes,
            provenance,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new_with_captured_root(
        actor: ActorHandle,
        workspace_id: impl Into<String>,
        version_id: impl Into<String>,
        shadow_root: PathBuf,
        captured_root: Result<Arc<CapturedRoot>, CaptureError>,
        now_ms: i64,
        author_json: Option<String>,
        leases: LeaseRegistry,
        self_writes: SelfWriteSuppression,
        provenance: CaptureProvenance,
    ) -> Self {
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
            workspace_id: workspace_id.into(),
            version_id: version_id.into(),
            shadow_root,
            captured_root,
            now_ms,
            author_json,
            search_policy: snapshot,
            files_policy,
            policy_held: std::cell::Cell::new(false),
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

    /// Refresh collection detection and record bindings after a clean capture
    /// pass. Adoption uses the runtime's ordinary Y.Doc update + settle path,
    /// including durable replication journaling and self-write suppression.
    pub(crate) fn reconcile_collections(&self) -> Result<Vec<String>, RuntimeError> {
        let root_guard = self.root_guard().map_err(|_| RuntimeError::Identity {
            reason: "workspace root changed during capture",
            source: None,
        })?;
        self.actor.reconcile_collections_blocking_guarded(
            self.workspace_id.clone(),
            self.version_id.clone(),
            self.shadow_root.clone(),
            self.leases.clone(),
            Arc::new(self.self_writes.clone()),
            self.now_ms,
            Arc::new(NoFaults),
            root_guard,
        )
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
            Ok(_) => Ok(DomainIngest::Persisted),
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
                        Ok(_) | Err(RuntimeError::Domain(DomainError::CaptureNotOwned)) => {
                            Ok(IngestOutcome::Captured { size, sha256 })
                        }
                        Err(RuntimeError::Domain(DomainError::InvalidPath { .. })) => {
                            Ok(IngestOutcome::NotOwned)
                        }
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
            // Known gap, tracked as #1023. This branch only runs when
            // the diff emitted an op for the path. A policy flip on an
            // unchanged file emits none (`.dohc` is unwatched, so policy
            // edits generate no events), so a path narrowed out of ownership
            // keeps its stale head until the driver rebuilds the controller
            // with an empty manifest on a policy-snapshot change and re-offers
            // every path through here.
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
    // Collection schemas are a reserved engine control file. The generic
    // scanner deliberately classifies unknown extensions as binary, but
    // collection discovery reads this YAML from the plaintext store.
    let text_media = path.rsplit('/').next() == Some(COLLECTION_SCHEMA_FILENAME)
        || is_text_media_type(media_type, path);
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
mod tests {
    use super::*;
    use dohc_engine_collab::{ContentKind, Ydoc};
    use dohc_engine_domain::{
        CollectionQuery, CollectionQueryResult, CollectionRecordDetails, MAX_TEXT_BYTES,
        RECORD_ID_FRONTMATTER_KEY, SecretDiskIntent, SecretFileStore, SecretWrite,
        VersionedTextStore, decline_oversized_collection_adoption_in_tx, get_collection_record,
        is_record_id, query_collection_records,
    };
    use dohc_engine_files::{
        CancellationToken, CaptureOp, ReconcilePlan, ScanGeneration, apply_reconcile_plan,
    };
    use dohc_engine_runtime::WorkspaceSupervisor;
    use dohc_engine_storage::{EngineStore, NoFaults as FilesNoFaults};
    use dohc_engine_testkit::ScratchDir;
    use proptest::prelude::*;
    use rusqlite::{Connection, OptionalExtension};
    use std::sync::Condvar;
    use std::time::Duration;

    const WORKSPACE_ID: &str = "ws-capture-sink";
    const VERSION_ID: &str = "main";

    fn sink_for(
        scratch: &ScratchDir,
        supervisor: &WorkspaceSupervisor,
    ) -> (PathBuf, StoreCaptureSink) {
        let db = dohc_engine_testkit::engine_db_path(scratch).expect("engine db path");
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        (
            db,
            StoreCaptureSink::new(actor, WORKSPACE_ID, VERSION_ID, scratch.path(), 10, None),
        )
    }

    fn write_file(root: &Path, path: &str, bytes: &[u8]) {
        let absolute = root.join(path);
        if let Some(parent) = absolute.parent() {
            std::fs::create_dir_all(parent).expect("create file parent");
        }
        std::fs::write(absolute, bytes).expect("write fixture");
    }

    fn durable_row_counts(db: &Path) -> Vec<(&'static str, i64)> {
        const TABLES: &[&str] = &[
            "file_objects",
            "blobs",
            "path_aliases",
            "snapshots",
            "moments",
            "materialization_jobs",
            "ydoc_docs",
            "ydoc_updates",
            "collections",
            "collection_records",
            "collection_record_fields",
            "collection_field_history",
            "collection_relation_edges",
        ];
        let conn = Connection::open(db).expect("open durable state database");
        TABLES
            .iter()
            .map(|table| {
                let count = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .expect("count durable rows");
                (*table, count)
            })
            .collect()
    }

    struct PausedRootGuard {
        root: CapturedRoot,
        pause_on_validation: usize,
        validations: std::sync::atomic::AtomicUsize,
        reached: (Mutex<bool>, Condvar),
        released: (Mutex<bool>, Condvar),
    }

    impl PausedRootGuard {
        fn new(root: &Path) -> Arc<Self> {
            Self::pausing_on(root, 1)
        }

        fn pausing_on(root: &Path, pause_on_validation: usize) -> Arc<Self> {
            Arc::new(Self {
                root: CapturedRoot::bind(root).expect("bind paused root guard"),
                pause_on_validation,
                validations: std::sync::atomic::AtomicUsize::new(0),
                reached: (Mutex::new(false), Condvar::new()),
                released: (Mutex::new(false), Condvar::new()),
            })
        }

        fn wait_until_reached(&self) {
            let reached = self.reached.0.lock().expect("lock reached state");
            let (reached, timeout) = self
                .reached
                .1
                .wait_timeout_while(reached, Duration::from_secs(10), |reached| !*reached)
                .expect("wait for actor root validation");
            assert!(*reached, "actor did not validate the queued root guard");
            assert!(!timeout.timed_out(), "actor root validation timed out");
        }

        fn release(&self) {
            let mut released = self.released.0.lock().expect("lock release state");
            *released = true;
            self.released.1.notify_all();
        }
    }

    impl WorkspaceRootGuard for PausedRootGuard {
        fn validate(&self, root_dir: &Path) -> Result<(), RuntimeError> {
            let validation = self
                .validations
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
                + 1;
            if validation != self.pause_on_validation {
                return self.root.validate(root_dir);
            }
            {
                let mut reached = self.reached.0.lock().expect("lock reached state");
                *reached = true;
                self.reached.1.notify_all();
            }
            let released = self.released.0.lock().expect("lock release state");
            let (released, timeout) = self
                .released
                .1
                .wait_timeout_while(released, Duration::from_secs(10), |released| !*released)
                .expect("wait for root replacement");
            if timeout.timed_out() || !*released {
                return Err(RuntimeError::Identity {
                    reason: "test root guard release timed out",
                    source: None,
                });
            }
            self.root.validate(root_dir)
        }
    }

    #[test]
    fn parallel_added_text_preparation_preserves_the_ordered_text_prefix() {
        let scratch = ScratchDir::new().expect("scratch");
        write_file(scratch.path(), "a.md", b"alpha");
        write_file(scratch.path(), "b.md", b"bravo");
        write_file(scratch.path(), "c.png", b"binary route");
        write_file(scratch.path(), "d.md", b"discarded suffix");
        let captured_root = CapturedRoot::bind(scratch.path()).expect("captured root");
        let candidates = [
            AddedTextCandidate {
                path: "a.md",
                media_type: "text/markdown",
            },
            AddedTextCandidate {
                path: "b.md",
                media_type: "text/markdown",
            },
            AddedTextCandidate {
                path: "c.png",
                media_type: "image/png",
            },
            AddedTextCandidate {
                path: "d.md",
                media_type: "text/markdown",
            },
        ];

        let PreparedTextPrefix::Ready(prepared) =
            prepare_added_text_prefix_parallel(scratch.path(), &captured_root, &candidates)
        else {
            panic!("the leading text files should form a batch prefix");
        };

        assert_eq!(prepared.len(), 2);
        assert_eq!(prepared[0].text, "alpha");
        assert_eq!(prepared[0].sha256, hex_sha256(b"alpha"));
        assert_eq!(prepared[1].text, "bravo");
        assert_eq!(prepared[1].sha256, hex_sha256(b"bravo"));
        assert!(matches!(
            prepare_added_text_prefix_parallel(scratch.path(), &captured_root, &candidates[2..],),
            PreparedTextPrefix::FallbackFirst
        ));
    }

    #[test]
    fn parallel_root_mismatch_discards_an_already_prepared_prefix() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let scratch = ScratchDir::new().expect("scratch");
        let root = scratch.path().to_path_buf();
        let moved_root = root.with_file_name(format!(
            "{}-moved",
            root.file_name().expect("root name").to_string_lossy()
        ));
        write_file(&root, "a.md", b"alpha");
        write_file(&root, "b.md", b"bravo");
        let captured_root = CapturedRoot::bind(&root).expect("captured root");
        let candidates = [
            AddedTextCandidate {
                path: "a.md",
                media_type: "text/markdown",
            },
            AddedTextCandidate {
                path: "b.md",
                media_type: "text/markdown",
            },
        ];
        let first_prepared = AtomicBool::new(false);
        let swapped = AtomicBool::new(false);

        let prepared = prepare_added_text_prefix_parallel_with(
            &candidates,
            |candidate| {
                if candidate.path == "a.md" {
                    first_prepared.store(true, Ordering::Release);
                    return Ok(CurrentContent::Text("alpha".to_owned()));
                }
                while !first_prepared.load(Ordering::Acquire) {
                    std::thread::yield_now();
                }
                if !swapped.swap(true, Ordering::AcqRel) {
                    std::fs::rename(&root, &moved_root).expect("move original capture root");
                    std::fs::create_dir(&root).expect("recreate capture root");
                    write_file(&root, "b.md", b"replacement workspace content");
                }
                read_current_with_canonical_root(
                    &root,
                    &captured_root,
                    candidate.path,
                    candidate.media_type,
                )
            },
            || captured_root.still_names(&root),
        );

        std::fs::remove_dir_all(&root).expect("remove replacement capture root");
        std::fs::rename(&moved_root, &root).expect("restore original capture root");
        assert!(matches!(
            prepared,
            PreparedTextPrefix::RootMismatch { attempted: 2 }
        ));
    }

    #[test]
    fn parallel_path_escape_falls_back_without_poisoning_sibling_progress() {
        let candidates = [
            AddedTextCandidate {
                path: "a.md",
                media_type: "text/markdown",
            },
            AddedTextCandidate {
                path: "linked/b.md",
                media_type: "text/markdown",
            },
            AddedTextCandidate {
                path: "c.md",
                media_type: "text/markdown",
            },
        ];
        let read = |candidate: AddedTextCandidate<'_>| match candidate.path {
            "linked/b.md" => Err(ESCAPES_ROOT),
            path => Ok(CurrentContent::Text(path.to_owned())),
        };

        let first = prepare_added_text_prefix_parallel_with(&candidates, read, || true);
        let PreparedTextPrefix::Ready(first) = first else {
            panic!("the good prefix must remain committable");
        };
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].text, "a.md");

        assert!(matches!(
            prepare_added_text_prefix_parallel_with(&candidates[1..], read, || true),
            PreparedTextPrefix::FallbackFirst
        ));
        let PreparedTextPrefix::Ready(last) =
            prepare_added_text_prefix_parallel_with(&candidates[2..], read, || true)
        else {
            panic!("the good suffix must progress after the refused path");
        };
        assert_eq!(last.len(), 1);
        assert_eq!(last[0].text, "c.md");
    }

    fn ingest(sink: &mut StoreCaptureSink, path: &str) -> Result<IngestOutcome, CaptureError> {
        ingest_as(sink, path, "text/markdown")
    }

    fn ingest_as(
        sink: &mut StoreCaptureSink,
        path: &str,
        media_type: &str,
    ) -> Result<IngestOutcome, CaptureError> {
        sink.ingest(path, 0, "advisory-sha", media_type, IngestReason::Changed)
    }

    fn seed_captured_richdoc_lineage(sink: &StoreCaptureSink, path: &str) {
        let markdown = std::fs::read_to_string(sink.shadow_root.join(path))
            .unwrap_or_else(|_| panic!("read captured rich-document fixture {path}"));
        seed_captured_richdoc_lineage_from_markdown(sink, path, markdown);
    }

    fn seed_captured_richdoc_lineage_from_markdown(
        sink: &StoreCaptureSink,
        path: &str,
        markdown: String,
    ) {
        let actor = sink.actor.clone();
        let path = path.to_owned();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test rich-document runtime")
            .block_on(async move {
                let state = actor
                    .ydoc_open_state(
                        WORKSPACE_ID.to_owned(),
                        11,
                        false,
                        None,
                        VERSION_ID.to_owned(),
                        path.clone(),
                        Some(ContentKind::Richdoc),
                        CancellationToken::new(),
                    )
                    .await
                    .expect("open captured rich-document fixture");
                assert!(
                    !state.lineage_existing,
                    "fixture must start without canonical Y.Doc lineage"
                );

                // These engine tests use the limited helper only to establish
                // simple fixture lineage. Production adoption imports through
                // the desktop's shared @dohc/ydoc-projection path.
                let doc = Ydoc::wire();
                doc.apply(&state.initial_update)
                    .expect("apply initial rich-document fixture state");
                doc.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
                    .expect("seed simple rich-document fixture");
                actor
                    .ydoc_record_update(
                        state.key,
                        path,
                        ContentKind::Richdoc,
                        state.regime,
                        doc.encode_full_state(),
                        None,
                        None,
                        state.lineage_claim_id,
                        true,
                        state.head_blob_sha256,
                        None,
                        12,
                        Arc::new(FilesNoFaults),
                        CancellationToken::new(),
                    )
                    .await
                    .expect("record simple rich-document fixture seed");
            });
    }

    fn set_richdoc_frontmatter_and_settle(
        sink: &StoreCaptureSink,
        path: &str,
        field: &str,
        value: &str,
    ) {
        let actor = sink.actor.clone();
        let root_dir = sink.shadow_root.clone();
        let self_writes = Arc::new(sink.self_writes.clone());
        let path = path.to_owned();
        let field = field.to_owned();
        let value = value.to_owned();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test rich-document edit runtime")
            .block_on(async move {
                let state = actor
                    .ydoc_open_state(
                        WORKSPACE_ID.to_owned(),
                        13,
                        false,
                        None,
                        VERSION_ID.to_owned(),
                        path.clone(),
                        Some(ContentKind::Richdoc),
                        CancellationToken::new(),
                    )
                    .await
                    .expect("open existing rich-document fixture");
                assert!(state.lineage_existing, "fixture must already be adopted");
                let doc = Ydoc::wire();
                doc.apply(&state.initial_update)
                    .expect("apply existing rich-document state");
                let update = doc.frontmatter_set(&field, &value);
                let append = actor
                    .ydoc_record_update(
                        state.key.clone(),
                        path.clone(),
                        ContentKind::Richdoc,
                        state.regime,
                        update,
                        None,
                        None,
                        state.lineage_claim_id,
                        false,
                        None,
                        None,
                        14,
                        Arc::new(FilesNoFaults),
                        CancellationToken::new(),
                    )
                    .await
                    .expect("record rich-document frontmatter edit");
                actor
                    .ydoc_settle(
                        root_dir,
                        state.key,
                        path,
                        ContentKind::Richdoc,
                        append.lineage_claim_id,
                        state.head_blob_sha256,
                        "capture-sink-frontmatter-edit".to_owned(),
                        self_writes,
                        15,
                        Arc::new(FilesNoFaults),
                        CancellationToken::new(),
                    )
                    .await
                    .expect("settle rich-document frontmatter edit");
            });
    }

    fn enable_sync_for_collection_test(db: &Path) {
        let connection = Connection::open(db).expect("open collection test database");
        connection
            .execute(
                "INSERT INTO sync_identity \
                 (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                 VALUES (?1, 'local-origin', 'epoch', 'stream', 1)",
                [WORKSPACE_ID],
            )
            .expect("seed collection test sync identity");
        connection
            .execute(
                "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
                 VALUES (?1, 'local-origin', 0)",
                [WORKSPACE_ID],
            )
            .expect("enable collection test sync");
    }

    fn snapshot(db: &Path, path: &str) -> Option<dohc_engine_domain::TextSnapshot> {
        let mut store = EngineStore::open(db, 100).expect("reopen store");
        VersionedTextStore::new(&mut store)
            .read_text(WORKSPACE_ID, VERSION_ID, path)
            .expect("read captured text")
    }

    /// The current binary head's sha256 for `path`, if the head is binary.
    fn binary_head(db: &Path, path: &str) -> Option<String> {
        use rusqlite::OptionalExtension;
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT s.binary_sha256 FROM snapshots s \
                     JOIN path_aliases a ON a.workspace_id = s.workspace_id \
                       AND a.version_id = s.version_id AND a.object_id = s.object_id \
                     WHERE s.workspace_id = ?1 AND a.path = ?2 \
                       AND s.content_kind = 'binary'",
                    [WORKSPACE_ID, path],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
            })
            .expect("binary head query")
            .flatten()
    }

    /// The encrypted tip's plaintext byte length for a secret path (metadata
    /// only — the test never decrypts).
    fn secret_tip_len(db: &Path, path: &str) -> Option<i64> {
        use rusqlite::OptionalExtension;
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT byte_length FROM secret_files WHERE workspace_id = ?1 AND path = ?2",
                    [WORKSPACE_ID, path],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
            })
            .expect("secret tip query")
    }

    fn secret_tip_capture_owned(db: &Path, path: &str) -> Option<bool> {
        use rusqlite::OptionalExtension;
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT m.capture_owned FROM secret_files f \
                     JOIN secret_moments m ON m.workspace_id = f.workspace_id \
                       AND m.moment_id = f.latest_moment_id \
                     WHERE f.workspace_id = ?1 AND f.version_id = ?2 AND f.path = ?3",
                    [WORKSPACE_ID, VERSION_ID, path],
                    |row| row.get::<_, bool>(0),
                )
                .optional()
            })
            .expect("secret ownership query")
    }

    fn moment_count(db: &Path, path: &str) -> i64 {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 AND path = ?2",
                    [WORKSPACE_ID, path],
                    |row| row.get(0),
                )
            })
            .expect("moment count")
    }

    fn collection_record(db: &Path, path: &str) -> Option<(Option<String>, String)> {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT record_id, adoption_state FROM collection_records \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND file_path = ?3",
                    [WORKSPACE_ID, VERSION_ID, path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
            })
            .expect("collection record")
    }

    fn adopted_record_id(db: &Path, path: &str) -> String {
        let (record_id, state) = collection_record(db, path).expect("record binding");
        assert_eq!(state, "adopted");
        let record_id = record_id.expect("adopted record id");
        assert!(is_record_id(&record_id), "WP1 record id format");
        record_id
    }

    fn query_collection(db: &Path, path: &str, resolve_relations: bool) -> CollectionQueryResult {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                query_collection_records(
                    conn,
                    WORKSPACE_ID,
                    path,
                    &CollectionQuery {
                        resolve_relations,
                        ..CollectionQuery::default()
                    },
                )
            })
            .expect("query collection")
            .expect("collection exists")
    }

    fn get_record(db: &Path, collection_path: &str, record_id: &str) -> CollectionRecordDetails {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                get_collection_record(conn, WORKSPACE_ID, collection_path, record_id, 100, None)
            })
            .expect("get collection record")
            .expect("record exists")
    }

    fn collection_status(db: &Path, path: &str) -> Option<(String, String)> {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT schema_status, degradation_reasons_json FROM collections \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND collection_path = ?3",
                    [WORKSPACE_ID, VERSION_ID, path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
            })
            .expect("collection status")
    }

    fn indexed_collection_field(
        db: &Path,
        path: &str,
        field: &str,
    ) -> Option<(String, String, Option<String>)> {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT f.value_json,f.validation_status,f.validation_reason_json \
                     FROM collection_record_fields f \
                     JOIN collection_records r ON r.workspace_id=f.workspace_id \
                       AND r.version_id=f.version_id AND r.record_id=f.record_id \
                     WHERE r.workspace_id=?1 AND r.version_id=?2 AND r.file_path=?3 \
                       AND f.field_name=?4",
                    rusqlite::params![WORKSPACE_ID, VERSION_ID, path, field],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
            })
            .expect("indexed collection field")
    }

    fn relation_edge_count(db: &Path, source_path: &str, field: &str, target: &str) -> i64 {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM collection_relation_edges e \
                     JOIN collection_records r ON r.workspace_id=e.workspace_id \
                       AND r.version_id=e.version_id AND r.record_id=e.source_record_id \
                     WHERE r.workspace_id=?1 AND r.version_id=?2 AND r.file_path=?3 \
                       AND e.field_name=?4 AND e.target_record_id=?5",
                    rusqlite::params![WORKSPACE_ID, VERSION_ID, source_path, field, target],
                    |row| row.get(0),
                )
            })
            .expect("relation edge count")
    }

    fn latest_field_history(
        db: &Path,
        source_path: &str,
        field: &str,
    ) -> (Option<String>, Option<String>, Option<String>) {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT h.previous_value_json,h.next_value_json,h.author_origin_id \
                     FROM collection_field_history h \
                     JOIN collection_records r ON r.workspace_id=h.workspace_id \
                       AND r.version_id=h.version_id AND r.record_id=h.record_id \
                     WHERE r.workspace_id=?1 AND r.version_id=?2 AND r.file_path=?3 \
                       AND h.field_name=?4 ORDER BY h.history_id DESC LIMIT 1",
                    rusqlite::params![WORKSPACE_ID, VERSION_ID, source_path, field],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .expect("latest collection field history")
    }

    fn latest_ydoc_actor_origin(db: &Path, path: &str) -> Option<String> {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT u.actor_origin_id FROM ydoc_updates u \
                     JOIN collection_records r ON r.workspace_id = u.workspace_id \
                       AND r.version_id = u.version_id AND r.object_id = u.object_id \
                     WHERE r.workspace_id = ?1 AND r.version_id = ?2 AND r.file_path = ?3 \
                     ORDER BY u.seq DESC LIMIT 1",
                    [WORKSPACE_ID, VERSION_ID, path],
                    |row| row.get(0),
                )
                .optional()
                .map(Option::flatten)
            })
            .expect("Y.Doc actor origin")
    }

    fn ydoc_update_count(db: &Path, path: &str) -> i64 {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates u \
                     JOIN collection_records r ON r.workspace_id = u.workspace_id \
                       AND r.version_id = u.version_id AND r.object_id = u.object_id \
                     WHERE r.workspace_id = ?1 AND r.version_id = ?2 AND r.file_path = ?3",
                    [WORKSPACE_ID, VERSION_ID, path],
                    |row| row.get(0),
                )
            })
            .expect("Y.Doc update count")
    }

    fn ydoc_update_count_for_object(db: &Path, path: &str) -> i64 {
        let object_id = snapshot(db, path).expect("Y.Doc object snapshot").object_id;
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                    [WORKSPACE_ID, VERSION_ID, object_id.as_str()],
                    |row| row.get(0),
                )
            })
            .expect("Y.Doc object update count")
    }

    fn engine_ydoc_update_count(db: &Path, path: &str) -> i64 {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates u \
                     JOIN collection_records r ON r.workspace_id = u.workspace_id \
                       AND r.version_id = u.version_id AND r.object_id = u.object_id \
                     WHERE r.workspace_id = ?1 AND r.version_id = ?2 AND r.file_path = ?3 \
                       AND u.actor_origin_id = 'engine'",
                    [WORKSPACE_ID, VERSION_ID, path],
                    |row| row.get(0),
                )
            })
            .expect("engine Y.Doc update count")
    }

    #[derive(Clone, Copy, Debug)]
    enum GeneratedFrontmatter {
        None,
        Valid,
        Malformed,
    }

    #[derive(Clone, Debug)]
    struct GeneratedAdoptionCase {
        markdown: String,
        frontmatter: GeneratedFrontmatter,
        first_line_len: Option<usize>,
        line_ending: &'static str,
        replicated: bool,
        id_collision_copy: bool,
    }

    impl GeneratedAdoptionCase {
        fn expected_adoption(&self, record_id: &str) -> Option<String> {
            match self.frontmatter {
                GeneratedFrontmatter::Malformed => None,
                GeneratedFrontmatter::Valid => {
                    let first_line_len = self.first_line_len.expect("frontmatter opener");
                    let mut adopted = String::with_capacity(
                        self.markdown.len() + RECORD_ID_FRONTMATTER_KEY.len() + record_id.len() + 3,
                    );
                    adopted.push_str(&self.markdown[..first_line_len]);
                    adopted.push_str(RECORD_ID_FRONTMATTER_KEY);
                    adopted.push_str(": ");
                    adopted.push_str(record_id);
                    adopted.push_str(self.line_ending);
                    adopted.push_str(&self.markdown[first_line_len..]);
                    Some(adopted)
                }
                GeneratedFrontmatter::None => {
                    let mut adopted = String::new();
                    adopted.push_str("---");
                    adopted.push_str(self.line_ending);
                    adopted.push_str(RECORD_ID_FRONTMATTER_KEY);
                    adopted.push_str(": ");
                    adopted.push_str(record_id);
                    adopted.push_str(self.line_ending);
                    adopted.push_str("---");
                    if !self.markdown.is_empty() {
                        adopted.push_str(self.line_ending);
                        adopted.push_str(self.line_ending);
                        adopted.push_str(&self.markdown);
                    }
                    Some(adopted)
                }
            }
        }
    }

    fn collection_adoption_cases() -> impl Strategy<Value = GeneratedAdoptionCase> {
        (
            0u8..3,
            prop::bool::ANY,
            0u8..3,
            0u8..3,
            any::<bool>(),
            any::<i32>(),
            prop::collection::vec(
                any::<char>().prop_filter("body line content", |character| {
                    !matches!(character, '\r' | '\n')
                }),
                0..96,
            ),
            prop::collection::vec(
                any::<char>().prop_filter("table cell line content", |character| {
                    !matches!(character, '\r' | '\n')
                }),
                0..32,
            ),
            prop::bool::ANY,
            prop::bool::ANY,
            prop::bool::ANY,
        )
            .prop_map(
                |(
                    frontmatter_kind,
                    crlf,
                    opener_whitespace,
                    closer_whitespace,
                    done,
                    estimate,
                    paragraph_chars,
                    cell_chars,
                    trailing_newline,
                    replicated,
                    id_collision_copy,
                )| {
                    let line_ending = if crlf { "\r\n" } else { "\n" };
                    let whitespace = |kind| match kind {
                        0 => "",
                        1 => " ",
                        _ => "\t",
                    };
                    let paragraph: String = paragraph_chars.into_iter().collect();
                    let cell: String = cell_chars.into_iter().collect();
                    let mut body = format!(
                        "Paragraph: {paragraph}{line_ending}{line_ending}| Key | Value |{line_ending}| --- | --- |{line_ending}| generated | {cell} |{line_ending}{line_ending}**bold** _italic_ `code` [link](https://example.com)"
                    );
                    if trailing_newline {
                        body.push_str(line_ending);
                    }

                    let frontmatter = match frontmatter_kind {
                        0 => GeneratedFrontmatter::None,
                        1 => GeneratedFrontmatter::Valid,
                        _ => GeneratedFrontmatter::Malformed,
                    };
                    if matches!(frontmatter, GeneratedFrontmatter::None) {
                        return GeneratedAdoptionCase {
                            markdown: body,
                            frontmatter,
                            first_line_len: None,
                            line_ending,
                            replicated,
                            id_collision_copy,
                        };
                    }

                    let opener = format!("---{}{line_ending}", whitespace(opener_whitespace));
                    let yaml = if matches!(frontmatter, GeneratedFrontmatter::Valid) {
                        format!(
                            "done: {done}{line_ending}estimate: {estimate}{line_ending}tags: [alpha, beta]{line_ending}nested:{line_ending}  enabled: true{line_ending}"
                        )
                    } else {
                        format!("broken: [{line_ending}")
                    };
                    let closer = format!("---{}", whitespace(closer_whitespace));
                    let eof_shape = (opener_whitespace + closer_whitespace) % 3;
                    let markdown = match eof_shape {
                        0 => format!("{opener}{yaml}{closer}"),
                        1 => format!("{opener}{yaml}{closer}{line_ending}"),
                        _ => format!(
                            "{opener}{yaml}{closer}{line_ending}{line_ending}{body}"
                        ),
                    };
                    GeneratedAdoptionCase {
                        first_line_len: Some(opener.len()),
                        markdown,
                        frontmatter,
                        line_ending,
                        replicated,
                        id_collision_copy,
                    }
                },
            )
    }

    proptest! {
        // The repository default is 256 cases and honors PROPTEST_CASES.
        #![proptest_config(ProptestConfig::default())]

        #[test]
        fn collection_record_adoption_is_lossless_or_side_effect_free(
            case in collection_adoption_cases()
        ) {
            let scratch = ScratchDir::new().expect("scratch");
            let supervisor = WorkspaceSupervisor::new();
            let (db, mut sink) = sink_for(&scratch, &supervisor);
            write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
            write_file(scratch.path(), "tasks/generated.md", case.markdown.as_bytes());
            ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
            ingest(&mut sink, "tasks/generated.md").expect("capture generated record");
            let original_moments = moment_count(&db, "tasks/generated.md");
            let original_updates = ydoc_update_count(&db, "tasks/generated.md");

            sink.reconcile_collections().expect("first adoption pass");
            if case.expected_adoption("placeholder").is_some() {
                if case.replicated {
                    enable_sync_for_collection_test(&db);
                }
                seed_captured_richdoc_lineage(&sink, "tasks/generated.md");
                sink.reconcile_collections().expect("seeded adoption pass");
            }

            let original_binding = collection_record(&db, "tasks/generated.md");
            if case.id_collision_copy
                && let Some((Some(original_id), state)) = original_binding.as_ref()
                && state == "adopted"
            {
                let original = std::fs::read_to_string(
                    scratch.path().join("tasks/generated.md"),
                )
                .expect("read adopted generated record");
                std::fs::copy(
                    scratch.path().join("tasks/generated.md"),
                    scratch.path().join("tasks/generated-copy.md"),
                )
                .expect("copy adopted generated record");
                ingest(&mut sink, "tasks/generated-copy.md").expect("capture generated copy");
                seed_captured_richdoc_lineage(&sink, "tasks/generated-copy.md");
                sink.reconcile_collections().expect("adopt generated copy");

                let copy_id = adopted_record_id(&db, "tasks/generated-copy.md");
                prop_assert_ne!(copy_id.as_str(), original_id.as_str());
                let id_line = format!("id: {original_id}{}", case.line_ending);
                let replacement = format!("id: {copy_id}{}", case.line_ending);
                let expected_copy = original.replacen(&id_line, &replacement, 1);
                prop_assert_ne!(expected_copy.as_str(), original.as_str());
                let copy_disk = std::fs::read_to_string(
                    scratch.path().join("tasks/generated-copy.md"),
                )
                .expect("read adopted generated copy");
                let copy_stored = snapshot(&db, "tasks/generated-copy.md")
                    .expect("generated copy snapshot");
                prop_assert_eq!(copy_disk.as_str(), expected_copy.as_str());
                prop_assert_eq!(copy_stored.text.as_str(), expected_copy.as_str());
                let original_after_copy =
                    std::fs::read_to_string(scratch.path().join("tasks/generated.md"))
                        .expect("reread adopted generated record");
                prop_assert_eq!(original_after_copy.as_str(), original.as_str());
            }

            let disk = std::fs::read(scratch.path().join("tasks/generated.md"))
                .expect("read generated record");
            let stored = snapshot(&db, "tasks/generated.md").expect("generated snapshot");
            let binding = collection_record(&db, "tasks/generated.md");
            let final_moments = moment_count(&db, "tasks/generated.md");
            let final_updates = ydoc_update_count(&db, "tasks/generated.md");
            drop(sink);
            supervisor.close(&db).expect("close actor");

            match binding {
                Some((Some(record_id), state)) if state == "adopted" => {
                    let expected = case.expected_adoption(&record_id).unwrap_or_else(|| {
                        panic!("malformed frontmatter must not acquire a binding")
                    });
                    prop_assert_eq!(disk.as_slice(), expected.as_bytes());
                    prop_assert_eq!(stored.text.as_bytes(), expected.as_bytes());
                    prop_assert_eq!(final_moments, original_moments + 1);
                    prop_assert_eq!(final_updates, original_updates + 2);
                }
                None => {
                    prop_assert!(case.expected_adoption("placeholder").is_none());
                    prop_assert_eq!(disk.as_slice(), case.markdown.as_bytes());
                    prop_assert_eq!(stored.text.as_bytes(), case.markdown.as_bytes());
                    prop_assert_eq!(final_moments, original_moments);
                    prop_assert_eq!(final_updates, original_updates);
                }
                third => {
                    prop_assert!(false, "forbidden adoption outcome: {third:?}");
                }
            }
        }
    }

    #[test]
    fn frontmatterless_collection_adoption_preserves_leading_blank_lines_and_markdown_bytes() {
        const MARKDOWN: &str = "\n\n| Key | Value |\n| --- | --- |\n| generated |  |\n\n**bold** _italic_ `code` [link](https://example.com)";

        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        write_file(scratch.path(), "tasks/generated.md", MARKDOWN.as_bytes());
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/generated.md").expect("capture generated record");

        sink.reconcile_collections().expect("first adoption pass");
        seed_captured_richdoc_lineage(&sink, "tasks/generated.md");
        sink.reconcile_collections().expect("seeded adoption pass");

        let (record_id, state) = collection_record(&db, "tasks/generated.md")
            .and_then(|(record_id, state)| record_id.map(|record_id| (record_id, state)))
            .expect("adopted collection record");
        assert_eq!(state, "adopted");
        let expected = format!("---\nid: {record_id}\n---\n\n{MARKDOWN}");
        assert_eq!(
            std::fs::read(scratch.path().join("tasks/generated.md")).expect("read adopted record"),
            expected.as_bytes()
        );
        assert_eq!(
            snapshot(&db, "tasks/generated.md")
                .expect("adopted snapshot")
                .text,
            expected
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn oversized_lossless_collection_adoption_declines_visibly_without_retrying() {
        const RECORD_ID_BYTES: usize = "rec_".len() + 26;
        const INSERTED_FRONTMATTER_BYTES: usize = "---\nid: \n---\n\n".len() + RECORD_ID_BYTES;

        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        let markdown = "x".repeat(MAX_TEXT_BYTES - INSERTED_FRONTMATTER_BYTES);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        write_file(scratch.path(), "tasks/oversized.md", markdown.as_bytes());
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/oversized.md").expect("capture oversized record");
        sink.reconcile_collections().expect("first adoption pass");
        let canonical_padding = "x".repeat(MAX_TEXT_BYTES - 64);
        seed_captured_richdoc_lineage_from_markdown(
            &sink,
            "tasks/oversized.md",
            format!("---\npadding: {canonical_padding}\n---"),
        );
        let moments_before = moment_count(&db, "tasks/oversized.md");
        let updates_before = ydoc_update_count_for_object(&db, "tasks/oversized.md");

        assert!(
            sink.reconcile_collections()
                .expect("decline oversized adoption")
                .is_empty()
        );
        assert_eq!(collection_record(&db, "tasks/oversized.md"), None);
        assert_eq!(
            collection_status(&db, "tasks"),
            Some((
                "degraded".to_owned(),
                "[{\"code\":\"record-too-large-for-adoption\",\"path\":\"tasks/oversized.md\"}]"
                    .to_owned(),
            ))
        );
        assert_eq!(
            std::fs::read(scratch.path().join("tasks/oversized.md")).expect("read declined record"),
            markdown.as_bytes()
        );
        assert_eq!(
            snapshot(&db, "tasks/oversized.md")
                .expect("declined record snapshot")
                .text,
            markdown
        );
        assert_eq!(moment_count(&db, "tasks/oversized.md"), moments_before);
        assert_eq!(
            ydoc_update_count_for_object(&db, "tasks/oversized.md"),
            updates_before
        );

        assert!(
            sink.reconcile_collections()
                .expect("repeat declined adoption reconciliation")
                .is_empty()
        );
        assert_eq!(collection_record(&db, "tasks/oversized.md"), None);
        assert_eq!(moment_count(&db, "tasks/oversized.md"), moments_before);
        assert_eq!(
            ydoc_update_count_for_object(&db, "tasks/oversized.md"),
            updates_before
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn oversized_collection_adoption_retries_after_watcher_shrinks_record() {
        const RECORD_ID_BYTES: usize = "rec_".len() + 26;
        const INSERTED_ID_LINE_BYTES: usize = "id: \n".len() + RECORD_ID_BYTES;
        const SHRUNK: &str = "---\ntitle: Small enough now\n---\n";

        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        let wrapper_bytes = "---\npadding: \n---".len();
        let oversized = format!(
            "---\npadding: {}\n---",
            "x".repeat(MAX_TEXT_BYTES - INSERTED_ID_LINE_BYTES + 1 - wrapper_bytes)
        );
        assert_eq!(oversized.len() + INSERTED_ID_LINE_BYTES, MAX_TEXT_BYTES + 1);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        write_file(scratch.path(), "tasks/oversized.md", oversized.as_bytes());
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/oversized.md").expect("capture oversized record");
        assert!(
            sink.reconcile_collections()
                .expect("bind oversized adoption")
                .is_empty()
        );
        let record_id = collection_record(&db, "tasks/oversized.md")
            .and_then(|(record_id, state)| {
                (state == "pending-lossless").then_some(record_id).flatten()
            })
            .expect("pending oversized adoption");
        let mut connection = Connection::open(&db).expect("open decline connection");
        let transaction = connection.transaction().expect("begin decline transaction");
        decline_oversized_collection_adoption_in_tx(
            &transaction,
            WORKSPACE_ID,
            VERSION_ID,
            "tasks",
            "tasks/oversized.md",
            &record_id,
        )
        .expect("persist oversized decline");
        transaction.commit().expect("commit oversized decline");
        drop(connection);
        assert!(
            sink.reconcile_collections()
                .expect("retain oversized decline")
                .is_empty()
        );
        assert_eq!(collection_record(&db, "tasks/oversized.md"), None);

        write_file(scratch.path(), "tasks/oversized.md", SHRUNK.as_bytes());
        ingest(&mut sink, "tasks/oversized.md").expect("capture watcher shrink");
        assert!(
            sink.reconcile_collections()
                .expect("re-offer repaired adoption")
                .is_empty()
        );
        seed_captured_richdoc_lineage(&sink, "tasks/oversized.md");
        assert_eq!(
            sink.reconcile_collections()
                .expect("retry repaired adoption"),
            ["tasks/oversized.md"]
        );

        let (adopted_record_id, state) = collection_record(&db, "tasks/oversized.md")
            .and_then(|(record_id, state)| record_id.map(|record_id| (record_id, state)))
            .expect("adopted repaired record");
        assert_eq!(state, "adopted");
        assert_eq!(
            collection_status(&db, "tasks"),
            Some(("valid".to_owned(), "[]".to_owned()))
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/oversized.md"))
                .expect("read adopted repaired record"),
            format!("---\nid: {adopted_record_id}\ntitle: Small enough now\n---\n")
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn collection_adoption_writes_one_engine_id_and_self_write_does_not_loop() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        write_file(scratch.path(), "tasks/alpha.md", b"Alpha task\n");
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/alpha.md").expect("capture record");
        assert_eq!(moment_count(&db, "tasks/alpha.md"), 1);
        assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 0);
        seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");

        assert_eq!(
            sink.reconcile_collections().expect("adopt record"),
            ["tasks/alpha.md"]
        );
        let record_id = adopted_record_id(&db, "tasks/alpha.md");
        let written = std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
            .expect("read adopted artifact");
        assert!(written.contains(&record_id));
        assert_eq!(
            snapshot(&db, "tasks/alpha.md")
                .expect("adopted snapshot")
                .text,
            written
        );
        assert_eq!(
            moment_count(&db, "tasks/alpha.md"),
            2,
            "settlement journals the engine-authored projected file moment"
        );
        assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 2);
        assert_eq!(engine_ydoc_update_count(&db, "tasks/alpha.md"), 1);
        assert_eq!(
            latest_ydoc_actor_origin(&db, "tasks/alpha.md").as_deref(),
            Some("engine")
        );

        let written_sha = hex_sha256(written.as_bytes());
        assert!(
            sink.self_writes
                .has_pending(WORKSPACE_ID, "tasks/alpha.md", &written_sha),
            "the settle must arm watcher suppression before replacing the file"
        );
        ingest(&mut sink, "tasks/alpha.md").expect("consume self-write observation");
        assert!(
            !sink
                .self_writes
                .has_pending(WORKSPACE_ID, "tasks/alpha.md", &written_sha),
            "watcher suppression is single-shot"
        );
        assert_eq!(moment_count(&db, "tasks/alpha.md"), 2);
        assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 2);
        assert_eq!(engine_ydoc_update_count(&db, "tasks/alpha.md"), 1);
        assert!(
            sink.reconcile_collections()
                .expect("idempotent reconciliation")
                .is_empty()
        );
        assert_eq!(moment_count(&db, "tasks/alpha.md"), 2);
        assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 2);
        assert_eq!(engine_ydoc_update_count(&db, "tasks/alpha.md"), 1);

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn reserved_collection_schema_is_text_under_the_scanners_unknown_media_type() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");

        assert!(matches!(
            ingest_as(
                &mut sink,
                "tasks/collection.yaml",
                "application/octet-stream"
            )
            .expect("capture reserved collection schema"),
            IngestOutcome::Captured { .. }
        ));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(
            snapshot(&db, "tasks/collection.yaml")
                .expect("collection schema text snapshot")
                .text,
            "name: Tasks\n"
        );
        assert!(binary_head(&db, "tasks/collection.yaml").is_none());
    }

    #[test]
    fn collection_adoption_seeds_typed_frontmatter_and_multi_relation_edges() {
        const FIRST_TARGET_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        const SECOND_TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  estimate:\n    type: number\n  done:\n    type: checkbox\n  related:\n    type: relation\n    collection: tasks\n    many: true\n",
        );
        write_file(
            scratch.path(),
            "tasks/alpha.md",
            format!(
                "---\nestimate: 3\ndone: true\nrelated: [{FIRST_TARGET_ID}, {SECOND_TARGET_ID}]\n---\n\nAlpha\n"
            )
            .as_bytes(),
        );
        write_file(
            scratch.path(),
            "tasks/first.md",
            format!("---\nid: {FIRST_TARGET_ID}\n---\n\nFirst\n").as_bytes(),
        );
        write_file(
            scratch.path(),
            "tasks/second.md",
            format!("---\nid: {SECOND_TARGET_ID}\n---\n\nSecond\n").as_bytes(),
        );
        for path in [
            "tasks/collection.yaml",
            "tasks/alpha.md",
            "tasks/first.md",
            "tasks/second.md",
        ] {
            ingest(&mut sink, path).unwrap_or_else(|_| panic!("capture {path}"));
        }
        for path in ["tasks/alpha.md", "tasks/first.md", "tasks/second.md"] {
            seed_captured_richdoc_lineage(&sink, path);
        }

        sink.reconcile_collections().expect("adopt typed record");
        assert_eq!(
            indexed_collection_field(&db, "tasks/alpha.md", "estimate"),
            Some(("3".to_owned(), "valid".to_owned(), None))
        );
        assert_eq!(
            indexed_collection_field(&db, "tasks/alpha.md", "done"),
            Some(("true".to_owned(), "valid".to_owned(), None))
        );
        assert_eq!(
            indexed_collection_field(&db, "tasks/alpha.md", "related"),
            Some((
                format!("[\"{FIRST_TARGET_ID}\",\"{SECOND_TARGET_ID}\"]"),
                "valid".to_owned(),
                None,
            ))
        );
        for target in [FIRST_TARGET_ID, SECOND_TARGET_ID] {
            assert_eq!(
                relation_edge_count(&db, "tasks/alpha.md", "related", target),
                1,
                "adoption must preserve the edge to {target}"
            );
        }

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn imported_collection_record_with_an_existing_id_tracks_later_capture_edits() {
        const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  status:\n    type: text\n",
        );
        write_file(
            scratch.path(),
            "tasks/imported.md",
            format!("---\nid: {RECORD_ID}\nstatus: todo\n---\n\nImported").as_bytes(),
        );
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/imported.md").expect("capture imported record");
        seed_captured_richdoc_lineage(&sink, "tasks/imported.md");
        sink.reconcile_collections().expect("adopt imported record");
        assert_eq!(adopted_record_id(&db, "tasks/imported.md"), RECORD_ID);

        let adopted = std::fs::read_to_string(scratch.path().join("tasks/imported.md"))
            .expect("read adopted record");
        let edited = adopted.replace("status: todo", "status: done");
        assert_ne!(edited, adopted, "the fixture must edit the status field");
        write_file(scratch.path(), "tasks/imported.md", edited.as_bytes());
        ingest(&mut sink, "tasks/imported.md").expect("capture imported record edit");
        sink.reconcile_collections()
            .expect("reconcile imported record edit");

        let queried = query_collection(&db, "tasks", false);
        let record = queried
            .records
            .iter()
            .find(|record| record.id == RECORD_ID)
            .expect("imported record in collection query");
        let status = record
            .values
            .iter()
            .find(|value| value.field == "status")
            .expect("edited status in collection query");
        assert_eq!(status.value, serde_json::Value::String("done".to_owned()));

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn invalid_collection_value_roundtrips_and_schema_edit_only_revalidates() {
        const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        let record = format!("---\nid: {RECORD_ID}\nestimate: nope\n---\n\nTask body\n");
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  estimate:\n    type: number\n",
        );
        write_file(scratch.path(), "tasks/alpha.md", record.as_bytes());
        ingest(&mut sink, "tasks/collection.yaml").expect("capture number schema");
        ingest(&mut sink, "tasks/alpha.md").expect("capture invalid record");

        assert!(
            sink.reconcile_collections()
                .expect("index invalid value")
                .is_empty()
        );
        let indexed =
            indexed_collection_field(&db, "tasks/alpha.md", "estimate").expect("estimate indexed");
        assert_eq!(indexed.0, "\"nope\"");
        assert_eq!(indexed.1, "flagged");
        assert!(
            indexed
                .2
                .expect("validation reason")
                .contains("expected-number")
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
                .expect("read invalid artifact"),
            record,
            "validation must not rewrite the record"
        );

        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  estimate:\n    type: text\n",
        );
        ingest(&mut sink, "tasks/collection.yaml").expect("capture text schema");
        assert!(
            sink.reconcile_collections()
                .expect("revalidate existing index")
                .is_empty()
        );
        assert_eq!(
            indexed_collection_field(&db, "tasks/alpha.md", "estimate"),
            Some(("\"nope\"".to_owned(), "valid".to_owned(), None))
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
                .expect("read revalidated artifact"),
            record,
            "schema revalidation must not touch the value or file"
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn deleting_relation_target_writes_back_and_histories_the_engine_drop() {
        const SOURCE_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
        );
        write_file(
            scratch.path(),
            "tasks/source.md",
            format!("---\nid: {SOURCE_ID}\nrelated: {TARGET_ID}\n---\n\nSource\n").as_bytes(),
        );
        write_file(
            scratch.path(),
            "tasks/target.md",
            format!("---\nid: {TARGET_ID}\n---\n\nTarget\n").as_bytes(),
        );
        ingest(&mut sink, "tasks/collection.yaml").expect("capture relation schema");
        ingest(&mut sink, "tasks/source.md").expect("capture referrer");
        ingest(&mut sink, "tasks/target.md").expect("capture target");
        for path in ["tasks/source.md", "tasks/target.md"] {
            seed_captured_richdoc_lineage(&sink, path);
        }
        assert_eq!(
            sink.reconcile_collections()
                .expect("adopt indexed relation"),
            ["tasks/source.md", "tasks/target.md"]
        );
        assert_eq!(
            relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
            1
        );

        std::fs::remove_file(scratch.path().join("tasks/target.md")).expect("delete target");
        sink.retire("tasks/target.md").expect("retire target");
        assert_eq!(
            sink.reconcile_collections().expect("drop inbound relation"),
            ["tasks/source.md"]
        );
        assert_eq!(
            relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
            0
        );
        assert_eq!(
            indexed_collection_field(&db, "tasks/source.md", "related"),
            None
        );
        assert!(
            !std::fs::read_to_string(scratch.path().join("tasks/source.md"))
                .expect("read cleaned referrer")
                .contains("related:"),
            "the relation is removed through the projected frontmatter write"
        );
        assert_eq!(
            latest_field_history(&db, "tasks/source.md", "related"),
            (
                Some(format!("\"{TARGET_ID}\"")),
                None,
                Some("engine".to_owned())
            )
        );
        let relation_history_count = get_record(&db, "tasks", SOURCE_ID)
            .history
            .iter()
            .filter(|entry| entry.field == "related")
            .count();
        assert_eq!(relation_history_count, 1);
        assert_eq!(
            latest_ydoc_actor_origin(&db, "tasks/source.md").as_deref(),
            Some("engine")
        );
        assert_eq!(engine_ydoc_update_count(&db, "tasks/source.md"), 1);

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn relation_cleanup_preserves_source_backed_body_bytes() {
        const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
        const BODY: &[u8] = concat!(
            "\r\n",
            "| Metric | Value |\r\n",
            "| ------ | ----- |\r\n",
            "| apples | 10    |\r\n",
            "\r\n",
            "- parent\r\n",
            "  - nested with **bold** and [details](https://example.com)"
        )
        .as_bytes();
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
        );
        let mut source = format!("--- \r\nrelated:   {TARGET_ID}\r\n---\t\r\n").into_bytes();
        source.extend_from_slice(BODY);
        write_file(scratch.path(), "tasks/source.md", &source);
        write_file(
            scratch.path(),
            "tasks/target.md",
            format!("---\nid: {TARGET_ID}\n---\n\nTarget\n").as_bytes(),
        );
        for path in [
            "tasks/collection.yaml",
            "tasks/source.md",
            "tasks/target.md",
        ] {
            ingest(&mut sink, path).unwrap_or_else(|_| panic!("capture {path}"));
        }
        for path in ["tasks/source.md", "tasks/target.md"] {
            seed_captured_richdoc_lineage(&sink, path);
        }

        sink.reconcile_collections().expect("adopt records");
        let adopted = std::fs::read(scratch.path().join("tasks/source.md"))
            .expect("read source-preserved record");
        assert!(
            adopted.ends_with(BODY),
            "adoption must establish the source-preserved body fixture"
        );
        assert_eq!(
            relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
            1
        );

        std::fs::remove_file(scratch.path().join("tasks/target.md")).expect("delete target");
        sink.retire("tasks/target.md").expect("retire target");
        assert_eq!(
            sink.reconcile_collections().expect("drop inbound relation"),
            ["tasks/source.md"]
        );

        let cleaned =
            std::fs::read(scratch.path().join("tasks/source.md")).expect("read settled referrer");
        assert_ne!(cleaned, adopted, "cleanup must remove the relation field");
        assert!(
            !String::from_utf8(cleaned.clone())
                .expect("rich-document artifact remains UTF-8")
                .contains("related:"),
            "the settled frontmatter must drop the relation"
        );
        assert!(
            cleaned.ends_with(BODY),
            "a frontmatter-only cleanup must keep the source-backed body byte-identical"
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn changing_relation_target_id_reasserts_the_engine_id_and_keeps_the_edge() {
        const SOURCE_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
        const NEW_TARGET_ID: &str = "rec_cccccccccccccccccccccccccc";
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
        );
        write_file(
            scratch.path(),
            "tasks/source.md",
            format!("---\nid: {SOURCE_ID}\nrelated: {TARGET_ID}\n---\n\nSource\n").as_bytes(),
        );
        write_file(
            scratch.path(),
            "tasks/target.md",
            format!("---\nid: {TARGET_ID}\n---\n\nTarget\n").as_bytes(),
        );
        ingest(&mut sink, "tasks/collection.yaml").expect("capture relation schema");
        ingest(&mut sink, "tasks/source.md").expect("capture referrer");
        ingest(&mut sink, "tasks/target.md").expect("capture target");
        for path in ["tasks/source.md", "tasks/target.md"] {
            seed_captured_richdoc_lineage(&sink, path);
        }
        sink.reconcile_collections()
            .expect("adopt indexed relation");
        assert_eq!(
            relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
            1
        );

        set_richdoc_frontmatter_and_settle(
            &sink,
            "tasks/target.md",
            RECORD_ID_FRONTMATTER_KEY,
            NEW_TARGET_ID,
        );
        let changed = sink
            .reconcile_collections()
            .expect("re-assert the engine-owned target id");

        assert_eq!(
            adopted_record_id(&db, "tasks/target.md"),
            TARGET_ID,
            "the engine-owned id survives the live id rewrite"
        );
        assert!(
            changed.iter().any(|path| path == "tasks/target.md"),
            "the target must settle through the attributed engine write-back"
        );
        assert!(
            std::fs::read_to_string(scratch.path().join("tasks/target.md"))
                .expect("read re-asserted target")
                .contains(&format!("id: {TARGET_ID}")),
            "the write-back restores the engine id in the settled file"
        );
        assert_eq!(
            relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
            1,
            "the inbound relation stays valid because its target never departed"
        );
        assert!(
            std::fs::read_to_string(scratch.path().join("tasks/source.md"))
                .expect("read untouched referrer after target id re-assertion")
                .contains(&format!("related: {TARGET_ID}")),
            "the referrer keeps its relation untouched"
        );
        let relation_history_count = get_record(&db, "tasks", SOURCE_ID)
            .history
            .iter()
            .filter(|entry| entry.field == "related")
            .count();
        assert_eq!(
            relation_history_count, 0,
            "no engine-authored relation drop is recorded"
        );
        assert_eq!(
            latest_ydoc_actor_origin(&db, "tasks/target.md").as_deref(),
            Some("engine"),
            "the id write-back is an engine-attributed Y.Doc write"
        );
        assert_eq!(
            engine_ydoc_update_count(&db, "tasks/target.md"),
            1,
            "the id write-back lands exactly one engine Y.Doc update"
        );
        assert!(
            sink.reconcile_collections()
                .expect("idempotent reconciliation after the id write-back")
                .is_empty(),
            "the re-asserted id must not keep settling"
        );
        assert_eq!(
            engine_ydoc_update_count(&db, "tasks/target.md"),
            1,
            "re-running reconciliation must not loop engine updates onto the target"
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn moving_relation_target_out_of_declared_collection_drops_it_once_with_engine_history() {
        const SOURCE_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  related:\n    type: relation\n    collection: people\n    many: false\n",
        );
        write_file(scratch.path(), "people/collection.yaml", b"name: People\n");
        write_file(
            scratch.path(),
            "archive/collection.yaml",
            b"name: Archive\n",
        );
        write_file(
            scratch.path(),
            "tasks/source.md",
            format!("---\nid: {SOURCE_ID}\nrelated: {TARGET_ID}\n---\n\nSource\n").as_bytes(),
        );
        write_file(
            scratch.path(),
            "people/target.md",
            format!("---\nid: {TARGET_ID}\n---\n\nTarget\n").as_bytes(),
        );
        for path in [
            "tasks/collection.yaml",
            "people/collection.yaml",
            "archive/collection.yaml",
            "tasks/source.md",
            "people/target.md",
        ] {
            ingest(&mut sink, path).unwrap_or_else(|_| panic!("capture {path}"));
        }
        for path in ["tasks/source.md", "people/target.md"] {
            seed_captured_richdoc_lineage(&sink, path);
        }
        sink.reconcile_collections()
            .expect("adopt cross-collection relation");
        assert_eq!(adopted_record_id(&db, "tasks/source.md"), SOURCE_ID);
        assert_eq!(adopted_record_id(&db, "people/target.md"), TARGET_ID);
        assert_eq!(
            relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
            1
        );

        std::fs::rename(
            scratch.path().join("people/target.md"),
            scratch.path().join("archive/target.md"),
        )
        .expect("move target out of declared collection");
        sink.retire("people/target.md")
            .expect("retire target's declared collection path");
        ingest(&mut sink, "archive/target.md").expect("capture moved target");
        seed_captured_richdoc_lineage(&sink, "archive/target.md");
        let changed = sink
            .reconcile_collections()
            .expect("drop relation to moved target");
        assert!(
            changed.iter().any(|path| path == "tasks/source.md"),
            "moving the target out of its declared collection must settle the referrer"
        );
        assert_eq!(adopted_record_id(&db, "archive/target.md"), TARGET_ID);
        assert_eq!(
            relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
            0
        );
        assert_eq!(
            indexed_collection_field(&db, "tasks/source.md", "related"),
            None
        );
        assert!(
            !std::fs::read_to_string(scratch.path().join("tasks/source.md"))
                .expect("read cleaned referrer after target move")
                .contains("related:"),
            "the moved target is removed through the projected frontmatter write"
        );
        assert_eq!(
            latest_field_history(&db, "tasks/source.md", "related"),
            (
                Some(format!("\"{TARGET_ID}\"")),
                None,
                Some("engine".to_owned())
            )
        );
        assert_eq!(
            latest_ydoc_actor_origin(&db, "tasks/source.md").as_deref(),
            Some("engine")
        );
        let relation_history_count = get_record(&db, "tasks", SOURCE_ID)
            .history
            .iter()
            .filter(|entry| entry.field == "related")
            .count();
        assert_eq!(relation_history_count, 1);

        std::fs::rename(
            scratch.path().join("archive/target.md"),
            scratch.path().join("people/target.md"),
        )
        .expect("move target back to declared collection");
        sink.retire("archive/target.md")
            .expect("retire target's archive path");
        ingest(&mut sink, "people/target.md").expect("capture restored target");
        seed_captured_richdoc_lineage(&sink, "people/target.md");
        sink.reconcile_collections()
            .expect("reconcile restored target");
        assert_eq!(adopted_record_id(&db, "people/target.md"), TARGET_ID);
        assert_eq!(
            relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
            0,
            "moving the target back must not resurrect the removed relation"
        );
        assert_eq!(
            indexed_collection_field(&db, "tasks/source.md", "related"),
            None
        );
        let relation_history_count = get_record(&db, "tasks", SOURCE_ID)
            .history
            .iter()
            .filter(|entry| entry.field == "related")
            .count();
        assert_eq!(
            relation_history_count, 1,
            "restoring the target must not author another source-field change"
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn copied_source_preserved_collection_record_keeps_bytes_modulo_fresh_id() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        let source = concat!(
            "--- \r\n",
            "status:   open\r\n",
            "---\t\r\n",
            "\r\n",
            "| Metric | Value |\r\n",
            "| ------ | ----- |\r\n",
            "| apples | 10    |\r\n",
            "\r\n",
            "- parent\r\n",
            "  - nested with **bold** and [details](https://example.com)"
        );
        write_file(scratch.path(), "tasks/original.md", source.as_bytes());
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/original.md").expect("capture original");
        seed_captured_richdoc_lineage(&sink, "tasks/original.md");
        sink.reconcile_collections().expect("adopt original");
        let original_id = adopted_record_id(&db, "tasks/original.md");
        let original = std::fs::read_to_string(scratch.path().join("tasks/original.md"))
            .expect("read adopted original");
        let original_snapshot = snapshot(&db, "tasks/original.md").expect("original snapshot");
        assert_eq!(original_snapshot.text, original);

        std::fs::copy(
            scratch.path().join("tasks/original.md"),
            scratch.path().join("tasks/copy.md"),
        )
        .expect("copy record");
        ingest(&mut sink, "tasks/copy.md").expect("capture copy");
        seed_captured_richdoc_lineage(&sink, "tasks/copy.md");
        assert_eq!(
            sink.reconcile_collections().expect("adopt copy"),
            ["tasks/copy.md"]
        );
        let copy_id = adopted_record_id(&db, "tasks/copy.md");
        assert_ne!(copy_id, original_id);
        assert_eq!(adopted_record_id(&db, "tasks/original.md"), original_id);
        let copy_text = std::fs::read_to_string(scratch.path().join("tasks/copy.md"))
            .expect("read copied record");
        let expected = original.replacen(
            &format!("id: {original_id}\r\n"),
            &format!("id: {copy_id}\r\n"),
            1,
        );
        assert_ne!(expected, original, "the expected bytes must replace the id");
        assert_eq!(copy_text, expected);
        assert_eq!(
            snapshot(&db, "tasks/copy.md")
                .expect("copied record snapshot")
                .text,
            expected
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/original.md"))
                .expect("reread adopted original"),
            original
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn re_adopting_the_same_file_without_an_id_preserves_identity_history_and_relations() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  title:\n    type: text\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
        );
        write_file(scratch.path(), "tasks/source.md", b"Source\n");
        write_file(scratch.path(), "tasks/target.md", b"Target\n");
        for path in [
            "tasks/collection.yaml",
            "tasks/source.md",
            "tasks/target.md",
        ] {
            ingest(&mut sink, path).unwrap_or_else(|_| panic!("capture {path}"));
        }
        for path in ["tasks/source.md", "tasks/target.md"] {
            seed_captured_richdoc_lineage(&sink, path);
        }
        sink.reconcile_collections().expect("adopt records");
        let source_id = adopted_record_id(&db, "tasks/source.md");
        let target_id = adopted_record_id(&db, "tasks/target.md");

        let adopted_source = std::fs::read_to_string(scratch.path().join("tasks/source.md"))
            .expect("read adopted source");
        let edited_source = adopted_source.replace(
            &format!("id: {source_id}\n---"),
            &format!("id: {source_id}\nrelated: {target_id}\n---"),
        );
        assert_ne!(
            edited_source, adopted_source,
            "the fixture must add the inbound relation"
        );
        write_file(scratch.path(), "tasks/source.md", edited_source.as_bytes());
        let adopted_target = std::fs::read_to_string(scratch.path().join("tasks/target.md"))
            .expect("read adopted target");
        let edited_target = adopted_target.replace(
            &format!("id: {target_id}\n---"),
            &format!("id: {target_id}\ntitle: Edited\n---"),
        );
        assert_ne!(
            edited_target, adopted_target,
            "the fixture must edit the target title"
        );
        write_file(scratch.path(), "tasks/target.md", edited_target.as_bytes());
        ingest(&mut sink, "tasks/source.md").expect("capture inbound relation");
        ingest(&mut sink, "tasks/target.md").expect("capture target edit");
        assert!(
            get_record(&db, "tasks", &target_id)
                .history
                .iter()
                .any(|entry| entry.field == "title"),
            "the fixture must create target history before re-adoption"
        );
        let related_before = query_collection(&db, "tasks", true)
            .records
            .into_iter()
            .find(|record| record.id == source_id)
            .expect("source before re-adoption")
            .values
            .into_iter()
            .find(|value| value.field == "related")
            .expect("inbound relation before re-adoption");
        assert_eq!(
            related_before.resolved_relations[0].record_id, target_id,
            "the fixture must create an inbound relation edge"
        );

        let target_with_id = std::fs::read_to_string(scratch.path().join("tasks/target.md"))
            .expect("read target before stripping id");
        let stripped_target = target_with_id.replace(&format!("id: {target_id}\n"), "");
        assert_ne!(
            stripped_target, target_with_id,
            "the fixture must strip the target id"
        );
        write_file(
            scratch.path(),
            "tasks/target.md",
            stripped_target.as_bytes(),
        );
        ingest(&mut sink, "tasks/target.md").expect("capture stripped record id");
        sink.reconcile_collections()
            .expect("re-adopt record after id removal");

        assert_eq!(
            adopted_record_id(&db, "tasks/target.md"),
            target_id,
            "the same file object keeps its bound record id"
        );
        let repaired_target = std::fs::read_to_string(scratch.path().join("tasks/target.md"))
            .expect("read re-adopted target");
        assert!(
            repaired_target.contains(&format!("id: {target_id}\n")),
            "re-adoption must restore the bound id to the artifact"
        );
        assert!(
            get_record(&db, "tasks", &target_id)
                .history
                .iter()
                .any(|entry| entry.field == "title"),
            "the original record history stays addressable"
        );
        let related_after = query_collection(&db, "tasks", true)
            .records
            .into_iter()
            .find(|record| record.id == source_id)
            .expect("source after re-adoption")
            .values
            .into_iter()
            .find(|value| value.field == "related")
            .expect("inbound relation after re-adoption");
        assert_eq!(
            related_after.value,
            serde_json::Value::String(target_id.clone())
        );
        assert_eq!(related_after.resolved_relations[0].record_id, target_id);

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn broken_collection_schema_degrades_and_recovers_without_data_loss() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  estimate:\n    type: number\n",
        );
        write_file(
            scratch.path(),
            "tasks/alpha.md",
            b"---\nestimate: nope\n---\n\nAlpha\n",
        );
        ingest(&mut sink, "tasks/collection.yaml").expect("capture valid schema");
        ingest(&mut sink, "tasks/alpha.md").expect("capture record");
        seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");

        assert_eq!(
            sink.reconcile_collections()
                .expect("adopt record under valid schema"),
            ["tasks/alpha.md"]
        );
        assert_eq!(
            collection_status(&db, "tasks"),
            Some(("valid".to_owned(), "[]".to_owned()))
        );
        let record_id = adopted_record_id(&db, "tasks/alpha.md");
        assert_eq!(moment_count(&db, "tasks/alpha.md"), 2);
        assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 2);
        let indexed =
            indexed_collection_field(&db, "tasks/alpha.md", "estimate").expect("estimate indexed");
        assert_eq!(indexed.0, "\"nope\"");
        assert_eq!(indexed.1, "flagged");
        assert!(
            indexed
                .2
                .expect("validation reason before schema degradation")
                .contains("expected-number")
        );
        let valid_record = std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
            .expect("read adopted record before schema degradation");

        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"fields:\n  title: [\n",
        );
        ingest(&mut sink, "tasks/collection.yaml").expect("capture broken schema");
        assert!(
            sink.reconcile_collections()
                .expect("fail-soft collection reconciliation")
                .is_empty()
        );
        let (status, reasons) = collection_status(&db, "tasks").expect("collection detected");
        assert_eq!(status, "degraded");
        assert_ne!(reasons, "[]");
        assert_eq!(adopted_record_id(&db, "tasks/alpha.md"), record_id);
        assert_eq!(
            indexed_collection_field(&db, "tasks/alpha.md", "estimate"),
            Some(("\"nope\"".to_owned(), "untyped".to_owned(), None))
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
                .expect("read record while schema is degraded"),
            valid_record
        );

        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"name: Tasks\nfields:\n  estimate:\n    type: number\n",
        );
        ingest(&mut sink, "tasks/collection.yaml").expect("capture repaired schema");
        assert!(
            sink.reconcile_collections()
                .expect("recover collection schema")
                .is_empty()
        );
        assert_eq!(
            collection_status(&db, "tasks"),
            Some(("valid".to_owned(), "[]".to_owned()))
        );
        assert_eq!(adopted_record_id(&db, "tasks/alpha.md"), record_id);
        let indexed =
            indexed_collection_field(&db, "tasks/alpha.md", "estimate").expect("estimate indexed");
        assert_eq!(indexed.0, "\"nope\"");
        assert_eq!(indexed.1, "flagged");
        assert!(
            indexed
                .2
                .expect("validation reason after schema recovery")
                .contains("expected-number")
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
                .expect("read record after schema recovery"),
            valid_record,
            "schema recovery must not rewrite or drop record data"
        );

        std::fs::remove_file(scratch.path().join("tasks/collection.yaml")).expect("remove schema");
        sink.retire("tasks/collection.yaml").expect("retire schema");
        assert!(
            sink.reconcile_collections()
                .expect("remove disappeared collection")
                .is_empty()
        );
        assert_eq!(collection_status(&db, "tasks"), None);
        assert_eq!(collection_record(&db, "tasks/alpha.md"), None);

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn collection_record_binding_follows_frontmatter_id_across_rename() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        write_file(scratch.path(), "tasks/before.md", b"Before\n");
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/before.md").expect("capture record");
        seed_captured_richdoc_lineage(&sink, "tasks/before.md");
        sink.reconcile_collections().expect("adopt record");
        let record_id = adopted_record_id(&db, "tasks/before.md");

        std::fs::rename(
            scratch.path().join("tasks/before.md"),
            scratch.path().join("tasks/after.md"),
        )
        .expect("rename record");
        sink.retire("tasks/before.md").expect("retire old path");
        ingest(&mut sink, "tasks/after.md").expect("capture new path");
        seed_captured_richdoc_lineage(&sink, "tasks/after.md");
        let renamed_record = std::fs::read_to_string(scratch.path().join("tasks/after.md"))
            .expect("read renamed record before adoption");
        assert_eq!(
            sink.reconcile_collections().expect("reconcile rename"),
            ["tasks/after.md"],
            "the renamed object settles after the shared rich-document import"
        );
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/after.md"))
                .expect("read adopted renamed record"),
            renamed_record,
            "a rename with a valid id must preserve the artifact byte-for-byte"
        );
        assert_eq!(adopted_record_id(&db, "tasks/after.md"), record_id);
        assert!(collection_record(&db, "tasks/before.md").is_none());

        std::fs::rename(
            scratch.path().join("tasks/after.md"),
            scratch.path().join("outside.md"),
        )
        .expect("move record out");
        sink.retire("tasks/after.md")
            .expect("retire collection path");
        ingest(&mut sink, "outside.md").expect("capture outside file");
        sink.reconcile_collections().expect("reconcile move out");
        assert!(collection_record(&db, "tasks/after.md").is_none());
        assert!(collection_record(&db, "outside.md").is_none());

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn collection_adoption_waits_for_an_open_file_conflict_to_resolve() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        write_file(scratch.path(), "tasks/blocked.md", b"Blocked\n");
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/blocked.md").expect("capture record");
        let object_id = snapshot(&db, "tasks/blocked.md")
            .expect("record snapshot")
            .object_id;
        let connection = rusqlite::Connection::open(&db).expect("open conflict connection");
        connection
            .execute(
                "INSERT INTO conflicts (\
                    workspace_id, conflict_id, path, target_version_id, source_version_id, \
                    created_at_ms, updated_at_ms, status, chosen_from, metadata_origin, \
                    base_exists, base_path, current_exists, current_path, current_object_id, \
                    incoming_exists, incoming_path, incoming_object_id\
                 ) VALUES (?1, 'collection-adoption-conflict', ?2, ?3, ?3, \
                    10, 10, 'open', 'current', 'sync', \
                    0, ?2, 1, ?2, ?4, 1, ?2, ?4)",
                rusqlite::params![WORKSPACE_ID, "tasks/blocked.md", VERSION_ID, object_id],
            )
            .expect("insert open conflict");
        drop(connection);

        assert!(
            sink.reconcile_collections()
                .expect("defer conflicted record")
                .is_empty()
        );
        assert_eq!(
            collection_record(&db, "tasks/blocked.md"),
            Some((None, "deferred-conflict-lossless".to_owned()))
        );
        assert_eq!(moment_count(&db, "tasks/blocked.md"), 1);
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("tasks/blocked.md"))
                .expect("read deferred record"),
            "Blocked\n"
        );

        let connection = rusqlite::Connection::open(&db).expect("open resolution connection");
        connection
            .execute(
                "UPDATE conflicts SET status = 'resolved', updated_at_ms = 20 \
                 WHERE workspace_id = ?1 AND conflict_id = 'collection-adoption-conflict'",
                [WORKSPACE_ID],
            )
            .expect("resolve conflict");
        drop(connection);
        assert!(
            sink.reconcile_collections()
                .expect("bind record after conflict resolution")
                .is_empty(),
            "the engine must wait for the shared rich-document importer"
        );
        assert_eq!(
            collection_record(&db, "tasks/blocked.md").map(|(_, state)| state),
            Some("pending-lossless".to_owned())
        );
        seed_captured_richdoc_lineage(&sink, "tasks/blocked.md");
        assert_eq!(
            sink.reconcile_collections()
                .expect("adopt shared-imported record after conflict resolution"),
            ["tasks/blocked.md"]
        );
        adopted_record_id(&db, "tasks/blocked.md");
        assert_eq!(moment_count(&db, "tasks/blocked.md"), 2);
        assert_eq!(ydoc_update_count(&db, "tasks/blocked.md"), 2);

        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    /// (metadata_summary, metadata_correlation_id) of the latest secret
    /// moment for `path`.
    fn secret_moment_metadata(db: &Path, path: &str) -> (Option<String>, Option<String>) {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT metadata_summary, metadata_correlation_id FROM secret_moments \
                     WHERE workspace_id = ?1 AND path = ?2 \
                     ORDER BY moment_order DESC LIMIT 1",
                    [WORKSPACE_ID, path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .expect("secret moment metadata")
    }

    /// (metadata_summary, metadata_correlation_id) of the latest moment for
    /// `path`.
    fn moment_metadata(db: &Path, path: &str) -> (Option<String>, Option<String>) {
        let store = EngineStore::open(db, 100).expect("reopen store");
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT metadata_summary, metadata_correlation_id FROM moments \
                     WHERE workspace_id = ?1 AND path = ?2 \
                     ORDER BY moment_order DESC LIMIT 1",
                    [WORKSPACE_ID, path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .expect("moment metadata")
    }

    #[test]
    fn a_reconcile_run_stamps_its_summary_and_correlation_on_every_moment() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        // A pre-pass live capture that the reconcile pass will DELETE.
        write_file(scratch.path(), "gone.md", b"deleted while closed");
        let (db, mut live_sink) = sink_for(&scratch, &supervisor);
        assert!(
            matches!(
                ingest(&mut live_sink, "gone.md").expect("seed capture"),
                IngestOutcome::Captured { .. }
            ),
            "dropping the provenance plumb-through in ingest_text / ingest_binary / retire_head (or in the domain's capture paths) fails this: a multi-file offline reconcile would render as ungrouped unlabeled history rows, and a mid-pass DELETE would split the group (history groups only consecutive same-correlation moments)."
        );
        drop(live_sink);
        std::fs::remove_file(scratch.path().join("gone.md")).expect("offline delete");

        write_file(scratch.path(), "notes/a.md", b"offline edit a");
        write_file(scratch.path(), "photo.png", &[0xff, 0x00, 0xfe]);
        write_file(scratch.path(), ".env", b"TOKEN=offline");

        let actor = supervisor.open(&db, 2).expect("open actor").actor;
        let mut sink = StoreCaptureSink::new_with_self_writes(
            actor,
            WORKSPACE_ID,
            VERSION_ID,
            scratch.path(),
            10,
            None,
            LeaseRegistry::new(),
            SelfWriteSuppression::default(),
            CaptureProvenance {
                summary: Some("Reconciled offline edits".to_owned()),
                correlation_id: Some("reconcile-test-pass".to_owned()),
            },
        );
        assert!(matches!(
            ingest(&mut sink, "notes/a.md").expect("text ingest"),
            IngestOutcome::Captured { .. }
        ));
        assert!(matches!(
            ingest_as(&mut sink, "photo.png", "image/png").expect("binary ingest"),
            IngestOutcome::Captured { .. }
        ));
        assert!(matches!(
            ingest(&mut sink, ".env").expect("secret ingest"),
            IngestOutcome::Captured { .. }
        ));
        sink.retire("gone.md").expect("pass delete");
        drop(sink);
        supervisor.close(&db).expect("close actor");

        // The delete moment carries the same provenance as the pass's
        // writes, so the history group stays contiguous.
        for path in ["notes/a.md", "photo.png", "gone.md"] {
            let (summary, correlation) = moment_metadata(&db, path);
            assert_eq!(
                summary.as_deref(),
                Some("Reconciled offline edits"),
                "{path} must carry the pass summary"
            );
            assert_eq!(
                correlation.as_deref(),
                Some("reconcile-test-pass"),
                "{path} must carry the shared pass correlation id"
            );
        }
        // Secret moments keep their per-file label (TS parity) but ride the
        // pass correlation so they group with the plaintext moments.
        let (secret_summary, secret_correlation) = secret_moment_metadata(&db, ".env");
        assert_eq!(secret_summary.as_deref(), Some("Updated .env"));
        assert_eq!(secret_correlation.as_deref(), Some("reconcile-test-pass"));
    }

    #[test]
    fn live_text_captures_carry_no_summary_and_binary_captures_stay_labeled() {
        // TS parity: a live TEXT write carries NO summary (the renderer's
        // copy for null is "Edited <basename>"); only binary (and secret)
        // writes carry the per-file "Updated <basename>" label. Neither
        // mints a correlation id.
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "notes/live.md", b"live edit");
        write_file(scratch.path(), "photo.png", &[0xff, 0x00, 0xfe]);
        assert!(matches!(
            ingest(&mut sink, "notes/live.md").expect("live text ingest"),
            IngestOutcome::Captured { .. }
        ));
        assert!(matches!(
            ingest_as(&mut sink, "photo.png", "image/png").expect("live binary ingest"),
            IngestOutcome::Captured { .. }
        ));
        drop(sink);
        supervisor.close(&db).expect("close actor");

        assert_eq!(moment_metadata(&db, "notes/live.md"), (None, None));
        let (summary, correlation) = moment_metadata(&db, "photo.png");
        assert_eq!(summary.as_deref(), Some("Updated photo.png"));
        assert_eq!(correlation, None);
    }

    #[test]
    fn content_kind_transitions_get_honest_moment_summaries() {
        // TS `writeIfChanged` parity: a tracked path flipping text<->binary
        // keeps its object identity and the moment says so honestly.
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "notes/flip.md", b"plain text");
        assert!(matches!(
            ingest(&mut sink, "notes/flip.md").expect("text ingest"),
            IngestOutcome::Captured { .. }
        ));
        // Binary in disguise under a text suffix: invalid UTF-8 routes to the
        // binary store and the moment records the flip.
        write_file(scratch.path(), "notes/flip.md", &[0xff, 0x00, 0xfe]);
        assert!(matches!(
            ingest(&mut sink, "notes/flip.md").expect("flip to binary"),
            IngestOutcome::Captured { .. }
        ));
        let (summary, _) = moment_metadata(&db, "notes/flip.md");
        assert_eq!(summary.as_deref(), Some("Became a binary file"));

        write_file(scratch.path(), "notes/flip.md", b"text again");
        assert!(matches!(
            ingest(&mut sink, "notes/flip.md").expect("flip back to text"),
            IngestOutcome::Captured { .. }
        ));
        let (summary, _) = moment_metadata(&db, "notes/flip.md");
        assert_eq!(summary.as_deref(), Some("Became a text file"));
        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn an_unreadable_policy_holds_capture_instead_of_widening_or_retiring() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();

        // Establish a capture-owned head under a healthy (absent) policy.
        write_file(scratch.path(), "kept.md", b"captured content");
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        assert!(matches!(
            ingest(&mut sink, "kept.md").expect("healthy ingest"),
            IngestOutcome::Captured { .. }
        ));
        drop(sink);

        // files.toml becomes unreadable (a directory is deterministic on
        // every platform: exists, not a regular file). The narrowing set is
        // now unknown — a fresh sink must hold, not widen to floor-only and
        // not retire.
        std::fs::create_dir_all(scratch.path().join(".dohc/files.toml")).expect("dir-as-policy");
        write_file(scratch.path(), "kept.md", b"edited while unreadable");
        let (_, mut sink) = sink_for(&scratch, &supervisor);
        assert!(
            ingest(&mut sink, "kept.md").is_err(),
            "unknown policy must fail the op (stays dirty, retried), not capture"
        );
        assert_eq!(
            snapshot(&db, "kept.md").expect("head survives").text,
            "captured content",
            "the held op must neither update nor retire the existing head"
        );

        // A MALFORMED file is a different case: the ratified WS-F rule keeps
        // capture floor-only (writes are never dropped for a bad policy).
        std::fs::remove_dir_all(scratch.path().join(".dohc/files.toml")).expect("rm dir");
        write_file(
            scratch.path(),
            ".dohc/files.toml",
            b"this is [not valid toml",
        );
        let (_, mut sink) = sink_for(&scratch, &supervisor);
        assert!(
            matches!(
                ingest(&mut sink, "kept.md").expect("malformed policy still captures"),
                IngestOutcome::Captured { .. }
            ),
            "WS-F: a malformed policy must not drop writes"
        );
        assert_eq!(
            snapshot(&db, "kept.md").expect("head updated").text,
            "edited while unreadable"
        );
    }

    fn try_symlink_file(link: &Path, target: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
    }

    fn try_symlink_dir(link: &Path, target: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        }
    }

    fn remove_dir_symlink(link: &Path) {
        #[cfg(unix)]
        std::fs::remove_file(link).expect("remove directory symlink");
        #[cfg(windows)]
        std::fs::remove_dir(link).expect("remove directory symlink");
    }

    #[test]
    fn text_ingest_rereads_updates_and_dedupes_equal_content() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "notes/a.md", b"first");

        assert!(matches!(
            ingest(&mut sink, "notes/a.md").expect("first ingest"),
            IngestOutcome::Captured { .. }
        ));
        assert!(matches!(
            ingest(&mut sink, "notes/a.md").expect("equal ingest"),
            IngestOutcome::Captured { .. }
        ));
        write_file(scratch.path(), "notes/a.md", b"latest");
        let updated = ingest(&mut sink, "notes/a.md").expect("updated ingest");
        // The receipt reports the identity of the bytes actually captured.
        assert_eq!(
            updated,
            IngestOutcome::Captured {
                size: 6,
                sha256: hex_sha256(b"latest"),
            }
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        let captured = snapshot(&db, "notes/a.md").expect("captured snapshot");
        assert_eq!(captured.text, "latest");
        assert_eq!(
            captured.metadata_origin,
            dohc_engine_domain::store::CAPTURE_ORIGIN
        );
        assert_eq!(moment_count(&db, "notes/a.md"), 2);
    }

    #[test]
    fn binary_ingest_dedupes_equal_bytes() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "logo.png", &[0, 1, 2, 255]);

        assert!(matches!(
            ingest_as(&mut sink, "logo.png", "image/png").expect("first ingest"),
            IngestOutcome::Captured { .. }
        ));
        assert!(matches!(
            ingest_as(&mut sink, "logo.png", "image/png").expect("equal ingest"),
            IngestOutcome::Captured { .. }
        ));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(
            binary_head(&db, "logo.png").as_deref(),
            Some(hex_sha256(&[0, 1, 2, 255]).as_str())
        );
        assert_eq!(moment_count(&db, "logo.png"), 1);
    }

    #[test]
    fn retire_removes_the_version_head() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "retired.md", b"captured");
        ingest(&mut sink, "retired.md").expect("ingest before retire");
        std::fs::remove_file(scratch.path().join("retired.md")).expect("delete from disk");
        sink.retire("retired.md").expect("retire");

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(snapshot(&db, "retired.md").is_none());
    }

    #[test]
    fn ignored_binary_and_secret_routes_do_not_write() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "binary.md", &[0xff, 0x00, 0xfe]);
        write_file(scratch.path(), ".env", b"TOKEN=secret");

        assert_eq!(
            ingest(&mut sink, ".dohc/ignored.md").expect("ignored path"),
            IngestOutcome::NotOwned
        );
        // Binary content captures as a BINHEAD binary head; secret content
        // captures into the encrypted store (never the plaintext one).
        assert!(matches!(
            ingest(&mut sink, "binary.md").expect("binary capture"),
            IngestOutcome::Captured { .. }
        ));
        assert!(matches!(
            ingest(&mut sink, ".env").expect("secret capture"),
            IngestOutcome::Captured { .. }
        ));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(moment_count(&db, ".dohc/ignored.md"), 0);
        assert_eq!(moment_count(&db, "binary.md"), 1);
        assert!(binary_head(&db, "binary.md").is_some());
        // The plaintext tables never see the secret; the encrypted tip does.
        assert_eq!(moment_count(&db, ".env"), 0);
        assert_eq!(secret_tip_len(&db, ".env"), Some(12));
    }

    #[test]
    fn oversized_text_retires_stale_authoritative_content() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "oversized.md", b"small");
        ingest(&mut sink, "oversized.md").expect("seed ingest");
        let oversized = vec![b'x'; MAX_CAPTURE_TEXT_BYTES as usize + 1];
        write_file(scratch.path(), "oversized.md", &oversized);
        assert_eq!(
            ingest(&mut sink, "oversized.md").expect("oversized retire"),
            IngestOutcome::NotOwned
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(snapshot(&db, "oversized.md").is_none());
    }

    #[test]
    fn image_heavy_excalidraw_is_utf8_text_up_to_max_text_bytes() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        // Three representative 2 MiB image payloads become 8 MiB of base64.
        // The portable JSON remains below MAX_TEXT_BYTES (10,485,760 bytes)
        // and above the 5 MiB binary cap, proving classification selects the
        // text ceiling before the read.
        let encoded = "A".repeat(2_700_000);
        let portable = format!(
            r#"{{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[{{"id":"ea","type":"image","version":1,"versionNonce":1,"isDeleted":false,"index":"a0","fileId":"a"}},{{"id":"eb","type":"image","version":1,"versionNonce":2,"isDeleted":false,"index":"a1","fileId":"b"}},{{"id":"ec","type":"image","version":1,"versionNonce":3,"isDeleted":false,"index":"a2","fileId":"c"}}],"appState":{{}},"files":{{"a":{{"id":"a","mimeType":"image/png","created":1,"dataURL":"data:image/png;base64,{encoded}"}},"b":{{"id":"b","mimeType":"image/jpeg","created":2,"dataURL":"data:image/jpeg;base64,{encoded}"}},"c":{{"id":"c","mimeType":"image/webp","created":3,"dataURL":"data:image/webp;base64,{encoded}"}}}}}}"#
        );
        assert!(portable.len() > MAX_CAPTURE_BINARY_BYTES as usize);
        assert!(portable.len() < MAX_CAPTURE_TEXT_BYTES as usize);
        let imported = dohc_engine_collab::import_portable_scene(&portable)
            .expect("representative healthy scene imports");
        assert_eq!(imported.files.len(), 3);
        write_file(
            scratch.path(),
            "image-heavy.excalidraw",
            portable.as_bytes(),
        );
        assert!(matches!(
            ingest_as(&mut sink, "image-heavy.excalidraw", "application/json")
                .expect("image-heavy scene capture"),
            IngestOutcome::Captured { .. }
        ));
        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(
            snapshot(&db, "image-heavy.excalidraw")
                .expect("captured portable scene")
                .text
                .len(),
            portable.len()
        );
    }

    #[test]
    fn invalid_utf8_and_over_max_text_bytes_excalidraw_are_not_binary() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);

        write_file(scratch.path(), "invalid.excalidraw", &[0xff, 0xfe]);
        assert_eq!(
            ingest_as(&mut sink, "invalid.excalidraw", "application/json")
                .expect("invalid UTF-8 refusal"),
            IngestOutcome::NotOwned
        );
        assert!(binary_head(&db, "invalid.excalidraw").is_none());

        let observed = MAX_CAPTURE_TEXT_BYTES + 1;
        write_file(
            scratch.path(),
            "over-cap.excalidraw",
            &vec![b'x'; observed as usize],
        );
        assert_eq!(MAX_CAPTURE_TEXT_BYTES, 10_485_760);
        assert_eq!(observed, 10_485_761);
        assert_eq!(
            ingest_as(&mut sink, "over-cap.excalidraw", "application/json")
                .expect("MAX_TEXT_BYTES 10,485,760-byte capture refusal at 10,485,761 bytes"),
            IngestOutcome::NotOwned
        );
        assert!(binary_head(&db, "over-cap.excalidraw").is_none());
        drop(sink);
        supervisor.close(&db).expect("close actor");
    }

    #[test]
    fn text_media_that_turns_binary_replaces_the_text_head() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "flip.md", b"was text");
        ingest(&mut sink, "flip.md").expect("seed ingest");
        write_file(scratch.path(), "flip.md", &[0xff, 0xfe, 0x00]);

        let flipped = ingest(&mut sink, "flip.md").expect("binary capture");
        assert_eq!(
            flipped,
            IngestOutcome::Captured {
                size: 3,
                sha256: hex_sha256(&[0xff, 0xfe, 0x00]),
            }
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        // One transition: the binary head replaced the text head atomically.
        assert_eq!(
            binary_head(&db, "flip.md").as_deref(),
            Some(hex_sha256(&[0xff, 0xfe, 0x00]).as_str())
        );
        assert_eq!(moment_count(&db, "flip.md"), 2);
    }

    #[test]
    fn non_text_media_never_lands_in_the_plaintext_store() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        // Valid UTF-8 bytes under a binary media type: UTF-8 sniffing alone
        // would capture this as text.
        write_file(scratch.path(), "photo.png", b"plain ascii bytes");

        assert!(matches!(
            ingest_as(&mut sink, "photo.png", "image/png").expect("binary capture"),
            IngestOutcome::Captured { .. }
        ));
        // Content-equality dedupe holds for binary too.
        assert!(matches!(
            ingest_as(&mut sink, "photo.png", "image/png").expect("equal binary"),
            IngestOutcome::Captured { .. }
        ));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(
            binary_head(&db, "photo.png").as_deref(),
            Some(hex_sha256(b"plain ascii bytes").as_str())
        );
        assert_eq!(moment_count(&db, "photo.png"), 1, "equal re-ingest deduped");
    }

    #[test]
    fn scanned_name_that_normalizes_to_a_different_key_is_refused() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "a/b.md", b"real");
        ingest(&mut sink, "a/b.md").expect("capture the real file");
        // A literal `a%2fb.md` on disk decodes to the same durable key as the
        // real `a/b.md`; capturing or retiring through it would clobber the
        // real file's head.
        write_file(scratch.path(), "a%2fb.md", b"evil");

        assert_eq!(
            ingest(&mut sink, "a%2fb.md").expect("refused, settled"),
            IngestOutcome::NotOwned
        );
        sink.retire("a%2fb.md").expect("refused retire is a no-op");

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(
            snapshot(&db, "a/b.md").expect("real head intact").text,
            "real"
        );
        assert_eq!(moment_count(&db, "a/b.md"), 1);
    }

    #[test]
    fn files_toml_tracked_false_narrows_and_retires() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut seed_sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "private/journal.md", b"personal");
        write_file(scratch.path(), "public.md", b"shared");
        ingest(&mut seed_sink, "private/journal.md").expect("seed private");
        ingest(&mut seed_sink, "public.md").expect("seed public");
        drop(seed_sink);

        write_file(
            scratch.path(),
            ".dohc/files.toml",
            b"[[rule]]\npath = \"private/**\"\ntracked = false\n",
        );
        // The policy snapshot is read at construction: a fresh sink sees it.
        let actor = supervisor.open(&db, 1).expect("reopen actor").actor;
        let mut sink =
            StoreCaptureSink::new(actor, WORKSPACE_ID, VERSION_ID, scratch.path(), 20, None);
        assert_eq!(
            ingest(&mut sink, "private/journal.md").expect("narrowed"),
            IngestOutcome::NotOwned
        );
        assert!(matches!(
            ingest(&mut sink, "public.md").expect("still tracked"),
            IngestOutcome::Captured { .. }
        ));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        // The opted-out path was retired, not left stale-but-authoritative.
        assert!(snapshot(&db, "private/journal.md").is_none());
        assert_eq!(
            snapshot(&db, "public.md").expect("public head").text,
            "shared"
        );
    }

    #[test]
    fn broken_files_toml_keeps_capture_floor_only() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        write_file(scratch.path(), ".dohc/files.toml", b"not = valid policy [[");
        write_file(scratch.path(), "notes/a.md", b"kept");
        let (db, mut sink) = sink_for(&scratch, &supervisor);

        // WS-F: a malformed policy never drops writes — capture stays
        // floor-only rather than failing closed.
        assert!(matches!(
            ingest(&mut sink, "notes/a.md").expect("floor-only capture"),
            IngestOutcome::Captured { .. }
        ));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(snapshot(&db, "notes/a.md").expect("head").text, "kept");
    }

    #[test]
    fn symlink_leaf_swap_is_refused_and_retired() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        let outside_scratch = ScratchDir::new().expect("outside scratch");
        let outside = outside_scratch.path().join("outside-target.md");
        std::fs::write(&outside, b"outside secret").expect("outside fixture");
        write_file(scratch.path(), "swap.md", b"honest");
        ingest(&mut sink, "swap.md").expect("seed ingest");

        // Swap the regular file for a symlink pointing outside the workspace
        // (the TOCTOU the no-follow reopen defends against).
        std::fs::remove_file(scratch.path().join("swap.md")).expect("remove original");
        let made = try_symlink_file(&scratch.path().join("swap.md"), &outside);
        if !made {
            eprintln!("note: symlink creation unavailable on this host; asserting the absent path");
        }
        // Symlink leaf (or, without symlink privilege, the now-absent path):
        // either way the path stopped being engine-ownable and must be retired
        // without ever reading the target's bytes.
        assert_eq!(
            ingest(&mut sink, "swap.md").expect("refused"),
            IngestOutcome::NotOwned
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(snapshot(&db, "swap.md").is_none());
    }

    #[test]
    fn symlinked_directory_never_carries_the_read_off_root() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        let outside_scratch = ScratchDir::new().expect("outside scratch");
        let outside_dir = outside_scratch.path().join("outside-dir");
        std::fs::create_dir_all(&outside_dir).expect("outside dir");
        std::fs::write(outside_dir.join("leak.md"), b"outside bytes").expect("outside file");

        let made = try_symlink_dir(&scratch.path().join("linkdir"), &outside_dir);
        if made {
            // The parent resolves outside the root: refused as an escape, and
            // nothing is captured or retired through it.
            assert_eq!(ingest(&mut sink, "linkdir/leak.md"), Err(ESCAPES_ROOT));
        } else {
            eprintln!("note: dir symlink unavailable on this host; asserting the absent path");
            assert_eq!(
                ingest(&mut sink, "linkdir/leak.md").expect("absent"),
                IngestOutcome::NotOwned
            );
        }

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(moment_count(&db, "linkdir/leak.md"), 0);
    }

    #[test]
    fn symlinked_directory_inside_the_root_is_refused_for_scanner_parity() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "real/x.md", b"real content");

        // An ancestor symlink that resolves inside the workspace still aliases
        // content under a path the scanner would never enumerate (the scanner
        // skips symlinked dirs), so the sink must refuse it — strict-equality
        // containment, not merely under-root.
        let made = try_symlink_dir(&scratch.path().join("alias"), &scratch.path().join("real"));
        if made {
            assert_eq!(ingest(&mut sink, "alias/x.md"), Err(ESCAPES_ROOT));
        } else {
            eprintln!("note: dir symlink unavailable on this host; asserting the absent path");
            assert_eq!(
                ingest(&mut sink, "alias/x.md").expect("absent"),
                IngestOutcome::NotOwned
            );
        }

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(moment_count(&db, "alias/x.md"), 0);
    }

    #[test]
    fn cached_canonical_root_refuses_a_root_symlink_swap() {
        // The engine database lives elsewhere so Windows can rename the
        // capture root while its actor remains open.
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().to_path_buf();
        let moved_root = root.with_file_name(format!(
            "{}-moved",
            root.file_name().expect("root name").to_string_lossy()
        ));
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        write_file(&root, "first.md", b"first");
        write_file(&root, "second.md", b"second");
        let mut sink = StoreCaptureSink::new(actor, WORKSPACE_ID, VERSION_ID, &root, 10, None);

        // The first read fixes this reconcile generation's canonical root.
        ingest(&mut sink, "first.md").expect("seed canonical root");
        std::fs::rename(&root, &moved_root).expect("move capture root");
        if !try_symlink_dir(&root, &moved_root) {
            std::fs::rename(&moved_root, &root).expect("restore capture root");
            eprintln!("note: dir symlink unavailable on this host; root swap not exercised");
            drop(sink);
            supervisor.close(&db).expect("close actor");
            return;
        }

        // Re-canonicalizing the root per file would accept the symlink's new
        // target. Comparing the current parent with the cached location must
        // instead fail closed without reading or capturing the target.
        assert_eq!(ingest(&mut sink, "second.md"), Err(ESCAPES_ROOT));

        remove_dir_symlink(&root);
        std::fs::rename(&moved_root, &root).expect("restore capture root");
        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(moment_count(&db, "second.md"), 0);
    }

    #[test]
    fn captured_root_refuses_a_different_directory_at_the_same_path() {
        // Keep the database outside the capture root so the root can move
        // while its workspace actor remains open.
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().to_path_buf();
        let moved_root = root.with_file_name(format!(
            "{}-moved",
            root.file_name().expect("root name").to_string_lossy()
        ));
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        write_file(&root, "first.md", b"first");
        let mut sink = StoreCaptureSink::new(actor, WORKSPACE_ID, VERSION_ID, &root, 10, None);

        // The first read binds this reconcile generation to the original
        // directory object, not merely to its canonical pathname.
        ingest(&mut sink, "first.md").expect("seed captured root");
        let original_root = sink.captured_root().expect("original root binding");
        std::fs::rename(&root, &moved_root).expect("move original capture root");
        std::fs::create_dir(&root).expect("recreate capture root at the same path");
        write_file(&root, "replacement.md", b"replacement workspace content");

        let candidates = [AddedTextCandidate {
            path: "replacement.md",
            media_type: "text/markdown",
        }];
        let parallel = prepare_added_text_prefix_parallel(&root, original_root, &candidates);
        let single = ingest(&mut sink, "replacement.md");
        let prepared = sink.prepared_text_capture(
            candidates[0],
            PreparedTextContent {
                text: "must not commit".to_owned(),
                size: 15,
                sha256: hex_sha256(b"must not commit"),
            },
        );
        let batch = sink.commit_added_text_batch(vec![prepared]);
        let policy_retire = sink.retire_policy_excluded("first.md");

        std::fs::remove_dir_all(&root).expect("remove replacement capture root");
        std::fs::rename(&moved_root, &root).expect("restore original capture root");
        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(matches!(
            parallel,
            PreparedTextPrefix::RootMismatch { attempted: 1 }
        ));
        assert_eq!(single, Err(ESCAPES_ROOT));
        assert_eq!(batch, BatchIngestResult::Uncertain { attempted: 1 });
        assert_eq!(policy_retire, Err(ESCAPES_ROOT));
        assert_eq!(moment_count(&db, "replacement.md"), 0);
        assert_eq!(
            snapshot(&db, "first.md").expect("head retained").text,
            "first"
        );
    }

    #[test]
    fn collection_reconcile_refuses_replacement_root_before_dispatch() {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().to_path_buf();
        let moved_root = root.with_file_name(format!(
            "{}-moved",
            root.file_name().expect("root name").to_string_lossy()
        ));
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        write_file(&root, "tasks/collection.yaml", b"name: Tasks\n");
        write_file(&root, "tasks/alpha.md", b"original task\n");
        let mut sink = StoreCaptureSink::new(actor, WORKSPACE_ID, VERSION_ID, &root, 10, None);
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/alpha.md").expect("capture record");
        seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");
        assert!(collection_record(&db, "tasks/alpha.md").is_none());

        std::fs::rename(&root, &moved_root).expect("move original capture root");
        std::fs::create_dir(&root).expect("create replacement root");
        write_file(&root, "tasks/collection.yaml", b"name: Replacement\n");
        write_file(&root, "tasks/alpha.md", b"replacement task\n");
        let replacement_before =
            std::fs::read(root.join("tasks/alpha.md")).expect("read replacement record");
        let result = sink.reconcile_collections();
        let replacement_after =
            std::fs::read(root.join("tasks/alpha.md")).expect("reread replacement record");
        let binding_after = collection_record(&db, "tasks/alpha.md");

        std::fs::remove_dir_all(&root).expect("remove replacement capture root");
        std::fs::rename(&moved_root, &root).expect("restore original capture root");
        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(matches!(
            result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert_eq!(replacement_after, replacement_before);
        assert!(binding_after.is_none(), "adoption must not reach the actor");
    }

    #[test]
    fn queued_collection_reconcile_refuses_replacement_root_before_db_changes() {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().to_path_buf();
        let moved_root = root.with_file_name(format!(
            "{}-moved",
            root.file_name().expect("root name").to_string_lossy()
        ));
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        write_file(&root, "tasks/collection.yaml", b"name: Tasks\n");
        write_file(&root, "tasks/alpha.md", b"original task\n");
        let mut sink =
            StoreCaptureSink::new(actor.clone(), WORKSPACE_ID, VERSION_ID, &root, 10, None);
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/alpha.md").expect("capture record");
        seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");
        assert!(collection_record(&db, "tasks/alpha.md").is_none());
        let durable_before = durable_row_counts(&db);

        let guard = PausedRootGuard::new(&root);
        let actor_guard: Arc<dyn WorkspaceRootGuard> = guard.clone();
        let command_actor = actor.clone();
        let command_leases = sink.leases.clone();
        let command_self_writes: Arc<dyn dohc_engine_runtime::SelfWriteRecorder> =
            Arc::new(sink.self_writes.clone());
        let command_root = root.clone();
        let command = std::thread::spawn(move || {
            command_actor.reconcile_collections_blocking_guarded(
                WORKSPACE_ID.to_owned(),
                VERSION_ID.to_owned(),
                command_root,
                command_leases,
                command_self_writes,
                10,
                Arc::new(NoFaults),
                actor_guard,
            )
        });

        guard.wait_until_reached();
        std::fs::rename(&root, &moved_root).expect("move original capture root");
        std::fs::create_dir(&root).expect("create replacement root");
        write_file(&root, "tasks/collection.yaml", b"name: Replacement\n");
        write_file(&root, "tasks/alpha.md", b"replacement task\n");
        let replacement_before =
            std::fs::read(root.join("tasks/alpha.md")).expect("read replacement record");
        guard.release();
        let result = command.join().expect("join reconcile command");
        let replacement_after =
            std::fs::read(root.join("tasks/alpha.md")).expect("reread replacement record");
        let binding_after = collection_record(&db, "tasks/alpha.md");
        let durable_after = durable_row_counts(&db);

        std::fs::remove_dir_all(&root).expect("remove replacement capture root");
        std::fs::rename(&moved_root, &root).expect("restore original capture root");
        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(matches!(
            result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert_eq!(replacement_after, replacement_before);
        assert_eq!(durable_after, durable_before);
        assert!(
            binding_after.is_none(),
            "queued reconciliation must not change collection bindings"
        );
    }

    #[test]
    fn post_commit_root_refusal_leaves_no_self_write_suppression() {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().to_path_buf();
        let moved_root = root.with_file_name(format!(
            "{}-moved",
            root.file_name().expect("root name").to_string_lossy()
        ));
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        write_file(&root, "tasks/collection.yaml", b"name: Tasks\n");
        write_file(&root, "tasks/alpha.md", b"original task\n");
        let mut sink =
            StoreCaptureSink::new(actor.clone(), WORKSPACE_ID, VERSION_ID, &root, 10, None);
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/alpha.md").expect("capture record");
        seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");

        // Reconciliation validates once at actor entry and once before the
        // settlement. Pause the third check, after the settlement commit but
        // before its materialization boundary.
        let guard = PausedRootGuard::pausing_on(&root, 3);
        let actor_guard: Arc<dyn WorkspaceRootGuard> = guard.clone();
        let command_actor = actor.clone();
        let command_leases = sink.leases.clone();
        let command_self_writes: Arc<dyn dohc_engine_runtime::SelfWriteRecorder> =
            Arc::new(sink.self_writes.clone());
        let command_root = root.clone();
        let command = std::thread::spawn(move || {
            command_actor.reconcile_collections_blocking_guarded(
                WORKSPACE_ID.to_owned(),
                VERSION_ID.to_owned(),
                command_root,
                command_leases,
                command_self_writes,
                10,
                Arc::new(NoFaults),
                actor_guard,
            )
        });

        guard.wait_until_reached();
        std::fs::rename(&root, &moved_root).expect("move original capture root");
        std::fs::create_dir(&root).expect("create replacement root");
        write_file(&root, "tasks/alpha.md", b"replacement task\n");
        let replacement_before =
            std::fs::read(root.join("tasks/alpha.md")).expect("read replacement record");
        guard.release();
        let result = command.join().expect("join reconcile command");
        let replacement_after =
            std::fs::read(root.join("tasks/alpha.md")).expect("reread replacement record");
        let committed =
            snapshot(&db, "tasks/alpha.md").expect("settlement committed before refusal");
        let suppression_pending =
            sink.self_writes
                .has_pending(WORKSPACE_ID, "tasks/alpha.md", &committed.blob_sha256);

        std::fs::remove_dir_all(&root).expect("remove replacement capture root");
        std::fs::rename(&moved_root, &root).expect("restore original capture root");
        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(matches!(
            result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert_eq!(replacement_after, replacement_before);
        assert!(
            !suppression_pending,
            "a refused materialization must not suppress a later genuine capture"
        );
    }

    #[test]
    fn queued_materialized_retire_refuses_replacement_root_before_db_changes() {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().to_path_buf();
        let moved_root = root.with_file_name(format!(
            "{}-moved",
            root.file_name().expect("root name").to_string_lossy()
        ));
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        write_file(&root, "first.md", b"first");
        let mut sink =
            StoreCaptureSink::new(actor.clone(), WORKSPACE_ID, VERSION_ID, &root, 10, None);
        ingest(&mut sink, "first.md").expect("capture first head");
        let durable_before = durable_row_counts(&db);

        let guard = PausedRootGuard::new(&root);
        let actor_guard: Arc<dyn WorkspaceRootGuard> = guard.clone();
        let command_actor = actor.clone();
        let command_leases = sink.leases.clone();
        let command_self_writes: Arc<dyn dohc_engine_runtime::SelfWriteRecorder> =
            Arc::new(sink.self_writes.clone());
        let command_root = root.clone();
        let command = std::thread::spawn(move || {
            command_actor.capture_retire_materialized_blocking_guarded(
                CaptureRetire {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    path: "first.md".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 20,
                    request_id: None,
                    only_if_text_head: false,
                    only_if_capture_origin: true,
                    allow_ydoc_origin: true,
                },
                command_root,
                command_self_writes,
                command_leases,
                Arc::new(NoFaults),
                actor_guard,
            )
        });

        guard.wait_until_reached();
        std::fs::rename(&root, &moved_root).expect("move original capture root");
        std::fs::create_dir(&root).expect("create replacement root");
        write_file(&root, "first.md", b"replacement first");
        let replacement_before =
            std::fs::read(root.join("first.md")).expect("read replacement head");
        guard.release();
        let result = command.join().expect("join retire command");
        let replacement_after =
            std::fs::read(root.join("first.md")).expect("reread replacement head");
        let retained = snapshot(&db, "first.md").expect("head retained");
        let durable_after = durable_row_counts(&db);

        std::fs::remove_dir_all(&root).expect("remove replacement capture root");
        std::fs::rename(&moved_root, &root).expect("restore original capture root");
        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(matches!(
            result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert_eq!(retained.text, "first");
        assert_eq!(durable_after, durable_before);
        assert_eq!(replacement_after, replacement_before);
    }

    #[test]
    fn present_root_binding_failure_cannot_adopt_a_later_replacement() {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().join("workspace");
        let moved_root = capture_scratch.path().join("workspace-moved");
        std::fs::create_dir(&root).expect("create capture root");
        write_file(&root, "first.md", b"first");
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        let mut seed =
            StoreCaptureSink::new(actor.clone(), WORKSPACE_ID, VERSION_ID, &root, 10, None);
        ingest(&mut seed, "first.md").expect("seed captured head");
        drop(seed);

        std::fs::rename(&root, &moved_root).expect("move original capture root");
        std::fs::write(&root, b"not a directory").expect("install refused root");
        let mut refused = StoreCaptureSink::new(actor, WORKSPACE_ID, VERSION_ID, &root, 20, None);
        std::fs::remove_file(&root).expect("remove refused root");
        std::fs::create_dir(&root).expect("install replacement directory");
        let retire = refused.retire_policy_excluded("first.md");

        std::fs::remove_dir_all(&root).expect("remove replacement capture root");
        std::fs::rename(&moved_root, &root).expect("restore original capture root");
        drop(refused);
        supervisor.close(&db).expect("close actor");
        assert_eq!(retire, Err(ESCAPES_ROOT));
        assert_eq!(
            snapshot(&db, "first.md").expect("head retained").text,
            "first"
        );
    }

    #[test]
    fn initially_absent_root_rejects_generation_and_fresh_sink_reads_policy() {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().join("workspace");
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        let mut stale =
            StoreCaptureSink::new(actor.clone(), WORKSPACE_ID, VERSION_ID, &root, 10, None);

        std::fs::create_dir(&root).expect("create recovered root");
        write_file(
            &root,
            ".dohc/files.toml",
            b"[[rule]]\npath = \"private/**\"\ntracked = false\n",
        );
        write_file(&root, "private/journal.md", b"personal");
        write_file(&root, "public.md", b"shared");
        assert_eq!(ingest(&mut stale, "private/journal.md"), Err(ESCAPES_ROOT));
        drop(stale);

        let mut fresh = StoreCaptureSink::new(actor, WORKSPACE_ID, VERSION_ID, &root, 20, None);
        assert_eq!(
            ingest(&mut fresh, "private/journal.md").expect("fresh policy snapshot"),
            IngestOutcome::NotOwned
        );
        assert!(matches!(
            ingest(&mut fresh, "public.md").expect("fresh public capture"),
            IngestOutcome::Captured { .. }
        ));

        drop(fresh);
        supervisor.close(&db).expect("close actor");
        assert!(snapshot(&db, "private/journal.md").is_none());
        assert_eq!(
            snapshot(&db, "public.md")
                .expect("captured public head")
                .text,
            "shared"
        );
    }

    #[test]
    fn reconcile_settles_deferred_and_raced_paths_without_degrading() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), ".env", b"TOKEN=x");
        write_file(scratch.path(), "b-good.md", b"good");
        let ingest_op = |path: &str| CaptureOp::Ingest {
            path: path.to_owned(),
            size: 1,
            sha256: "stale".to_owned(),
            mtime_ms: 0,
            media_type: "text/markdown",
            reason: IngestReason::Added,
        };
        let plan = ReconcilePlan {
            from_generation: ScanGeneration(0),
            to_generation: ScanGeneration(1),
            ops: vec![
                ingest_op(".env"),
                ingest_op("b-good.md"),
                ingest_op("c-gone.md"),
            ],
            retained_over_cap: Vec::new(),
            unconfirmed_removed: Vec::new(),
            degraded: false,
            degraded_paths: Vec::new(),
            prepared_from_dirty: true,
            dirty_epoch: 0,
        };

        let result = apply_reconcile_plan(&plan, &mut sink, &FilesNoFaults);
        // The text sibling and the secret apply (the secret into the
        // encrypted store); only the raced-away path settles as not-owned.
        assert_eq!(result.applied_paths, [".env", "b-good.md"]);
        assert_eq!(result.not_owned_paths, ["c-gone.md"]);
        assert!(result.failed_applies.is_empty());
        assert!(!result.degraded);

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(snapshot(&db, ".env").is_none());
        assert!(snapshot(&db, "c-gone.md").is_none());
        assert_eq!(
            snapshot(&db, "b-good.md").expect("sibling snapshot").text,
            "good"
        );
    }

    #[test]
    fn store_refused_name_settles_as_not_owned_instead_of_degrading() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        // Legal on-disk names the scan floor tracks but the domain store's
        // stricter admission gate refuses (`..` substring). Retrying can never
        // succeed, so the op must settle instead of poisoning every capture
        // run as degraded.
        write_file(scratch.path(), "release..notes.md", b"legal on disk");

        assert_eq!(
            ingest(&mut sink, "release..notes.md").expect("refused name settles"),
            IngestOutcome::NotOwned
        );
        // Once the file is gone, a planned retire of the refused name is a
        // clean no-op (the store can never have held a head for it).
        std::fs::remove_file(scratch.path().join("release..notes.md")).expect("delete");
        sink.retire("release..notes.md")
            .expect("nothing to retire under a refused name");

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(moment_count(&db, "release..notes.md"), 0);
    }

    #[test]
    fn retire_is_refused_when_a_regular_file_reappeared() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "back.md", b"captured");
        ingest(&mut sink, "back.md").expect("seed ingest");

        // A Retire op prepared from a scan that saw the path absent must be
        // refused if the file reappeared before the apply — retiring would
        // forget the manifest entry while a live disk file has no snapshot.
        assert_eq!(sink.retire("back.md"), Err(RETIRE_RACED));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(
            snapshot(&db, "back.md").expect("head retained").text,
            "captured"
        );
    }

    #[cfg(unix)]
    #[test]
    fn fifo_leaf_neither_blocks_nor_captures() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        let fifo_path = scratch.path().join("pipe.md");
        // The workspace forbids unsafe code, so shell out to coreutils
        // instead of calling libc::mkfifo directly.
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        assert!(made, "mkfifo unavailable on this unix host");

        // The advisory lstat rejects the at-rest FIFO; the O_NONBLOCK open is
        // what guarantees a FIFO swapped in after that check cannot hang the
        // worker — exercise it directly.
        assert!(matches!(
            open_no_follow(&fifo_path),
            NoFollowOpen::Opened(_) | NoFollowOpen::Failed
        ));
        assert_eq!(
            ingest(&mut sink, "pipe.md").expect("fifo is not ownable"),
            IngestOutcome::NotOwned
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(moment_count(&db, "pipe.md"), 0);
    }

    #[test]
    fn binary_flip_and_revert_to_identical_text_recaptures_the_head() {
        use dohc_engine_files::{
            CancellationToken, ReconcileController, ReconcileRun, ScanBounds, Scanner,
            apply_then_ack,
        };

        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
        let mut controller = ReconcileController::new();
        let reconcile = |controller: &mut ReconcileController| match controller
            .reconcile(&scanner, scratch.path(), &CancellationToken::new())
            .expect("reconcile")
        {
            ReconcileRun::Completed(plan) => plan,
            other => panic!("expected completed plan, got {other:?}"),
        };

        // Capture the original text through the full plan/ack cycle.
        write_file(scratch.path(), "flip.md", b"same bytes");
        let plan = reconcile(&mut controller);
        apply_then_ack(&mut controller, &plan, &mut sink, &FilesNoFaults).expect("seed ack");
        assert!(controller.tracks_path("flip.md"));

        // Flip to binary: the binary head is captured and the manifest
        // records the binary bytes' hash.
        write_file(scratch.path(), "flip.md", &[0xff, 0xfe, 0x00]);
        controller.mark_dirty();
        let plan = reconcile(&mut controller);
        apply_then_ack(&mut controller, &plan, &mut sink, &FilesNoFaults).expect("flip ack");
        assert!(
            controller.tracks_path("flip.md"),
            "a captured binary flip records the binary hash"
        );

        // Revert to the exact original text bytes: the manifest holds the
        // binary hash, so this diffs as a change and re-ingests as text.
        write_file(scratch.path(), "flip.md", b"same bytes");
        controller.mark_dirty();
        let plan = reconcile(&mut controller);
        apply_then_ack(&mut controller, &plan, &mut sink, &FilesNoFaults).expect("revert ack");

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(
            snapshot(&db, "flip.md").expect("recaptured head").text,
            "same bytes"
        );
    }

    #[test]
    fn secret_capture_encrypts_dedupes_and_retires() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), ".env", b"TOKEN=alpha");

        let first = ingest(&mut sink, ".env").expect("secret capture");
        assert_eq!(
            first,
            IngestOutcome::Captured {
                size: 11,
                sha256: hex_sha256(b"TOKEN=alpha"),
            }
        );
        // The key file was minted on first use and is reused thereafter.
        let key_path = scratch.path().join(".dohc/engine/secret.key");
        let key_bytes = std::fs::read(&key_path).expect("key file exists");
        assert!(matches!(
            ingest(&mut sink, ".env").expect("equal secret capture"),
            IngestOutcome::Captured { .. }
        ));
        assert_eq!(
            std::fs::read(&key_path).expect("key file stable"),
            key_bytes,
            "an existing key is never regenerated"
        );

        // Delete from disk: the plan retire removes the encrypted tip.
        std::fs::remove_file(scratch.path().join(".env")).expect("delete");
        sink.retire(".env").expect("secret retire");

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(secret_tip_len(&db, ".env"), None, "tip retired");
        assert_eq!(moment_count(&db, ".env"), 0, "plaintext tables untouched");
    }

    #[test]
    fn secret_key_is_not_minted_in_a_replacement_root_after_plaintext_read() {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let capture_scratch = ScratchDir::new().expect("capture scratch");
        let root = capture_scratch.path().to_path_buf();
        let moved_root = root.with_file_name(format!(
            "{}-moved",
            root.file_name().expect("root name").to_string_lossy()
        ));
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        write_file(&root, ".env", b"TOKEN=original");
        let mut sink = StoreCaptureSink::new(actor, WORKSPACE_ID, VERSION_ID, &root, 10, None);

        let content = sink
            .read_current_secret(".env")
            .expect("read original plaintext");
        std::fs::rename(&root, &moved_root).expect("move original capture root");
        std::fs::create_dir(&root).expect("recreate capture root");
        let result = sink.ingest_secret_content(".env", true, false, content);
        let replacement_key_exists = root.join(".dohc/engine/secret.key").exists();

        std::fs::remove_dir_all(&root).expect("remove replacement capture root");
        std::fs::rename(&moved_root, &root).expect("restore original capture root");
        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(result, Err(ESCAPES_ROOT));
        assert!(
            !replacement_key_exists,
            "replacement root must receive no key"
        );
        assert_eq!(secret_tip_len(&db, ".env"), None);
    }

    #[test]
    fn secret_changed_ingest_consumes_an_engine_self_write() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine db path");
        let key = create_key_file(scratch.path()).expect("secret key");
        let mut store = EngineStore::open(&db, 1).expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &FilesNoFaults)
            .expect("main");
        SecretFileStore::new(&mut store, &key)
            .write_secret_file(
                &SecretWrite {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    path: ".env".to_owned(),
                    text: "MODE=feature\n".to_owned(),
                    moment_id: "switch-owned-by-api".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 2,
                    disk_intent: SecretDiskIntent::Materialize,
                },
                &FilesNoFaults,
            )
            .expect("API secret");
        drop(store);
        write_file(scratch.path(), ".env", b"MODE=feature\n");

        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 3).expect("actor").actor;
        let self_writes = SelfWriteSuppression::default();
        self_writes.record(WORKSPACE_ID, ".env", &hex_sha256(b"MODE=feature\n"));
        let mut sink = StoreCaptureSink::new_with_self_writes(
            actor,
            WORKSPACE_ID,
            VERSION_ID,
            scratch.path(),
            4,
            None,
            LeaseRegistry::new(),
            self_writes,
            CaptureProvenance::default(),
        );
        let observed_sha = match sink.read_current_secret(".env").expect("read secret") {
            SecretContent::Text(text) => hex_sha256(text.as_bytes()),
            SecretContent::Untracked => panic!("fixture secret must be tracked"),
        };
        assert!(
            sink.self_writes
                .has_pending(WORKSPACE_ID, ".env", &observed_sha),
            "fixture must arm the exact identity capture will observe"
        );

        assert!(matches!(
            ingest(&mut sink, ".env").expect("suppressed switch observation"),
            IngestOutcome::Captured { .. }
        ));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(
            secret_tip_capture_owned(&db, ".env"),
            Some(false),
            "observing the engine's own switch write must not grant capture ownership"
        );
    }

    #[test]
    fn secret_that_stops_being_utf8_text_retires_the_tip() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), ".env", b"TOKEN=alpha");
        ingest(&mut sink, ".env").expect("seed secret");

        // Binary-in-disguise is not capturable secret text (TS parity: the
        // secret read has no binary route) — the stale tip must retire.
        write_file(scratch.path(), ".env", &[0xff, 0x00, 0xfe]);
        assert_eq!(
            ingest(&mut sink, ".env").expect("untracked secret"),
            IngestOutcome::NotOwned
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(secret_tip_len(&db, ".env"), None);
    }

    #[test]
    fn secret_retire_is_refused_when_the_file_reappeared() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), ".env", b"TOKEN=alpha");
        ingest(&mut sink, ".env").expect("seed secret");

        // A Retire op prepared from an absent-scan must refuse if the secret
        // file reappeared before the apply.
        assert_eq!(sink.retire(".env"), Err(RETIRE_RACED));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(secret_tip_len(&db, ".env"), Some(11), "tip retained");
    }

    #[test]
    fn missing_key_over_existing_secret_state_fails_closed_instead_of_reminting() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), ".env", b"TOKEN=alpha");
        ingest(&mut sink, ".env").expect("seed secret");
        drop(sink);

        // A backup restored without the key file / accidental deletion.
        std::fs::remove_file(scratch.path().join(".dohc/engine/secret.key")).expect("lose key");

        let actor = supervisor.open(&db, 1).expect("reopen actor").actor;
        let mut fresh =
            StoreCaptureSink::new(actor, WORKSPACE_ID, VERSION_ID, scratch.path(), 30, None);
        write_file(scratch.path(), ".env", b"TOKEN=changed");
        let err = ingest(&mut fresh, ".env").expect_err("must not mint over live secret state");
        assert_eq!(err.reason, "workspace secret key unavailable");
        assert!(
            !scratch.path().join(".dohc/engine/secret.key").exists(),
            "no fresh key was minted over the orphaned history"
        );

        drop(fresh);
        supervisor.close(&db).expect("close actor");
        assert_eq!(secret_tip_len(&db, ".env"), Some(11), "tip retained");
    }

    #[test]
    fn non_canonical_secret_names_are_refused_both_ways() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        // A literal on-disk `%2eenv` decodes to the durable key `.env`;
        // capturing it would create an encrypted head under an aliased key.
        write_file(scratch.path(), "%2eenv", b"TOKEN=evil");

        assert_eq!(
            ingest(&mut sink, "%2eenv").expect("refused, settled"),
            IngestOutcome::NotOwned
        );
        sink.retire("%2eenv").expect("refused retire is a no-op");

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(secret_tip_len(&db, ".env"), None);
        assert_eq!(secret_tip_len(&db, "%2eenv"), None);
    }

    #[test]
    fn suppression_keeps_multiple_pending_identities_per_path() {
        // Two settles can land before capture consumes the first watcher
        // event. Mutation check: restore the single-slot HashMap<_, String>
        // registry — the in-order case consumes sha2 for the first event
        // (mismatch → ingest) and this test fails.
        let writes = SelfWriteSuppression::default();
        // In-order delivery: each event consumes its own identity.
        writes.record("ws", "a.md", "sha1");
        writes.record("ws", "a.md", "sha2");
        assert!(writes.consume("ws", "a.md", "sha1"));
        assert!(writes.consume("ws", "a.md", "sha2"));
        assert!(!writes.consume("ws", "a.md", "sha2"), "single-shot");
        // Coalesced delivery: matching the later identity consumes the
        // superseded earlier one too.
        writes.record("ws", "a.md", "sha1");
        writes.record("ws", "a.md", "sha2");
        assert!(writes.consume("ws", "a.md", "sha2"));
        assert!(
            !writes.consume("ws", "a.md", "sha1"),
            "predecessor consumed"
        );
        // External edit: every pending identity clears (no later-revert
        // suppression) and the observation ingests.
        writes.record("ws", "a.md", "sha1");
        assert!(!writes.consume("ws", "a.md", "external"));
        assert!(!writes.consume("ws", "a.md", "sha1"), "cleared by mismatch");
        // A stale retract removes only its own identity.
        writes.record("ws", "a.md", "sha1");
        writes.record("ws", "a.md", "sha2");
        dohc_engine_runtime::SelfWriteRecorder::retract(&writes, "ws", "a.md", "sha1");
        assert!(writes.consume("ws", "a.md", "sha2"), "newer entry survives");
    }

    #[test]
    fn non_ownable_ingest_spares_a_ydoc_head_but_retires_a_capture_head() {
        // AUDIT-SILENTSAVE. Pins the sink wiring directly: that the
        // NonOwnable branch passes allow_ydoc_origin=false. The rpc test
        // covers the same rule end to end, but only while the driver keeps
        // offering that path — this does not depend on the driver at all.
        //
        // A settled Y.Doc past MAX_CAPTURE_TEXT_BYTES arrives here as
        // NonOwnable. Retiring it destroys a document the user just saved.
        // An ordinary CAPTURE head of the same shape must still retire.
        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("db");
        let mut store = EngineStore::open(&db, 1).expect("store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &FilesNoFaults)
            .expect("main");

        // A materialized Y.Doc head, exactly as a settle leaves it.
        store
            .write_with(&FilesNoFaults, |tx| {
                dohc_engine_domain::write_projected_text_in_tx(
                    tx,
                    &dohc_engine_domain::WriteText {
                        workspace_id: WORKSPACE_ID.to_owned(),
                        version_id: VERSION_ID.to_owned(),
                        object_id: "obj-sink-ydoc".to_owned(),
                        path: "notes/settled.md".to_owned(),
                        text: "settled body".to_owned(),
                        moment_id: "m-sink-ydoc".to_owned(),
                        metadata_origin: "ydoc".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                        request_id: None,
                    },
                )?;
                Ok::<(), dohc_engine_domain::DomainError>(())
            })
            .expect("ydoc head");
        drop(store);

        // An ordinary captured head at another path, via the sink itself.
        let supervisor = WorkspaceSupervisor::new();
        let (_db, mut seed_sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "notes/plain.md", b"plain body");
        assert!(matches!(
            ingest(&mut seed_sink, "notes/plain.md").expect("seed ingest"),
            IngestOutcome::Captured { .. }
        ));
        assert!(snapshot(&db, "notes/plain.md").is_some());

        // Both files are now NON-OWNABLE on disk: past the text cap.
        let over_cap = vec![b'x'; (MAX_CAPTURE_TEXT_BYTES + 1) as usize];
        write_file(scratch.path(), "notes/settled.md", &over_cap);
        write_file(scratch.path(), "notes/plain.md", &over_cap);

        let (_db2, mut sink) = sink_for(&scratch, &supervisor);
        assert!(matches!(
            ingest(&mut sink, "notes/settled.md").expect("ydoc ingest"),
            IngestOutcome::NotOwned
        ));
        assert!(matches!(
            ingest(&mut sink, "notes/plain.md").expect("capture ingest"),
            IngestOutcome::NotOwned
        ));

        // The assertion: ownership decided, not the classification alone.
        assert!(
            snapshot(&db, "notes/settled.md").is_some(),
            "a settled Y.Doc head must survive a not-engine-ownable ingest"
        );
        assert!(
            snapshot(&db, "notes/plain.md").is_none(),
            "an ordinary capture head must still retire when it stops being ownable"
        );
    }
}
