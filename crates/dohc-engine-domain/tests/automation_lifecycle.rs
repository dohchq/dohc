//! Added and removed records (ADR 0008): reconcile claims a record whose file
//! a moment on this computer brought into its Collection or took out of it,
//! once per automation, keyed by that moment. A moment synced from another
//! computer, a moment older than the subscription or the Collection, a merge
//! replaying another version's change, and every binding change with no such
//! moment (frontmatter breaking and healing) claim nothing.

use dohc_engine_domain::{
    AutomationChangeKind, AutomationClaim, AutomationFactValue, AutomationSubscription,
    AutomationTrigger, CreateNamedVersion, DeleteTextFile, MergeTextFileFromVersion,
    MergeTextFileResult, NoFaults, RenameTextFile, TxnOutcome, VersionedTextStore, WriteText,
    claim_record_lifecycle_in_tx, reconcile_collections_in_tx, subscribe_automation,
};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::json;

const WS: &str = "ws-automation-lifecycle";
const MAIN: &str = "main";
const LIFECYCLE: &str = "collection:tasks#lifecycle";
const ALPHA: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const BETA: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const GAMMA: &str = "rec_cccccccccccccccccccccccccc";

fn open_store(scratch: &ScratchDir) -> EngineStore {
    let db = engine_db_path(scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, MAIN, 1, &NoFaults)
        .expect("main version");
    store
}

fn subscribe(store: &mut EngineStore, automation_id: &str, now_ms: i64) {
    subscribe_automation(
        store,
        WS,
        &AutomationSubscription {
            automation_id: automation_id.to_owned(),
            prefix: "tasks".to_owned(),
            kinds: vec![AutomationChangeKind::Added, AutomationChangeKind::Removed],
            fields: None,
        },
        now_ms,
        &NoFaults,
    )
    .expect("subscribe");
}

fn write(store: &mut EngineStore, path: &str, text: &str, moment_id: &str, now_ms: i64) {
    write_as(store, path, text, moment_id, now_ms, None);
}

fn write_as(
    store: &mut EngineStore,
    path: &str,
    text: &str,
    moment_id: &str,
    now_ms: i64,
    author_json: Option<String>,
) {
    write_object(
        store,
        (MAIN, &format!("object:{path}")),
        path,
        text,
        moment_id,
        now_ms,
        author_json,
    );
}

/// Write `path` as `object` in `version`.
fn write_object(
    store: &mut EngineStore,
    (version, object): (&str, &str),
    path: &str,
    text: &str,
    moment_id: &str,
    now_ms: i64,
    author_json: Option<String>,
) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: version.to_owned(),
                object_id: object.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: moment_id.to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json,
                now_ms,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("write text");
}

fn record(id: &str, status: &str) -> String {
    format!("---\nid: {id}\nstatus: {status}\n---\n\nBody")
}

fn moment_order(store: &EngineStore, moment_id: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT moment_order FROM moments WHERE workspace_id = ?1 AND moment_id = ?2",
                [WS, moment_id],
                |row| row.get(0),
            )
        })
        .expect("moment order")
}

/// One reconcile pass of main and its lifecycle claims, in one transaction.
fn reconcile(store: &mut EngineStore, now_ms: i64) -> Vec<AutomationClaim> {
    reconcile_version(store, MAIN, now_ms)
}

fn reconcile_version(store: &mut EngineStore, version: &str, now_ms: i64) -> Vec<AutomationClaim> {
    match store
        .write_with(&NoFaults, |tx| {
            let reconciliation = reconcile_collections_in_tx(tx, WS, version)?;
            claim_record_lifecycle_in_tx(tx, WS, version, &reconciliation.lifecycle, now_ms)
        })
        .expect("reconcile")
    {
        TxnOutcome::Committed(claims) => claims,
        TxnOutcome::Crashed { .. } => unreachable!("no faults injected"),
    }
}

