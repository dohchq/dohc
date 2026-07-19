//! Dormant files-reconcile adapter for the actor-owned capture primitives.

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
use dohc_engine_runtime::{ActorHandle, CaptureIngest, CaptureRetire, NoFaults, RuntimeError};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const CAPTURE_METADATA_ORIGIN: &str = "capture";
const READ_FAILED: CaptureError = CaptureError {
    reason: "capture disk read failed",
};
const INGEST_FAILED: CaptureError = CaptureError {
    reason: "capture text ingest failed",
};
const RETIRE_FAILED: CaptureError = CaptureError {
    reason: "capture retire failed",
};
const ESCAPES_ROOT: CaptureError = CaptureError {
    reason: "capture path did not resolve inside the workspace root",
};
const RETIRE_RACED: CaptureError = CaptureError {
    reason: "retire refused: a regular file reappeared at the path",
};
/// Guards RETIRE ops only (ingest deferrals settle as `NotOwned` — see
/// `CaptureSink::ingest`). A secret retire targets the encrypted store, which
/// this plaintext sink cannot reach; the contained failure keeps the op dirty
/// for the secret-capture sub-shard. In practice unreachable: the manifest
/// never records secret paths, so no plan can emit a secret retire.
const SECRET_DEFERRED: CaptureError = CaptureError {
    reason: "secret capture deferred to the secret-capture sub-shard",
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
        }
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
        match contained_parent(&self.shadow_root, &absolute) {
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
        verify_opened_containment(&self.shadow_root, &absolute, &file)?;
        let metadata = file.metadata().map_err(|_| READ_FAILED)?;
        if !metadata.file_type().is_file() {
            return Ok(CurrentContent::Untracked);
        }
        if metadata.len() > MAX_CAPTURE_BINARY_BYTES {
            return Ok(CurrentContent::Untracked);
        }
        if !is_text_media_type(media_type, path) {
            // Non-text media is engine-ownable BINARY content: the TS oracle
            // routes it to the binary store before any UTF-8 sniffing, so a
            // UTF-8-clean `.png` must never land in the plaintext store.
            return Ok(CurrentContent::Binary);
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_CAPTURE_BINARY_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| READ_FAILED)?;
        if bytes.len() as u64 > MAX_CAPTURE_BINARY_BYTES {
            return Ok(CurrentContent::Untracked);
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
            Err(_) => Ok(CurrentContent::Binary),
        }
    }

    // The blocking actor calls below carry no timeout; this adapter is dormant
    // and not on any request path. The composition driver (sub-shard C) owns
    // stall handling when it wires this sink into workspace open/close.
    fn ingest_text(&self, path: &str, text: String) -> Result<DomainIngest, CaptureError> {
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
            Err(_) => Err(INGEST_FAILED),
        }
    }

    fn retire_head(&self, path: &str, only_if_text_head: bool) -> Result<(), CaptureError> {
        match self.actor.capture_retire_blocking(
            CaptureRetire {
                workspace_id: self.workspace_id.clone(),
                version_id: self.version_id.clone(),
                path: path.to_owned(),
                now_ms: self.now_ms,
                request_id: None,
                only_if_text_head,
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
}

impl CaptureSink for StoreCaptureSink {
    fn ingest(
        &mut self,
        path: &str,
        _size: u64,
        _sha256: &str,
        media_type: &str,
        _reason: IngestReason,
    ) -> Result<IngestOutcome, CaptureError> {
        // Plan hashes and sizes describe the scan observation only. Re-read the
        // path so settled rapid writes coalesce to the latest disk state.
        let normalized = match classify_engine_file_path_normalized(path) {
            (PathClassification::Ignored, _) => return Ok(IngestOutcome::NotOwned),
            // The ENCRYPTED store owns secret paths, never this plaintext
            // sink. NotOwned keeps the manifest honest AND keeps the deferral
            // alive: a forgotten path is re-offered as `Added` by every later
            // scan, so the secret-capture sub-shard picks it up with no state
            // migration — and a healthy workspace with a `.env` never reads
            // as degraded in the meantime. (No retire: a secret path can
            // never have held a plaintext head.)
            (PathClassification::Secret, _) => return Ok(IngestOutcome::NotOwned),
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
                match self.ingest_text(path, text)? {
                    DomainIngest::Persisted => Ok(IngestOutcome::Captured { size, sha256 }),
                    DomainIngest::NameRefused => Ok(IngestOutcome::NotOwned),
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
            CurrentContent::Binary => {
                // A path that WAS text and became binary must not keep the old
                // text authoritative while binary capture is deferred to the
                // binary sub-shard. NotOwned (not a failure): failing the op
                // would leave the manifest holding the RETIRED text's hash, so
                // a later edit back to those exact bytes would diff clean and
                // never restore the head — a silent lost capture. Forgetting
                // the path instead re-offers it on every later scan, which is
                // also what lets binary capture pick it up once it lands.
                //
                // only_if_text_head: a LIVE binary head (mirrored resolve, or
                // the binary sub-shard once it lands) is not this plaintext
                // sink's to delete — the retire is a no-op for it.
                self.retire_head(path, true)?;
                Ok(IngestOutcome::NotOwned)
            }
        }
    }

    fn retire(&mut self, path: &str) -> Result<(), CaptureError> {
        match classify_engine_file_path_normalized(path) {
            (PathClassification::Ignored, _) => Ok(()),
            (PathClassification::Secret, _) => Err(SECRET_DEFERRED),
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
                match contained_parent(&self.shadow_root, &absolute) {
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

enum CurrentContent {
    Text(String),
    /// Present, engine-ownable binary bytes (capture deferred to B-binary).
    Binary,
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

/// A symlinked ancestor directory must never carry a capture read outside the
/// workspace root: the resolved parent has to stay under the resolved root.
/// Unresolvable-for-any-other-reason fails CLOSED as an escape.
fn contained_parent(root: &Path, absolute: &Path) -> Containment {
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
    if real_parent.starts_with(&real_root) {
        Containment::Contained
    } else {
        Containment::Escaped
    }
}

/// Post-open containment recheck: re-resolve the OPENED path and require it
/// still under the root. Catches an ancestor directory swapped to a symlink
/// between the pre-open containment check and the open. On Unix the opened
/// descriptor's (dev, ino) must also match the re-resolved path, so a
/// swap-back cannot hide a foreign descriptor.
fn verify_opened_containment(
    root: &Path,
    absolute: &Path,
    file: &File,
) -> Result<(), CaptureError> {
    let real = absolute.canonicalize().map_err(|_| ESCAPES_ROOT)?;
    let real_root = root.canonicalize().map_err(|_| ESCAPES_ROOT)?;
    if !real.starts_with(&real_root) {
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
        // Deferrals settle as NotOwned: the manifest forgets the path, so
        // every later scan re-offers it to the follow-up binary/secret
        // sub-shards; nothing is recorded as captured meanwhile.
        assert_eq!(
            ingest(&mut sink, "binary.md").expect("deferred binary"),
            IngestOutcome::NotOwned
        );
        assert_eq!(
            ingest(&mut sink, ".env").expect("deferred secret"),
            IngestOutcome::NotOwned
        );
        assert_eq!(sink.retire(".env"), Err(SECRET_DEFERRED));

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert_eq!(moment_count(&db, ".dohc/ignored.md"), 0);
        assert_eq!(moment_count(&db, "binary.md"), 0);
        assert_eq!(moment_count(&db, ".env"), 0);
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
    fn text_media_that_turns_binary_retires_the_stale_text_head() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "flip.md", b"was text");
        ingest(&mut sink, "flip.md").expect("seed ingest");
        write_file(scratch.path(), "flip.md", &[0xff, 0xfe, 0x00]);

        assert_eq!(
            ingest(&mut sink, "flip.md").expect("deferred binary"),
            IngestOutcome::NotOwned
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        // The stale text must not stay authoritative while binary is deferred.
        assert!(snapshot(&db, "flip.md").is_none());
    }

    #[test]
    fn non_text_media_never_lands_in_the_plaintext_store() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        // Valid UTF-8 bytes under a binary media type: UTF-8 sniffing alone
        // would capture this as text.
        write_file(scratch.path(), "photo.png", b"plain ascii bytes");

        assert_eq!(
            ingest_as(&mut sink, "photo.png", "image/png").expect("deferred binary"),
            IngestOutcome::NotOwned
        );

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(snapshot(&db, "photo.png").is_none());
        assert_eq!(moment_count(&db, "photo.png"), 0);
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
        // The text sibling applies; the deferred secret and the raced-away
        // path settle as not-owned (forgotten, re-offered by later scans) —
        // a healthy workspace with a .env must not read as degraded.
        assert_eq!(result.applied_paths, ["b-good.md"]);
        assert_eq!(result.not_owned_paths, [".env", "c-gone.md"]);
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

        // Flip to binary: the head retires and the manifest must FORGET the
        // path (recording anything would leave the old text hash behind).
        write_file(scratch.path(), "flip.md", &[0xff, 0xfe, 0x00]);
        controller.mark_dirty();
        let plan = reconcile(&mut controller);
        apply_then_ack(&mut controller, &plan, &mut sink, &FilesNoFaults).expect("flip ack");
        assert!(
            !controller.tracks_path("flip.md"),
            "a deferred binary flip must not keep the retired text's manifest entry"
        );

        // Revert to the EXACT original bytes. If the manifest had kept the old
        // hash, this scan would diff clean and the head would stay lost.
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
}
