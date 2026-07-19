//! Dormant files-reconcile adapter for the actor-owned capture primitives.

use dohc_engine_files::media::is_text_media_type;
use dohc_engine_files::policy::{PathClassification, classify_engine_file_path_normalized};
use dohc_engine_files::{
    CaptureError, CaptureSink, IngestOutcome, IngestReason, MAX_CAPTURE_BINARY_BYTES,
    MAX_CAPTURE_TEXT_BYTES,
};
use dohc_engine_runtime::search::{
    FilesPolicyRule, read_engine_search_policy, resolve_effective_policy,
};
use dohc_engine_runtime::{ActorHandle, CaptureIngest, CaptureRetire, NoFaults};
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
/// Deferral, not success: the op must NOT be acknowledged (the manifest would
/// record secret content as captured and never retry it), and not `NotOwned`
/// either (the path IS engine-owned — by the encrypted store). The contained
/// failure keeps it dirty for the secret-capture sub-shard, bounded by the
/// controller's degraded-retry quarantine.
const SECRET_DEFERRED: CaptureError = CaptureError {
    reason: "secret capture deferred to the secret-capture sub-shard",
};
/// Same deferral posture for engine-ownable binary content.
const BINARY_DEFERRED: CaptureError = CaptureError {
    reason: "binary capture deferred to the binary-capture sub-shard",
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
    fn ingest_text(&self, path: &str, text: String) -> Result<(), CaptureError> {
        self.actor
            .capture_ingest_blocking(
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
            )
            .map(|_| ())
            .map_err(|_| INGEST_FAILED)
    }

    fn retire_head(&self, path: &str) -> Result<(), CaptureError> {
        self.actor
            .capture_retire_blocking(
                CaptureRetire {
                    workspace_id: self.workspace_id.clone(),
                    version_id: self.version_id.clone(),
                    path: path.to_owned(),
                    now_ms: self.now_ms,
                    request_id: None,
                },
                Arc::new(NoFaults),
            )
            .map(|_| ())
            .map_err(|_| RETIRE_FAILED)
    }
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
            (PathClassification::Secret, _) => return Err(SECRET_DEFERRED),
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
            self.retire_head(path)?;
            return Ok(IngestOutcome::NotOwned);
        }
        match self.read_current(path, media_type)? {
            CurrentContent::Text(text) => {
                self.ingest_text(path, text)?;
                Ok(IngestOutcome::Captured)
            }
            CurrentContent::Untracked => {
                // The path stopped being engine-ownable text (absent, symlink,
                // non-file, or over cap): retire so no stale snapshot remains,
                // and report NotOwned so the manifest forgets the path instead
                // of recording the planned ingest as captured.
                self.retire_head(path)?;
                Ok(IngestOutcome::NotOwned)
            }
            CurrentContent::Binary => {
                // A path that WAS text and became binary must not keep the old
                // text authoritative while binary capture is deferred.
                self.retire_head(path)?;
                Err(BINARY_DEFERRED)
            }
        }
    }

    fn retire(&mut self, path: &str) -> Result<(), CaptureError> {
        match classify_engine_file_path_normalized(path) {
            (PathClassification::Ignored, _) => Ok(()),
            (PathClassification::Secret, _) => Err(SECRET_DEFERRED),
            (PathClassification::Tracked, Some(normalized)) if normalized == path => {
                self.retire_head(path)
            }
            // Nothing was ever stored under a non-canonical literal name.
            (PathClassification::Tracked, _) => Ok(()),
        }
    }
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
    match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
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

        assert_eq!(
            ingest(&mut sink, "notes/a.md").expect("first ingest"),
            IngestOutcome::Captured
        );
        assert_eq!(
            ingest(&mut sink, "notes/a.md").expect("equal ingest"),
            IngestOutcome::Captured
        );
        write_file(scratch.path(), "notes/a.md", b"latest");
        assert_eq!(
            ingest(&mut sink, "notes/a.md").expect("updated ingest"),
            IngestOutcome::Captured
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
        // Deferrals FAIL the op (so it is never acknowledged as captured);
        // the follow-up sub-shards add binary and encrypted secret persistence.
        assert_eq!(ingest(&mut sink, "binary.md"), Err(BINARY_DEFERRED));
        assert_eq!(ingest(&mut sink, ".env"), Err(SECRET_DEFERRED));
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

        assert_eq!(ingest(&mut sink, "flip.md"), Err(BINARY_DEFERRED));

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
            ingest_as(&mut sink, "photo.png", "image/png"),
            Err(BINARY_DEFERRED)
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
        assert_eq!(
            ingest(&mut sink, "public.md").expect("still tracked"),
            IngestOutcome::Captured
        );

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
        assert_eq!(
            ingest(&mut sink, "notes/a.md").expect("floor-only capture"),
            IngestOutcome::Captured
        );

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
    fn reconcile_contains_one_deferred_failure_and_applies_its_siblings() {
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
        // The deferred secret fails (stays dirty for retry), the text sibling
        // applies, and the raced-away path settles as not-owned.
        assert_eq!(result.failed_applies, [".env"]);
        assert_eq!(result.applied_paths, ["b-good.md"]);
        assert_eq!(result.not_owned_paths, ["c-gone.md"]);
        assert!(result.degraded);

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(snapshot(&db, ".env").is_none());
        assert!(snapshot(&db, "c-gone.md").is_none());
        assert_eq!(
            snapshot(&db, "b-good.md").expect("sibling snapshot").text,
            "good"
        );
    }
}
