//! Typing the engine admitted but never settled must survive the local write
//! that folds another text into its closed lineage. The lineage converges on
//! the written file. The typed text becomes an ordinary sibling file with its
//! own History moment, so the person and their agents can read it back.

use dohc_engine_collab::{CloseOutcome, ContentKind, DocKey, LeaseRegistry, Ydoc};
use dohc_engine_domain::{
    ChangeActorKind, ChangeAttribution, DomainError, RenameTextFile, WriteResult, WriteText,
};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, CaptureIngest, RuntimeError, WorkspaceSupervisor, YdocAppend,
    YdocOpenState,
};
use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, NoFaults, hex_sha256};
use dohc_engine_sync::{SyncError, YdocRecoveryMaterialization};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, capture::ExistingRootGuard, engine_db_path};
use std::{path::PathBuf, sync::Arc};

const WS: &str = "unsettled-local-recovery";
const PATH: &str = "notes/note.md";
const BASE: &str = "Base paragraph.\n";
const HUMAN: &str = "Human continued typing in the open document.\n";
const OUTSIDE: &str = "Written outside dohc.\n";
const FOREIGN: &str = "Another program created this file.\n";
const REPLACED: &str = "Replaced through the API.\n";
const OTHER: &str = "notes/other.md";
const KEPT: &str = "notes/kept.md";
const OTHER_TEXT: &str = "Another file changed while dohc was closed.\n";
const SUMMARY: &str =
    "Recovered unsaved edits from notes/note.md after a later write changed the file.";

/// Fields drop in order: a failed assertion closes the actor, and with it the
/// database, before the scratch tree holding that database is removed.
struct Fixture {
    actor: ActorHandle,
    supervisor: WorkspaceSupervisor,
    db: PathBuf,
    scratch: ScratchDir,
}

impl Fixture {
    fn root(&self) -> &std::path::Path {
        self.scratch.path()
    }

    fn store(&self) -> EngineStore {
        EngineStore::open_read_only(&self.db).expect("read the engine store")
    }

    fn close(self) {
        self.supervisor.close(&self.db).expect("close actor");
    }
}

async fn fixture() -> Fixture {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("engine database path");
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes directory");
    std::fs::write(scratch.path().join(PATH), BASE).expect("base file");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    let fixture = Fixture {
        actor,
        supervisor,
        db,
        scratch,
    };
    capture(&fixture.actor, BASE, 1, false, Arc::new(NoFaults))
        .await
        .expect("capture the base file");
    fixture
}

/// A disk write reaching capture with no live lease on the file. The capture
/// sink claims a head another origin wrote only for a file it watched change;
/// the first sight of a file never claims (`capture_sink.rs`, `IngestReason`).
async fn capture(
    actor: &ActorHandle,
    text: &str,
    now_ms: i64,
    claim_foreign_head: bool,
    faults: Arc<dyn FaultInjector>,
) -> Result<WriteResult, RuntimeError> {
    actor
        .capture_ingest(
            ingest(PATH, text, now_ms, claim_foreign_head),
            LeaseRegistry::new(),
            faults,
            CancellationToken::new(),
        )
        .await
}

fn ingest(path: &str, text: &str, now_ms: i64, claim_foreign_head: bool) -> CaptureIngest {
    CaptureIngest {
        workspace_id: WS.into(),
        version_id: "main".into(),
        path: path.into(),
        text: text.into(),
        metadata_origin: "capture".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head,
    }
}

/// The write job that places `path`, with its status.
fn write_job(store: &EngineStore, path: &str) -> (String, String) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT job_id, status FROM materialization_jobs \
                 WHERE workspace_id=?1 AND target_path=?2 AND operation='write' \
                 ORDER BY target_generation DESC LIMIT 1",
                [WS, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("read the write job")
}

async fn repair(
    actor: &ActorHandle,
    faults: Arc<dyn FaultInjector>,
) -> Result<Vec<YdocRecoveryMaterialization>, RuntimeError> {
    actor
        .repair_conflicted_ydoc_recoveries(WS.into(), faults, CancellationToken::new())
        .await
}

fn paths(recoveries: &[YdocRecoveryMaterialization]) -> Vec<&str> {
    recoveries
        .iter()
        .map(|recovery| recovery.path.as_str())
        .collect()
}

