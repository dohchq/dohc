//! A folder's access.yaml reaches the journal before the files it covers, and
//! a rule changed outside dohc in a way that widens reach waits for its owner.
use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc, ensure_marker, scene_asset_ref};
use dohc_engine_domain::{CreateNamedVersion, DomainError, DuplicateFile, VersionedTextStore};
use dohc_engine_files::access_rules::{Level, level_for_email, parse_access_rule};
use dohc_engine_runtime::{
    ACCESS_RULE_WAITS, AccessRuleDecision, ActorHandle, CancellationToken, CaptureIngest,
    CaptureIngestBinary, CaptureRetire, DeleteTextFile, FaultAction, FaultInjector, FaultPoint,
    MergeTextFileFromVersion, NoFaults, RenameTextFile, RollbackTextFileMutation, RuntimeError,
    WorkspaceSupervisor, WriteBinary, WriteText,
};
use dohc_engine_storage::{EngineStore, hex_sha256};
use dohc_engine_sync::SyncError;
use dohc_engine_testkit::capture::ExistingRootGuard;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const WS: &str = "ws-access-order";
const VIEW: &str = "members: view\n";
const NOBODY: &str = "people: {}\n";
const EDIT: &str = "members: edit\n";

struct Fixture {
    scratch: ScratchDir,
    db: PathBuf,
    supervisor: WorkspaceSupervisor,
    actor: ActorHandle,
    runtime: tokio::runtime::Runtime,
}

/// Every path under `dir`, relative to it, files and folders alike.
fn walkdir_names(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).expect("read folder") {
            let path = entry.expect("entry").path();
            names.push(
                path.strip_prefix(dir)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
            if path.is_dir() {
                pending.push(path);
            }
        }
    }
    names.sort();
    names
}

impl Fixture {
    fn new() -> Self {
        let f = Self::local();
        f.replicate();
        f
    }

    /// A workspace that does not replicate yet, so nothing orders its moments.
    fn local() -> Self {
        let scratch = ScratchDir::new().expect("scratch");
        let db = engine_db_path(&scratch).expect("db");
        Self::with_store(scratch, db)
    }

    /// A replicating store kept outside any workspace's `.dohc/engine`
    /// folder, with files captured from the scratch folder.
    fn standalone() -> Self {
        let scratch = ScratchDir::new().expect("scratch");
        let folder = scratch.path().join("stores");
        std::fs::create_dir_all(&folder).expect("store folder");
        let f = Self::with_store(scratch, folder.join("engine.db"));
        f.replicate();
        f
    }

    /// A workspace whose store a test can take out of the workspace folder
    /// while it stays open, as moving `.dohc/engine` does. Windows refuses to
    /// move the folder of an open store, so there `.dohc/engine` is a link
    /// the test removes.
    fn movable() -> Self {
        let scratch = ScratchDir::new().expect("scratch");
        #[cfg(windows)]
        let db = {
            let held = scratch.path().join(".dohc/held-engine");
            std::fs::create_dir_all(&held).expect("store folder");
            let engine = scratch.path().join(".dohc/engine");
            assert!(
                dohc_engine_testkit::scratch::try_make_dir_alias(&held, &engine).expect("link"),
                "link .dohc/engine"
            );
            engine.join("engine.db")
        };
        #[cfg(not(windows))]
        let db = engine_db_path(&scratch).expect("db");
        Self::with_store(scratch, db)
    }

    /// Take the open store out of the workspace folder.
    fn move_store_away(&self) {
        let engine = self.root().join(".dohc/engine");
        #[cfg(windows)]
        std::fs::remove_dir(&engine).expect("remove the store link");
        #[cfg(not(windows))]
        std::fs::rename(&engine, self.root().join(".dohc/engine-moved"))
            .expect("move the store folder");
    }

    /// Put the store back where it was opened. Returns what a change wrote
    /// at `.dohc/engine` while the store was away, which is cleared first.
    fn move_store_back(&self) -> Vec<String> {
        let engine = self.root().join(".dohc/engine");
        let mut stray = Vec::new();
        if engine.exists() {
            for entry in walkdir_names(&engine) {
                stray.push(entry);
            }
            std::fs::remove_dir_all(&engine).expect("clear what was written");
        }
        #[cfg(windows)]
        assert!(
            dohc_engine_testkit::scratch::try_make_dir_alias(
                &self.root().join(".dohc/held-engine"),
                &engine
            )
            .expect("link"),
            "link .dohc/engine"
        );
        #[cfg(not(windows))]
        std::fs::rename(self.root().join(".dohc/engine-moved"), &engine)
            .expect("move the store folder back");
        stray
    }

    fn with_store(scratch: ScratchDir, db: PathBuf) -> Self {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .expect("main version");
        drop(store);
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("runtime");
        Self {
            scratch,
            db,
            supervisor,
            actor,
            runtime,
        }
    }

    fn replicate(&self) {
        let conn = rusqlite::Connection::open(&self.db).expect("open db");
        conn.execute_batch(&format!(
            "INSERT INTO sync_identity \
             (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
             VALUES ('{WS}', 'origin-local', 'epoch-local', 'stream-local', 1); \
             INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
             VALUES ('{WS}', 'origin-local', 0);"
        ))
        .expect("seed sync state");
    }

    fn root(&self) -> &Path {
        self.scratch.path()
    }

    /// Close the engine and open it again, replaying pending placements as
    /// the desktop does when it opens a workspace.
    fn restart(&mut self) {
        self.supervisor.close(&self.db).expect("close");
        self.actor = self.supervisor.open(&self.db, 1).expect("reopen").actor;
        self.runtime
            .block_on(self.actor.materialize_replay_pending(
                self.root().to_path_buf(),
                WS.to_owned(),
                50,
            ))
            .expect("replay");
    }

    /// Write `text` at `path` on disk, as an outside editor would.
    fn put(&self, path: &str, text: &str) {
        let absolute = self.root().join(path);
        std::fs::create_dir_all(absolute.parent().unwrap()).unwrap();
        std::fs::write(absolute, text).unwrap();
    }

    /// Make every entry under the root look older than the settle period.
    fn settle(&self) {
        let then =
            filetime::FileTime::from_system_time(SystemTime::now() - Duration::from_secs(60));
        let mut pending = vec![self.root().to_path_buf()];
        while let Some(path) = pending.pop() {
            if path.ends_with(".dohc") {
                continue;
            }
            if path.is_dir() {
                pending.extend(std::fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
            }
            filetime::set_file_mtime(&path, then).unwrap();
        }
    }

    fn capture(&self, paths: &[&str]) -> Vec<Result<(), RuntimeError>> {
        let inputs: Vec<CaptureIngest> = paths
            .iter()
            .map(|path| {
                ingest(
                    path,
                    &std::fs::read_to_string(self.root().join(path)).unwrap(),
                )
            })
            .collect();
        self.actor
            .capture_ingest_batch_blocking(
                inputs,
                Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
                    self.root(),
                )),
                dohc_engine_collab::LeaseRegistry::new(),
                Arc::new(NoFaults),
                self.root().to_path_buf(),
                Arc::new(ExistingRootGuard),
            )
            .expect("capture batch")
            .into_iter()
            .map(|result| result.map(drop))
            .collect()
    }

    fn capture_ok(&self, paths: &[&str]) {
        for (path, result) in paths.iter().zip(self.capture(paths)) {
            result.unwrap_or_else(|error| panic!("capture {path}: {error}"));
        }
    }

    fn retire(&self, path: &str) -> Result<(), RuntimeError> {
        self.actor
            .capture_retire_materialized_blocking_guarded(
                CaptureRetire {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    path: path.to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 20,
                    request_id: None,
                    only_if_text_head: false,
                    only_if_capture_origin: false,
                    allow_ydoc_origin: true,
                },
                self.root().to_path_buf(),
                true,
                Arc::new(()),
                dohc_engine_collab::LeaseRegistry::new(),
                Arc::new(NoFaults),
                Arc::new(ExistingRootGuard),
            )
            .map(drop)
    }

    /// Decide on the rule the folder's hold shows.
    fn decide(&self, folder: &str, decision: AccessRuleDecision) -> Result<(), RuntimeError> {
        let hold = self
            .runtime
            .block_on(self.actor.access_rule_holds(WS.to_owned()))
            .expect("holds")
            .into_iter()
            .find(|hold| hold.folder == folder)
            .expect("a hold to decide");
        self.decide_on(folder, decision, hold.observed_sha256, &hold.reason)
    }

    fn decide_on(
        &self,
        folder: &str,
        decision: AccessRuleDecision,
        seen: Option<String>,
        reason: &str,
    ) -> Result<(), RuntimeError> {
        self.decided_on(folder, decision, seen, reason).map(drop)
    }

    fn decided_on(
        &self,
        folder: &str,
        decision: AccessRuleDecision,
        seen: Option<String>,
        reason: &str,
    ) -> Result<dohc_engine_runtime::AccessRuleDecided, RuntimeError> {
        self.decided_at(folder, decision, seen, reason, 30, Arc::new(NoFaults))
    }

    /// Mark a Version "feature" active, creating it from Main the first
    /// time, or Main again, as a Version switch leaves the store.
    fn activate_feature(&self, feature: bool) {
        if feature {
            let _ = self.runtime.block_on(self.actor.create_named_version(
                CreateNamedVersion {
                    workspace_id: WS.to_owned(),
                    new_version_id: "feature".to_owned(),
                    name: "feature".to_owned(),
                    from_version_id: "main".to_owned(),
                    now_ms: 41,
                    request_id: None,
                },
                Arc::new(NoFaults),
                CancellationToken::new(),
            ));
        }
        rusqlite::Connection::open(&self.db)
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO active_versions (workspace_id, version_id) VALUES (?1, ?2)",
                [WS, if feature { "feature" } else { "main" }],
            )
            .unwrap();
    }

    fn decided_at(
        &self,
        folder: &str,
        decision: AccessRuleDecision,
        seen: Option<String>,
        reason: &str,
        now_ms: i64,
        faults: Arc<dyn dohc_engine_storage::FaultInjector>,
    ) -> Result<dohc_engine_runtime::AccessRuleDecided, RuntimeError> {
        self.runtime.block_on(self.actor.decide_access_rule(
            WS.to_owned(),
            "main".to_owned(),
            folder.to_owned(),
            decision,
            seen,
            reason.to_owned(),
            self.root().to_path_buf(),
            Arc::new(()),
            now_ms,
            faults,
        ))
    }

    fn holds(&self) -> Vec<(String, String)> {
        self.runtime
            .block_on(self.actor.access_rule_holds(WS.to_owned()))
            .expect("holds")
            .into_iter()
            .map(|hold| (hold.folder, hold.reason))
            .collect()
    }

    /// The moments the relay would replay, in origin order.
    fn journal(&self) -> Vec<String> {
        let conn = rusqlite::Connection::open(&self.db).expect("open db");
        conn.prepare(
            "SELECT json_extract(payload_json,'$.operation') || ' ' || \
             json_extract(payload_json,'$.path') FROM replication_log \
             WHERE workspace_id=?1 AND imported=0 AND op_kind='moment.append' \
             ORDER BY origin_seq",
        )
        .unwrap()
        .query_map([WS], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<String>>>()
        .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.supervisor.close(&self.db);
    }
}

fn ingest(path: &str, text: &str) -> CaptureIngest {
    CaptureIngest {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        metadata_origin: "capture".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 10,
        request_id: None,
        claim_foreign_head: true,
    }
}

fn waits(result: &Result<(), RuntimeError>) -> bool {
    matches!(
        result,
        Err(RuntimeError::Sync(SyncError::RetryableState { reason })) if *reason == ACCESS_RULE_WAITS
    )
}

fn held(result: &Result<(), RuntimeError>, folder: &str) -> bool {
    matches!(result, Err(RuntimeError::AccessRuleHeld { folder: held, .. }) if held == folder)
}

fn lines(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|line| (*line).to_owned()).collect()
}

/// A team folder whose committed rule lets members view.
fn ruled_team() -> Fixture {
    let f = Fixture::new();
    f.put("team/access.yaml", VIEW);
    f.put("team/a.md", "alpha");
    f.settle();
    f.capture_ok(&["team/access.yaml", "team/a.md"]);
    f
}

