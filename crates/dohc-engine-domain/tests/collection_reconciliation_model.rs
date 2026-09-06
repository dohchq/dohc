use std::collections::{HashMap, HashSet};

use dohc_engine_domain::{
    CollectionReconcileResult, DomainError, NoFaults, TxnOutcome, VersionedTextStore, WriteText,
    reconcile_collections_in_tx, set_collection_adoption_state_in_tx,
};
use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::{Connection, params};

const WORKSPACE_ID: &str = "collection-reconciliation-model";
const VERSION_ID: &str = "main";
const SOURCE_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHANGED_TARGET_ID: &str = "rec_cccccccccccccccccccccccccc";
const SOURCE_OBJECT: &str = "model-source-object";
const TARGET_OBJECT: &str = "model-target-object";
const COPY_OBJECT: &str = "model-copy-object";
const SOURCE_PATH: &str = "records/source.md";
const TARGET_PATH: &str = "records/z-target.md";
const RENAMED_TARGET_PATH: &str = "records/z-renamed-target.md";
const COPY_PATH: &str = "records/a-copy.md";
const MAX_SEQUENCE_LENGTH: usize = 4;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Event {
    WriteValidFrontmatter,
    WriteMalformedFrontmatter,
    Repair,
    Rename,
    ReplaceAtPath,
    CopyWithSameId,
    Delete,
    ChangeId,
    OpenConflict,
    ResolveConflict,
}

impl Event {
    const ALL: [Self; 10] = [
        Self::WriteValidFrontmatter,
        Self::WriteMalformedFrontmatter,
        Self::Repair,
        Self::Rename,
        Self::ReplaceAtPath,
        Self::CopyWithSameId,
        Self::Delete,
        Self::ChangeId,
        Self::OpenConflict,
        Self::ResolveConflict,
    ];
}

#[derive(Clone, Debug)]
struct ModelState {
    target_present: bool,
    target_valid: bool,
    target_renamed: bool,
    copy_present: bool,
    target_id_changed: bool,
    open_conflict_id: Option<String>,
    valid_revision: bool,
    owners: HashMap<String, String>,
}

impl ModelState {
    fn initial() -> Self {
        Self {
            target_present: true,
            target_valid: true,
            target_renamed: false,
            copy_present: false,
            target_id_changed: false,
            open_conflict_id: None,
            valid_revision: false,
            owners: HashMap::from([
                (SOURCE_ID.to_owned(), SOURCE_OBJECT.to_owned()),
                (TARGET_ID.to_owned(), TARGET_OBJECT.to_owned()),
            ]),
        }
    }

    fn target_path(&self) -> &'static str {
        if self.target_renamed {
            RENAMED_TARGET_PATH
        } else {
            TARGET_PATH
        }
    }

    fn target_id(&self) -> &'static str {
        if self.target_id_changed {
            CHANGED_TARGET_ID
        } else {
            TARGET_ID
        }
    }

    fn allows(&self, event: Event) -> bool {
        match event {
            Event::WriteValidFrontmatter => self.target_present && self.target_valid,
            Event::WriteMalformedFrontmatter => self.target_present && self.target_valid,
            Event::Repair => self.target_present && !self.target_valid,
            Event::Rename => self.target_present && !self.target_renamed,
            Event::ReplaceAtPath => {
                self.target_present && !self.target_renamed && !self.copy_present
            }
            Event::CopyWithSameId => self.target_present && !self.copy_present,
            Event::Delete => self.target_present,
            Event::ChangeId => self.target_present && self.target_valid && !self.target_id_changed,
            Event::OpenConflict => self.target_present && self.open_conflict_id.is_none(),
            Event::ResolveConflict => self.open_conflict_id.is_some(),
        }
    }
}

fn fresh_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
        .expect("main version");
    (scratch, store)
}

fn write_text_for_object(
    store: &mut EngineStore,
    path: &str,
    text: &str,
    object_id: &str,
    moment_id: &str,
    now_ms: i64,
) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                object_id: object_id.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: moment_id.to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed model text");
}

fn record_text(record_id: &str, name: &str) -> String {
    format!("---\nid: {record_id}\nName: {name}\n---\n")
}

fn put_blob(conn: &Connection, text: &str) -> Result<String, DomainError> {
    let sha256 = hex_sha256(text.as_bytes());
    conn.execute(
        "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
        params![sha256, text.len() as i64, text],
    )
    .map_err(StorageError::persist_public)?;
    Ok(sha256)
}