async fn place(fixture: &Fixture, job_id: &str, now_ms: i64) -> Result<(), RuntimeError> {
    fixture
        .actor
        .materialize_replay_selected_for_fence(
            fixture.root().to_path_buf(),
            WS.into(),
            Arc::new(()),
            vec![job_id.to_owned()],
            now_ms,
        )
        .await
}

/// Every `(recovered …)` file beside the document on disk, by name.
fn recovered_files_on_disk(fixture: &Fixture) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(fixture.root().join("notes"))
        .expect("read the notes directory")
        .map(|entry| {
            entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.contains(" (recovered "))
        .collect();
    names.sort();
    names
}

/// A person renames a file through the API.
async fn rename(fixture: &Fixture, from: &str, to: &str, moment_id: &str, now_ms: i64) {
    fixture
        .actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: WS.into(),
                version_id: "main".into(),
                from_path: from.to_owned(),
                to_path: to.to_owned(),
                moment_id: moment_id.to_owned(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
            },
            fixture.root().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("the person renames the file");
}

/// The copy's name with the next collision ordinal.
fn second_name(first_path: &str) -> String {
    let (stem, _) = first_path
        .rsplit_once(").md")
        .expect("the copy ends with the recovery marker");
    format!("{stem} 2).md")
}

/// Another program creates a different file at the copy's chosen name after
/// the recovery commits and before the copy reaches disk. Returns the copy
/// and its pending write.
async fn recover_and_occupy(fixture: &Fixture) -> (Sibling, String) {
    let (opened, doc) = open_and_seed(&fixture.actor, 2).await;
    type_human(&fixture.actor, &opened, &doc, 3).await;
    std::fs::write(fixture.root().join(PATH), OUTSIDE).expect("outside write");
    capture(&fixture.actor, OUTSIDE, 4, true, Arc::new(NoFaults))
        .await
        .expect("capture the outside write");
    let store = fixture.store();
    let copy = assert_recovered_sibling(&store);
    let (job, status) = write_job(&store, &copy.path);
    assert_eq!(status, "pending");
    drop(store);
    std::fs::write(fixture.root().join(&copy.path), FOREIGN).expect("foreign file");
    (copy, job)
}

/// The materializer keeps the other program's file and refuses the copy's
/// write. Nothing moves until capture records the occupant.
async fn refuse_placement(fixture: &Fixture, copy: &Sibling, job: &str) {
    let placed = place(fixture, job, 5).await;
    assert!(
        matches!(
            placed,
            Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 })
        ),
        "the write is refused, not forced: {placed:?}"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root().join(&copy.path)).expect("occupant"),
        FOREIGN,
        "the other program's file stays"
    );
    let store = fixture.store();
    assert_eq!(write_job(&store, &copy.path).1, "conflict");
    drop(store);

    // Until capture records the occupant, the copy's name is still in question.
    let repaired = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("repair before capture");
    assert!(repaired.is_empty(), "nothing moves yet: {repaired:?}");
}