#[test]
fn a_batch_journals_its_rule_first_in_either_order() {
    for order in [
        ["team/access.yaml", "team/a.md"],
        ["team/a.md", "team/access.yaml"],
    ] {
        let f = Fixture::new();
        f.put("team/access.yaml", VIEW);
        f.put("team/a.md", "alpha");
        f.settle();
        f.capture_ok(&order);
        assert_eq!(
            f.journal(),
            lines(&["write team/access.yaml", "write team/a.md"]),
            "{order:?}"
        );
    }
}

/// The relay reads `team/ACCESS.yaml` as team's rule, so the engine does too.
#[test]
fn a_rule_spelled_with_other_capitals_journals_before_its_files() {
    let f = Fixture::new();
    f.put("team/a.md", "alpha");
    f.settle();
    f.capture_ok(&["team/a.md"]);
    f.put("team/ACCESS.yaml", VIEW);
    f.put("team/a.md", "alpha 2");
    f.settle();
    f.capture_ok(&["team/a.md"]);
    assert_eq!(
        f.journal(),
        lines(&[
            "write team/a.md",
            "write team/ACCESS.yaml",
            "write team/a.md"
        ])
    );

    // Its removal is a removal, whatever the spelling.
    std::fs::remove_file(f.root().join("team/ACCESS.yaml")).unwrap();
    f.put("team/a.md", "alpha 3");
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    assert_eq!(f.holds(), vec![("team".to_owned(), "removed".to_owned())]);
}

/// Respelling a rule on disk retires the old spelling first in a capture
/// plan. The new spelling reaches the journal before the old one goes.
#[test]
fn a_respelled_rule_journals_its_new_spelling_before_the_old_ones_delete() {
    let f = ruled_team();
    let before = f.journal();
    std::fs::rename(
        f.root().join("team/access.yaml"),
        f.root().join("team/Access.yaml"),
    )
    .unwrap();
    f.settle();
    f.actor
        .capture_retire_respelled_blocking_guarded(
            CaptureRetire {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: "team/access.yaml".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 20,
                request_id: None,
                only_if_text_head: false,
                only_if_capture_origin: true,
                allow_ydoc_origin: true,
            },
            "team/Access.yaml".to_owned(),
            dohc_engine_storage::hex_sha256(VIEW.as_bytes()),
            f.root().to_path_buf(),
            Arc::new(()),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            Arc::new(ExistingRootGuard),
        )
        .expect("retire old spelling");
    f.capture_ok(&["team/Access.yaml"]);
    let mut expected = before;
    expected.extend(lines(&[
        "write team/Access.yaml",
        "delete team/access.yaml",
    ]));
    assert_eq!(f.journal(), expected);
    assert!(f.holds().is_empty());
}

#[test]
fn a_narrowed_rule_journals_before_the_file_that_follows_it() {
    let f = ruled_team();
    f.put("team/access.yaml", NOBODY);
    f.put("team/a.md", "alpha 2");
    f.settle();
    f.capture_ok(&["team/a.md"]);
    assert_eq!(
        f.journal(),
        lines(&[
            "write team/access.yaml",
            "write team/a.md",
            "write team/access.yaml",
            "write team/a.md",
        ])
    );
}

#[test]
fn a_widened_rule_holds_its_folder_until_the_owner_accepts_it() {
    let f = ruled_team();
    let before = f.journal();
    f.put("team/access.yaml", EDIT);
    f.put("team/a.md", "alpha 2");
    f.settle();
    let results = f.capture(&["team/a.md", "team/access.yaml"]);
    assert!(
        results.iter().all(|result| held(result, "team")),
        "{results:?}"
    );
    assert_eq!(f.journal(), before, "nothing under the folder journals");
    assert_eq!(f.holds(), vec![("team".to_owned(), "widened".to_owned())]);

    f.decide("team", AccessRuleDecision::Accept)
        .expect("accept");
    assert!(f.holds().is_empty());
    f.capture_ok(&["team/a.md"]);
    let mut expected = before;
    expected.extend(lines(&["write team/access.yaml", "write team/a.md"]));
    assert_eq!(f.journal(), expected);
}

/// Allowing an outer rule judges the rules held under it again at once: one
/// the outer rule now gives as much records with it and its hold goes, so no
/// notice stays for a rule that no longer widens anything.
#[test]
fn allowing_an_outer_rule_records_an_inner_rule_it_now_covers() {
    let f = ruled_team();
    let before = f.journal();
    f.put("team/sub/access.yaml", EDIT);
    f.put("team/sub/b.md", "beta");
    f.settle();
    assert!(held(&f.capture(&["team/sub/access.yaml"])[0], "team/sub"));
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/access.yaml"])[0], "team"));
    assert_eq!(f.holds().len(), 2);

    f.decide("team", AccessRuleDecision::Accept)
        .expect("accept");
    assert!(f.holds().is_empty(), "{:?}", f.holds());
    f.capture_ok(&["team/sub/b.md"]);
    let mut expected = before;
    expected.extend(lines(&[
        "write team/access.yaml",
        "write team/sub/access.yaml",
        "write team/sub/b.md",
    ]));
    assert_eq!(f.journal(), expected);
}

/// A decision while another program holds the rule file open says the file
/// is held, as a write to any held file does, and changes nothing; once the
/// file is free the same decision runs. Its notice says the file is held.
#[cfg(windows)]
#[test]
fn a_decision_on_a_rule_another_program_holds_says_it_is_held() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = ruled_team();
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    let before = f.journal();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(f.root().join("team/access.yaml"))
        .expect("hold the rule open");
    // The notice says why it can't show the rule.
    let views = f.hold_views();
    assert_eq!(views[0].unreadable, Some("locked"), "{views:?}");
    for decision in [AccessRuleDecision::Accept, AccessRuleDecision::Restore] {
        let decided = f.decide("team", decision);
        assert!(
            matches!(&decided, Err(error) if error.code() == "file-locked"),
            "{decided:?}"
        );
    }
    assert_eq!(f.journal(), before);
    assert_eq!(f.holds(), vec![("team".to_owned(), "widened".to_owned())]);
    drop(lock);
    f.decide("team", AccessRuleDecision::Accept)
        .expect("accept once the file is free");
    assert!(f.holds().is_empty());
}

/// Restoring an outer rule leaves an inner rule that still widens held.
#[test]
fn restoring_an_outer_rule_keeps_an_inner_widening_held() {
    let f = ruled_team();
    f.put("team/sub/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/sub/access.yaml"])[0], "team/sub"));
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/access.yaml"])[0], "team"));
    let sub = f
        .runtime
        .block_on(f.actor.access_rule_holds(WS.to_owned()))
        .expect("holds")
        .into_iter()
        .find(|hold| hold.folder == "team/sub")
        .expect("sub hold");

    f.decide("team", AccessRuleDecision::Restore)
        .expect("restore");
    let after = f
        .runtime
        .block_on(f.actor.access_rule_holds(WS.to_owned()))
        .expect("holds");
    assert_eq!(after, vec![sub]);
}

/// The owner decides on the rule they saw. One changed on disk since is
/// refused, and the folder's hold shows the rule there now.
#[test]
fn a_decision_on_a_rule_changed_since_is_refused() {
    let f = ruled_team();
    let before = f.journal();
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    let seen = Some(dohc_engine_storage::hex_sha256(EDIT.as_bytes()));
    std::fs::remove_file(f.root().join("team/access.yaml")).unwrap();
    f.settle();
    for decision in [AccessRuleDecision::Accept, AccessRuleDecision::Restore] {
        let decided = f.decide_on("team", decision, seen.clone(), "widened");
        assert!(
            matches!(&decided, Err(RuntimeError::AccessRuleChanged { folder }) if folder == "team"),
            "{decided:?}"
        );
    }
    assert!(!f.root().join("team/access.yaml").exists());
    assert_eq!(f.journal(), before);
    assert_eq!(f.holds(), vec![("team".to_owned(), "removed".to_owned())]);
}

fn ignores_case(root: &Path) -> bool {
    std::fs::write(root.join("probe.md"), "probe").unwrap();
    let ignores_case = std::fs::metadata(root.join("PROBE.md")).is_ok();
    std::fs::remove_file(root.join("probe.md")).unwrap();
    if !ignores_case {
        eprintln!("skipping: this disk keeps case apart");
    }
    ignores_case
}

/// A Version respells the rule with new contents. Merged on a disk that
/// ignores case, Main journals the new spelling before the old one's delete,
/// so the folder always has a rule, and the merged rule ends on disk under
/// its new spelling with no conflict copy beside it.
#[test]
fn a_rule_respelled_with_new_contents_merges_onto_a_disk_that_ignores_case() {
    merge_a_respelled_rule(false);
}

/// The new spelling's merge still waits for the old one's delete when the
/// engine restarts between them and replays its pending placements.
#[test]
fn a_respelled_rule_merged_across_a_restart_waits_for_its_old_spelling() {
    merge_a_respelled_rule(true);
}