fn append_model_moment(
    conn: &Connection,
    object_id: &str,
    path: &str,
    blob_sha256: &str,
) -> Result<String, DomainError> {
    let moment_order = conn
        .query_row(
            "SELECT COALESCE(MAX(moment_order),0)+1 FROM moments WHERE workspace_id=?1",
            [WORKSPACE_ID],
            |row| row.get::<_, i64>(0),
        )
        .map_err(StorageError::persist_public)?;
    let moment_id = format!("model-event-moment-{moment_order}");
    conn.execute(
        "INSERT INTO moments (workspace_id,moment_order,moment_id,version_id,object_id, \
           path,recorded_at_ms,operation,after_blob_sha256,before_present,metadata_origin, \
           after_content_kind,after_binary_sha256) \
         VALUES (?1,?2,?3,?4,?5,?6,?2,'write',?7,1,'test','text',NULL)",
        params![
            WORKSPACE_ID,
            moment_order,
            moment_id,
            VERSION_ID,
            object_id,
            path,
            blob_sha256
        ],
    )
    .map_err(StorageError::persist_public)?;
    Ok(moment_id)
}

fn replace_target_text(
    conn: &Connection,
    state: &ModelState,
    text: &str,
) -> Result<(), DomainError> {
    let sha256 = put_blob(conn, text)?;
    let moment_id = append_model_moment(conn, TARGET_OBJECT, state.target_path(), &sha256)?;
    let changed = conn
        .execute(
            "UPDATE snapshots SET blob_sha256=?4,updated_at_ms=updated_at_ms+1, \
               latest_moment_id=?5 \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![WORKSPACE_ID, VERSION_ID, TARGET_OBJECT, sha256, moment_id],
        )
        .map_err(StorageError::persist_public)?;
    assert_eq!(
        changed,
        usize::from(state.target_present),
        "the model target head must match its presence flag"
    );
    Ok(())
}

fn insert_copy(conn: &Connection, state: &ModelState, path: &str) -> Result<(), DomainError> {
    let text = record_text(state.target_id(), "Target copy");
    let sha256 = put_blob(conn, &text)?;
    conn.execute(
        "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES (?1,?2,100)",
        params![WORKSPACE_ID, COPY_OBJECT],
    )
    .map_err(StorageError::persist_public)?;
    conn.execute(
        "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
         VALUES (?1,?2,?3,?4)",
        params![WORKSPACE_ID, VERSION_ID, path, COPY_OBJECT],
    )
    .map_err(StorageError::persist_public)?;
    let moment_id = append_model_moment(conn, COPY_OBJECT, path, &sha256)?;
    conn.execute(
        "INSERT INTO snapshots (workspace_id,version_id,object_id,path,blob_sha256, \
           updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
         VALUES (?1,?2,?3,?4,?5,100,?6,'test','text',NULL)",
        params![
            WORKSPACE_ID,
            VERSION_ID,
            COPY_OBJECT,
            path,
            sha256,
            moment_id
        ],
    )
    .map_err(StorageError::persist_public)?;
    Ok(())
}