/// The refused copy and its occupant, which capture records as the path's
/// head the way it records a file it watched change. Returns the copy and
/// its refused job.
async fn collide(fixture: &Fixture) -> (Sibling, String) {
    let (copy, job) = recover_and_occupy(fixture).await;
    refuse_placement(fixture, &copy, &job).await;
    fixture
        .actor
        .capture_ingest(
            ingest(&copy.path, FOREIGN, 6, true),
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture the occupant");
    (copy, job)
}

/// The capture sink's first sight of the occupant: a name never in its
/// manifest, so no claim on a head another origin wrote.
async fn first_sight(
    actor: &ActorHandle,
    path: &str,
    now_ms: i64,
) -> Result<WriteResult, RuntimeError> {
    actor
        .capture_ingest(
            ingest(path, FOREIGN, now_ms, false),
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
}

/// Open the captured file as a live plaintext document and record the seed
/// the way the RPC layer does: from the open's seed content, with no author.
async fn open_and_seed(actor: &ActorHandle, now_ms: i64) -> (YdocOpenState, Ydoc) {
    let opened = actor
        .ydoc_open_state(
            WS.into(),
            now_ms,
            true,
            None,
            "main".into(),
            PATH.into(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open the document");
    let doc = Ydoc::wire();
    doc.apply(&opened.initial_update)
        .expect("load the initial state");
    let seed = opened
        .seed_content
        .as_deref()
        .expect("the open seeds from the captured head");
    let seed_update = doc.plaintext_insert(0, seed);
    actor
        .ydoc_record_update(
            opened.key.clone(),
            PATH.into(),
            ContentKind::Plaintext,
            opened.regime,
            seed_update,
            None,
            None,
            opened.lineage_claim_id.clone(),
            false,
            opened.owner_seed_source.clone(),
            None,
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("record the seed");
    assert_eq!(doc.plaintext_string(), BASE);
    (opened, doc)
}

/// A person appends to the open document. The engine admits the update; no
/// settle follows.
async fn type_human(
    actor: &ActorHandle,
    opened: &YdocOpenState,
    doc: &Ydoc,
    now_ms: i64,
) -> YdocAppend {
    let end = doc.plaintext_string().encode_utf16().count() as u32;
    let update = doc.plaintext_insert(end, HUMAN);
    actor
        .ydoc_record_update(
            opened.key.clone(),
            PATH.into(),
            ContentKind::Plaintext,
            opened.regime,
            update,
            Some("local-person".into()),
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Human,
                on_behalf_of: None,
                depth: 0,
                run: None,
            }),
            opened.lineage_claim_id.clone(),
            false,
            None,
            None,
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("admit the typing")
}

async fn settle(fixture: &Fixture, opened: &YdocOpenState, append: &YdocAppend, now_ms: i64) {
    fixture
        .actor
        .ydoc_settle(
            fixture.root().to_path_buf(),
            opened.key.clone(),
            PATH.into(),
            ContentKind::Plaintext,
            append.lineage_claim_id.clone(),
            opened.head_blob_sha256.clone(),
            "unsettled-local-recovery".into(),
            Arc::new(()),
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,

            None,
        )
        .await
        .expect("settle the typing")
        .settled()
        .expect("the settle lands");
}

#[derive(Debug)]
struct Sibling {
    path: String,
    object_id: String,
    text: String,
    origin: String,
    summary: Option<String>,
    correlation: Option<String>,
    author_json: Option<String>,
    job_pending: bool,
}

/// Every text head in `main` other than the document itself, with the
/// moment that produced it.
fn siblings(store: &EngineStore) -> Vec<Sibling> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT s.path, s.object_id, b.text, m.metadata_origin, m.metadata_summary, \
                        m.metadata_correlation_id, m.author_json, \
                        EXISTS(SELECT 1 FROM materialization_jobs j \
                                WHERE j.target_path=s.path AND j.status='pending') \
                 FROM snapshots s \
                 JOIN blobs b ON b.sha256=s.blob_sha256 \
                 JOIN moments m ON m.workspace_id=s.workspace_id \
                              AND m.moment_id=s.latest_moment_id \
                 WHERE s.workspace_id=?1 AND s.version_id='main' AND s.path<>?2 \
                 ORDER BY s.path",
            )?;
            let rows = statement.query_map([WS, PATH], |row| {
                Ok(Sibling {
                    path: row.get(0)?,
                    object_id: row.get(1)?,
                    text: row.get(2)?,
                    origin: row.get(3)?,
                    summary: row.get(4)?,
                    correlation: row.get(5)?,
                    author_json: row.get(6)?,
                    job_pending: row.get(7)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .expect("read the sibling heads")
}

fn head_text(store: &EngineStore, path: &str) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                 WHERE s.workspace_id=?1 AND s.version_id='main' AND s.path=?2",
                [WS, path],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("read the head")
}

fn last_settled_sha(store: &EngineStore, key: &DocKey) -> Option<String> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_settled_sha FROM ydoc_docs \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                [&key.workspace_id, &key.version_id, &key.object_id],
                |row| row.get::<_, Option<String>>(0),
            )
        })
        .expect("read the settle marker")
}

fn lineage_text(store: &EngineStore, key: &DocKey) -> String {
    dohc_engine_collab::load_persisted(store, key)
        .expect("load the lineage")
        .expect("the lineage is retained")
        .doc
        .plaintext_string()
}

fn assert_recovered_sibling(store: &EngineStore) -> Sibling {
    let mut found = siblings(store);
    assert_eq!(found.len(), 1, "exactly one sibling: {found:?}");
    let sibling = found.remove(0);
    assert!(
        sibling.path.starts_with("notes/note (recovered ") && sibling.path.ends_with(".md"),
        "the copy sits beside the document: {}",
        sibling.path
    );
    assert_eq!(sibling.text, format!("{BASE}{HUMAN}"));
    sibling
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsettled_typing_survives_a_local_write_as_a_recovered_sibling() {
    let fixture = fixture().await;
    let (opened, doc) = open_and_seed(&fixture.actor, 2).await;
    type_human(&fixture.actor, &opened, &doc, 3).await;

    // The editor has let go of the file. The outside write reaches capture.
    std::fs::write(fixture.root().join(PATH), OUTSIDE).expect("outside write");
    capture(&fixture.actor, OUTSIDE, 4, true, Arc::new(NoFaults))
        .await
        .expect("capture the outside write");

    let store = fixture.store();
    let sibling = assert_recovered_sibling(&store);
    assert_eq!(
        sibling.origin, "ydoc",
        "the text came from the live document"
    );
    assert_eq!(sibling.summary.as_deref(), Some(SUMMARY));
    assert!(
        sibling
            .correlation
            .as_deref()
            .is_some_and(|correlation| correlation.starts_with("ydoc-local-recovery:v1:")),
        "local cause: {:?}",
        sibling.correlation
    );
    assert!(
        sibling
            .author_json
            .as_deref()
            .is_some_and(|authors| authors.contains("local-person")),
        "the person who typed keeps credit: {:?}",
        sibling.author_json
    );
    assert!(sibling.job_pending, "the copy waits for materialization");
    assert_eq!(
        head_text(&store, PATH),
        OUTSIDE,
        "the outside edit stays the file"
    );
    assert_eq!(
        last_settled_sha(&store, &opened.key).as_deref(),
        Some(hex_sha256(OUTSIDE.as_bytes()).as_str()),
        "the lineage converges on the written file"
    );
    drop(store);

    // The same write arriving again finds the folded lineage and adds nothing.
    capture(&fixture.actor, OUTSIDE, 5, true, Arc::new(NoFaults))
        .await
        .expect("capture the same write again");
    assert_eq!(siblings(&fixture.store()).len(), 1);

    // The converged lineage still prunes on close, and the copy outlives it.
    let closed = fixture
        .actor
        .ydoc_close_session(
            opened.key.clone(),
            6,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("close the session");
    assert!(
        matches!(closed.outcome, Some(CloseOutcome::Pruned { .. })),
        "a covered local lineage prunes: {:?}",
        closed.outcome
    );
    assert_recovered_sibling(&fixture.store());
    fixture.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_untouched_seed_creates_no_copy() {
    let fixture = fixture().await;
    let (opened, _doc) = open_and_seed(&fixture.actor, 2).await;
    std::fs::write(fixture.root().join(PATH), OUTSIDE).expect("outside write");
    capture(&fixture.actor, OUTSIDE, 3, true, Arc::new(NoFaults))
        .await
        .expect("capture the outside write");

    let store = fixture.store();
    assert!(
        siblings(&store).is_empty(),
        "the file already held the seed"
    );
    assert_eq!(head_text(&store, PATH), OUTSIDE);
    assert_eq!(
        last_settled_sha(&store, &opened.key).as_deref(),
        Some(hex_sha256(OUTSIDE.as_bytes()).as_str())
    );
    drop(store);
    fixture.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_settled_document_creates_no_copy() {
    let fixture = fixture().await;
    let (opened, doc) = open_and_seed(&fixture.actor, 2).await;
    let append = type_human(&fixture.actor, &opened, &doc, 3).await;
    settle(&fixture, &opened, &append, 4).await;
    assert_eq!(
        std::fs::read_to_string(fixture.root().join(PATH)).expect("settled file"),
        format!("{BASE}{HUMAN}")
    );

    std::fs::write(fixture.root().join(PATH), OUTSIDE).expect("outside write");
    capture(&fixture.actor, OUTSIDE, 5, true, Arc::new(NoFaults))
        .await
        .expect("capture the outside write");

    let store = fixture.store();
    assert!(
        siblings(&store).is_empty(),
        "History already holds the settled text"
    );
    assert_eq!(head_text(&store, PATH), OUTSIDE);
    drop(store);
    fixture.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_equal_to_the_unsettled_text_creates_no_copy() {
    let fixture = fixture().await;
    let (opened, doc) = open_and_seed(&fixture.actor, 2).await;
    type_human(&fixture.actor, &opened, &doc, 3).await;
    let same = format!("{BASE}{HUMAN}");
    std::fs::write(fixture.root().join(PATH), &same).expect("identical write");
    capture(&fixture.actor, &same, 4, true, Arc::new(NoFaults))
        .await
        .expect("capture the identical write");

    let store = fixture.store();
    assert!(
        siblings(&store).is_empty(),
        "nothing differs, nothing to keep"
    );
    assert_eq!(
        last_settled_sha(&store, &opened.key).as_deref(),
        Some(hex_sha256(same.as_bytes()).as_str()),
        "the lineage settles to the text it already held"
    );
    drop(store);
    fixture.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_before_commit_keeps_the_typing_and_the_retry_recovers_once() {
    let fixture = fixture().await;
    let (opened, doc) = open_and_seed(&fixture.actor, 2).await;
    type_human(&fixture.actor, &opened, &doc, 3).await;
    std::fs::write(fixture.root().join(PATH), OUTSIDE).expect("outside write");

    let crashed = capture(
        &fixture.actor,
        OUTSIDE,
        4,
        true,
        ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist),
    )
    .await;
    assert!(
        matches!(crashed, Err(RuntimeError::OperationCrashed)),
        "the capture transaction rolls back: {crashed:?}"
    );
    let store = fixture.store();
    assert!(siblings(&store).is_empty(), "no half-written copy");
    assert_eq!(head_text(&store, PATH), BASE, "no half-captured file");
    assert_eq!(
        lineage_text(&store, &opened.key),
        format!("{BASE}{HUMAN}"),
        "the typing is still in the lineage"
    );
    assert_eq!(last_settled_sha(&store, &opened.key), None);
    drop(store);

    capture(&fixture.actor, OUTSIDE, 5, true, Arc::new(NoFaults))
        .await
        .expect("retry the capture");
    let store = fixture.store();
    assert_recovered_sibling(&store);
    assert_eq!(head_text(&store, PATH), OUTSIDE);
    drop(store);
    fixture.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_at_the_copy_name_moves_the_copy_to_the_next_free_name() {
    let fixture = fixture().await;
    let (first, first_job) = collide(&fixture).await;
    let second_path = second_name(&first.path);

    let repaired = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("repair the collision");
    assert_eq!(paths(&repaired), vec![second_path.as_str()]);
    let store = fixture.store();
    let found = siblings(&store);
    assert_eq!(found.len(), 2, "the occupant and the moved copy: {found:?}");
    let occupant = found
        .iter()
        .find(|sibling| sibling.path == first.path)
        .expect("the occupant keeps its name");
    assert_eq!(occupant.text, FOREIGN);
    assert_eq!(occupant.origin, "capture");
    assert!(
        !occupant.job_pending,
        "no write is left aimed at the occupant"
    );
    let moved = found
        .iter()
        .find(|sibling| sibling.path == second_path)
        .expect("the copy takes the next free name");
    assert_eq!(moved.text, format!("{BASE}{HUMAN}"));
    assert_eq!(moved.origin, "ydoc");
    assert_eq!(moved.summary.as_deref(), Some(SUMMARY));
    assert_eq!(moved.correlation, first.correlation);
    assert_eq!(moved.author_json, first.author_json);
    assert!(
        moved.job_pending,
        "the moved copy waits for materialization"
    );
    let (second_job, second_status) = write_job(&store, &second_path);
    assert_eq!(repaired[0].materialization_job_id, second_job);
    assert_eq!(second_status, "pending");
    assert_eq!(
        write_job(&store, &first.path),
        (first_job, "cancelled".to_owned()),
        "the refused write is superseded by the moved copy"
    );
    drop(store);

    // Another pass announces the same pending copy and makes no third.
    let again = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("repair again");
    assert_eq!(paths(&again), vec![second_path.as_str()]);
    assert_eq!(siblings(&fixture.store()).len(), 2);

    // The copy reaches disk beside the occupant, and is then announced no more.
    place(&fixture, &second_job, 7)
        .await
        .expect("place the copy");
    assert_eq!(
        std::fs::read_to_string(fixture.root().join(&second_path)).expect("moved copy"),
        format!("{BASE}{HUMAN}")
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root().join(&first.path)).expect("occupant"),
        FOREIGN
    );
    let placed = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("repair after placement");
    assert!(placed.is_empty(), "{placed:?}");
    fixture.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_after_the_move_commits_moves_the_copy_once() {
    let fixture = fixture().await;
    let (first, first_job) = collide(&fixture).await;
    let second_path = second_name(&first.path);

    let crashed = repair(
        &fixture.actor,
        ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck),
    )
    .await;
    assert!(
        matches!(crashed, Err(RuntimeError::Sync(SyncError::FaultCrash))),
        "the move commits and only its response is lost: {crashed:?}"
    );
    let repaired = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("resume after the crash");
    assert_eq!(paths(&repaired), vec![second_path.as_str()]);
    let store = fixture.store();
    let found = siblings(&store);
    assert_eq!(found.len(), 2, "exactly one moved copy: {found:?}");
    assert!(
        found
            .iter()
            .any(|sibling| sibling.path == second_path && sibling.text == format!("{BASE}{HUMAN}"))
    );
    assert_eq!(
        write_job(&store, &first.path),
        (first_job, "cancelled".to_owned())
    );
    drop(store);
    fixture.close();
}

/// Capture recorded the other program's file at the copy's name, then a
/// person edited that file through the API before a repair pass ran. The
/// record of the occupant stands, so the pass still moves the recovered text
/// to the next free name and leaves the edited occupant where it is.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edited_occupant_capture_recorded_still_moves_the_copy() {
    let fixture = fixture().await;
    let (first, first_job) = collide(&fixture).await;
    let second_path = second_name(&first.path);
    fixture
        .actor
        .versioned_text_write(
            WriteText {
                workspace_id: WS.into(),
                version_id: "main".into(),
                object_id: first.object_id.clone(),
                path: first.path.clone(),
                text: REPLACED.into(),
                moment_id: "moment-edited-occupant".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 7,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("a person edits the occupant");

    let repaired = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("repair the collision");
    assert_eq!(paths(&repaired), vec![second_path.as_str()]);
    let store = fixture.store();
    let found = siblings(&store);
    assert_eq!(found.len(), 2, "the occupant and the moved copy: {found:?}");
    let occupant = found
        .iter()
        .find(|sibling| sibling.path == first.path)
        .expect("the occupant keeps its name");
    assert_eq!(occupant.text, REPLACED);
    assert_eq!(occupant.origin, "api");
    let moved = found
        .iter()
        .find(|sibling| sibling.path == second_path)
        .expect("the copy takes the next free name");
    assert_eq!(moved.text, format!("{BASE}{HUMAN}"));
    assert_eq!(moved.origin, "ydoc");
    assert_eq!(
        write_job(&store, &first.path),
        (first_job, "cancelled".to_owned())
    );
    drop(store);
    fixture.close();
}

/// A person renames the refused copy away and back before capture sees the
/// other program's file. The head at the copy's name is the person's rename,
/// not a recorded occupant: a repair pass makes no second copy of text the
/// person already has.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_renamed_away_and_back_is_not_copied_again() {
    let fixture = fixture().await;
    let (copy, job) = recover_and_occupy(&fixture).await;
    refuse_placement(&fixture, &copy, &job).await;
    rename(&fixture, &copy.path, KEPT, "moment-away", 6).await;
    rename(&fixture, KEPT, &copy.path, "moment-back", 7).await;

    let repaired = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("repair after the renames");
    assert!(
        repaired.is_empty(),
        "the renamed copy is not copied again: {repaired:?}"
    );
    let store = fixture.store();
    let found = siblings(&store);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].path, copy.path);
    assert_eq!(found[0].text, format!("{BASE}{HUMAN}"));
    assert_eq!(found[0].origin, "api", "the head is the person's rename");
    assert_eq!(
        write_job(&store, &copy.path),
        (job, "conflict".to_owned()),
        "the refused write stays refused"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root().join(&copy.path)).expect("occupant"),
        FOREIGN
    );
    drop(store);
    fixture.close();
}

/// Which pending copy a person renames before it reaches disk.
#[derive(Clone, Copy)]
enum PendingCopy {
    /// The copy the recovery itself created.
    Original,
    /// The replacement a committed repair created, whose response was lost.
    Replacement,
}

/// A person renames a recovered copy while its write is still pending. The
/// rename keeps the text under the new name; the write aimed at the old name
/// must go with it, or ordinary pending replay, as the next open runs it,
/// puts a file back at that name.
async fn a_renamed_pending_copy_is_not_written_back_at_its_old_name(which: PendingCopy) {
    let fixture = fixture().await;
    let (path, job) = match which {
        PendingCopy::Original => {
            let (opened, doc) = open_and_seed(&fixture.actor, 2).await;
            type_human(&fixture.actor, &opened, &doc, 3).await;
            std::fs::write(fixture.root().join(PATH), OUTSIDE).expect("outside write");
            capture(&fixture.actor, OUTSIDE, 4, true, Arc::new(NoFaults))
                .await
                .expect("capture the outside write");
            let store = fixture.store();
            let copy = assert_recovered_sibling(&store);
            let (job, status) = write_job(&store, &copy.path);
            assert_eq!(status, "pending");
            (copy.path, job)
        }
        PendingCopy::Replacement => {
            let (first, _) = collide(&fixture).await;
            let crashed = repair(
                &fixture.actor,
                ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck),
            )
            .await;
            assert!(
                matches!(crashed, Err(RuntimeError::Sync(SyncError::FaultCrash))),
                "the move commits and only its response is lost: {crashed:?}"
            );
            let second_path = second_name(&first.path);
            let (job, status) = write_job(&fixture.store(), &second_path);
            assert_eq!(status, "pending");
            (second_path, job)
        }
    };
    let on_disk = recovered_files_on_disk(&fixture);

    rename(&fixture, &path, KEPT, "moment-kept", 7).await;
    let store = fixture.store();
    assert_eq!(
        head_text(&store, KEPT),
        format!("{BASE}{HUMAN}"),
        "the rename keeps the text"
    );
    assert_eq!(
        write_job(&store, &path),
        (job, "cancelled".to_owned()),
        "the write aimed at the old name goes with the rename"
    );
    drop(store);
    let announced = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("repair after the rename");
    assert!(
        announced.is_empty(),
        "nothing is left to announce at the old name: {announced:?}"
    );

    // Ordinary pending replay, as the next open runs it before capture starts.
    fixture
        .actor
        .materialize_replay_pending(fixture.root().to_path_buf(), WS.into(), 8)
        .await
        .expect("replay pending writes");
    assert!(
        !fixture.root().join(&path).exists(),
        "{path} is not written back"
    );
    assert_eq!(
        recovered_files_on_disk(&fixture),
        on_disk,
        "no copy appears on disk under any name"
    );
    assert_eq!(head_text(&fixture.store(), KEPT), format!("{BASE}{HUMAN}"));
    fixture.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_renamed_pending_copy_is_not_written_back_at_its_old_name_by_replay() {
    a_renamed_pending_copy_is_not_written_back_at_its_old_name(PendingCopy::Original).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_renamed_pending_replacement_is_not_written_back_at_its_old_name_by_replay() {
    a_renamed_pending_copy_is_not_written_back_at_its_old_name(PendingCopy::Replacement).await;
}

/// Several files changed while dohc was closed. The startup pass captures
/// them in one batch; the first folds a lineage and recovers a copy, and the
/// copy's moment must not take the order the batch reserved for the next file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recovery_inside_a_capture_batch_leaves_room_for_the_next_file() {
    let fixture = fixture().await;
    let (opened, doc) = open_and_seed(&fixture.actor, 2).await;
    type_human(&fixture.actor, &opened, &doc, 3).await;
    std::fs::write(fixture.root().join(PATH), OUTSIDE).expect("outside write");
    std::fs::write(fixture.root().join(OTHER), OTHER_TEXT).expect("other file");

    let actor = fixture.actor.clone();
    let root = fixture.root().to_path_buf();
    let policy = Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
        &root,
    ));
    let results = std::thread::spawn(move || {
        actor.capture_ingest_batch_blocking(
            vec![
                ingest(PATH, OUTSIDE, 4, true),
                ingest(OTHER, OTHER_TEXT, 4, false),
            ],
            policy,
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            root,
            Arc::new(ExistingRootGuard),
        )
    })
    .join()
    .expect("batch thread")
    .expect("capture the batch");
    assert_eq!(results.len(), 2);
    let recovering = results[0]
        .as_ref()
        .expect("the file with unsettled typing commits");
    let next = results[1]
        .as_ref()
        .expect("the next changed file commits in the same pass");

    let store = fixture.store();
    let copies: Vec<Sibling> = siblings(&store)
        .into_iter()
        .filter(|sibling| sibling.path != OTHER)
        .collect();
    assert_eq!(copies.len(), 1, "exactly one copy: {copies:?}");
    assert_eq!(copies[0].text, format!("{BASE}{HUMAN}"));
    assert_eq!(head_text(&store, PATH), OUTSIDE);
    assert_eq!(head_text(&store, OTHER), OTHER_TEXT);
    assert!(
        next.moment.moment_order > recovering.moment.moment_order + 1,
        "the copy's moment sits between the two files: {} then {}",
        recovering.moment.moment_order,
        next.moment.moment_order
    );
    drop(store);
    fixture.close();
}

/// The daemon's capture sink sees the occupant for the first time: the
/// copy's name was never in its files manifest, and first sight claims no
/// head another origin wrote. The store knows this head was never placed,
/// so the occupant is recorded without a claim and the copy moves.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_first_sight_of_the_occupant_records_it_and_moves_the_copy() {
    let fixture = fixture().await;
    let (first, first_job) = recover_and_occupy(&fixture).await;
    refuse_placement(&fixture, &first, &first_job).await;
    let second_path = second_name(&first.path);

    first_sight(&fixture.actor, &first.path, 6)
        .await
        .expect("first sight records the occupant of a refused recovery name");
    let repaired = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("repair the collision");
    assert_eq!(paths(&repaired), vec![second_path.as_str()]);
    let store = fixture.store();
    let found = siblings(&store);
    assert_eq!(found.len(), 2, "the occupant and the moved copy: {found:?}");
    let occupant = found
        .iter()
        .find(|sibling| sibling.path == first.path)
        .expect("the occupant keeps its name");
    assert_eq!(occupant.text, FOREIGN);
    assert_eq!(occupant.origin, "capture");
    let moved = found
        .iter()
        .find(|sibling| sibling.path == second_path)
        .expect("the copy takes the next free name");
    assert_eq!(moved.text, format!("{BASE}{HUMAN}"));
    assert_eq!(moved.origin, "ydoc");
    assert_eq!(moved.summary.as_deref(), Some(SUMMARY));
    assert_eq!(moved.correlation, first.correlation);
    assert_eq!(moved.author_json, first.author_json);
    assert!(
        moved.job_pending,
        "the moved copy waits for materialization"
    );
    assert_eq!(
        write_job(&store, &first.path),
        (first_job, "cancelled".to_owned()),
        "the refused write is superseded by the moved copy"
    );
    drop(store);

    // The occupant is capture's own head now: seeing it again adds nothing.
    first_sight(&fixture.actor, &first.path, 7)
        .await
        .expect("the same bytes again");
    assert_eq!(siblings(&fixture.store()).len(), 2);
    fixture.close();
}