/// Each claim's kind and record.
fn claimed(claims: &[AutomationClaim]) -> Vec<(AutomationChangeKind, &str)> {
    claims
        .iter()
        .map(|claim| {
            (
                claim.change.kind,
                claim.record_id.as_deref().unwrap_or_default(),
            )
        })
        .collect()
}

/// Journal `moment_id` as a replication import from another computer.
fn import(store: &mut EngineStore, moment_id: &str, origin_seq: i64) {
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log \
                 (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, \
                  imported) \
                 VALUES (?1, 'origin-peer', ?2, 'moment.append', ?3, 11, 1)",
                rusqlite::params![WS, origin_seq, json!({ "momentId": moment_id }).to_string()],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("journal the moment as imported");
}

fn seed_collection(store: &mut EngineStore) {
    write(
        store,
        "tasks/collection.yaml",
        "fields:\n  status:\n    type: text\n",
        "schema",
        10,
    );
}

#[test]
fn a_record_added_and_removed_on_this_computer_claims_once_each() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, LIFECYCLE, 5);
    seed_collection(&mut store);
    write(
        &mut store,
        "tasks/alpha.md",
        &record(ALPHA, "open"),
        "alpha-created",
        11,
    );

    let added = reconcile(&mut store, 20);
    assert_eq!(
        added.len(),
        1,
        "one automation, one added record: {added:?}"
    );
    let claim = &added[0];
    assert_eq!(claim.automation_id, LIFECYCLE);
    assert_eq!(claim.record_id.as_deref(), Some(ALPHA));
    assert_eq!(claim.change.kind, AutomationChangeKind::Added);
    assert_eq!(
        claim.trigger,
        AutomationTrigger::Moment {
            moment_order: moment_order(&store, "alpha-created"),
        },
        "the key is the moment that created the file"
    );
    assert!(
        reconcile(&mut store, 21).is_empty(),
        "a second pass adds nothing"
    );

    // Breaking the frontmatter unbinds the record, but its file never left
    // the Collection: no removal. Healing it binds the record again under
    // the same creating moment: no second addition.
    write(
        &mut store,
        "tasks/alpha.md",
        "---\nstatus: [\n---\n",
        "alpha-broken",
        30,
    );
    assert!(
        reconcile(&mut store, 31).is_empty(),
        "a broken record is not removed"
    );
    write(
        &mut store,
        "tasks/alpha.md",
        &record(ALPHA, "done"),
        "alpha-healed",
        40,
    );
    assert!(
        reconcile(&mut store, 41).is_empty(),
        "a healed record is not added again"
    );

    VersionedTextStore::new(&mut store)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: WS.to_owned(),
                version_id: MAIN.to_owned(),
                path: "tasks/alpha.md".to_owned(),
                moment_id: "alpha-deleted".to_owned(),
                request_id: None,
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 50,
            },
            &NoFaults,
        )
        .expect("delete record");
    let removed = reconcile(&mut store, 51);
    assert_eq!(removed.len(), 1, "{removed:?}");
    assert_eq!(removed[0].record_id.as_deref(), Some(ALPHA));
    assert_eq!(removed[0].change.kind, AutomationChangeKind::Removed);
    assert_eq!(
        removed[0].trigger,
        AutomationTrigger::Moment {
            moment_order: moment_order(&store, "alpha-deleted"),
        }
    );
    assert!(reconcile(&mut store, 52).is_empty());

    let facts = served_facts(&mut store, 60);
    assert_eq!(
        facts,
        vec![
            (AutomationChangeKind::Added, None, Some(json!("open"))),
            (AutomationChangeKind::Removed, Some(json!("done")), None),
        ],
        "an added record lists its values, a removed one its last values"
    );
}