fn merge_a_respelled_rule(restart_between: bool) {
    let mut f = Fixture::new();
    if !ignores_case(f.root()) {
        return;
    }
    f.put("team/access.yaml", VIEW);
    f.put("team/a.md", "alpha");
    f.settle();
    f.capture_ok(&["team/access.yaml", "team/a.md"]);
    f.runtime
        .block_on(f.actor.create_named_version(
            CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 41,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        ))
        .expect("version");
    f.runtime
        .block_on(f.actor.versioned_text_rename(
            RenameTextFile {
                workspace_id: WS.to_owned(),
                version_id: "feature".to_owned(),
                from_path: "team/access.yaml".to_owned(),
                to_path: "team/ACCESS.yaml".to_owned(),
                moment_id: "m-respell".to_owned(),
                request_id: None,
                metadata_origin: "cli".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 42,
            },
            f.root().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        ))
        .expect("respell");
    f.versioned_write(WriteText {
        version_id: "feature".to_owned(),
        ..write("team/ACCESS.yaml", EDIT, "m-edit")
    })
    .expect("edit");
    let before = f.journal();
    // The desktop merges a rule's writes before its deletes.
    for (path, now_ms) in [("team/ACCESS.yaml", 43), ("team/access.yaml", 44)] {
        f.runtime
            .block_on(f.actor.versioned_text_merge(
                MergeTextFileFromVersion {
                    workspace_id: WS.to_owned(),
                    target_version_id: "main".to_owned(),
                    source_version_id: "feature".to_owned(),
                    path: path.to_owned(),
                    object_id: "ignored".to_owned(),
                    moment_id: format!("merge-{now_ms}"),
                    request_id: None,
                    conflict_id: format!("conflict-{now_ms}"),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms,
                },
                f.root().to_path_buf(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .unwrap_or_else(|error| panic!("merge {path}: {error}"));
        if restart_between && now_ms == 43 {
            f.restart();
        }
    }
    assert_eq!(
        f.journal()[before.len()..],
        lines(&["write team/ACCESS.yaml", "delete team/access.yaml"])
    );
    let mut names: Vec<String> = std::fs::read_dir(f.root().join("team"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["ACCESS.yaml", "a.md"]);
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/ACCESS.yaml")).unwrap(),
        EDIT
    );
    let unfinished: i64 = rusqlite::Connection::open(&f.db)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM materialization_jobs WHERE status IN ('pending','conflict')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unfinished, 0, "no merge job is left pending or in conflict");
}

/// A rule gone and a rule spelled twice both record no bytes, so the owner's
/// decision on a removal names its reason too. A second spelling saved since
/// is refused, and stays on disk. Judged again, two spellings hide the
/// folder at every step, so dohc records them and the hold goes.
#[test]
fn a_decision_on_a_removal_that_became_two_spellings_is_refused() {
    for decision in [AccessRuleDecision::Accept, AccessRuleDecision::Restore] {
        let f = ruled_team();
        std::fs::remove_file(f.root().join("team/access.yaml")).unwrap();
        f.settle();
        assert!(held(&f.capture(&["team/a.md"])[0], "team"));
        assert_eq!(f.holds(), vec![("team".to_owned(), "removed".to_owned())]);
        // A fullwidth letter folds to the same rule but is its own name on disk.
        let other = "team/\u{FF41}ccess.yaml";
        f.put("team/access.yaml", EDIT);
        f.put(other, EDIT);
        f.settle();
        let decided = f.decide_on("team", decision, None, "removed");
        assert!(
            matches!(&decided, Err(RuntimeError::AccessRuleChanged { folder }) if folder == "team"),
            "{decided:?}"
        );
        assert!(f.root().join("team/access.yaml").exists());
        assert!(f.root().join(other).exists());
        assert!(f.holds().is_empty());
        assert_eq!(recorded_reach(&f, "members"), None);
    }
}

impl Fixture {
    /// Each hold's change rows as `who: before → after`, with the rest of
    /// what its notice shows.
    fn hold_views(&self) -> Vec<dohc_engine_runtime::AccessRuleHoldView> {
        let holds = self
            .runtime
            .block_on(self.actor.access_rule_holds(WS.to_owned()))
            .expect("holds");
        self.runtime
            .block_on(
                self.actor
                    .access_rule_hold_views(self.root().to_path_buf(), holds),
            )
            .expect("hold views")
    }
}

fn rows(view: &dohc_engine_runtime::AccessRuleHoldView) -> Vec<String> {
    view.changes
        .iter()
        .map(|change| format!("{}: {} → {}", change.who, change.before, change.after))
        .collect()
}

/// A widened folder's notice lists who reaches it differently, from the
/// rule dohc recorded to the rule on disk now, and opens that rule.
#[test]
fn a_widened_hold_lists_who_reaches_the_folder_differently() {
    let f = ruled_team();
    f.put(
        "team/access.yaml",
        "members: edit\npeople:\n  sam@example.com: edit\n",
    );
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    let views = f.hold_views();
    let [view] = views.as_slice() else {
        panic!("{views:?}")
    };
    assert_eq!(
        rows(view),
        lines(&["members: view → edit", "sam@example.com: view → edit"])
    );
    assert_eq!(view.recorded.as_deref(), Some(VIEW));
    assert_eq!(view.rule_path.as_deref(), Some("team/access.yaml"));
    assert_eq!(view.unreadable, None);

    // Two spellings are one unreadable rule.
    f.put("team/\u{FF41}ccess.yaml", EDIT);
    assert_eq!(f.hold_views()[0].unreadable, Some("several-files"));
    assert!(f.hold_views()[0].changes.is_empty());
    // Both files can be read, so recording them, which hides the folder,
    // runs.
    let mut expected = f.journal();
    f.decide_on("team", AccessRuleDecision::Accept, None, "widened")
        .expect("record both spellings");
    assert!(f.holds().is_empty());
    // The new spelling goes first, so the folder hides from the first step.
    expected.extend(lines(&[
        "write team/\u{FF41}ccess.yaml",
        "write team/access.yaml",
    ]));
    assert_eq!(f.journal(), expected);
}

/// Recording a widened rule beside a second spelling hides the folder, and
/// every step of it does: stopped after its first moment, the journal gives
/// nobody more than the rule recorded before.
#[test]
fn hiding_a_folder_spelled_twice_widens_nothing_at_any_step() {
    struct CrashAfterOneMoment(PathBuf, i64, std::sync::atomic::AtomicBool);
    impl FaultInjector for CrashAfterOneMoment {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point != FaultPoint::StorageBeforePersist
                || self.2.load(std::sync::atomic::Ordering::SeqCst)
            {
                return FaultAction::Continue;
            }
            if moments(&self.0) > self.1 {
                self.2.store(true, std::sync::atomic::Ordering::SeqCst);
                return FaultAction::Crash;
            }
            FaultAction::Continue
        }
    }
    fn moments(db: &Path) -> i64 {
        rusqlite::Connection::open(db)
            .expect("open db")
            .query_row(
                "SELECT count(*) FROM replication_log WHERE op_kind='moment.append'",
                [],
                |row| row.get(0),
            )
            .expect("count moments")
    }
    let f = ruled_team();
    let other = "team/\u{FF41}ccess.yaml";
    f.put(
        "team/access.yaml",
        "members: edit\npeople:\n  sam@example.com: edit\n",
    );
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    f.put(other, EDIT);
    let before = f.journal();
    assert_eq!(recorded_reach(&f, "members"), Some(Level::View));
    let crash = Arc::new(CrashAfterOneMoment(
        f.db.clone(),
        moments(&f.db),
        Default::default(),
    ));
    let halfway = f.decided_at(
        "team",
        AccessRuleDecision::Accept,
        None,
        "widened",
        30,
        crash,
    );
    assert!(
        matches!(halfway, Err(RuntimeError::OperationCrashed)),
        "{halfway:?}"
    );
    for who in ["members", "sam@example.com"] {
        assert_eq!(recorded_reach(&f, who), None, "{who} after the first step");
    }
    let mut expected = before.clone();
    expected.push(format!("write {other}"));
    assert_eq!(f.journal(), expected, "one moment, then the stop");
    f.decide_on("team", AccessRuleDecision::Accept, None, "widened")
        .expect("finish hiding");
    expected.push("write team/access.yaml".to_owned());
    assert_eq!(f.journal(), expected);
    for who in ["members", "sam@example.com"] {
        assert_eq!(recorded_reach(&f, who), None, "{who} at the end");
    }
}

/// What the recorded rule of `team` gives `who`, as the relay reads it: one
/// readable spelling is the rule, and several hide the folder.
fn recorded_reach(f: &Fixture, who: &str) -> Option<Level> {
    let conn = rusqlite::Connection::open(&f.db).expect("open db");
    let texts: Vec<String> = ["team/access.yaml", "team/\u{FF41}ccess.yaml"]
        .into_iter()
        .filter_map(|path| {
            dohc_engine_domain::select_snapshot_by_path_in_tx(&conn, WS, "main", path)
                .expect("read snapshot")
                .snapshot
                .map(|snapshot| snapshot.text)
        })
        .collect();
    let [text] = texts.as_slice() else {
        return None;
    };
    let rule = parse_access_rule(text)?;
    match who {
        "members" => rule.members,
        email => level_for_email(&rule, email),
    }
}

/// A removed rule's notice lists each entry it recorded, with the reach the
/// folder falls back to: the nearest rule above, or the workspace level.
#[test]
fn a_removed_hold_lists_what_the_folder_falls_back_to() {
    for (removed, folder, expected, falls_back_to) in [
        (
            "team/sub/access.yaml",
            "team/sub",
            lines(&["members: none → view"]),
            Some("team"),
        ),
        (
            "team/access.yaml",
            "team",
            lines(&[
                "members: view → workspace",
                "sam@example.com: view → workspace",
            ]),
            None,
        ),
    ] {
        let f = Fixture::new();
        f.put(
            "team/access.yaml",
            "members: view\npeople:\n  sam@example.com: view\n",
        );
        f.put("team/sub/access.yaml", "people:\n  sam@example.com: view\n");
        f.put("team/sub/b.md", "beta");
        f.settle();
        f.capture_ok(&["team/access.yaml", "team/sub/access.yaml", "team/sub/b.md"]);
        std::fs::remove_file(f.root().join(removed)).unwrap();
        f.put("team/sub/b.md", "beta 2");
        f.settle();
        assert!(held(&f.capture(&["team/sub/b.md"])[0], folder));
        let views = f.hold_views();
        let [view] = views.as_slice() else {
            panic!("{views:?}")
        };
        assert_eq!(view.hold.folder, folder);
        assert_eq!(rows(view), expected, "{folder}");
        assert_eq!(view.falls_back_to.as_deref(), falls_back_to, "{folder}");
    }
}

/// A notice's levels are the relay's: every rule from the root down applies,
/// a person an outer rule names counts, and a rule that hides someone above
/// the folder hides them before and after.
#[test]
fn a_held_rules_levels_follow_every_rule_above_it() {
    // The root rule hides members, so team giving them edit reaches nobody
    // and neither change does; ana and bo, whom only the root rule names, go
    // from the folder's view to team's edit.
    let expected = lines(&[
        "ana@example.com: view → edit",
        "bo@example.com: view → edit",
    ]);
    for removes in [false, true] {
        let f = Fixture::new();
        // Outer rules wider than view hold until the owner allows them.
        for (path, folder, text) in [
            (
                "access.yaml",
                "",
                "people:\n  ana@example.com: edit\n  bo@example.com: view\n",
            ),
            ("team/access.yaml", "team", EDIT),
        ] {
            f.put(path, text);
            f.settle();
            if f.capture(&[path])[0].is_err() {
                f.decide(folder, AccessRuleDecision::Accept).unwrap();
            }
        }
        f.put("team/sub/access.yaml", VIEW);
        f.put("team/sub/b.md", "beta");
        f.settle();
        f.capture_ok(&["team/sub/access.yaml", "team/sub/b.md"]);
        assert!(f.holds().is_empty());
        if removes {
            std::fs::remove_file(f.root().join("team/sub/access.yaml")).unwrap();
        } else {
            f.put("team/sub/access.yaml", EDIT);
        }
        f.put("team/sub/b.md", "beta 2");
        f.settle();
        assert!(held(&f.capture(&["team/sub/b.md"])[0], "team/sub"));
        let views = f.hold_views();
        let [view] = views.as_slice() else {
            panic!("{views:?}")
        };
        assert_eq!(rows(view), expected, "removes: {removes}");
        // Without its rule the folder follows team's, under the root's.
        let falls_back_to = removes.then_some("team");
        assert_eq!(view.falls_back_to.as_deref(), falls_back_to);
    }
}

impl Fixture {
    /// The kept copies the workspace lists, by path, with their bytes.
    fn kept_copies(&self) -> Vec<(String, String)> {
        self.runtime
            .block_on(
                self.actor
                    .kept_materialization_files(WS.to_owned(), self.root().to_path_buf()),
            )
            .expect("kept copies")
            .into_iter()
            .map(|(path, staged)| {
                (
                    path,
                    std::fs::read_to_string(self.root().join(staged)).unwrap(),
                )
            })
            .collect()
    }
}

/// Restore puts the recorded rule back and keeps the one it replaced as a
/// kept copy, which the owner can still save.
#[test]
fn restoring_a_widened_rule_puts_the_committed_bytes_back() {
    let f = ruled_team();
    let before = f.journal();
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    let decided = f
        .decided_on(
            "team",
            AccessRuleDecision::Restore,
            Some(dohc_engine_storage::hex_sha256(EDIT.as_bytes())),
            "widened",
        )
        .expect("restore");
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/access.yaml")).unwrap(),
        VIEW
    );
    assert_eq!(decided.kept, lines(&["team/access.yaml"]));
    assert_eq!(
        f.kept_copies(),
        vec![("team/access.yaml".to_owned(), EDIT.to_owned())]
    );
    assert!(f.holds().is_empty());
    assert_eq!(f.journal(), before);
}

/// A Restore whose placement waits and is tried again keeps the rule from
/// outside dohc once.
#[test]
fn a_restore_tried_again_keeps_one_copy_of_the_outside_rule() {
    struct SaveOverOnce {
        path: PathBuf,
        fired: std::sync::atomic::AtomicBool,
    }
    impl dohc_engine_storage::FaultInjector for SaveOverOnce {
        fn poll(&self, point: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
            if point == dohc_engine_storage::FaultPoint::MaterializeBeforePreimageRevalidate
                && !self.fired.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                std::fs::write(&self.path, "members: comment\n").unwrap();
            }
            dohc_engine_storage::FaultAction::Continue
        }
    }
    let f = ruled_team();
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    let seen = Some(dohc_engine_storage::hex_sha256(EDIT.as_bytes()));
    let first = f.decided_at(
        "team",
        AccessRuleDecision::Restore,
        seen.clone(),
        "widened",
        30,
        Arc::new(SaveOverOnce {
            path: f.root().join("team/access.yaml"),
            fired: false.into(),
        }),
    );
    assert!(
        matches!(&first, Err(RuntimeError::Sync(SyncError::RetryableState { reason })) if *reason == ACCESS_RULE_WAITS),
        "{first:?}"
    );
    // The editor saves the outside rule again, and the owner tries again.
    f.put("team/access.yaml", EDIT);
    f.decided_at(
        "team",
        AccessRuleDecision::Restore,
        seen,
        "widened",
        31,
        Arc::new(NoFaults),
    )
    .expect("restore");
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/access.yaml")).unwrap(),
        VIEW
    );
    assert_eq!(
        f.kept_copies(),
        vec![("team/access.yaml".to_owned(), EDIT.to_owned())]
    );
}