/// First sight claims a recovery head only once the materializer has refused
/// its write, and only while the head is still that recovery. A copy whose
/// write is still pending, or whose text a person replaced through the API,
/// is left alone like any head another origin wrote. The replaced copy has no
/// recorded occupant either, so a repair pass makes no second copy of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_first_sight_leaves_an_unrefused_or_replaced_copy_alone() {
    let fixture = fixture().await;
    let (copy, job) = recover_and_occupy(&fixture).await;

    let pending = first_sight(&fixture.actor, &copy.path, 5).await;
    assert!(
        matches!(
            pending,
            Err(RuntimeError::Domain(DomainError::CaptureNotOwned))
        ),
        "the materializer has not ruled on the copy's write: {pending:?}"
    );
    refuse_placement(&fixture, &copy, &job).await;

    fixture
        .actor
        .versioned_text_write(
            WriteText {
                workspace_id: WS.into(),
                version_id: "main".into(),
                object_id: copy.object_id.clone(),
                path: copy.path.clone(),
                text: REPLACED.into(),
                moment_id: "moment-replaced".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 6,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("a person replaces the copy's text");
    let replaced = first_sight(&fixture.actor, &copy.path, 7).await;
    assert!(
        matches!(
            replaced,
            Err(RuntimeError::Domain(DomainError::CaptureNotOwned))
        ),
        "the head is no longer the refused recovery: {replaced:?}"
    );
    let store = fixture.store();
    let found = siblings(&store);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].origin, "api");
    assert_eq!(found[0].text, REPLACED);
    drop(store);

    // The person's text is the head and no occupant was recorded over the
    // recovery: the pass moves nothing.
    let repaired = repair(&fixture.actor, Arc::new(NoFaults))
        .await
        .expect("repair after the replacement");
    assert!(
        repaired.is_empty(),
        "the replaced copy is not copied again: {repaired:?}"
    );
    let found = siblings(&fixture.store());
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].text, REPLACED);
    fixture.close();
}