fn apply_event(
    conn: &Connection,
    state: &mut ModelState,
    event: Event,
    step: usize,
) -> Result<(), DomainError> {
    match event {
        Event::WriteValidFrontmatter => {
            state.valid_revision = !state.valid_revision;
            let name = if state.valid_revision {
                "Target revised"
            } else {
                "Target"
            };
            replace_target_text(conn, state, &record_text(state.target_id(), name))?;
        }
        Event::WriteMalformedFrontmatter => {
            replace_target_text(conn, state, "---\nid: [\n---\n")?;
            state.target_valid = false;
        }
        Event::Repair => {
            replace_target_text(
                conn,
                state,
                &record_text(state.target_id(), "Target repaired"),
            )?;
            state.target_valid = true;
            // The malformed interlude dropped the binding row, so the repaired
            // file's id is the only identity thread the engine can re-bind
            // from. With an unchanged id this is a no-op; after ChangeId the
            // identity legitimately migrates to the repaired file's id — but
            // only when no other object already owns that id (otherwise the
            // engine remints the repaired file a fresh one).
            state
                .owners
                .retain(|_, owner_object| owner_object != TARGET_OBJECT);
            state
                .owners
                .entry(state.target_id().to_owned())
                .or_insert_with(|| TARGET_OBJECT.to_owned());
        }
        Event::Rename => {
            let old_path = state.target_path();
            let blob_sha256 = conn
                .query_row(
                    "SELECT blob_sha256 FROM snapshots \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![WORKSPACE_ID, VERSION_ID, TARGET_OBJECT],
                    |row| row.get::<_, String>(0),
                )
                .map_err(StorageError::persist_public)?;
            let moment_id =
                append_model_moment(conn, TARGET_OBJECT, RENAMED_TARGET_PATH, &blob_sha256)?;
            conn.execute(
                "DELETE FROM path_aliases \
                 WHERE workspace_id=?1 AND version_id=?2 AND path=?3 AND object_id=?4",
                params![WORKSPACE_ID, VERSION_ID, old_path, TARGET_OBJECT],
            )
            .map_err(StorageError::persist_public)?;
            conn.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES (?1,?2,?3,?4)",
                params![WORKSPACE_ID, VERSION_ID, RENAMED_TARGET_PATH, TARGET_OBJECT],
            )
            .map_err(StorageError::persist_public)?;
            conn.execute(
                "UPDATE snapshots SET path=?4,updated_at_ms=updated_at_ms+1, \
                   latest_moment_id=?5 \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![
                    WORKSPACE_ID,
                    VERSION_ID,
                    TARGET_OBJECT,
                    RENAMED_TARGET_PATH,
                    moment_id
                ],
            )
            .map_err(StorageError::persist_public)?;
            state.target_renamed = true;
        }
        Event::ReplaceAtPath => {
            let old_path = state.target_path();
            let blob_sha256 = conn
                .query_row(
                    "SELECT blob_sha256 FROM snapshots \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![WORKSPACE_ID, VERSION_ID, TARGET_OBJECT],
                    |row| row.get::<_, String>(0),
                )
                .map_err(StorageError::persist_public)?;
            let moment_id =
                append_model_moment(conn, TARGET_OBJECT, RENAMED_TARGET_PATH, &blob_sha256)?;
            conn.execute(
                "DELETE FROM path_aliases \
                 WHERE workspace_id=?1 AND version_id=?2 AND path=?3 AND object_id=?4",
                params![WORKSPACE_ID, VERSION_ID, old_path, TARGET_OBJECT],
            )
            .map_err(StorageError::persist_public)?;
            conn.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES (?1,?2,?3,?4)",
                params![WORKSPACE_ID, VERSION_ID, RENAMED_TARGET_PATH, TARGET_OBJECT],
            )
            .map_err(StorageError::persist_public)?;
            conn.execute(
                "UPDATE snapshots SET path=?4,updated_at_ms=updated_at_ms+1, \
                   latest_moment_id=?5 \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![
                    WORKSPACE_ID,
                    VERSION_ID,
                    TARGET_OBJECT,
                    RENAMED_TARGET_PATH,
                    moment_id
                ],
            )
            .map_err(StorageError::persist_public)?;
            state.target_renamed = true;
            insert_copy(conn, state, old_path)?;
            state.copy_present = true;
        }
        Event::CopyWithSameId => {
            insert_copy(conn, state, COPY_PATH)?;
            state.copy_present = true;
        }
        Event::Delete => {
            conn.execute(
                "DELETE FROM path_aliases \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![WORKSPACE_ID, VERSION_ID, TARGET_OBJECT],
            )
            .map_err(StorageError::persist_public)?;
            conn.execute(
                "DELETE FROM snapshots \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![WORKSPACE_ID, VERSION_ID, TARGET_OBJECT],
            )
            .map_err(StorageError::persist_public)?;
            state.target_present = false;
            state
                .owners
                .retain(|_, owner_object| owner_object != TARGET_OBJECT);
        }
        Event::ChangeId => {
            // The id is engine-owned: rewriting the file's id never moves the
            // record identity. The binding keeps TARGET_ID and the engine
            // schedules a write-back, so ownership is unchanged in the model.
            state.target_id_changed = true;
            replace_target_text(
                conn,
                state,
                &record_text(CHANGED_TARGET_ID, "Target changed id"),
            )?;
        }
        Event::OpenConflict => {
            let conflict_id = format!("model-target-conflict-{step}");
            conn.execute(
                "INSERT INTO conflicts ( \
                   workspace_id,conflict_id,path,target_version_id,source_version_id, \
                   created_at_ms,updated_at_ms,status,chosen_from,metadata_origin, \
                   base_exists,base_path,current_exists,current_path,current_object_id, \
                   incoming_exists,incoming_path,incoming_object_id \
                 ) VALUES (?1,?5,?2,?3,?3, \
                   100,100,'open','current','sync',0,?2,1,?2,?4,1,?2,?4)",
                params![
                    WORKSPACE_ID,
                    state.target_path(),
                    VERSION_ID,
                    TARGET_OBJECT,
                    conflict_id
                ],
            )
            .map_err(StorageError::persist_public)?;
            state.open_conflict_id = Some(conflict_id);
        }
        Event::ResolveConflict => {
            let conflict_id = state
                .open_conflict_id
                .take()
                .expect("resolve is allowed only with an open conflict");
            conn.execute(
                "UPDATE conflicts SET status='resolved',updated_at_ms=updated_at_ms+1 \
                 WHERE workspace_id=?1 AND conflict_id=?2",
                params![WORKSPACE_ID, conflict_id],
            )
            .map_err(StorageError::persist_public)?;
            state
                .owners
                .retain(|_, owner_object| owner_object != TARGET_OBJECT);
            if state.target_present && state.target_valid {
                // The engine identity survives a file-level id rewrite, so the
                // resolved target always re-claims TARGET_ID.
                state
                    .owners
                    .insert(TARGET_ID.to_owned(), TARGET_OBJECT.to_owned());
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
struct Binding {
    record_id: Option<String>,
    file_path: String,
    object_id: String,
    adoption_state: String,
    index_initialized: bool,
}

fn load_bindings(conn: &Connection) -> Result<Vec<Binding>, DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT record_id,file_path,object_id,adoption_state,index_initialized \
             FROM collection_records WHERE workspace_id=?1 AND version_id=?2 \
             ORDER BY file_path",
        )
        .map_err(StorageError::persist_public)?;
    statement
        .query_map(params![WORKSPACE_ID, VERSION_ID], |row| {
            Ok(Binding {
                record_id: row.get(0)?,
                file_path: row.get(1)?,
                object_id: row.get(2)?,
                adoption_state: row.get(3)?,
                index_initialized: row.get(4)?,
            })
        })
        .map_err(StorageError::persist_public)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::persist_public)
        .map_err(Into::into)
}

