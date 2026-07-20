//! Dormant files-reconcile adapter for the actor-owned capture primitives.

use dohc_engine_crypto::{SecretDataKey, create_key_file, load_key_file};
use dohc_engine_domain::DomainError;
use dohc_engine_files::media::is_text_media_type;
use dohc_engine_files::policy::{PathClassification, classify_engine_file_path_normalized};
use dohc_engine_files::{
    CaptureError, CaptureSink, IngestOutcome, IngestReason, MAX_CAPTURE_BINARY_BYTES,
    MAX_CAPTURE_TEXT_BYTES,
};
use dohc_engine_runtime::search::{
    FilesPolicyRule, read_engine_search_policy, resolve_effective_policy,
};
use dohc_engine_runtime::{
    ActorHandle, CaptureIngest, CaptureIngestBinary, CaptureRetire, CaptureSecret,
    CaptureSecretRetire, NoFaults, RuntimeError,
};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const CAPTURE_METADATA_ORIGIN: &str = "capture";
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
const SECRET_KEY_UNAVAILABLE: CaptureError = CaptureError {
    reason: "workspace secret key unavailable",
};

/// Bridges a files-crate reconcile plan to the actor's domain capture writes.
///
/// The adapter is intentionally not wired into workspace open/close yet. Its
/// caller supplies the active version and capture-time provenance for one
/// reconcile run; `.dohc/files.toml` is read once at construction, matching
/// the one-policy-snapshot-per-task rule in the TS capture path.
pub struct StoreCaptureSink {
    actor: ActorHandle,
    workspace_id: String,
    version_id: String,
    shadow_root: PathBuf,
    now_ms: i64,
    author_json: Option<String>,
    files_policy: Option<Vec<FilesPolicyRule>>,
    /// Lazily loaded-or-created on the FIRST secret capture (TS parity:
    /// `loadSecretDataKey` create branch) so workspaces without secrets never
    /// mint a key file.
    secret_key: Option<SecretDataKey>,
}

impl StoreCaptureSink {
    pub fn new(
        actor: ActorHandle,
        workspace_id: impl Into<String>,
        version_id: impl Into<String>,
        shadow_root: impl Into<PathBuf>,
        now_ms: i64,
        author_json: Option<String>,
    ) -> Self {
        let shadow_root = shadow_root.into();
        // `.dohc/files.toml` can only NARROW engine ownership below the hard
        // floor. A broken policy file keeps capture FLOOR-ONLY (the WS-F rule:
        // writes are never dropped for a malformed policy — search is where a
        // broken policy fails closed), which is exactly the `None` this
        // returns for a missing OR broken file.
        let files_policy = read_engine_search_policy(&shadow_root).files_policy;
        StoreCaptureSink {
            actor,
            workspace_id: workspace_id.into(),
            version_id: version_id.into(),
            shadow_root,
            now_ms,
            author_json,
            files_policy,
            secret_key: None,
        }
    }

    fn ensure_secret_key(&mut self) -> Result<&SecretDataKey, CaptureError> {
        if self.secret_key.is_none() {
            let key = match load_key_file(&self.shadow_root).map_err(|_| SECRET_KEY_UNAVAILABLE)? {
                Some(key) => key,
                None => {
                    // NEVER mint over existing encrypted state: a missing key
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
                    create_key_file(&self.shadow_root).map_err(|_| SECRET_KEY_UNAVAILABLE)?
                }
            };
            self.secret_key = Some(key);
        }
        Ok(self.secret_key.as_ref().expect("key just ensured"))
    }

    fn policy_tracks(&self, path: &str) -> bool {
        match &self.files_policy {
            None => true,
            Some(rules) => resolve_effective_policy(path, Some(rules.as_slice()), None).tracked,
        }
    }