/// A decision reads its hold under the capture gate: once its Version is no
/// longer active, or the hold is decided, it is refused and disk stays.
#[test]
fn a_decision_on_a_hold_its_version_no_longer_shows_is_refused() {
    let f = ruled_team();
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    let seen = Some(dohc_engine_storage::hex_sha256(EDIT.as_bytes()));
    // The switch lands after the caller read the hold, before its decision.
    f.activate_feature(true);
    let refused = f.decide_on("team", AccessRuleDecision::Restore, seen.clone(), "widened");
    assert!(
        matches!(refused, Err(RuntimeError::AccessRuleNotHeld)),
        "{refused:?}"
    );
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/access.yaml")).unwrap(),
        EDIT
    );
    f.activate_feature(false);
    f.decide_on("team", AccessRuleDecision::Accept, seen.clone(), "widened")
        .expect("accept");
    // A second press on the decided hold.
    let again = f.decide_on("team", AccessRuleDecision::Restore, seen, "widened");
    assert!(
        matches!(again, Err(RuntimeError::AccessRuleNotHeld)),
        "{again:?}"
    );
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/access.yaml")).unwrap(),
        EDIT
    );
}

fn moved<T>(result: &Result<T, RuntimeError>) -> bool {
    matches!(
        result,
        Err(RuntimeError::Sync(SyncError::InvalidInput { reason }))
            if *reason == dohc_engine_runtime::WORKSPACE_FOLDER_MOVED
    )
}

/// A movable, replicating workspace whose team folder waits for its owner
/// over a widened rule.
fn held_team() -> Fixture {
    let f = Fixture::movable();
    f.replicate();
    f.put("team/access.yaml", VIEW);
    f.put("team/a.md", "alpha");
    f.settle();
    f.capture_ok(&["team/access.yaml", "team/a.md"]);
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    f
}