fn object_is_present(conn: &Connection, object_id: &str) -> Result<bool, DomainError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM snapshots \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
        params![WORKSPACE_ID, VERSION_ID, object_id],
        |row| row.get(0),
    )
    .map_err(StorageError::persist_public)
    .map_err(Into::into)
}

fn indexed_field_count(
    conn: &Connection,
    record_id: &str,
    field_name: &str,
) -> Result<i64, DomainError> {
    conn.query_row(
        "SELECT COUNT(*) FROM collection_record_fields \
         WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3 AND field_name=?4",
        params![WORKSPACE_ID, VERSION_ID, record_id, field_name],
        |row| row.get(0),
    )
    .map_err(StorageError::persist_public)
    .map_err(Into::into)
}

fn assert_invariants(
    conn: &Connection,
    state: &mut ModelState,
    result: &CollectionReconcileResult,
    sequence: &[Event],
) -> Result<(), DomainError> {
    let mut present_owners = HashMap::new();
    for (record_id, object_id) in &state.owners {
        if object_is_present(conn, object_id)? {
            present_owners.insert(record_id.clone(), object_id.clone());
        }
    }
    state.owners = present_owners;

    for cleanup in &result.relation_cleanups {
        assert!(
            !state.owners.contains_key(&cleanup.target_record_id),
            "relation cleanup targeted a present record after {sequence:?}: {cleanup:?}"
        );
    }

    let bindings = load_bindings(conn)?;
    for binding in &bindings {
        assert!(
            matches!(
                binding.adoption_state.as_str(),
                "pending"
                    | "pending-lossless"
                    | "deferred-conflict"
                    | "deferred-conflict-lossless"
                    | "adopted"
            ),
            "undefined adoption state after {sequence:?}: {binding:?}"
        );
        let Some(record_id) = binding.record_id.as_ref() else {
            continue;
        };
        if let Some(owner_object) = state.owners.get(record_id) {
            assert_eq!(
                &binding.object_id, owner_object,
                "record id moved to another object after {sequence:?}: {binding:?}"
            );
        } else {
            state
                .owners
                .insert(record_id.clone(), binding.object_id.clone());
        }

        if !binding.index_initialized {
            continue;
        }
        assert_eq!(
            indexed_field_count(conn, record_id, "Name")?,
            1,
            "index_initialized binding lacks its current or retained field after {sequence:?}: {binding:?}"
        );
    }
    Ok(())
}