    /// Re-read the CURRENT disk state for a planned ingest, mirroring the TS
    /// oracle's `readDiskTextState`: lstat-refuse symlink leaves, route by
    /// media type BEFORE UTF-8 sniffing, and apply the text/binary caps. The
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
        let absolute = self.shadow_root.join(path);
        match contained_parent(&self.shadow_root, path) {
            Containment::Contained => {}
            Containment::Absent => return Ok(CurrentContent::Untracked),
            Containment::Escaped => return Err(ESCAPES_ROOT),
        }
        // Advisory lstat mirror of the TS refusal (symlink leaf and non-file
        // entries are not engine-ownable); the no-follow open below is what
        // actually closes the check-then-open race.
        match std::fs::symlink_metadata(&absolute) {
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Ok(CurrentContent::Untracked);
            }
            Ok(_) => {}
            Err(err) if absent_error(&err) => return Ok(CurrentContent::Untracked),
            Err(_) => return Err(READ_FAILED),
        }
        let file = match open_no_follow(&absolute) {
            NoFollowOpen::Opened(file) => file,
            NoFollowOpen::Refused | NoFollowOpen::Absent => return Ok(CurrentContent::Untracked),
            NoFollowOpen::Failed => return Err(READ_FAILED),
        };
        verify_opened_containment(&self.shadow_root, path, &file)?;
        let metadata = file.metadata().map_err(|_| READ_FAILED)?;
        if !metadata.file_type().is_file() {
            return Ok(CurrentContent::Untracked);
        }
        // Between the capture cap and the SCAN cap (64 MiB) the scanner still
        // lists the file, so a grow-past-capture-cap lands here and retires.
        // PAST the scan cap the plan classifies it `retained_over_cap` and the
        // sink is never called — deliberately NOT a retire: the ratified CAL-3
        // delta (BEHAVIOR_DELTA.md §7.1) keeps last-known-good rather than
        // false-deleting live user data behind an operational scan bound.
        if metadata.len() > MAX_CAPTURE_BINARY_BYTES {
            return Ok(CurrentContent::Untracked);
        }
        let text_media = is_text_media_type(media_type, path);
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_CAPTURE_BINARY_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| READ_FAILED)?;
        if bytes.len() as u64 > MAX_CAPTURE_BINARY_BYTES {
            return Ok(CurrentContent::Untracked);
        }
        if !text_media {
            // Non-text media is engine-ownable BINARY content: the TS oracle
            // routes it to the binary store before any UTF-8 sniffing, so a
            // UTF-8-clean `.png` must never land in the plaintext store.
            return Ok(CurrentContent::Binary(bytes));
        }
        match String::from_utf8(bytes) {
            Ok(text) if text.len() as u64 > MAX_CAPTURE_TEXT_BYTES => {
                // Genuine text over the text cap stays untracked (established
                // TS behavior), even though binary of the same size would be
                // ownable.
                Ok(CurrentContent::Untracked)
            }
            Ok(text) => Ok(CurrentContent::Text(text)),
            // A text-suffixed path can be binary in disguise (invalid UTF-8);
            // the store accepts that as binary up to the binary cap.
            Err(err) => Ok(CurrentContent::Binary(err.into_bytes())),
        }
    }

    // The blocking actor calls below carry no timeout; this adapter is dormant
    // and not on any request path. The composition driver (sub-shard C) owns
    // stall handling when it wires this sink into workspace open/close.
    fn ingest_text(
        &self,
        path: &str,
        text: String,
        claim_foreign_head: bool,
    ) -> Result<DomainIngest, CaptureError> {
        match self.actor.capture_ingest_blocking(
            CaptureIngest {
                workspace_id: self.workspace_id.clone(),
                version_id: self.version_id.clone(),
                path: path.to_owned(),
                text,
                metadata_origin: CAPTURE_METADATA_ORIGIN.to_owned(),
                author_json: self.author_json.clone(),
                now_ms: self.now_ms,
                request_id: None,
                claim_foreign_head,
            },
            Arc::new(NoFaults),
        ) {
            Ok(_) => Ok(DomainIngest::Persisted),
            // The store's admission gate is STRICTER than the scan floor
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
                metadata_origin: CAPTURE_METADATA_ORIGIN.to_owned(),
                author_json: self.author_json.clone(),
                now_ms: self.now_ms,
                request_id: None,
                claim_foreign_head,
            },
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

    /// Capture one secret path: read the CURRENT plaintext (mirroring the TS
    /// oracle's `readDiskSecretState` — text rules WITHOUT the media-type
    /// heuristic; non-UTF-8 is untracked, never binary) and write it through
    /// the encrypted store. The workspace key is loaded-or-created on first
    /// use.
    fn ingest_secret(&mut self, path: &str) -> Result<IngestOutcome, CaptureError> {
        match self.read_current_secret(path)? {
            SecretContent::Text(text) => {
                let size = text.len() as u64;
                let sha256 = sha256_hex(text.as_bytes());
                self.ensure_secret_key()?;
                let key = self.secret_key.clone().expect("key ensured just above");
                match self.actor.capture_secret_blocking(
                    CaptureSecret {
                        workspace_id: self.workspace_id.clone(),
                        version_id: self.version_id.clone(),
                        path: path.to_owned(),
                        text,
                        metadata_origin: SECRET_CAPTURE_ORIGIN.to_owned(),
                        now_ms: self.now_ms,
                    },
                    key,
                    Arc::new(NoFaults),
                ) {
                    Ok(_) => Ok(IngestOutcome::Captured { size, sha256 }),
                    Err(RuntimeError::Domain(DomainError::InvalidPath { .. })) => {
                        Ok(IngestOutcome::NotOwned)
                    }
                    Err(_) => Err(SECRET_INGEST_FAILED),
                }
            }
            SecretContent::Untracked => {
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
        match contained_parent(&self.shadow_root, path) {
            Containment::Contained => {}
            Containment::Absent => return Ok(SecretContent::Untracked),
            Containment::Escaped => return Err(ESCAPES_ROOT),
        }
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
            NoFollowOpen::Refused | NoFollowOpen::Absent => return Ok(SecretContent::Untracked),
            NoFollowOpen::Failed => return Err(READ_FAILED),
        };
        verify_opened_containment(&self.shadow_root, path, &file)?;
        let metadata = file.metadata().map_err(|_| READ_FAILED)?;
        if !metadata.file_type().is_file() {
            return Ok(SecretContent::Untracked);
        }
        if metadata.len() > MAX_CAPTURE_TEXT_BYTES {
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
    }

    fn retire_secret(&self, path: &str) -> Result<(), CaptureError> {
        match self.actor.capture_secret_retire_blocking(
            CaptureSecretRetire {
                workspace_id: self.workspace_id.clone(),
                version_id: self.version_id.clone(),
                path: path.to_owned(),
                metadata_origin: SECRET_CAPTURE_ORIGIN.to_owned(),
                now_ms: self.now_ms,
            },
            Arc::new(NoFaults),
        ) {
            Ok(_) => Ok(()),
            Err(RuntimeError::Domain(DomainError::InvalidPath { .. })) => Ok(()),
            Err(_) => Err(SECRET_RETIRE_FAILED),
        }
    }

    /// Retire a head this sink OWNS. `only_if_capture_origin` is always set:
    /// a head written by RPC or replication may legitimately have no disk
    /// counterpart, so a disk-driven retire must never destroy it.
    fn retire_head(&self, path: &str, only_if_text_head: bool) -> Result<(), CaptureError> {
        match self.actor.capture_retire_blocking(
            CaptureRetire {
                workspace_id: self.workspace_id.clone(),
                version_id: self.version_id.clone(),
                path: path.to_owned(),
                now_ms: self.now_ms,
                request_id: None,
                only_if_text_head,
                only_if_capture_origin: true,
            },
            Arc::new(NoFaults),
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

impl CaptureSink for StoreCaptureSink {
    fn ingest(
        &mut self,
        path: &str,
        _size: u64,
        _sha256: &str,
        media_type: &str,
        reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError> {
        // Capture claims a head written by ANOTHER origin only when it
        // OBSERVED the disk transition (`Changed`). On first sight (`Added`,
        // e.g. a fresh or reset manifest) stale disk bytes are
        // indistinguishable from a genuine edit, so a foreign head is left
        // intact — the path is still TRACKED (so the next real edit is seen
        // as `Changed` and captured), just not overwritten now.
        let claim_foreign_head = matches!(reason, IngestReason::Changed);
        // Plan hashes and sizes describe the scan observation only. Re-read the
        // path so settled rapid writes coalesce to the latest disk state.
        let normalized = match classify_engine_file_path_normalized(path) {
            (PathClassification::Ignored, _) => return Ok(IngestOutcome::NotOwned),
            // Secret paths route to the ENCRYPTED store, never the plaintext
            // one (the secret floor outranks policy — `.dohc` files can never
            // unmark it). Same canonical-key rule as the tracked branch: a
            // scanned name that normalizes differently (a literal `%2eenv`)
            // must not create encrypted heads under an aliased key.
            (PathClassification::Secret, normalized) => {
                if normalized.as_deref() != Some(path) {
                    return Ok(IngestOutcome::NotOwned);
                }
                return self.ingest_secret(path);
            }
            (PathClassification::Tracked, normalized) => normalized.ok_or(INGEST_FAILED)?,
        };
        // The domain stores under the CANONICAL relative path. A scanned disk
        // name that normalizes to a DIFFERENT key (e.g. a literal `a%2fb.md`
        // decoding to `a/b.md`) would persist content for a path that does not
        // exist on disk and could clobber the real file at that key. Refuse to
        // capture it — and never retire through it, the canonical key may
        // belong to another live file.
        if normalized != path {
            return Ok(IngestOutcome::NotOwned);
        }
        if !self.policy_tracks(path) {
            // `.dohc/files.toml` narrowed the path out of engine ownership:
            // retire any stale head (TS: "Stopped tracking by policy") so
            // opted-out content is never left stale-but-authoritative.
            //
            // KNOWN GAP, owned by the composition-driver sub-shard: this
            // branch only runs when the diff emitted an op for the path. A
            // policy flip on an UNCHANGED file emits none (`.dohc` is
            // unwatched — policy edits generate no events, matching the TS
            // oracle), so the driver must rebuild the controller with an
            // empty manifest on a policy-snapshot change to re-offer every
            // path through here.
            self.retire_head(path, false)?;
            return Ok(IngestOutcome::NotOwned);
        }
        match self.read_current(path, media_type)? {
            CurrentContent::Text(text) => {
                // Report the identity of the bytes ACTUALLY captured — the
                // re-read can be newer than the plan's scan observation, and
                // the manifest must record reality or a later revert to the
                // scan-time bytes would diff clean and never re-ingest.
                let size = text.len() as u64;
                let sha256 = sha256_hex(text.as_bytes());
                match self.ingest_text(path, text, claim_foreign_head)? {
                    DomainIngest::Persisted => Ok(IngestOutcome::Captured { size, sha256 }),
                    DomainIngest::NameRefused => Ok(IngestOutcome::NotOwned),
                    // Foreign head left intact: TRACK the disk identity so the
                    // next genuine edit arrives as `Changed` and is captured.
                    DomainIngest::ForeignHead => Ok(IngestOutcome::Captured { size, sha256 }),
                }
            }
            CurrentContent::Untracked => {
                // The path stopped being engine-ownable text (absent, symlink,
                // non-file, or over cap): retire so no stale snapshot remains,
                // and report NotOwned so the manifest forgets the path instead
                // of recording the planned ingest as captured.
                self.retire_head(path, false)?;
                Ok(IngestOutcome::NotOwned)
            }
            CurrentContent::Binary(bytes) => {
                // Engine-ownable binary content persists as a BINHEAD binary
                // head (a text->binary flip replaces the text head in the
                // same transaction — no separate retire). The receipt carries
                // the bytes' identity, which equals the scanner's hash of the
                // same file bytes.
                let size = bytes.len() as u64;
                let sha256 = sha256_hex(&bytes);
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
                match contained_parent(&self.shadow_root, path) {
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
                // regular file that REAPPEARED between scan and apply must not
                // be retired — fail the op so the path stays dirty and the
                // rescan captures the live content instead.
                let absolute = self.shadow_root.join(path);
                // Same ancestor containment as read_current: the probe's
                // verdict must never be based on an off-root file reached
                // through a symlinked ancestor. A missing parent confirms the
                // tracked file gone; an escape retains last-known-good.
                match contained_parent(&self.shadow_root, path) {
                    Containment::Contained => {}
                    Containment::Absent => return self.retire_head(path, false),
                    Containment::Escaped => return Err(ESCAPES_ROOT),
                }
                match std::fs::symlink_metadata(&absolute) {
                    Ok(metadata) if metadata.file_type().is_file() => Err(RETIRE_RACED),
                    // A non-regular replacement confirms the tracked regular
                    // file gone; absence confirms it outright.
                    Ok(_) => self.retire_head(path, false),
                    Err(err) if absent_error(&err) => self.retire_head(path, false),
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

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
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
    /// Absent, or present but not engine-ownable at this path.
    Untracked,
}

fn absent_error(err: &std::io::Error) -> bool {
    matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}

enum Containment {
    Contained,
    Absent,
    Escaped,
}

/// The canonical location `rel_path` would have if NO ancestor were a
/// symlink: the canonical root joined with the lexical segments. Any symlink
/// anywhere in the chain — even one resolving INSIDE the root — makes the
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

/// Ancestor guard: the canonicalized parent must EQUAL the canonical root
/// joined with the lexical parent segments — not merely resolve somewhere
/// under the root. Strict equality rejects a symlinked ancestor regardless of
/// where it points (off-root exfiltration AND in-root aliasing).
/// Unresolvable-for-any-other-reason fails CLOSED as a refusal.
fn contained_parent(root: &Path, rel_path: &str) -> Containment {
    let absolute = root.join(rel_path);
    let Some(parent) = absolute.parent() else {
        return Containment::Escaped;
    };
    let real_parent = match parent.canonicalize() {
        Ok(real) => real,
        Err(err) if absent_error(&err) => return Containment::Absent,
        Err(_) => return Containment::Escaped,
    };
    let Ok(real_root) = root.canonicalize() else {
        return Containment::Escaped;
    };
    let parent_rel = rel_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    if real_parent == expected_absolute(&real_root, parent_rel) {
        Containment::Contained
    } else {
        Containment::Escaped
    }
}

/// Post-open containment recheck: re-resolve the OPENED path and require it
/// EQUAL to its lexical location under the canonical root (same strict rule
/// as [`contained_parent`]). Catches an ancestor swapped to a symlink between
/// the pre-open check and the open. On Unix the opened descriptor's
/// (dev, ino) must also match the re-resolved path, so a swap-back cannot
/// hide a foreign descriptor.
fn verify_opened_containment(root: &Path, rel_path: &str, file: &File) -> Result<(), CaptureError> {
    let absolute = root.join(rel_path);
    let real = absolute.canonicalize().map_err(|_| ESCAPES_ROOT)?;
    let real_root = root.canonicalize().map_err(|_| ESCAPES_ROOT)?;
    if real != expected_absolute(&real_root, rel_path) {
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
    use dohc_engine_domain::VersionedTextStore;
    use dohc_engine_files::{CaptureOp, ReconcilePlan, ScanGeneration, apply_reconcile_plan};
    use dohc_engine_runtime::WorkspaceSupervisor;
    use dohc_engine_storage::{EngineStore, NoFaults as FilesNoFaults};
    use dohc_engine_testkit::ScratchDir;

    const WORKSPACE_ID: &str = "ws-capture-sink";
    const VERSION_ID: &str = "main";

    fn sink_for(
        scratch: &ScratchDir,
        supervisor: &WorkspaceSupervisor,
    ) -> (PathBuf, StoreCaptureSink) {
        let db = scratch.engine_db_path().expect("engine db path");
        let actor = supervisor.open(&db, 1).expect("open actor");
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
                sha256: sha256_hex(b"latest"),
            }
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        let captured = snapshot(&db, "notes/a.md").expect("captured snapshot");
        assert_eq!(captured.text, "latest");
        assert_eq!(captured.metadata_origin, CAPTURE_METADATA_ORIGIN);
        assert_eq!(moment_count(&db, "notes/a.md"), 2);
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
        // captures into the ENCRYPTED store (never the plaintext one).
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
                sha256: sha256_hex(&[0xff, 0xfe, 0x00]),
            }
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        // One transition: the binary head replaced the text head atomically.
        assert_eq!(
            binary_head(&db, "flip.md").as_deref(),
            Some(sha256_hex(&[0xff, 0xfe, 0x00]).as_str())
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
            Some(sha256_hex(b"plain ascii bytes").as_str())
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
        // A literal `a%2fb.md` on disk decodes to the SAME durable key as the
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
        let actor = supervisor.open(&db, 1).expect("reopen actor");
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

        // An ancestor symlink that resolves INSIDE the workspace still aliases
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
        // The text sibling AND the secret apply (the secret into the
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
        // what guarantees a FIFO swapped in AFTER that check cannot hang the
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

        // Flip to binary: the binary head is CAPTURED and the manifest
        // records the binary bytes' hash.
        write_file(scratch.path(), "flip.md", &[0xff, 0xfe, 0x00]);
        controller.mark_dirty();
        let plan = reconcile(&mut controller);
        apply_then_ack(&mut controller, &plan, &mut sink, &FilesNoFaults).expect("flip ack");
        assert!(
            controller.tracks_path("flip.md"),
            "a captured binary flip records the binary hash"
        );

        // Revert to the EXACT original text bytes: the manifest holds the
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
                sha256: sha256_hex(b"TOKEN=alpha"),
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
    fn secret_that_stops_being_utf8_text_retires_the_tip() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), ".env", b"TOKEN=alpha");
        ingest(&mut sink, ".env").expect("seed secret");

        // Binary-in-disguise is NOT capturable secret text (TS parity: the
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

        let actor = supervisor.open(&db, 1).expect("reopen actor");
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
}
