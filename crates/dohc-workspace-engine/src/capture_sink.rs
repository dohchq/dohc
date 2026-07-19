//! Dormant files-reconcile adapter for the actor-owned capture primitives.

use dohc_engine_files::{CaptureError, CaptureSink, IngestReason, MAX_CAPTURE_TEXT_BYTES};
use dohc_engine_runtime::search::{PathFloor, classify_engine_file_path};
use dohc_engine_runtime::{ActorHandle, CaptureIngest, CaptureRetire, NoFaults};
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
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

/// Bridges a files-crate reconcile plan to the actor's domain capture writes.
///
/// The adapter is intentionally not wired into workspace open/close yet. Its
/// caller supplies the active version and capture-time provenance for one
/// reconcile run.
pub struct StoreCaptureSink {
    actor: ActorHandle,
    workspace_id: String,
    version_id: String,
    shadow_root: PathBuf,
    now_ms: i64,
    author_json: Option<String>,
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
        StoreCaptureSink {
            actor,
            workspace_id: workspace_id.into(),
            version_id: version_id.into(),
            shadow_root: shadow_root.into(),
            now_ms,
            author_json,
        }
    }

    fn read_current_text(&self, path: &str) -> Result<CurrentContent, CaptureError> {
        let absolute = self.shadow_root.join(path);
        let metadata = std::fs::symlink_metadata(&absolute).map_err(|_| READ_FAILED)?;
        if !metadata.file_type().is_file() {
            return Ok(CurrentContent::Untracked);
        }
        if metadata.len() > MAX_CAPTURE_TEXT_BYTES {
            return Ok(CurrentContent::Untracked);
        }

        let file = File::open(&absolute).map_err(|_| READ_FAILED)?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_CAPTURE_TEXT_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| READ_FAILED)?;
        if bytes.len() as u64 > MAX_CAPTURE_TEXT_BYTES {
            return Ok(CurrentContent::Untracked);
        }
        match String::from_utf8(bytes) {
            Ok(text) => Ok(CurrentContent::Text(text)),
            Err(_) => Ok(CurrentContent::Binary),
        }
    }

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

    fn record_deferred(marker: &str, path: &str) {
        eprintln!("[{marker}] path={path:?}");
    }
}

impl CaptureSink for StoreCaptureSink {
    fn ingest(
        &mut self,
        path: &str,
        _size: u64,
        _sha256: &str,
        _media_type: &str,
        _reason: IngestReason,
    ) -> Result<(), CaptureError> {
        // Plan hashes and sizes describe the scan observation only. Re-read the
        // path so settled rapid writes coalesce to the latest disk state.
        match classify_engine_file_path(path) {
            PathFloor::Ignored => return Ok(()),
            PathFloor::Secret => {
                // TODO(files-daemon-secret-capture): route through the encrypted
                // secret store in the dedicated secret-capture sub-shard.
                Self::record_deferred("DEFERRED_CAPTURE_SECRET", path);
                return Ok(());
            }
            PathFloor::Tracked => {}
        }

        match self.read_current_text(path)? {
            CurrentContent::Text(text) => self.ingest_text(path, text),
            CurrentContent::Untracked => self.retire(path),
            CurrentContent::Binary => {
                // TODO(files-daemon-binary-capture): route through the binary
                // domain primitive in the dedicated binary-capture sub-shard.
                Self::record_deferred("DEFERRED_CAPTURE_BINARY", path);
                Ok(())
            }
        }
    }

    fn retire(&mut self, path: &str) -> Result<(), CaptureError> {
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

enum CurrentContent {
    Text(String),
    Binary,
    Untracked,
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::VersionedTextStore;
    use dohc_engine_files::{CaptureOp, ReconcilePlan, ScanGeneration, apply_reconcile_plan};
    use dohc_engine_runtime::WorkspaceSupervisor;
    use dohc_engine_storage::{EngineStore, NoFaults as FilesNoFaults};
    use dohc_engine_testkit::ScratchDir;
    use std::path::Path;

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

    fn ingest(sink: &mut StoreCaptureSink, path: &str) -> Result<(), CaptureError> {
        sink.ingest(
            path,
            0,
            "advisory-sha",
            "text/markdown",
            IngestReason::Changed,
        )
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

    #[test]
    fn text_ingest_rereads_updates_and_dedupes_equal_content() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "notes/a.md", b"first");

        ingest(&mut sink, "notes/a.md").expect("first ingest");
        ingest(&mut sink, "notes/a.md").expect("equal ingest");
        write_file(scratch.path(), "notes/a.md", b"latest");
        ingest(&mut sink, "notes/a.md").expect("updated ingest");

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

        ingest(&mut sink, ".dohc/ignored.md").expect("ignored path");
        // Follow-up sub-shards add binary and encrypted secret persistence.
        ingest(&mut sink, "binary.md").expect("deferred binary");
        ingest(&mut sink, ".env").expect("deferred secret");

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
        ingest(&mut sink, "oversized.md").expect("oversized retire");

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(snapshot(&db, "oversized.md").is_none());
    }

    #[test]
    fn reconcile_contains_one_read_failure_and_applies_its_sibling() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "b-good.md", b"good");
        let plan = ReconcilePlan {
            from_generation: ScanGeneration(0),
            to_generation: ScanGeneration(1),
            ops: vec![
                CaptureOp::Ingest {
                    path: "a-unreadable.md".to_owned(),
                    size: 1,
                    sha256: "stale".to_owned(),
                    media_type: "text/markdown",
                    reason: IngestReason::Added,
                },
                CaptureOp::Ingest {
                    path: "b-good.md".to_owned(),
                    size: 1,
                    sha256: "stale".to_owned(),
                    media_type: "text/markdown",
                    reason: IngestReason::Added,
                },
            ],
            retained_over_cap: Vec::new(),
            unconfirmed_removed: Vec::new(),
            degraded: false,
            degraded_paths: Vec::new(),
            prepared_from_dirty: true,
            dirty_epoch: 0,
        };

        let result = apply_reconcile_plan(&plan, &mut sink, &FilesNoFaults);
        assert_eq!(result.failed_applies, ["a-unreadable.md"]);
        assert_eq!(result.applied_paths, ["b-good.md"]);
        assert!(result.degraded);

        drop(sink);
        supervisor.close(&db).expect("close actor");
        assert!(snapshot(&db, "a-unreadable.md").is_none());
        assert_eq!(
            snapshot(&db, "b-good.md").expect("sibling snapshot").text,
            "good"
        );
    }
}
