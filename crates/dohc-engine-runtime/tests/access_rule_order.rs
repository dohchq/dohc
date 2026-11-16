//! A folder's access.yaml reaches the journal before the files it covers, and
//! a rule changed outside dohc in a way that widens reach waits for its owner.
use dohc_engine_domain::{CreateNamedVersion, DomainError, DuplicateFile, VersionedTextStore};
use dohc_engine_runtime::{
    ACCESS_RULE_WAITS, AccessRuleDecision, ActorHandle, CancellationToken, CaptureIngest,
    CaptureIngestBinary, CaptureRetire, DeleteTextFile, MergeTextFileFromVersion, NoFaults,
    RenameTextFile, RollbackTextFileMutation, RuntimeError, WorkspaceSupervisor, WriteBinary,
    WriteText,
};
use dohc_engine_storage::EngineStore;
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

    fn undo_rule(
        &self,
        folder: &str,
        undo: dohc_engine_runtime::AccessRuleUndo,
    ) -> Result<(), RuntimeError> {
        self.undo_rule_with(folder, undo, Arc::new(NoFaults))
    }

    fn undo_rule_with(
        &self,
        folder: &str,
        undo: dohc_engine_runtime::AccessRuleUndo,
        faults: Arc<dyn dohc_engine_storage::FaultInjector>,
    ) -> Result<(), RuntimeError> {
        self.runtime.block_on(self.actor.undo_access_rule(
            WS.to_owned(),
            "main".to_owned(),
            folder.to_owned(),
            undo,
            self.root().to_path_buf(),
            Arc::new(()),
            40,
            faults,
        ))
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
/// is refused, and stays on disk.
#[test]
fn a_decision_on_a_removal_that_became_two_spellings_is_refused() {
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
    for decision in [AccessRuleDecision::Accept, AccessRuleDecision::Restore] {
        let decided = f.decide_on("team", decision, None, "removed");
        assert!(
            matches!(&decided, Err(RuntimeError::AccessRuleChanged { folder }) if folder == "team"),
            "{decided:?}"
        );
        assert!(f.root().join("team/access.yaml").exists());
        assert!(f.root().join(other).exists());
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
    assert_eq!(f.hold_views()[0].unreadable, Some("on-disk"));
    assert!(f.hold_views()[0].changes.is_empty());
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

/// Each decision on a one-file rule says the ordinary change that reverses
/// it: the rule it replaced, over the bytes it left.
#[test]
fn a_decision_names_the_change_that_reverses_it() {
    let sha = |text: &str| Some(dohc_engine_storage::hex_sha256(text.as_bytes()));
    let undo = |path: &str, text: Option<&str>, expected: Option<String>| {
        Some(dohc_engine_runtime::AccessRuleUndo {
            path: path.to_owned(),
            text: text.map(str::to_owned),
            expected_sha256: expected,
        })
    };
    for (decision, expected) in [
        (
            AccessRuleDecision::Accept,
            undo("team/access.yaml", Some(VIEW), sha(EDIT)),
        ),
        (
            AccessRuleDecision::Restore,
            undo("team/access.yaml", Some(EDIT), sha(VIEW)),
        ),
    ] {
        let f = ruled_team();
        f.put("team/access.yaml", EDIT);
        f.settle();
        assert!(held(&f.capture(&["team/a.md"])[0], "team"));
        let decided = f
            .decided_on("team", decision, sha(EDIT), "widened")
            .expect("decide");
        assert_eq!(decided.undo, expected, "{decision:?} on a widening");
    }
    for (decision, expected) in [
        (
            AccessRuleDecision::Accept,
            undo("team/access.yaml", Some(VIEW), None),
        ),
        (
            AccessRuleDecision::Restore,
            undo("team/access.yaml", None, sha(VIEW)),
        ),
    ] {
        let f = ruled_team();
        std::fs::remove_file(f.root().join("team/access.yaml")).unwrap();
        f.settle();
        assert!(held(&f.capture(&["team/a.md"])[0], "team"));
        let decided = f
            .decided_on("team", decision, None, "removed")
            .expect("decide");
        assert_eq!(decided.undo, expected, "{decision:?} on a removal");
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

/// Undo of Allow puts the recorded rule back through the engine, as a change
/// the owner made through dohc.
#[test]
fn undoing_an_accepted_rule_puts_the_recorded_rule_back() {
    let f = ruled_team();
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    let decided = f
        .decided_on(
            "team",
            AccessRuleDecision::Accept,
            Some(dohc_engine_storage::hex_sha256(EDIT.as_bytes())),
            "widened",
        )
        .expect("accept");
    let undo = decided.undo.expect("an undo");
    // Another Version's rules are on disk while it is active.
    f.activate_feature(true);
    let refused = f.undo_rule("team", undo.clone());
    assert!(
        matches!(&refused, Err(RuntimeError::AccessRuleChanged { .. })),
        "{refused:?}"
    );
    f.activate_feature(false);
    let before = f.journal();
    f.undo_rule("team", undo).expect("undo");
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/access.yaml")).unwrap(),
        VIEW
    );
    assert_eq!(
        f.journal()[before.len()..],
        lines(&["write team/access.yaml"])
    );
    f.settle();
    f.capture_ok(&["team/a.md"]);
    assert!(f.holds().is_empty());
}

/// Undo of Restore puts back the rule from outside dohc that Restore
/// removed. It commits as written, so it widens without a hold.
#[test]
fn undoing_a_restore_puts_the_outside_rule_back() {
    let f = ruled_team();
    f.put("team/sub/access.yaml", EDIT);
    f.put("team/sub/b.md", "beta");
    f.settle();
    assert!(held(&f.capture(&["team/sub/b.md"])[0], "team/sub"));
    let decided = f
        .decided_on(
            "team/sub",
            AccessRuleDecision::Restore,
            Some(dohc_engine_storage::hex_sha256(EDIT.as_bytes())),
            "widened",
        )
        .expect("restore");
    let before = f.journal();
    f.undo_rule("team/sub", decided.undo.expect("an undo"))
        .expect("undo");
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/sub/access.yaml")).unwrap(),
        EDIT
    );
    assert_eq!(
        f.journal()[before.len()..],
        lines(&["write team/sub/access.yaml"])
    );
    f.settle();
    f.capture_ok(&["team/sub/b.md"]);
    assert!(f.holds().is_empty());
}

/// Undo refuses once the rule changed since the decision, and the rule on
/// disk stays as it is.
#[test]
fn undo_after_the_rule_changed_again_is_refused() {
    let f = ruled_team();
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    let decided = f
        .decided_on(
            "team",
            AccessRuleDecision::Accept,
            Some(dohc_engine_storage::hex_sha256(EDIT.as_bytes())),
            "widened",
        )
        .expect("accept");
    f.put("team/access.yaml", NOBODY);
    let before = f.journal();
    let refused = f.undo_rule("team", decided.undo.expect("an undo"));
    assert!(
        matches!(&refused, Err(RuntimeError::AccessRuleChanged { folder }) if folder == "team"),
        "{refused:?}"
    );
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/access.yaml")).unwrap(),
        NOBODY
    );
    assert_eq!(f.journal(), before);
}

/// Undo commits the rule it placed. An outside save that lands before that
/// commit is capture's to judge, so a widening holds.
#[test]
fn an_outside_save_during_an_undo_is_judged_after_it() {
    struct SaveAfterPlacement(PathBuf);
    impl dohc_engine_storage::FaultInjector for SaveAfterPlacement {
        fn poll(&self, point: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
            if point == dohc_engine_storage::FaultPoint::MaterializeAfterRenameBeforeComplete {
                std::fs::write(&self.0, EDIT).unwrap();
            }
            dohc_engine_storage::FaultAction::Continue
        }
    }
    let f = ruled_team();
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    let decided = f
        .decided_on(
            "team",
            AccessRuleDecision::Accept,
            Some(dohc_engine_storage::hex_sha256(EDIT.as_bytes())),
            "widened",
        )
        .expect("accept");
    let before = f.journal();
    f.undo_rule_with(
        "team",
        decided.undo.expect("an undo"),
        Arc::new(SaveAfterPlacement(f.root().join("team/access.yaml"))),
    )
    .expect("undo");
    assert_eq!(
        f.journal()[before.len()..],
        lines(&["write team/access.yaml"])
    );
    f.settle();
    assert!(held(&f.capture(&["team/a.md"])[0], "team"));
    assert_eq!(f.holds(), vec![("team".to_owned(), "widened".to_owned())]);
}

/// An Undo whose placement fails leaves nothing to replay, so the bytes it
/// meant to place are judged as a change from outside dohc.
#[test]
fn a_failed_undo_leaves_no_placement_to_replay() {
    struct CrashPlacement;
    impl dohc_engine_storage::FaultInjector for CrashPlacement {
        fn poll(&self, point: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
            if point == dohc_engine_storage::FaultPoint::MaterializeAfterTempWrite {
                dohc_engine_storage::FaultAction::Crash
            } else {
                dohc_engine_storage::FaultAction::Continue
            }
        }
    }
    let mut f = ruled_team();
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
    let failed = f.undo_rule_with(
        "team",
        decided.undo.expect("an undo"),
        Arc::new(CrashPlacement),
    );
    assert!(waits(&failed), "{failed:?}");
    f.restart();
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/access.yaml")).unwrap(),
        VIEW
    );
    // The owner puts the outside rule back by hand.
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/access.yaml"])[0], "team"));
}

/// A crash between an Undo's placement and its commit leaves the placement
/// pending, with bytes nothing committed. Opening the workspace cancels it
/// before replay, so neither replay nor capture takes those bytes for
/// dohc's own.
#[test]
fn an_undo_a_crash_left_pending_is_cancelled_when_the_workspace_opens() {
    struct CrashPlacement;
    impl dohc_engine_storage::FaultInjector for CrashPlacement {
        fn poll(&self, point: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
            if point == dohc_engine_storage::FaultPoint::MaterializeAfterTempWrite {
                dohc_engine_storage::FaultAction::Crash
            } else {
                dohc_engine_storage::FaultAction::Continue
            }
        }
    }
    let undo_jobs = |f: &Fixture, status: Option<&str>| -> Vec<String> {
        let conn = rusqlite::Connection::open(&f.db).unwrap();
        if let Some(status) = status {
            conn.execute(
                "UPDATE materialization_jobs SET status=?1 WHERE job_id LIKE 'access-rule-undo%'",
                [status],
            )
            .unwrap();
        }
        conn.prepare(
            "SELECT status FROM materialization_jobs WHERE job_id LIKE 'access-rule-undo%'",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<String>>>()
        .unwrap()
    };
    let mut f = ruled_team();
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
    let journal = f.journal();
    let failed = f.undo_rule_with(
        "team",
        decided.undo.expect("an undo"),
        Arc::new(CrashPlacement),
    );
    assert!(waits(&failed), "{failed:?}");
    // The process died before Undo could cancel its placement.
    assert_eq!(undo_jobs(&f, Some("pending")), ["pending"]);
    f.restart();
    assert_eq!(undo_jobs(&f, None), ["cancelled"]);
    assert_eq!(
        std::fs::read_to_string(f.root().join("team/access.yaml")).unwrap(),
        VIEW
    );
    assert_eq!(f.journal(), journal);
    // The owner puts the outside rule back by hand, and it holds again.
    f.put("team/access.yaml", EDIT);
    f.settle();
    assert!(held(&f.capture(&["team/access.yaml"])[0], "team"));
    assert_eq!(f.journal(), journal);
}

/// Restoring a folder whose new rule nothing committed removes that rule
/// from disk and keeps it as a kept copy, so the restore can be undone.
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
        self.runtime
            .block_on(self.actor.versioned_text_rollback(
                RollbackTextFileMutation {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    path: "crew/a.md".to_owned(),
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