/// Drain every pending claim and read its `status` fact.
fn served_facts(
    store: &mut EngineStore,
    now_ms: i64,
) -> Vec<(
    AutomationChangeKind,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
)> {
    let whole = |value: &Option<AutomationFactValue>| match value {
        Some(AutomationFactValue::Whole { value }) => Some(value.clone()),
        Some(AutomationFactValue::Truncated { .. }) => panic!("a short value travels whole"),
        None => None,
    };
    let mut served = Vec::new();
    while let Some((claim, facts)) = dohc_engine_domain::claim_next_pending_automation(
        store,
        WS,
        "collection:",
        now_ms,
        &NoFaults,
    )
    .expect("claim next")
    {
        let status = facts
            .fields
            .iter()
            .find(|fact| fact.field_name == "status")
            .expect("status fact");
        assert_eq!(
            status.history_id, None,
            "a lifecycle fact has no history row"
        );
        served.push((
            claim.change.kind,
            whole(&status.previous),
            whole(&status.next),
        ));
    }
    served
}

/// A record moved out of its Collection is removed by the move, even when
/// the moved file is edited before reconcile runs.
#[test]
fn a_record_moved_out_of_its_collection_is_removed_by_the_rename() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, LIFECYCLE, 5);
    seed_collection(&mut store);
    write(
        &mut store,
        "tasks/gamma.md",
        &record(GAMMA, "open"),
        "gamma-created",
        11,
    );
    assert_eq!(reconcile(&mut store, 20).len(), 1);

    VersionedTextStore::new(&mut store)
        .rename_text_file(
            &RenameTextFile {
                workspace_id: WS.to_owned(),
                version_id: MAIN.to_owned(),
                from_path: "tasks/gamma.md".to_owned(),
                to_path: "archive/gamma.md".to_owned(),
                moment_id: "gamma-moved".to_owned(),
                request_id: None,
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
            },
            &NoFaults,
        )
        .expect("move record out");
    write_object(
        &mut store,
        (MAIN, "object:tasks/gamma.md"),
        "archive/gamma.md",
        &record(GAMMA, "done"),
        "gamma-edited",
        31,
        None,
    );
    let removed = reconcile(&mut store, 32);
    assert_eq!(removed.len(), 1, "{removed:?}");
    assert_eq!(removed[0].change.kind, AutomationChangeKind::Removed);
    assert_eq!(
        removed[0].trigger,
        AutomationTrigger::Moment {
            moment_order: moment_order(&store, "gamma-moved"),
        }
    );
}

#[test]
fn a_synced_or_older_moment_claims_nothing() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, LIFECYCLE, 5);
    seed_collection(&mut store);

    // Another computer created beta: replication imported its moment.
    write(
        &mut store,
        "tasks/beta.md",
        &record(BETA, "open"),
        "beta-remote",
        11,
    );
    import(&mut store, "beta-remote", 7);
    assert!(
        reconcile(&mut store, 20).is_empty(),
        "the computer that created the file claims it, not this one"
    );

    // A subscription made after gamma's file was created does not claim it.
    write(
        &mut store,
        "tasks/gamma.md",
        &record(GAMMA, "open"),
        "gamma-created",
        30,
    );
    subscribe(&mut store, "collection:tasks#late", 35);
    let claims = reconcile(&mut store, 40);
    assert_eq!(
        claims
            .iter()
            .map(|claim| claim.automation_id.as_str())
            .collect::<Vec<_>>(),
        vec![LIFECYCLE],
        "only the subscription that existed when the file was created claims"
    );
}