fn explore_sequences(
    conn: &Connection,
    state: &ModelState,
    sequence: &mut Vec<Event>,
    visited: &mut usize,
    covered_events: &mut HashSet<Event>,
) -> Result<(), DomainError> {
    if sequence.len() == MAX_SEQUENCE_LENGTH {
        return Ok(());
    }

    // The source-to-target relation orients the two otherwise symmetric
    // records. Applying events only to the target prunes the mirrored record
    // labels; `allows` also removes impossible and no-op transitions.
    for event in Event::ALL {
        if !state.allows(event) {
            continue;
        }
        let savepoint = format!("model_depth_{}", sequence.len());
        conn.execute_batch(&format!("SAVEPOINT {savepoint}"))
            .map_err(StorageError::persist_public)?;

        let mut next = state.clone();
        apply_event(conn, &mut next, event, sequence.len())?;
        let result = reconcile_collections_in_tx(conn, WORKSPACE_ID, VERSION_ID)?;
        sequence.push(event);
        *visited += 1;
        covered_events.insert(event);
        assert_invariants(conn, &mut next, &result, sequence)?;
        explore_sequences(conn, &next, sequence, visited, covered_events)?;
        sequence.pop();

        conn.execute_batch(&format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}"))
            .map_err(StorageError::persist_public)?;
    }
    Ok(())
}

#[test]
fn bounded_reconciliation_event_sequences_preserve_collection_invariants() {
    let (_scratch, mut store) = fresh_store();
    write_text_for_object(
        &mut store,
        "records/collection.yaml",
        "fields:\n  Name:\n    type: text\n  Peer:\n    type: relation\n    collection: records\n    many: false\n",
        "model-schema-object",
        "model-schema-moment",
        2,
    );
    write_text_for_object(
        &mut store,
        SOURCE_PATH,
        &format!("---\nid: {SOURCE_ID}\nName: Source\nPeer: {TARGET_ID}\n---\n"),
        SOURCE_OBJECT,
        "model-source-moment",
        3,
    );
    write_text_for_object(
        &mut store,
        TARGET_PATH,
        &record_text(TARGET_ID, "Target"),
        TARGET_OBJECT,
        "model-target-moment",
        4,
    );

    let seeded = store
        .write_with(&NoFaults, |tx| {
            let result = reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)?;
            assert!(result.relation_cleanups.is_empty());
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                SOURCE_PATH,
                SOURCE_ID,
                "adopted",
            )?;
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                TARGET_PATH,
                TARGET_ID,
                "adopted",
            )?;
            Ok::<_, DomainError>(())
        })
        .expect("seed adopted model records");
    assert!(matches!(seeded, TxnOutcome::Committed(())));

    let explored = store
        .write_with(&NoFaults, |tx| {
            let mut state = ModelState::initial();
            assert_invariants(tx, &mut state, &CollectionReconcileResult::default(), &[])?;
            let mut sequence = Vec::new();
            let mut visited = 0;
            let mut covered_events = HashSet::new();
            explore_sequences(tx, &state, &mut sequence, &mut visited, &mut covered_events)?;
            assert!(
                Event::ALL
                    .into_iter()
                    .all(|event| covered_events.contains(&event)),
                "every reconciliation event must be reachable: {covered_events:?}"
            );
            Ok::<_, DomainError>(visited)
        })
        .expect("enumerate reconciliation event sequences");
    let TxnOutcome::Committed(visited) = explored else {
        panic!("reconciliation state model crashed");
    };
    assert!(visited >= Event::ALL.len());
}