/// Once the store leaves the workspace folder while it stays open, a
/// decision on a held rule is refused before it keeps, places, removes or
/// commits a rule, or clears the hold.
#[test]
fn a_decision_after_the_store_moved_changes_nothing() {
    let seen = || Some(dohc_engine_storage::hex_sha256(EDIT.as_bytes()));
    let rule = |f: &Fixture| std::fs::read_to_string(f.root().join("team/access.yaml")).unwrap();
    let held_team_still = vec![("team".to_owned(), "widened".to_owned())];
    // Every case runs, so one failure shows them all.
    let mut wrong = Vec::new();
    for decision in [AccessRuleDecision::Accept, AccessRuleDecision::Restore] {
        let f = held_team();
        let before = f.journal();
        f.move_store_away();
        let decided = f.decide_on("team", decision, seen(), "widened");
        let stray = f.move_store_back();
        // Refused, nothing written where the store was, the rule on disk, no
        // kept copy, the hold, the journal.
        let state = (
            moved(&decided),
            stray,
            rule(&f),
            f.kept_copies(),
            f.holds(),
            f.journal() == before,
        );
        let refused = (
            true,
            Vec::new(),
            EDIT.to_owned(),
            Vec::new(),
            held_team_still.clone(),
            true,
        );
        if state != refused {
            wrong.push(format!("{decision:?}: {decided:?} {state:?}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Restoring a folder whose new rule nothing committed removes that rule
/// from disk and keeps it as a kept copy the owner can still save.
#[test]
fn restoring_an_uncommitted_rule_keeps_its_bytes() {
    let f = ruled_team();
    f.put("team/sub/access.yaml", EDIT);
    f.put("team/sub/b.md", "beta");
    f.settle();
    assert!(held(&f.capture(&["team/sub/b.md"])[0], "team/sub"));
    f.decide("team/sub", AccessRuleDecision::Restore)
        .expect("restore");
    assert!(!f.root().join("team/sub/access.yaml").exists());
    assert_eq!(
        f.kept_copies(),
        vec![("team/sub/access.yaml".to_owned(), EDIT.to_owned())]
    );
    assert!(f.holds().is_empty());
}

/// A rule dohc is still placing on disk goes unjudged only while capture
/// reads the bytes being placed. A widening saved over the placement holds.
#[test]
fn a_widening_saved_over_a_pending_rule_placement_holds() {
    let f = ruled_team();
    let before = f.journal();
    rusqlite::Connection::open(&f.db)
        .unwrap()
        .execute(
            "INSERT INTO materialization_jobs (job_id, target_path, content_sha256, \
             preimage_present, target_generation, created_at_ms, workspace_id) \
             VALUES ('job-rule', 'team/access.yaml', ?1, 0, 1, 1, ?2)",
            [
                dohc_engine_storage::hex_sha256(VIEW.as_bytes()),
                WS.to_owned(),
            ],
        )
        .unwrap();
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/access.yaml"])[0], "team"));
    assert_eq!(f.journal(), before);
    assert_eq!(f.holds(), vec![("team".to_owned(), "widened".to_owned())]);
}

/// A rule removed from disk while dohc places another spelling of it is a
/// removal outside dohc: the pending job is not this delete's own.
#[test]
fn a_rule_removed_beside_another_spellings_pending_placement_holds() {
    let f = ruled_team();
    let before = f.journal();
    rusqlite::Connection::open(&f.db)
        .unwrap()
        .execute(
            "INSERT INTO materialization_jobs (job_id, target_path, content_sha256,              preimage_present, target_generation, created_at_ms, workspace_id)              VALUES ('job-rule', 'team/ACCESS.yaml', ?1, 0, 1, 1, ?2)",
            [
                dohc_engine_storage::hex_sha256(VIEW.as_bytes()),
                WS.to_owned(),
            ],
        )
        .unwrap();
    std::fs::remove_file(f.root().join("team/access.yaml")).unwrap();
    f.settle();
    let retired = f.retire("team/access.yaml");
    assert!(held(&retired, "team"), "{retired:?}");
    assert_eq!(f.journal(), before);
    assert_eq!(f.holds(), vec![("team".to_owned(), "removed".to_owned())]);
}

/// A rule removed from disk while dohc still writes a narrower one there is
/// a removal outside dohc: only dohc's own pending delete of the path makes
/// the delete its own.
#[test]
fn a_rule_removed_while_a_narrowing_write_is_pending_holds() {
    let f = ruled_team();
    let before = f.journal();
    let conn = rusqlite::Connection::open(&f.db).unwrap();
    let narrower = dohc_engine_storage::hex_sha256(NOBODY.as_bytes());
    conn.execute(
        "INSERT INTO binary_blobs (sha256, byte_length, bytes) VALUES (?1, ?2, ?3)",
        rusqlite::params![narrower, NOBODY.len() as i64, NOBODY.as_bytes()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO materialization_jobs (job_id, target_path, content_sha256, \
         preimage_present, preimage_sha256, target_generation, created_at_ms, workspace_id) \
         VALUES ('job-narrow', 'team/access.yaml', ?1, 1, ?2, 1, 1, ?3)",
        [
            narrower,
            dohc_engine_storage::hex_sha256(VIEW.as_bytes()),
            WS.to_owned(),
        ],
    )
    .unwrap();
    std::fs::remove_file(f.root().join("team/access.yaml")).unwrap();
    f.settle();
    let retired = f.retire("team/access.yaml");
    assert!(held(&retired, "team"), "{retired:?}");
    assert_eq!(f.journal(), before);
    assert_eq!(f.holds(), vec![("team".to_owned(), "removed".to_owned())]);
}

#[test]
fn an_editor_save_inside_the_settle_period_journals_no_widening() {
    let f = ruled_team();
    let before = f.journal();
    // The editor deletes the rule, then renames its copy into place.
    std::fs::remove_file(f.root().join("team/access.yaml")).unwrap();
    assert!(waits(&f.retire("team/access.yaml")));
    assert!(waits(&f.capture(&["team/a.md"])[0]));
    f.put("team/access.yaml.tmp", EDIT);
    std::fs::rename(
        f.root().join("team/access.yaml.tmp"),
        f.root().join("team/access.yaml"),
    )
    .unwrap();
    assert!(waits(&f.capture(&["team/access.yaml", "team/a.md"])[0]));
    assert_eq!(f.journal(), before);
    assert!(f.holds().is_empty(), "nothing settled long enough to judge");
}

#[test]
fn a_rule_removed_over_files_holds_and_a_removed_folder_deletes_rule_last() {
    let f = ruled_team();
    std::fs::remove_file(f.root().join("team/access.yaml")).unwrap();
    f.settle();
    assert!(held(&f.retire("team/access.yaml"), "team"));
    assert_eq!(f.holds(), vec![("team".to_owned(), "removed".to_owned())]);

    let f = ruled_team();
    let before = f.journal();
    std::fs::remove_dir_all(f.root().join("team")).unwrap();
    f.settle();
    // The rule waits for the deletes of the files it covers.
    assert!(waits(&f.retire("team/access.yaml")));
    f.retire("team/a.md").expect("retire file");
    f.retire("team/access.yaml").expect("retire rule");
    let mut expected = before;
    expected.extend(lines(&["delete team/a.md", "delete team/access.yaml"]));
    assert_eq!(f.journal(), expected);
    assert!(f.holds().is_empty());
}

#[test]
fn a_rule_rename_journals_a_create_then_a_delete() {
    let f = Fixture::new();
    let token = CancellationToken::new;
    f.runtime
        .block_on(f.actor.versioned_text_write_indexed(
            write("team/access.yaml", VIEW, "m-rule"),
            f.root().to_path_buf(),
            Arc::new(NoFaults),
            token(),
        ))
        .expect("write rule");
    f.runtime
        .block_on(f.actor.versioned_text_rename(
            RenameTextFile {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                from_path: "team/access.yaml".to_owned(),
                to_path: "crew/access.yaml".to_owned(),
                moment_id: "m-move".to_owned(),
                request_id: None,
                metadata_origin: "cli".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 40,
            },
            f.root().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            token(),
        ))
        .expect("rename rule");
    assert_eq!(
        f.journal(),
        lines(&[
            "write team/access.yaml",
            "write crew/access.yaml",
            "delete team/access.yaml",
        ])
    );
}

/// A rule rename tried again after its first try finished, as when its answer
/// was lost, returns its first answer from what it recorded. Whatever
/// happened to either path since changes neither the answer, the files nor
/// the journal.
#[test]
fn a_finished_rule_rename_tried_again_replays() {
    for later in [
        "nothing",
        "destination edited",
        "destination removed",
        "source recreated",
    ] {
        let f = Fixture::new();
        f.versioned_write(write("team/access.yaml", VIEW, "m-rule"))
            .expect("write rule");
        let first = rule_rename(&f, "crew", Arc::new(NoFaults)).expect("rename rule");
        match later {
            "destination edited" => f
                .versioned_write(write("crew/access.yaml", NOBODY, "m-edit"))
                .expect("edit the destination"),
            "destination removed" => f
                .versioned_delete(delete("crew/access.yaml", "m-gone"))
                .expect("remove the destination"),
            "source recreated" => f
                .versioned_write(write("team/access.yaml", EDIT, "m-again"))
                .expect("recreate the source"),
            _ => {}
        }
        let files = rule_files(&f);
        let journal = f.journal();
        let again = rule_rename(&f, "crew", Arc::new(NoFaults))
            .unwrap_or_else(|error| panic!("{later}: the same rename tried again: {error:?}"));
        assert!(again.deduped, "{later}: {again:?}");
        assert_eq!(again.moment.moment_id, first.moment.moment_id, "{later}");
        assert_eq!(again.after.text, first.after.text, "{later}");
        assert_eq!(again.object.object_id, first.object.object_id, "{later}");
        assert_eq!(rule_files(&f), files, "{later}");
        assert_eq!(f.journal(), journal, "{later}");
        let elsewhere = rule_rename(&f, "else", Arc::new(NoFaults));
        assert!(
            matches!(
                elsewhere,
                Err(RuntimeError::Domain(
                    DomainError::IdempotencyKeyReuseMismatch
                ))
            ),
            "{later}: {elsewhere:?}"
        );
        assert_eq!(f.journal(), journal, "{later}");
    }
}

/// A rule rename whose first half finished and second didn't writes the
/// first half again from the text it recorded, then finishes the second,
/// unless its source changed since: that later edit stays, and the retry is
/// refused.
#[test]
fn a_half_finished_rule_rename_tried_again_replays_its_first_half() {
    struct CrashOnceMoved(PathBuf, std::sync::atomic::AtomicBool);
    impl FaultInjector for CrashOnceMoved {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point != FaultPoint::StorageBeforePersist
                || self.1.load(std::sync::atomic::Ordering::SeqCst)
            {
                return FaultAction::Continue;
            }
            let conn = rusqlite::Connection::open(&self.0).expect("open db");
            let moved: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id='r-move-to')",
                    [],
                    |row| row.get(0),
                )
                .expect("read requests");
            if moved {
                self.1.store(true, std::sync::atomic::Ordering::SeqCst);
                FaultAction::Crash
            } else {
                FaultAction::Continue
            }
        }
    }
    for source_edited in [false, true] {
        let f = Fixture::new();
        f.versioned_write(write("team/access.yaml", VIEW, "m-rule"))
            .expect("write rule");
        let crash = Arc::new(CrashOnceMoved(f.db.clone(), Default::default()));
        let halfway = rule_rename(&f, "crew", crash);
        assert!(
            matches!(halfway, Err(RuntimeError::OperationCrashed)),
            "{halfway:?}"
        );
        if !source_edited {
            let again =
                rule_rename(&f, "crew", Arc::new(NoFaults)).expect("the same rename tried again");
            assert_eq!(again.after.text, VIEW);
            assert_eq!(
                f.journal(),
                lines(&[
                    "write team/access.yaml",
                    "write crew/access.yaml",
                    "delete team/access.yaml",
                ])
            );
            continue;
        }
        f.versioned_write(write("team/access.yaml", EDIT, "m-later"))
            .expect("edit the source");
        let journal = f.journal();
        let again = rule_rename(&f, "crew", Arc::new(NoFaults));
        assert!(
            matches!(
                again,
                Err(RuntimeError::Domain(
                    DomainError::IdempotencyKeyReuseMismatch
                ))
            ),
            "{again:?}"
        );
        assert_eq!(f.journal(), journal);
        let conn = rusqlite::Connection::open(&f.db).expect("open db");
        let source = dohc_engine_domain::select_snapshot_by_path_in_tx(
            &conn,
            WS,
            "main",
            "team/access.yaml",
        )
        .expect("read the source")
        .snapshot
        .map(|snapshot| snapshot.text);
        assert_eq!(source.as_deref(), Some(EDIT), "the later edit stays");
    }
}

/// Move `team/access.yaml` into folder `to` as request `r-move`.
fn rule_rename(
    f: &Fixture,
    to: &str,
    faults: Arc<dyn FaultInjector>,
) -> Result<dohc_engine_domain::RenameResult, RuntimeError> {
    f.runtime.block_on(f.actor.versioned_text_rename(
        RenameTextFile {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            from_path: "team/access.yaml".to_owned(),
            to_path: format!("{to}/access.yaml"),
            moment_id: "m-move".to_owned(),
            request_id: Some("r-move".to_owned()),
            metadata_origin: "cli".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 40,
        },
        f.root().to_path_buf(),
        Arc::new(()),
        faults,
        CancellationToken::new(),
    ))
}

/// What both rename paths hold on disk.
fn rule_files(f: &Fixture) -> [Option<String>; 2] {
    ["team/access.yaml", "crew/access.yaml"]
        .map(|path| std::fs::read_to_string(f.root().join(path)).ok())
}

/// A rule rename onto another folder's rule is refused, as any rename onto
/// an existing file is, before either rule changes.
#[test]
fn a_rule_rename_onto_another_rule_is_refused() {
    let f = Fixture::new();
    for (path, text, moment) in [
        ("team/access.yaml", VIEW, "m-team"),
        ("crew/access.yaml", NOBODY, "m-crew"),
    ] {
        f.versioned_write(write(path, text, moment))
            .expect("write rule");
    }
    let before = f.journal();
    let renamed = f.runtime.block_on(f.actor.versioned_text_rename(
        RenameTextFile {
            workspace_id: WS.to_owned(),
            version_id: "main".to_owned(),
            from_path: "team/access.yaml".to_owned(),
            to_path: "crew/access.yaml".to_owned(),
            moment_id: "m-move".to_owned(),
            request_id: Some("r-move".to_owned()),
            metadata_origin: "cli".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 40,
        },
        f.root().to_path_buf(),
        Arc::new(()),
        Arc::new(NoFaults),
        CancellationToken::new(),
    ));
    assert!(
        matches!(
            renamed,
            Err(RuntimeError::Domain(DomainError::TargetPathExists))
        ),
        "{renamed:?}"
    );
    assert_eq!(f.journal(), before);
}

/// A rule written without publication is only in the store. Its absence on
/// disk is not a removal outside dohc.
#[test]
fn an_unpublished_rule_is_not_read_as_removed() {
    let f = Fixture::new();
    for (path, text, moment) in [
        ("team/access.yaml", VIEW, "m-rule"),
        ("team/a.md", "alpha", "m-a"),
    ] {
        f.runtime
            .block_on(f.actor.versioned_text_write_indexed(
                write(path, text, moment),
                f.root().to_path_buf(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .expect("write");
        f.settle();
    }
    assert_eq!(
        f.journal(),
        lines(&["write team/access.yaml", "write team/a.md"])
    );
    assert!(f.holds().is_empty());
}

impl Fixture {
    fn versioned_write(&self, input: WriteText) -> Result<(), RuntimeError> {
        self.runtime
            .block_on(self.actor.versioned_text_write_indexed(
                input,
                self.root().to_path_buf(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .map(drop)
    }

    fn versioned_delete(&self, input: DeleteTextFile) -> Result<(), RuntimeError> {
        self.runtime
            .block_on(self.actor.versioned_text_delete(
                input,
                self.root().to_path_buf(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .map(drop)
    }

    fn undo(&self, operation: &str, request: &str) -> Result<(), RuntimeError> {
        self.runtime
            .block_on(self.actor.history_undo_in_turns(
                WS.to_owned(),
                operation.to_owned(),
                request.to_owned(),
                None,
                self.root().to_path_buf(),
                Arc::new(NoFaults),
                60,
                [Arc::default(), Arc::default()],
                Arc::new(()),
                None,
                CancellationToken::new(),
            ))
            .map(drop)
    }
}

/// Undo, rollback and merge meet a rule on disk that nothing committed yet.
/// Each puts the rule first and goes on, on its first attempt: a refusal by
/// the commit-point check never reaches its caller.
#[test]
fn writers_without_a_step_of_their_own_put_a_pending_rule_first() {
    type Step = fn(&Fixture) -> Result<(), RuntimeError>;
    let writers: [(&str, Step, Step); 3] = [
        (
            "undo",
            |f| {
                f.versioned_write(write("team/a.md", "alpha", "m-alpha"))?;
                f.versioned_delete(delete("team/a.md", "d-alpha"))
            },
            |f| f.undo(OP, "undo-delete"),
        ),
        (
            "rollback",
            |f| {
                f.versioned_write(write("team/a.md", "alpha", "m-alpha"))?;
                f.versioned_write(write("team/a.md", "alpha 2", "m-alpha-2"))
            },
            |f| {
                f.runtime
                    .block_on(f.actor.versioned_text_rollback(
                        RollbackTextFileMutation {
                            workspace_id: WS.to_owned(),
                            version_id: "main".to_owned(),
                            path: "team/a.md".to_owned(),
                            mutation_moment_id: "m-alpha-2".to_owned(),
                            request_id: None,
                            metadata_origin: "api".to_owned(),
                            author_json: None,
                        },
                        f.root().to_path_buf(),
                        Arc::new(()),
                        Arc::new(NoFaults),
                        CancellationToken::new(),
                    ))
                    .map(drop)
            },
        ),
        (
            "merge",
            |f| {
                f.versioned_write(write("team/a.md", "alpha", "m-alpha"))?;
                f.runtime.block_on(f.actor.create_named_version(
                    CreateNamedVersion {
                        workspace_id: WS.to_owned(),
                        new_version_id: "feature".to_owned(),
                        name: "feature".to_owned(),
                        from_version_id: "main".to_owned(),
                        now_ms: 41,
                        request_id: None,
                    },
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                ))?;
                f.versioned_write(WriteText {
                    version_id: "feature".to_owned(),
                    ..write("team/a.md", "alpha 2", "m-feature")
                })
            },
            |f| {
                f.runtime
                    .block_on(f.actor.versioned_text_merge(
                        MergeTextFileFromVersion {
                            workspace_id: WS.to_owned(),
                            target_version_id: "main".to_owned(),
                            source_version_id: "feature".to_owned(),
                            path: "team/a.md".to_owned(),
                            object_id: "ignored".to_owned(),
                            moment_id: "m-merge".to_owned(),
                            request_id: None,
                            conflict_id: "conflict-merge".to_owned(),
                            metadata_origin: "api".to_owned(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 42,
                        },
                        f.root().to_path_buf(),
                        Arc::new(()),
                        Arc::new(NoFaults),
                        CancellationToken::new(),
                    ))
                    .map(drop)
            },
        ),
    ];
    for (name, prepare, writer) in writers {
        let f = Fixture::new();
        prepare(&f).unwrap_or_else(|error| panic!("{name} setup: {error}"));
        let before = f.journal();
        f.put("team/access.yaml", VIEW);
        f.settle();
        writer(&f).unwrap_or_else(|error| panic!("{name}: {error}"));
        let journal = f.journal();
        assert_eq!(journal[..before.len()], before[..], "{name}");
        assert_eq!(
            journal[before.len()..],
            lines(&["write team/access.yaml", "write team/a.md"]),
            "{name}"
        );
    }
}

impl Fixture {
    fn rollback(&self, moment: &str) -> Result<(), RuntimeError> {
        self.rollback_at("crew/a.md", moment)
    }

    fn rollback_at(&self, path: &str, moment: &str) -> Result<(), RuntimeError> {
        self.runtime
            .block_on(self.actor.versioned_text_rollback(
                RollbackTextFileMutation {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    path: path.to_owned(),
                    mutation_moment_id: moment.to_owned(),
                    request_id: None,
                    metadata_origin: "api".to_owned(),
                    author_json: None,
                },
                self.root().to_path_buf(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .map(drop)
    }
}

/// Rolling back a move between two folders whose new rules wait on disk
/// commits both rules, one after the other, before the move back. A folder
/// held for its owner answers for the rollback.
#[test]
fn a_rollback_across_two_waiting_rules_commits_both_first() {
    for team_held in [false, true] {
        let f = Fixture::new();
        if team_held {
            f.put("team/access.yaml", NOBODY);
            f.settle();
            f.capture_ok(&["team/access.yaml"]);
        }
        f.versioned_write(write("team/a.md", "alpha", "m-alpha"))
            .expect("write");
        f.runtime
            .block_on(f.actor.versioned_text_rename(
                RenameTextFile {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    from_path: "team/a.md".to_owned(),
                    to_path: "crew/a.md".to_owned(),
                    moment_id: "m-move".to_owned(),
                    request_id: None,
                    metadata_origin: "cli".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 40,
                },
                f.root().to_path_buf(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .expect("move");
        let before = f.journal();
        f.put("crew/access.yaml", VIEW);
        f.put("team/access.yaml", if team_held { EDIT } else { VIEW });
        f.settle();
        let rolled = f.rollback("m-move");
        let journal = f.journal();
        if team_held {
            assert!(held(&rolled, "team"), "{rolled:?}");
            assert_eq!(journal[before.len()..], lines(&["write crew/access.yaml"]));
        } else {
            rolled.expect("rollback");
            assert_eq!(
                journal[before.len()..],
                lines(&[
                    "write crew/access.yaml",
                    "write team/access.yaml",
                    "rename team/a.md",
                ])
            );
        }
    }
}

impl Fixture {
    /// The moments the store records, in order.
    fn moments(&self) -> Vec<String> {
        rusqlite::Connection::open(&self.db)
            .unwrap()
            .prepare("SELECT moment_id FROM moments WHERE workspace_id=?1 ORDER BY moment_order")
            .unwrap()
            .query_map([WS], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn rename(&self, from: &str, to: &str, moment: &str) -> Result<(), RuntimeError> {
        self.runtime
            .block_on(self.actor.versioned_text_rename(
                RenameTextFile {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    from_path: from.to_owned(),
                    to_path: to.to_owned(),
                    moment_id: moment.to_owned(),
                    request_id: None,
                    metadata_origin: "cli".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 40,
                },
                self.root().to_path_buf(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .map(drop)
    }

    /// Merge team/a.md from the feature Version into Main.
    fn merge_feature(&self) -> Result<(), RuntimeError> {
        self.runtime
            .block_on(self.actor.versioned_text_merge(
                MergeTextFileFromVersion {
                    workspace_id: WS.to_owned(),
                    target_version_id: "main".to_owned(),
                    source_version_id: "feature".to_owned(),
                    path: "team/a.md".to_owned(),
                    object_id: "ignored".to_owned(),
                    moment_id: "m-merge".to_owned(),
                    request_id: None,
                    conflict_id: "conflict-merge".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 42,
                },
                self.root().to_path_buf(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .map(drop)
    }
}

fn move_team_to_crew(f: &Fixture) -> Result<(), RuntimeError> {
    f.versioned_write(write("team/a.md", "alpha", "m-alpha"))?;
    f.rename("team/a.md", "crew/a.md", "m-move")
}

fn edit_on_feature(f: &Fixture) -> Result<(), RuntimeError> {
    f.versioned_write(write("team/a.md", "alpha", "m-alpha"))?;
    f.runtime.block_on(f.actor.create_named_version(
        CreateNamedVersion {
            workspace_id: WS.to_owned(),
            new_version_id: "feature".to_owned(),
            name: "feature".to_owned(),
            from_version_id: "main".to_owned(),
            now_ms: 41,
            request_id: None,
        },
        Arc::new(NoFaults),
        CancellationToken::new(),
    ))?;
    f.versioned_write(WriteText {
        version_id: "feature".to_owned(),
        ..write("team/a.md", "alpha 2", "m-feature")
    })
}

/// Rollback, merge, conflict resolution and Duplicate rely on the
/// commit-point check alone. Once the workspace replicates, under a folder
/// held for its owner each is refused and records nothing. Rolling back a
/// move is held at either of its paths, Duplicate at its copy. A workspace
/// that does not replicate holds none of them.
#[test]
fn writers_without_a_step_of_their_own_are_held_once_the_workspace_replicates() {
    type Step = fn(&Fixture) -> Result<(), RuntimeError>;
    let cases: [(&str, &str, Step, Step); 5] = [
        (
            "duplicate into a held folder",
            "team",
            |f| f.versioned_write(write("src/a.md", "alpha", "m-alpha")),
            |f| f.duplicate("src/a.md", "team/copy.md"),
        ),
        (
            "rollback into a held folder",
            "team",
            move_team_to_crew,
            |f| f.rollback("m-move"),
        ),
        (
            "rollback out of a held folder",
            "crew",
            move_team_to_crew,
            |f| f.rollback("m-move"),
        ),
        ("merge", "team", edit_on_feature, Fixture::merge_feature),
        (
            "conflict resolution",
            "team",
            |f| {
                edit_on_feature(f)?;
                f.versioned_write(write("team/a.md", "alpha 3", "m-main"))?;
                f.merge_feature()
            },
            |f| {
                f.runtime
                    .block_on(f.actor.conflict_resolve_indexed(
                        dohc_engine_runtime::ResolveTextConflict {
                            workspace_id: WS.to_owned(),
                            conflict_id: "conflict-merge".to_owned(),
                            resolution: dohc_engine_domain::ResolveConflictKind::ApplyIncoming,
                            object_id: "resolved-object".to_owned(),
                            write_moment_id: "resolved-write".to_owned(),
                            delete_moment_id: "resolved-delete".to_owned(),
                            metadata_origin: "api".to_owned(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 43,
                            request_id: None,
                            conflict_answer_budget_bytes: usize::MAX,
                        },
                        dohc_engine_collab::LeaseRegistry::new(),
                        f.root().to_path_buf(),
                        Arc::new(NoFaults),
                        CancellationToken::new(),
                    ))
                    .map(drop)
            },
        ),
    ];
    // Every case runs, so one failure shows them all.
    let mut wrong = Vec::new();
    for replicates in [true, false] {
        for (name, folder, prepare, writer) in cases {
            let f = if replicates {
                Fixture::new()
            } else {
                Fixture::local()
            };
            let rule = format!("{folder}/access.yaml");
            f.put(&rule, NOBODY);
            f.settle();
            f.capture_ok(&[&rule]);
            prepare(&f).unwrap_or_else(|error| panic!("{name} setup: {error}"));
            f.put(&rule, EDIT);
            f.settle();
            let before = f.moments();
            let result = writer(&f);
            // Held, nothing recorded, the hold; or done, with no hold.
            let state = (held(&result, folder), f.moments() == before, f.holds());
            let expected = if replicates {
                (true, true, vec![(folder.to_owned(), "widened".to_owned())])
            } else {
                (false, false, Vec::new())
            };
            if state != expected || (!replicates && result.is_err()) {
                wrong.push(format!(
                    "{name}, replicates: {replicates}: {result:?} {state:?}"
                ));
            }
        }
    }
    // Nor are they let through once the store left the workspace folder.
    let moved_cases: [(&str, Step, Step); 3] = [
        ("rollback", move_team_to_crew, |f| f.rollback("m-move")),
        ("merge", edit_on_feature, Fixture::merge_feature),
        (
            "duplicate",
            |f| f.versioned_write(write("team/a.md", "alpha", "m-alpha")),
            |f| f.duplicate("team/a.md", "team/copy.md"),
        ),
    ];
    for (name, prepare, writer) in moved_cases {
        let f = Fixture::movable();
        prepare(&f).unwrap_or_else(|error| panic!("{name} setup: {error}"));
        let before = f.moments();
        f.move_store_away();
        let result = writer(&f);
        let stray = f.move_store_back();
        let state = (moved(&result), stray, f.moments() == before);
        if state != (true, Vec::new(), true) {
            wrong.push(format!(
                "{name} after the store moved: {result:?} {state:?}"
            ));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

impl Fixture {
    fn duplicate(&self, from: &str, to: &str) -> Result<(), RuntimeError> {
        self.runtime
            .block_on(self.actor.duplicate_file(
                DuplicateFile {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    from_path: from.to_owned(),
                    to_path: to.to_owned(),
                    operation_id: "dohc-operation:duplicate".to_owned(),
                    author_json: None,
                    now_ms: 45,
                },
                self.root().to_path_buf(),
                Arc::new(NoFaults),
            ))
            .map(drop)
    }
}

const DRAWING: &str = "drawings/d.excalidraw";

/// A local workspace with a drawing and one asset of it, under an `assets`
/// folder whose committed rule lets nobody in.
fn drawing_with_ruled_asset(replicates: bool) -> Fixture {
    drawing_with_asset(false, replicates).0
}

/// A workspace with a drawing and one asset of it, and the folder whose
/// committed rule lets nobody in: `assets`, or with `in_owner` the asset's
/// own folder, where the rule sits beside the asset.
fn drawing_with_asset(in_owner: bool, replicates: bool) -> (Fixture, String) {
    let mut f = Fixture::local();
    if replicates {
        f.replicate();
    }
    if !in_owner {
        f.put("assets/access.yaml", NOBODY);
    }
    f.put(
        DRAWING,
        r#"{"type":"excalidraw","elements":[],"appState":{},"files":{}}"#,
    );
    f.settle();
    if in_owner {
        f.capture_ok(&[DRAWING]);
    } else {
        f.capture_ok(&["assets/access.yaml", DRAWING]);
    }
    f.supervisor.close(&f.db).expect("close");
    let drawing: String = rusqlite::Connection::open(&f.db)
        .unwrap()
        .query_row(
            "SELECT object_id FROM snapshots WHERE workspace_id=?1 AND path=?2",
            [WS, DRAWING],
            |row| row.get(0),
        )
        .expect("the drawing's object");
    let key = DocKey::new(WS, "main", &drawing).expect("doc key");
    let mut store = EngineStore::open(&f.db, 1).expect("open store");
    ensure_marker(
        &mut store,
        &key,
        ContentKind::Scene,
        Regime::LocalOnly,
        &NoFaults,
        2,
    )
    .expect("scene marker");
    drop(store);
    f.actor = f.supervisor.open(&f.db, 1).expect("reopen").actor;
    let bytes = b"asset bytes".to_vec();
    let path = scene_asset_ref(WS, "main", &drawing, &hex_sha256(&bytes), "image/png")
        .expect("asset path");
    let folder = if in_owner {
        let owner = path.rsplit_once('/').expect("owner folder").0.to_owned();
        let rule = format!("{owner}/access.yaml");
        f.put(&rule, NOBODY);
        f.settle();
        f.capture_ok(&[&rule]);
        owner
    } else {
        "assets".to_owned()
    };
    f.runtime
        .block_on(f.actor.versioned_binary_write(
            WriteBinary {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: "asset-object".to_owned(),
                path,
                bytes,
                moment_id: "m-asset".to_owned(),
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 41,
                request_id: None,
            },
            f.root().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        ))
        .expect("write the asset");
    (f, folder)
}

/// A drawing's assets sit under `assets/excalidraw/`, outside the drawing's
/// folder. Deleting a drawing deletes its assets with it, and rolling that
/// delete back writes them again. Once the workspace replicates, a widened
/// rule over the assets holds each of these writers, and none records
/// anything. A workspace that does not replicate holds none of them.
#[test]
fn a_rule_over_a_drawings_assets_holds_its_delete_and_rollback() {
    type Step = fn(&Fixture) -> Result<(), RuntimeError>;
    let cases: [(&str, Step, Step); 3] = [
        (
            "delete",
            |_| Ok(()),
            |f| f.versioned_delete(delete(DRAWING, "d-drawing")),
        ),
        (
            "capture retire",
            |f| {
                std::fs::remove_file(f.root().join(DRAWING)).expect("remove the drawing");
                Ok(())
            },
            |f| f.retire(DRAWING),
        ),
        (
            "rollback of the delete",
            |f| {
                f.versioned_delete(DeleteTextFile {
                    metadata_correlation_id: None,
                    ..delete(DRAWING, "d-drawing")
                })
            },
            |f| f.rollback_at(DRAWING, "d-drawing"),
        ),
    ];
    // Every case runs, so one failure shows them all.
    let mut wrong = Vec::new();
    for replicates in [true, false] {
        for (name, prepare, writer) in cases {
            let f = drawing_with_ruled_asset(replicates);
            prepare(&f).unwrap_or_else(|error| panic!("{name} setup: {error}"));
            f.put("assets/access.yaml", EDIT);
            f.settle();
            let before = f.moments();
            let result = writer(&f);
            // Held, nothing recorded, the hold; or done, with no hold.
            let state = (held(&result, "assets"), f.moments() == before, f.holds());
            let expected = if replicates {
                (
                    true,
                    true,
                    vec![("assets".to_owned(), "widened".to_owned())],
                )
            } else {
                (false, false, Vec::new())
            };
            if state != expected || (!replicates && result.is_err()) {
                wrong.push(format!(
                    "{name}, replicates: {replicates}: {result:?} {state:?}"
                ));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Deleting a drawing deletes only its own assets, never a rule beside them.
/// Once the workspace replicates, a rule in the asset folder, widened outside
/// dohc, stays held through the delete, and the delete records nothing.
#[test]
fn a_rule_beside_a_drawings_assets_stays_held_through_its_delete() {
    type Step = fn(&Fixture) -> Result<(), RuntimeError>;
    let cases: [(&str, Step, Step); 2] = [
        (
            "delete",
            |_| Ok(()),
            |f| f.versioned_delete(delete(DRAWING, "d-drawing")),
        ),
        (
            "capture retire",
            |f| {
                std::fs::remove_file(f.root().join(DRAWING)).expect("remove the drawing");
                Ok(())
            },
            |f| f.retire(DRAWING),
        ),
    ];
    // Every case runs, so one failure shows them all.
    let mut wrong = Vec::new();
    for (name, prepare, writer) in cases {
        let (f, folder) = drawing_with_asset(true, true);
        prepare(&f).unwrap_or_else(|error| panic!("{name} setup: {error}"));
        let rule = format!("{folder}/access.yaml");
        f.put(&rule, EDIT);
        f.settle();
        let before = f.moments();
        let result = writer(&f);
        // Held, nothing recorded, the hold, the widened rule on disk.
        let state = (
            held(&result, &folder),
            f.moments() == before,
            f.holds(),
            std::fs::read_to_string(f.root().join(&rule)).ok(),
        );
        if state
            != (
                true,
                true,
                vec![(folder.clone(), "widened".to_owned())],
                Some(EDIT.to_owned()),
            )
        {
            wrong.push(format!("{name}: {result:?} {state:?}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

impl Fixture {
    fn pending_jobs(&self) -> Vec<String> {
        rusqlite::Connection::open(&self.db)
            .unwrap()
            .prepare(
                "SELECT job_id FROM materialization_jobs WHERE workspace_id=?1 \
                 AND status='pending' ORDER BY job_id",
            )
            .unwrap()
            .query_map([WS], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn place(
        &self,
        undo: dohc_engine_runtime::HistoryUndoResult,
    ) -> dohc_engine_runtime::HistoryUndoResult {
        self.runtime.block_on(self.actor.history_undo_place(
            WS.to_owned(),
            undo,
            self.root().to_path_buf(),
            Arc::new(()),
            61,
            |_| {},
        ))
    }
}

/// History Undo commits its inverse moments, then places their files in
/// later turns. A store that left the workspace folder between the two
/// places nothing, through the Undo or through a Version fence's replay: the
/// jobs stay pending, and place once the store is back.
#[test]
fn an_undo_placed_after_the_store_moved_places_nothing() {
    let f = Fixture::movable();
    f.versioned_write(write("team/a.md", "alpha", "m-alpha"))
        .expect("write");
    f.versioned_delete(delete("team/a.md", "d-alpha"))
        .expect("delete");
    let undo = f
        .runtime
        .block_on(f.actor.history_undo_in_turns(
            WS.to_owned(),
            OP.to_owned(),
            "undo-then-move".to_owned(),
            None,
            f.root().to_path_buf(),
            Arc::new(NoFaults),
            60,
            [Arc::default(), Arc::default()],
            Arc::new(()),
            None,
            CancellationToken::new(),
        ))
        .expect("undo");
    let pending = f.pending_jobs();
    assert!(!pending.is_empty(), "the Undo left its placement for later");
    assert!(!f.root().join("team/a.md").exists());
    f.move_store_away();
    let placed = f.place(undo.clone());
    let fence = |selected: Option<Vec<String>>| {
        let (root, ws) = (f.root().to_path_buf(), WS.to_owned());
        f.runtime.block_on(async {
            match selected {
                None => {
                    f.actor
                        .materialize_replay_pending_for_fence(root, ws, Arc::new(()), 61)
                        .await
                }
                Some(jobs) => {
                    f.actor
                        .materialize_replay_selected_for_fence(root, ws, Arc::new(()), jobs, 61)
                        .await
                }
            }
        })
    };
    let fenced = [fence(None), fence(Some(pending.clone()))];
    let stray = f.move_store_back();
    // Placed, each fence refused as moved, written where the store was, the
    // file, the jobs still pending.
    let state = (
        placed.materialized,
        fenced.iter().map(moved).collect::<Vec<_>>(),
        stray,
        f.root().join("team/a.md").exists(),
        f.pending_jobs() == pending,
    );
    assert_eq!(
        state,
        (false, vec![true, true], Vec::new(), false, true),
        "{fenced:?}"
    );
    assert!(f.place(undo).materialized, "placed once the store is back");
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/a.md")).unwrap(),
        "alpha"
    );
}

impl Fixture {
    fn open_note(&self, path: &str, now: i64) -> dohc_engine_runtime::YdocOpenState {
        self.runtime
            .block_on(self.actor.ydoc_open_state(
                WS.to_owned(),
                now,
                true,
                None,
                "main".to_owned(),
                path.to_owned(),
                Some(ContentKind::Richdoc),
                CancellationToken::new(),
            ))
            .expect("open the note")
    }

    fn record_note(
        &self,
        state: &dohc_engine_runtime::YdocOpenState,
        path: &str,
        update: Vec<u8>,
        seed: bool,
    ) {
        self.runtime
            .block_on(self.actor.ydoc_record_update(
                state.key.clone(),
                path.to_owned(),
                ContentKind::Richdoc,
                Regime::LocalOnly,
                update,
                None,
                None,
                state.lineage_claim_id.clone(),
                seed,
                if seed {
                    state.owner_seed_source.clone()
                } else {
                    None
                },
                None,
                20,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            ))
            .expect("record an update");
    }
}

/// A live document's settlement writes its Markdown through dohc. Once the
/// workspace replicates, a folder held for its owner holds the settlement
/// too, and it records nothing. A workspace that does not replicate settles.
#[test]
fn a_live_document_under_a_held_folder_settles_nothing() {
    for replicates in [true, false] {
        live_document_under_a_held_folder(replicates);
    }
}

fn live_document_under_a_held_folder(replicates: bool) {
    const NOTE: &str = "team/note.md";
    let f = Fixture::local();
    if replicates {
        f.replicate();
    }
    f.put("team/access.yaml", NOBODY);
    f.put(NOTE, "seed\n");
    f.settle();
    f.capture_ok(&["team/access.yaml", NOTE]);
    let state = f.open_note(NOTE, 50);
    let doc = Ydoc::wire();
    let seed = doc
        .rewrite_content_to_markdown(ContentKind::Richdoc, "seed")
        .expect("seed");
    f.record_note(&state, NOTE, seed, true);
    let state = f.open_note(NOTE, 51);
    f.record_note(&state, NOTE, doc.richdoc_append_paragraph("edited"), false);
    f.put("team/access.yaml", EDIT);
    f.settle();
    let before = f.moments();
    let settled = f
        .runtime
        .block_on(f.actor.ydoc_settle(
            f.root().to_path_buf(),
            state.key.clone(),
            NOTE.to_owned(),
            ContentKind::Richdoc,
            state.lineage_claim_id.clone(),
            state.head_blob_sha256.clone(),
            "held-session".to_owned(),
            Arc::new(()),
            52,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        ))
        .map(drop);
    // Held, nothing recorded, the file on disk, the hold; or settled, with
    // no hold.
    let state = (
        held(&settled, "team"),
        f.moments() == before,
        std::fs::read_to_string(f.root().join(NOTE)).unwrap(),
        f.holds(),
    );
    let expected = if replicates {
        (
            true,
            true,
            "seed\n".to_owned(),
            vec![("team".to_owned(), "widened".to_owned())],
        )
    } else {
        (false, false, "seed\n\nedited\n".to_owned(), Vec::new())
    };
    assert_eq!(state, expected, "replicates: {replicates}: {settled:?}");
}

impl Fixture {
    /// Open the captured `path`, which holds "seed", as a live document, with
    /// an edit that is not settled yet when `edit` is set.
    fn live_note(&self, path: &str, edit: bool) -> dohc_engine_runtime::YdocOpenState {
        let state = self.open_note(path, 50);
        let doc = Ydoc::wire();
        let seed = doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, "seed")
            .expect("seed");
        self.record_note(&state, path, seed, true);
        let state = self.open_note(path, 51);
        if edit {
            self.record_note(&state, path, doc.richdoc_append_paragraph("edited"), false);
        }
        state
    }

    /// How many updates the live document at `key` has recorded.
    fn updates(&self, key: &DocKey) -> i64 {
        rusqlite::Connection::open(&self.db)
            .unwrap()
            .query_row(
                "SELECT head_update_seq FROM ydoc_docs WHERE workspace_id=?1 \
                 AND version_id=?2 AND object_id=?3",
                [&key.workspace_id, &key.version_id, &key.object_id],
                |row| row.get(0),
            )
            .expect("the live document")
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.root().join(path)).unwrap()
    }
}

/// Reconciling a Collection writes an id into a record file that has none,
/// first in its live document, then on disk. Once the workspace replicates,
/// a folder held for its owner holds the record, and once the store left the
/// workspace folder nothing is reconciled. Either way the document and its
/// file stay as they were.
#[test]
fn a_collection_record_is_not_adopted_under_a_held_folder_or_a_moved_store() {
    const NOTE: &str = "team/a.md";
    let mut wrong = Vec::new();
    for moved_store in [false, true] {
        let f = if moved_store {
            Fixture::movable()
        } else {
            let f = Fixture::new();
            f.put("team/access.yaml", NOBODY);
            f
        };
        f.put(
            "team/collection.yaml",
            "fields:\n  status:\n    type: text\n",
        );
        f.put(NOTE, "seed\n");
        f.settle();
        let mut paths = vec!["team/collection.yaml", NOTE];
        if !moved_store {
            paths.insert(0, "team/access.yaml");
        }
        f.capture_ok(&paths);
        let state = f.live_note(NOTE, false);
        let (before, updates) = (f.moments(), f.updates(&state.key));
        if moved_store {
            f.move_store_away();
        } else {
            f.put("team/access.yaml", EDIT);
            f.settle();
        }
        let result = f
            .runtime
            .block_on(f.actor.reconcile_collections_guarded(
                WS.to_owned(),
                "main".to_owned(),
                f.root().to_path_buf(),
                dohc_engine_collab::LeaseRegistry::new(),
                Arc::new(()),
                60,
                Arc::new(NoFaults),
                CancellationToken::new(),
                Arc::new(ExistingRootGuard),
            ))
            .map(drop);
        let stray = if moved_store {
            f.move_store_back()
        } else {
            Vec::new()
        };
        // Refused as moved, written where the store was, moments unchanged,
        // updates unchanged, the file, the holds.
        let state = (
            moved(&result),
            stray,
            f.moments() == before,
            f.updates(&state.key) == updates,
            f.read(NOTE),
            f.holds(),
        );
        let expected = if moved_store {
            (
                true,
                Vec::new(),
                true,
                true,
                "seed\n".to_owned(),
                Vec::new(),
            )
        } else {
            (
                false,
                Vec::new(),
                true,
                true,
                "seed\n".to_owned(),
                vec![("team".to_owned(), "widened".to_owned())],
            )
        };
        if state != expected || (!moved_store && result.is_err()) {
            wrong.push(format!("moved {moved_store}: {result:?} {state:?}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

impl Fixture {
    /// Record that the live document at `path` owes its save, as a held or
    /// interrupted settlement leaves it, and return the obligation.
    fn owe_save(
        &mut self,
        state: &dohc_engine_runtime::YdocOpenState,
        path: &str,
    ) -> dohc_engine_collab::markdown_write_obligations::Obligation {
        use dohc_engine_collab::markdown_write_obligations as obligations;
        self.supervisor.close(&self.db).expect("close");
        let conn = rusqlite::Connection::open(&self.db).unwrap();
        obligations::record_in(
            &conn,
            &obligations::Obligation {
                order: 0,
                key: state.key.clone(),
                lineage_claim_id: state.lineage_claim_id.clone().unwrap_or_default(),
                operation_id: "owed-session".to_owned(),
                kind: obligations::Kind::Session,
                path: path.to_owned(),
                retry_inputs: serde_json::json!({
                    "expectedHeadSha256": state.head_blob_sha256,
                    "restoreGeneration": null,
                    "useReader": false,
                }),
                held_checkpoint_sha256: None,
                held_head_sha256: state.head_blob_sha256.clone(),
                source_sha256: None,
                settled_head_sha256: None,
            },
            52,
        )
        .expect("owe the save");
        let owed = obligations::pending_in(&conn, WS)
            .expect("owed saves")
            .pop()
            .expect("the owed save");
        drop(conn);
        self.actor = self.supervisor.open(&self.db, 1).expect("reopen").actor;
        owed
    }
}

/// Markdown recovery retries a save a live document owes. Once the store left
/// the workspace folder, it writes nothing and the save stays owed.
#[test]
fn an_owed_save_recovered_after_the_store_moved_writes_nothing() {
    const NOTE: &str = "team/note.md";
    let mut f = Fixture::movable();
    f.put(NOTE, "seed\n");
    f.settle();
    f.capture_ok(&[NOTE]);
    let state = f.live_note(NOTE, true);
    let owed = f.owe_save(&state, NOTE);
    let before = f.moments();
    f.move_store_away();
    let recovered = f.runtime.block_on(f.actor.recover_markdown_write(
        owed,
        f.root().to_path_buf(),
        Arc::new(ExistingRootGuard),
        dohc_engine_collab::LeaseRegistry::new(),
        Arc::new(()),
        53,
        CancellationToken::new(),
    ));
    let stray = f.move_store_back();
    // Refused as moved, written where the store was, moments unchanged, the
    // file, the save still owed.
    let owes = dohc_engine_collab::markdown_write_obligations::pending_in(
        &rusqlite::Connection::open(&f.db).unwrap(),
        WS,
    )
    .expect("owed saves")
    .len();
    let state = (
        moved(&recovered),
        stray,
        f.moments() == before,
        f.read(NOTE),
        owes,
    );
    assert_eq!(
        state,
        (true, Vec::new(), true, "seed\n".to_owned(), 1),
        "{recovered:?}"
    );
}

const OP: &str = "dohc-operation:remove-team";
const COPY: &str = "dohc-operation:copy-rule";

/// Undoing a Duplicate that made a folder's rule removes the rule the way a
/// rule missing from disk goes: only from a folder left with no file it
/// covered. Otherwise Undo skips it and journals nothing; no one changed the
/// rule outside dohc, so nothing waits for the owner.
#[test]
fn undoing_a_copied_rule_removes_it_only_from_a_folder_it_leaves_empty() {
    for other_file in [false, true] {
        let f = ruled_team();
        f.runtime
            .block_on(f.actor.duplicate_file(
                DuplicateFile {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    from_path: "team/access.yaml".to_owned(),
                    to_path: "crew/access.yaml".to_owned(),
                    operation_id: COPY.to_owned(),
                    author_json: None,
                    now_ms: 30,
                },
                f.root().to_path_buf(),
                Arc::new(NoFaults),
            ))
            .expect("duplicate the rule");
        if other_file {
            f.versioned_write(write("crew/b.md", "beta", "m-beta"))
                .expect("write under the copied rule");
        }
        f.settle();
        let mut expected = f.journal();
        f.undo(COPY, "undo-copy").expect("undo");
        if !other_file {
            expected.push("delete crew/access.yaml".to_owned());
        }
        assert_eq!(f.journal(), expected, "other file: {other_file}");
        let kept: bool = rusqlite::Connection::open(&f.db)
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM path_aliases WHERE workspace_id=?1                  AND path='crew/access.yaml')",
                [WS],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, other_file, "other file: {other_file}");
        assert!(f.holds().is_empty());
    }
}

/// A folder moved on disk with its rule reaches the engine as capture's
/// plan orders it: the rule's create at the destination, the files' writes
/// there, their deletes at the source, and the source rule's delete last.
#[test]
fn a_moved_ruled_folder_journals_its_rule_create_first_and_delete_last() {
    let f = ruled_team();
    let mut expected = f.journal();
    std::fs::rename(f.root().join("team"), f.root().join("crew")).unwrap();
    f.settle();
    f.capture_ok(&["crew/access.yaml", "crew/a.md"]);
    f.retire("team/a.md").expect("retire the moved file");
    f.retire("team/access.yaml").expect("retire the moved rule");
    expected.extend(lines(&[
        "write crew/access.yaml",
        "write crew/a.md",
        "delete team/a.md",
        "delete team/access.yaml",
    ]));
    assert_eq!(f.journal(), expected);
    assert!(f.holds().is_empty());
}

fn delete(path: &str, moment: &str) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        path: path.to_owned(),
        moment_id: moment.to_owned(),
        request_id: None,
        metadata_origin: "cli".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: Some(OP.to_owned()),
        author_json: None,
        now_ms: 50,
    }
}

#[test]
fn restoring_a_deleted_ruled_folder_journals_its_rule_first() {
    let f = Fixture::local();
    for (path, text, moment) in [
        ("team/access.yaml", VIEW, "m-rule"),
        ("team/a.md", "alpha", "m-a"),
    ] {
        f.runtime
            .block_on(f.actor.versioned_text_write_indexed(
                write(path, text, moment),
                f.root().to_path_buf(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .expect("write");
    }
    // Recorded before the workspace replicated, so nothing put the rule's
    // delete last; Undo replays the operation backwards.
    for (path, moment) in [("team/access.yaml", "d-rule"), ("team/a.md", "d-a")] {
        f.runtime
            .block_on(f.actor.versioned_text_delete(
                delete(path, moment),
                f.root().to_path_buf(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .expect("delete");
    }
    f.replicate();
    f.runtime
        .block_on(f.actor.history_undo_in_turns(
            WS.to_owned(),
            OP.to_owned(),
            "undo-remove-team".to_owned(),
            None,
            f.root().to_path_buf(),
            Arc::new(NoFaults),
            60,
            [Arc::default(), Arc::default()],
            Arc::new(()),
            None,
            CancellationToken::new(),
        ))
        .expect("undo");
    let journal = f.journal();
    assert_eq!(
        journal
            .iter()
            .map(|line| line.split_once(' ').unwrap().1)
            .collect::<Vec<_>>(),
        ["team/access.yaml", "team/a.md"],
        "{journal:?}"
    );
}

fn write(path: &str, text: &str, moment: &str) -> WriteText {
    WriteText {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        object_id: format!("object-{moment}"),
        path: path.to_owned(),
        text: text.to_owned(),
        moment_id: moment.to_owned(),
        metadata_origin: "cli".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 40,
        request_id: None,
    }
}

/// Every kind of writer reaches the step: a writer that changes a file under
/// a folder whose new rule sits on disk uncommitted commits the rule first,
/// then its own change, on its first attempt.
#[test]
fn every_writer_puts_a_pending_rule_before_its_file() {
    type Writer = fn(&Fixture) -> Result<(), RuntimeError>;
    let writers: [(&str, Writer); 7] = [
        ("capture text", |f| {
            f.put("team/a.md", "alpha 2");
            f.capture(&["team/a.md"]).remove(0)
        }),
        ("capture binary", |f| {
            f.actor
                .capture_ingest_binary_blocking(
                    Arc::new(CaptureIngestBinary {
                        workspace_id: WS.to_owned(),
                        version_id: "main".to_owned(),
                        path: "team/a.md".to_owned(),
                        bytes: vec![0, 159, 146, 150],
                        metadata_origin: "capture".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 10,
                        request_id: None,
                        claim_foreign_head: true,
                    }),
                    dohc_engine_collab::LeaseRegistry::new(),
                    Arc::new(NoFaults),
                )
                .map(drop)
        }),
        ("versioned binary write", |f| {
            f.runtime
                .block_on(f.actor.versioned_binary_write(
                    WriteBinary {
                        workspace_id: WS.to_owned(),
                        version_id: "main".to_owned(),
                        object_id: "object-binary".to_owned(),
                        path: "team/a.md".to_owned(),
                        bytes: vec![0, 159, 146, 150],
                        moment_id: "m-binary".to_owned(),
                        metadata_origin: "cli".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 40,
                        request_id: None,
                    },
                    f.root().to_path_buf(),
                    Arc::new(()),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                ))
                .map(drop)
        }),
        ("capture retire", |f| {
            // Removing the file restarts the folder's settle period.
            let _ = std::fs::remove_file(f.root().join("team/a.md"));
            f.settle();
            f.retire("team/a.md")
        }),
        ("versioned write", |f| {
            f.runtime
                .block_on(f.actor.versioned_text_write_indexed(
                    write("team/a.md", "written", "m-write"),
                    f.root().to_path_buf(),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                ))
                .map(drop)
        }),
        ("versioned delete", |f| {
            f.runtime
                .block_on(f.actor.versioned_text_delete(
                    DeleteTextFile {
                        workspace_id: WS.to_owned(),
                        version_id: "main".to_owned(),
                        path: "team/a.md".to_owned(),
                        moment_id: "m-delete".to_owned(),
                        request_id: None,
                        metadata_origin: "cli".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 40,
                    },
                    f.root().to_path_buf(),
                    Arc::new(()),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                ))
                .map(drop)
        }),
        ("versioned rename", |f| {
            f.runtime
                .block_on(f.actor.versioned_text_rename(
                    RenameTextFile {
                        workspace_id: WS.to_owned(),
                        version_id: "main".to_owned(),
                        from_path: "team/a.md".to_owned(),
                        to_path: "team/b.md".to_owned(),
                        moment_id: "m-rename".to_owned(),
                        request_id: None,
                        metadata_origin: "cli".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 40,
                    },
                    f.root().to_path_buf(),
                    Arc::new(()),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                ))
                .map(drop)
        }),
    ];
    for (name, writer) in writers {
        let f = Fixture::new();
        f.put("team/a.md", "alpha");
        f.settle();
        f.capture_ok(&["team/a.md"]);
        let before = f.journal();
        f.put("team/access.yaml", VIEW);
        f.settle();
        writer(&f).unwrap_or_else(|error| panic!("{name}: {error}"));
        let journal = f.journal();
        assert_eq!(journal[..before.len()], before[..], "{name}");
        assert_eq!(
            journal.get(before.len()).map(String::as_str),
            Some("write team/access.yaml"),
            "{name}: {journal:?}"
        );
        assert!(journal.len() > before.len() + 1, "{name}: {journal:?}");
    }
}

/// A store opened for a workspace must sit in that workspace's
/// `.dohc/engine` folder: anywhere else it would have no rules to order, so
/// it does not open.
#[test]
fn a_workspace_store_outside_its_workspace_folder_does_not_open() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.path().join("stores").join("engine.db");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    for passive in [false, true] {
        let opened = if passive {
            supervisor.open_passive_root_bound(&db, 1, "root-token", None)
        } else {
            supervisor.open_root_bound(&db, 1, "root-token", None)
        };
        assert!(
            matches!(
                &opened,
                Err(RuntimeError::Storage(dohc_engine_storage::StorageError::InvalidInput { reason }))
                    if reason.contains("outside its workspace folder")
            ),
            "passive {passive}: {:?}",
            opened.map(|_| ())
        );
    }
}

/// A store bound to no workspace, kept outside any `.dohc/engine` folder,
/// opens and writes with no rules to order.
#[test]
fn a_store_outside_any_workspace_writes_without_ordering() {
    let f = Fixture::standalone();
    // Neither rule waits to settle, and the widening holds nothing.
    f.put("team/access.yaml", VIEW);
    f.put("team/a.md", "alpha");
    f.capture_ok(&["team/access.yaml", "team/a.md"]);
    f.put("team/access.yaml", EDIT);
    f.put("team/a.md", "alpha 2");
    f.capture_ok(&["team/access.yaml", "team/a.md"]);
    assert!(f.holds().is_empty());
    assert_eq!(
        f.journal(),
        lines(&[
            "write team/access.yaml",
            "write team/a.md",
            "write team/access.yaml",
            "write team/a.md"
        ])
    );
}

/// When the workspace folder moves while its store stays open, the folder
/// the store was opened in no longer holds it. Its rules are not the
/// workspace's, so every write is refused until the folder is back.
#[cfg(unix)]
#[test]
fn a_write_after_the_workspace_folder_moved_is_refused() {
    let f = ruled_team();
    let before = f.journal();
    let moved = f.root().with_extension("moved");
    std::fs::rename(f.root(), &moved).expect("move the workspace folder");
    std::fs::create_dir_all(moved.join("private")).unwrap();
    std::fs::write(moved.join("private/access.yaml"), NOBODY).unwrap();
    let write_new = |f: &Fixture, moment: &str| {
        f.runtime
            .block_on(f.actor.versioned_text_write_indexed(
                write("private/new.md", "secret", moment),
                f.root().to_path_buf(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            ))
            .map(drop)
    };
    let refused = write_new(&f, "m-moved");
    std::fs::rename(&moved, f.root()).expect("move the workspace folder back");
    assert!(
        matches!(
            &refused,
            Err(RuntimeError::Sync(SyncError::InvalidInput { reason }))
                if *reason == dohc_engine_runtime::WORKSPACE_FOLDER_MOVED
        ),
        "{refused:?}"
    );
    assert_eq!(f.journal(), before);
    // Back in place, the rule beside the file journals first.
    f.settle();
    write_new(&f, "m-back").expect("write once the folder is back");
    assert_eq!(
        f.journal()[before.len()..],
        lines(&["write private/access.yaml", "write private/new.md"])
    );
}

/// History Undo reads its plan through the store's held folder, which only
/// Unix keeps after `.dohc/engine` moves. Once the store left the workspace
/// folder, Undo is refused before any of its turns writes: it restores no
/// file and records no plan.
#[cfg(unix)]
#[test]
fn an_undo_after_the_store_moved_records_nothing() {
    let f = Fixture::new();
    f.versioned_write(write("team/a.md", "alpha", "m-alpha"))
        .expect("write");
    f.versioned_delete(delete("team/a.md", "d-alpha"))
        .expect("delete");
    let before = f.moments();
    f.move_store_away();
    let refused = f.undo(OP, "undo-moved");
    let stray = f.move_store_back();
    assert!(moved(&refused), "{refused:?}");
    assert_eq!(stray, Vec::<String>::new(), "written where the store was");
    assert!(!f.root().join("team/a.md").exists());
    assert_eq!(f.moments(), before);
    let plans: i64 = rusqlite::Connection::open(&f.db)
        .unwrap()
        .query_row("SELECT count(*) FROM history_undo_plans", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(plans, 0, "a pending Undo plan was recorded");
}