/// A record an automation creates declares the automation as its author, so
/// the writing automation never claims its own creation and a creation at
/// the chain depth cap records a stop instead of running.
#[test]
fn an_automation_authored_creation_keeps_the_self_skip_and_the_depth_cap() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, LIFECYCLE, 5);
    subscribe(&mut store, "collection:tasks#other", 5);
    seed_collection(&mut store);
    let author = |depth: u32| {
        json!([{
            "kind": "automation",
            "automationId": LIFECYCLE,
            "onBehalfOf": "user:ice",
            "depth": depth,
        }])
        .to_string()
    };
    write_as(
        &mut store,
        "tasks/alpha.md",
        &record(ALPHA, "open"),
        "alpha-created",
        11,
        Some(author(1)),
    );
    let claims = reconcile(&mut store, 20);
    assert_eq!(
        claims
            .iter()
            .map(|claim| claim.automation_id.as_str())
            .collect::<Vec<_>>(),
        vec!["collection:tasks#other"],
        "the automation that created the record does not claim it"
    );
    assert_eq!(claims[0].depth, 1);
    assert_eq!(
        claims[0].change.author_origin_id.as_deref(),
        Some(LIFECYCLE)
    );
    assert_eq!(
        claims[0].change.actor_kind,
        Some(dohc_engine_domain::ChangeActorKind::Automation)
    );

    write_as(
        &mut store,
        "tasks/beta.md",
        &record(BETA, "open"),
        "beta-created",
        30,
        Some(author(dohc_engine_domain::AUTOMATION_CHAIN_DEPTH_CAP)),
    );
    let stopped = reconcile(&mut store, 40);
    assert_eq!(stopped.len(), 1, "{stopped:?}");
    assert!(
        stopped[0].chain_stopped(),
        "a creation at the cap stops the chain"
    );
}

/// Expiring run history keeps an added claim's key, so a record whose
/// binding comes back later is not added twice.
#[test]
fn a_pruned_added_claim_keeps_its_key() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe_automation(
        &mut store,
        WS,
        &AutomationSubscription {
            automation_id: LIFECYCLE.to_owned(),
            prefix: "tasks".to_owned(),
            kinds: vec![AutomationChangeKind::Added, AutomationChangeKind::Changed],
            fields: None,
        },
        5,
        &NoFaults,
    )
    .expect("subscribe");
    seed_collection(&mut store);
    write(
        &mut store,
        "tasks/alpha.md",
        &record(ALPHA, "open"),
        "alpha-created",
        11,
    );
    assert_eq!(reconcile(&mut store, 20).len(), 1);
    let (claim, _) = dohc_engine_domain::claim_next_pending_automation(
        &mut store,
        WS,
        "collection:",
        1_000,
        &NoFaults,
    )
    .expect("claim next")
    .expect("the added claim");
    dohc_engine_domain::settle_automation_claim(
        &mut store,
        WS,
        &claim.claim_id,
        &dohc_engine_domain::AutomationSettle::Done,
        1_000,
        &NoFaults,
    )
    .expect("settle");
    let pruned = dohc_engine_domain::prune_automation_history(
        &mut store,
        WS,
        &[],
        1_001 + dohc_engine_domain::AUTOMATION_HISTORY_RETENTION_MS,
        &NoFaults,
    )
    .expect("prune");
    assert_eq!(pruned.pruned, 1);
    let added_facts: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT change_fields_json FROM automation_claims \
                 WHERE workspace_id = ?1 AND change_kind = 'added'",
                [WS],
                |row| row.get(0),
            )
        })
        .expect("the added claim is kept after it expires");
    assert_eq!(added_facts, "[]", "a kept added claim drops its facts");

    write(
        &mut store,
        "tasks/alpha.md",
        "---\nstatus: [\n---\n",
        "alpha-broken",
        2_000,
    );
    assert!(reconcile(&mut store, 2_001).is_empty());
    write(
        &mut store,
        "tasks/alpha.md",
        &record(ALPHA, "done"),
        "alpha-healed",
        2_010,
    );
    assert!(
        reconcile(&mut store, 2_011).is_empty(),
        "the kept key stops a second addition"
    );
}