#[test]
fn replacing_an_adopted_path_keeps_the_departed_objects_id_and_remints_the_replacement() {
    let (_scratch, mut store) = fresh_store();
    write_text_for_object(
        &mut store,
        "records/collection.yaml",
        "fields:\n  Name:\n    type: text\n",
        "model-schema-object",
        "model-schema-moment",
        2,
    );
    write_text_for_object(
        &mut store,
        TARGET_PATH,
        &record_text(TARGET_ID, "Target"),
        TARGET_OBJECT,
        "model-target-moment",
        3,
    );
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)?;
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                TARGET_PATH,
                TARGET_ID,
                "adopted",
            )?;
            Ok::<_, DomainError>(())
        })
        .expect("seed adopted target");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            let mut state = ModelState::initial();
            apply_event(tx, &mut state, Event::ReplaceAtPath, 0)?;
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("replace adopted path");
    let result = match reconciled {
        TxnOutcome::Committed(result) => result,
        TxnOutcome::Crashed { .. } => panic!("replacement reconciliation crashed"),
    };
    let bindings = store
        .read_with(load_bindings)
        .expect("load replacement bindings");
    let departed = bindings
        .iter()
        .find(|binding| binding.file_path == RENAMED_TARGET_PATH)
        .expect("departed object binding");
    let replacement = bindings
        .iter()
        .find(|binding| binding.file_path == TARGET_PATH)
        .expect("replacement object binding");

    assert_eq!(departed.object_id, TARGET_OBJECT);
    assert_eq!(departed.record_id.as_deref(), Some(TARGET_ID));
    assert_eq!(departed.adoption_state, "adopted");
    assert_eq!(replacement.object_id, COPY_OBJECT);
    assert_ne!(replacement.record_id.as_deref(), Some(TARGET_ID));
    assert_eq!(replacement.adoption_state, "pending-lossless");
    assert_eq!(
        result.adoptions,
        [dohc_engine_domain::CollectionAdoptionCandidate {
            record_id: replacement.record_id.clone().expect("replacement id"),
            collection_path: "records".to_owned(),
            file_path: TARGET_PATH.to_owned(),
            object_id: COPY_OBJECT.to_owned(),
            lossless_insertion_required: true,
        }]
    );
}

#[test]
fn an_adopted_object_reasserts_its_bound_id_without_moving_history() {
    let (_scratch, mut store) = fresh_store();
    write_text_for_object(
        &mut store,
        "records/collection.yaml",
        "fields:\n  Name:\n    type: text\n",
        "model-schema-object",
        "model-schema-moment",
        2,
    );
    write_text_for_object(
        &mut store,
        TARGET_PATH,
        &record_text(TARGET_ID, "Target"),
        TARGET_OBJECT,
        "model-target-moment",
        3,
    );
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)?;
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                TARGET_PATH,
                TARGET_ID,
                "adopted",
            )?;
            tx.execute(
                "INSERT INTO collection_field_history \
                 (workspace_id,version_id,record_id,field_name,previous_value_json, \
                  next_value_json,recorded_at_ms) \
                 VALUES (?1,?2,?3,'Name','\"Before\"','\"Target\"',3)",
                params![WORKSPACE_ID, VERSION_ID, TARGET_ID],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, DomainError>(())
        })
        .expect("seed adopted target with history");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            let state = ModelState::initial();
            replace_target_text(tx, &state, &record_text(CHANGED_TARGET_ID, "Changed id"))?;
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile edited engine-owned id");
    let TxnOutcome::Committed(result) = reconciled else {
        panic!("id reconciliation crashed");
    };

    assert_eq!(
        result.adoptions,
        [dohc_engine_domain::CollectionAdoptionCandidate {
            record_id: TARGET_ID.to_owned(),
            collection_path: "records".to_owned(),
            file_path: TARGET_PATH.to_owned(),
            object_id: TARGET_OBJECT.to_owned(),
            lossless_insertion_required: false,
        }]
    );
    let binding = store
        .read_with(load_bindings)
        .expect("read reassertion binding")
        .into_iter()
        .find(|binding| binding.object_id == TARGET_OBJECT)
        .expect("target binding");
    assert_eq!(binding.record_id.as_deref(), Some(TARGET_ID));
    assert_eq!(binding.adoption_state, "pending");
    let history_ids = store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT record_id FROM collection_field_history \
                 WHERE workspace_id=?1 AND version_id=?2 ORDER BY history_id",
            )?;
            statement
                .query_map(params![WORKSPACE_ID, VERSION_ID], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("read retained history identity");
    assert_eq!(history_ids, [TARGET_ID]);
}