/// A record made on a branch is added there, once. Merging it into main
/// replays that change: main binds the record and claims nothing more.
#[test]
fn a_record_merged_from_a_branch_is_added_once() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, LIFECYCLE, 5);
    seed_collection(&mut store);
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "feat".to_owned(),
                name: "feature".to_owned(),
                from_version_id: MAIN.to_owned(),
                now_ms: 11,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("fork");
    write_object(
        &mut store,
        ("feat", "object:feat/alpha"),
        "tasks/alpha.md",
        &record(ALPHA, "open"),
        "alpha-on-feat",
        12,
        None,
    );
    assert_eq!(
        claimed(&reconcile_version(&mut store, "feat", 20)),
        vec![(AutomationChangeKind::Added, ALPHA)],
        "the branch that made the record adds it"
    );

    let merged = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version_with(
            &MergeTextFileFromVersion {
                workspace_id: WS.to_owned(),
                target_version_id: MAIN.to_owned(),
                source_version_id: "feat".to_owned(),
                path: "tasks/alpha.md".to_owned(),
                object_id: "object:main/alpha".to_owned(),
                moment_id: "alpha-merged".to_owned(),
                request_id: None,
                conflict_id: "alpha-conflict".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
            },
            &NoFaults,
            |_, _| Ok(()),
        )
        .expect("merge");
    assert!(matches!(merged, MergeTextFileResult::Write { .. }));
    assert!(
        reconcile(&mut store, 31).is_empty(),
        "main claims nothing for the merged record"
    );
    let bound: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_records \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND record_id = ?3",
                [WS, MAIN, ALPHA],
                |row| row.get(0),
            )
        })
        .expect("main's binding");
    assert_eq!(bound, 1, "main did bind the merged record");
}

/// A folder that becomes a Collection around its files adds none of them,
/// whether its schema is created or renamed in from a sibling file; a file
/// created in it afterwards is added.
#[test]
fn a_collection_made_around_existing_files_adds_none_of_them() {
    for renamed_in in [false, true] {
        let scratch = ScratchDir::new().expect("scratch");
        let mut store = open_store(&scratch);
        subscribe(&mut store, LIFECYCLE, 5);
        if renamed_in {
            write(
                &mut store,
                "tasks/schema.tmp",
                "fields:\n  status:\n    type: text\n",
                "schema-draft",
                6,
            );
        }
        write(
            &mut store,
            "tasks/alpha.md",
            &record(ALPHA, "open"),
            "alpha-created",
            8,
        );
        if renamed_in {
            VersionedTextStore::new(&mut store)
                .rename_text_file(
                    &RenameTextFile {
                        workspace_id: WS.to_owned(),
                        version_id: MAIN.to_owned(),
                        from_path: "tasks/schema.tmp".to_owned(),
                        to_path: "tasks/collection.yaml".to_owned(),
                        moment_id: "schema-renamed".to_owned(),
                        request_id: None,
                        metadata_origin: "test".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 10,
                    },
                    &NoFaults,
                )
                .expect("rename the schema into place");
        } else {
            seed_collection(&mut store);
        }
        assert!(
            reconcile(&mut store, 20).is_empty(),
            "alpha was in the folder before it was a Collection (renamed in: {renamed_in})"
        );
        write(
            &mut store,
            "tasks/beta.md",
            &record(BETA, "open"),
            "beta-created",
            30,
        );
        assert_eq!(
            claimed(&reconcile(&mut store, 31)),
            vec![(AutomationChangeKind::Added, BETA)]
        );
    }
}

/// A bound record's `id` belongs to the engine, but a record whose
/// frontmatter broke is unbound, and healing it under another id binds a
/// new record. That record is added, keyed like the old one by the moment
/// its file entered the Collection.
#[test]
fn a_record_healed_under_a_new_id_is_added_under_it() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, LIFECYCLE, 5);
    seed_collection(&mut store);
    write(
        &mut store,
        "tasks/alpha.md",
        &record(ALPHA, "open"),
        "alpha-created",
        11,
    );
    assert_eq!(reconcile(&mut store, 20).len(), 1);
    write(
        &mut store,
        "tasks/alpha.md",
        "---\nstatus: [\n---\n",
        "alpha-broken",
        25,
    );
    assert!(reconcile(&mut store, 26).is_empty());
    write(
        &mut store,
        "tasks/alpha.md",
        &record(BETA, "open"),
        "alpha-renumbered",
        30,
    );
    let claims = reconcile(&mut store, 31);
    assert_eq!(claimed(&claims), vec![(AutomationChangeKind::Added, BETA)]);
    assert_eq!(
        claims[0].trigger,
        AutomationTrigger::Moment {
            moment_order: moment_order(&store, "alpha-created"),
        }
    );
}

/// An import that was refused wrote nothing: a moment of this computer's
/// that shares its moment id is still this computer's, as sync enrolment
/// reads it.
#[test]
fn a_refused_import_leaves_the_moment_local() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, LIFECYCLE, 5);
    seed_collection(&mut store);
    write(
        &mut store,
        "tasks/beta.md",
        &record(BETA, "open"),
        "beta-created",
        11,
    );
    import(&mut store, "beta-created", 7);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_pending_refusals \
                 (workspace_id, origin_id, origin_seq, op_kind, reason_code, reason_message) \
                 VALUES (?1, 'origin-peer', 7, 'moment.append', 'invalid-input', 'refused')",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("refuse the import");
    assert_eq!(
        claimed(&reconcile(&mut store, 20)),
        vec![(AutomationChangeKind::Added, BETA)]
    );
}

/// A record bound with only its `id` is added with no values. Its first
/// field write is a change that every automation hears, including one that
/// also wants added records, so none misses the first values.
#[test]
fn a_record_added_with_only_its_id_claims_its_first_values_as_a_change() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    for (automation_id, kinds) in [
        (
            "collection:tasks#both",
            vec![AutomationChangeKind::Added, AutomationChangeKind::Changed],
        ),
        (
            "collection:tasks#changed",
            vec![AutomationChangeKind::Changed],
        ),
    ] {
        subscribe_automation(
            &mut store,
            WS,
            &AutomationSubscription {
                automation_id: automation_id.to_owned(),
                prefix: "tasks".to_owned(),
                kinds,
                fields: None,
            },
            5,
            &NoFaults,
        )
        .expect("subscribe");
    }
    seed_collection(&mut store);
    write(
        &mut store,
        "tasks/alpha.md",
        &format!("---\nid: {ALPHA}\n---\n\nBody"),
        "alpha-created",
        11,
    );
    let added = reconcile(&mut store, 20);
    assert_eq!(claimed(&added), vec![(AutomationChangeKind::Added, ALPHA)]);
    assert_eq!(added[0].automation_id, "collection:tasks#both");

    let claims = store
        .write_with(&NoFaults, |tx| {
            let facts = dohc_engine_domain::index_collection_record_text_in_tx(
                tx,
                WS,
                MAIN,
                "object:tasks/alpha.md",
                "tasks/alpha.md",
                &record(ALPHA, "open"),
                None,
                None,
                30,
            )?
            .expect("the first values are a change");
            assert!(facts.created, "the record's first field write");
            dohc_engine_domain::claim_automation_triggers_in_tx(tx, WS, &facts, 30)
        })
        .expect("claim");
    let TxnOutcome::Committed(claims) = claims else {
        unreachable!("no faults injected")
    };
    assert_eq!(
        claims
            .iter()
            .map(|claim| (claim.automation_id.as_str(), claim.change.kind))
            .collect::<Vec<_>>(),
        vec![
            ("collection:tasks#both", AutomationChangeKind::Changed),
            ("collection:tasks#changed", AutomationChangeKind::Changed),
        ]
    );
}

#[test]
fn every_author_in_a_shared_creation_keeps_the_automation_self_skip() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    subscribe(&mut store, LIFECYCLE, 5);
    subscribe(&mut store, "collection:tasks#other", 5);
    seed_collection(&mut store);
    write_as(
        &mut store,
        "tasks/alpha.md",
        &record(ALPHA, "open"),
        "shared-created",
        11,
        Some(
            json!([
                {"kind":"automation","automationId":LIFECYCLE,"onBehalfOf":"user:ice","depth":2},
                {"kind":"agent","agentId":"collaborator","onBehalfOf":"user:ice"}
            ])
            .to_string(),
        ),
    );
    let claims = reconcile(&mut store, 20);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].automation_id, "collection:tasks#other");
    assert_eq!(claims[0].depth, 2);
    assert_eq!(claims[0].change.author_origin_id, None);
}
