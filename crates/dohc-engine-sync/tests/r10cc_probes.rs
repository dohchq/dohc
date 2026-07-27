//! Adversarial R10-CONFLICT-COMPLETE regressions: convergence / fail-closed /
//! replication invariants on the replicated resolve apply path. Ported from the
//! rev1 (convergence) review worktree and adjusted to assert the shipped fixes
//! (M1 text/delete poison-pill defer, S1 `BinaryApplyFailed` reason).

use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError, hex_sha256};
use dohc_engine_sync::{
    ApplyOutcome, PendingResolveReason, ReplicationEnvelope, apply_conflict_envelope,
};
use dohc_engine_testkit::ScratchDir;
use rusqlite::params;
use serde_json::json;

fn store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&path, 1_000).expect("open");
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("workspace");
    (scratch, store)
}

fn envelope(origin: &str, seq: i64, kind: &str, payload: serde_json::Value) -> ReplicationEnvelope {
    ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: origin.to_owned(),
        origin_seq: seq,
        op_kind: kind.to_owned(),
        payload,
        recorded_at_ms: 2_000 + seq,
    }
}

fn seed_current(store: &mut EngineStore, text: &str) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "current-object".to_owned(),
                path: "doc.md".to_owned(),
                text: text.to_owned(),
                moment_id: "current-moment".to_owned(),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_500,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed current text");
}

/// Open a mirrored (sync-origin) text conflict on doc.md.
fn open_mirrored(store: &mut EngineStore, id: &str, current_exists: bool) {
    let current = if current_exists {
        json!({
            "exists": true, "path": "doc.md", "objectId": "current-object",
            "contentKind": "text", "text": "receiver current", "updatedAtMs": 1_500,
            "latestMomentId": "current-moment", "metadata": { "origin": "sync" }
        })
    } else {
        json!({ "exists": false, "path": "doc.md", "contentKind": "text" })
    };
    let payload = json!({
        "id": id, "workspaceId": "ws", "path": "doc.md",
        "targetVersionId": "main", "sourceVersionId": "peer",
        "createdAtMs": 2_000, "updatedAtMs": 2_000,
        "base": { "exists": false, "path": "doc.md", "contentKind": "text" },
        "current": current,
        "incoming": {
            "exists": true, "path": "doc.md", "objectId": "incoming-object",
            "contentKind": "text", "text": "origin current", "updatedAtMs": 1_900,
            "latestMomentId": "incoming-moment", "metadata": { "origin": "sync" }
        },
        "status": "open", "chosenFrom": "current", "metadata": { "origin": "sync" }
    });
    apply_conflict_envelope(
        store,
        &envelope("peer", 0, "conflict.open", payload),
        &NoFaults,
    )
    .expect("open mirrored conflict");
}

/// Hydrate the binary blob and flip the incoming side to a hydrated binary side.
fn make_incoming_binary(store: &mut EngineStore, id: &str, bytes: &[u8]) -> String {
    let sha = hex_sha256(bytes);
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::conflicts::hydrate_binary_conflict_blob(tx, &sha, bytes)
                .map_err(StorageError::persist_public)?;
            tx.execute(
                "UPDATE conflicts SET incoming_content_kind = 'binary', \
                 incoming_blob_sha256 = NULL, incoming_binary_sha256 = ?1 \
                 WHERE workspace_id = 'ws' AND conflict_id = ?2",
                params![sha, id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("mark binary incoming side");
    sha
}

fn resolve_env(origin: &str, seq: i64, id: &str) -> ReplicationEnvelope {
    envelope(
        origin,
        seq,
        "conflict.resolve",
        json!({
            "conflictId": id, "status": "resolved", "chosenFrom": "current",
            "resolution": "kept-current", "updatedAtMs": 3_000, "targetVersionId": "main"
        }),
    )
}

fn conflict_status(store: &EngineStore, id: &str) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT status FROM conflicts WHERE workspace_id = 'ws' AND conflict_id = ?1",
                params![id],
                |row| row.get(0),
            )
        })
        .expect("status")
}

fn acked_seq(store: &EngineStore, origin: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT acked_seq FROM replication_peers \
                 WHERE workspace_id = 'ws' AND origin_id = ?1",
                params![origin],
                |row| row.get(0),
            )
        })
        .expect("acked seq")
}

fn job_count(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM materialization_jobs", [], |r| {
                r.get(0)
            })
        })
        .expect("job count")
}

fn count(store: &EngineStore, sql: &str) -> i64 {
    store
        .read_with(|conn| conn.query_row(sql, [], |r| r.get(0)))
        .expect("count")
}

fn deferred_reason(
    outcome: &ApplyOutcome<dohc_engine_sync::ConflictApplyResult>,
) -> PendingResolveReason {
    let ApplyOutcome::Applied(result) = outcome else {
        panic!("expected Applied, got {outcome:?}");
    };
    // deferred() derivation must equal pending_resolve.is_some().
    assert_eq!(result.deferred(), result.pending_resolve.is_some());
    assert!(result.deferred(), "expected a deferred result: {result:?}");
    assert!(
        !result.matched,
        "a deferred resolve must not report matched"
    );
    result
        .pending_resolve
        .as_ref()
        .expect("pending resolve present")
        .reason
}

/// PROBE 1 / S1 (savepoint rollback integrity + distinct reason). Force
/// `write_binary_file_in_tx` to fail mid-apply by colliding the
/// deterministically-derived object id with a pre-existing file object. The
/// apply MUST roll back cleanly to the savepoint and DEFER (Ok, not Err),
/// advance the ack, leave NO partial write, and surface `BinaryApplyFailed`
/// (a genuine apply-helper failure — NOT the unhydrated pre-check).
#[test]
fn binary_apply_helper_failure_rolls_back_and_defers_binary_apply_failed() {
    let (_s, mut store) = store();
    // current absent so write_binary_file_in_tx takes the new-object branch.
    open_mirrored(&mut store, "savepoint-c", false);
    let bytes = b"\x00binary payload\xff";
    make_incoming_binary(&mut store, "savepoint-c", bytes);

    // The object id the apply will try to mint for resolve coord (peer, seq=1).
    let seed = "ws:peer:1:object";
    let colliding_object = format!("sync-conflict-object-{}", hex_sha256(seed.as_bytes()));
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws', ?1, 1)",
                params![colliding_object],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("pre-seed colliding object");

    let files_before = count(&store, "SELECT COUNT(*) FROM file_objects");
    let jobs_before = job_count(&store);

    let outcome = apply_conflict_envelope(
        &mut store,
        &resolve_env("peer", 1, "savepoint-c"),
        &NoFaults,
    )
    .expect("helper failure must NOT propagate as Err");

    // Fail-closed: deferred, not applied, not errored; with the distinct reason.
    assert_eq!(
        deferred_reason(&outcome),
        PendingResolveReason::BinaryApplyFailed
    );
    // Row stays open, ack advanced.
    assert_eq!(conflict_status(&store, "savepoint-c"), "open");
    assert_eq!(acked_seq(&store, "peer"), 1);
    // Nothing partial: no new object, no new path alias, no materialization job.
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM file_objects"),
        files_before
    );
    assert_eq!(job_count(&store), jobs_before);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM path_aliases WHERE path = 'doc.md'"
        ),
        0,
        "no path alias may leak from the rolled-back binary write"
    );
}

/// PROBE 2 (no-clobber divergence). A binary incoming resolve whose TEXT current
/// head has moved since the conflict opened must DEFER StaleHead, never clobber
/// the newer live head with the stale binary side.
#[test]
fn binary_apply_defers_stale_head_and_does_not_clobber_live() {
    let (_s, mut store) = store();
    seed_current(&mut store, "receiver current");
    open_mirrored(&mut store, "stale-bin", true);
    make_incoming_binary(&mut store, "stale-bin", b"\x00stale binary\xff");

    // Advance the live head after the conflict opened.
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "current-object".to_owned(),
                path: "doc.md".to_owned(),
                text: "NEWER LIVE HEAD".to_owned(),
                moment_id: "newer-moment".to_owned(),
                metadata_origin: "local".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_500,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("advance live head");
    let jobs_before = job_count(&store);

    let outcome =
        apply_conflict_envelope(&mut store, &resolve_env("peer", 1, "stale-bin"), &NoFaults)
            .expect("stale head must defer, not Err");
    assert_eq!(deferred_reason(&outcome), PendingResolveReason::StaleHead);
    assert_eq!(conflict_status(&store, "stale-bin"), "open");
    assert_eq!(acked_seq(&store, "peer"), 1);
    assert_eq!(
        job_count(&store),
        jobs_before,
        "no binary write may be staged"
    );
    let live = VersionedTextStore::new(&mut store)
        .read_text("ws", "main", "doc.md")
        .expect("read")
        .expect("snapshot")
        .text;
    assert_eq!(live, "NEWER LIVE HEAD", "the live head must be untouched");
}

/// PROBE 3 (path-change divergence). A binary incoming side at a DIFFERENT path
/// than the conflict path must DEFER PathChange, never write.
#[test]
fn binary_apply_defers_path_change() {
    let (_s, mut store) = store();
    seed_current(&mut store, "receiver current");
    open_mirrored(&mut store, "pc-bin", true);
    make_incoming_binary(&mut store, "pc-bin", b"\x00pathchange binary\xff");
    // Move the incoming side to a different path.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE conflicts SET incoming_path = 'renamed.bin' \
                 WHERE workspace_id = 'ws' AND conflict_id = 'pc-bin'",
                [],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("rename incoming");
    let jobs_before = job_count(&store);

    let outcome = apply_conflict_envelope(&mut store, &resolve_env("peer", 1, "pc-bin"), &NoFaults)
        .expect("path change must defer, not Err");
    assert_eq!(deferred_reason(&outcome), PendingResolveReason::PathChange);
    assert_eq!(conflict_status(&store, "pc-bin"), "open");
    assert_eq!(acked_seq(&store, "peer"), 1);
    assert_eq!(job_count(&store), jobs_before);
}

/// PROBE 4 (exactly-once across DISTINCT coordinates). After a binary resolve
/// applies, redelivery of the SAME logical resolution from a different peer
/// coordinate must short-circuit: no second materialization job, no re-close.
#[test]
fn binary_apply_distinct_coordinate_replay_is_idempotent() {
    let (_s, mut store) = store();
    seed_current(&mut store, "receiver current");
    open_mirrored(&mut store, "once-bin", true);
    let sha = make_incoming_binary(&mut store, "once-bin", b"\x00once binary\xff");

    let first =
        apply_conflict_envelope(&mut store, &resolve_env("peer-a", 0, "once-bin"), &NoFaults)
            .expect("first binary resolve");
    assert!(matches!(
        first,
        ApplyOutcome::Applied(ref r) if r.matched && r.pending_resolve.is_none()
    ));
    assert_eq!(conflict_status(&store, "once-bin"), "resolved");
    let jobs_after_first = job_count(&store);
    assert_eq!(jobs_after_first, 1, "exactly one materialization job");
    let staged_sha: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT content_sha256 FROM materialization_jobs LIMIT 1",
                [],
                |r| r.get(0),
            )
        })
        .expect("staged sha");
    assert_eq!(
        staged_sha, sha,
        "the applied sha must be the incoming binary sha"
    );

    // Distinct coordinate (peer-b, seq 0), identical logical resolution.
    let second =
        apply_conflict_envelope(&mut store, &resolve_env("peer-b", 0, "once-bin"), &NoFaults)
            .expect("distinct-coordinate replay");
    assert!(matches!(
        second,
        ApplyOutcome::Applied(ref r) if r.matched && r.pending_resolve.is_none()
    ));
    assert_eq!(
        job_count(&store),
        jobs_after_first,
        "no duplicate materialization job"
    );
    assert_eq!(acked_seq(&store, "peer-b"), 0);
}

/// PROBE 5 (divergent terminal resolution after a binary apply). Once resolved
/// via binary apply, a DIFFERENT terminal resolution at a new coordinate must
/// defer StaleHead, never re-apply / clobber.
#[test]
fn divergent_resolution_after_binary_apply_defers_stale_head() {
    let (_s, mut store) = store();
    seed_current(&mut store, "receiver current");
    open_mirrored(&mut store, "div-bin", true);
    make_incoming_binary(&mut store, "div-bin", b"\x00div binary\xff");
    apply_conflict_envelope(&mut store, &resolve_env("peer-a", 0, "div-bin"), &NoFaults)
        .expect("first resolve applies");
    let jobs_before = job_count(&store);

    // A conflicting terminal resolution (applied-incoming) at a new coordinate.
    let divergent = envelope(
        "peer-b",
        0,
        "conflict.resolve",
        json!({
            "conflictId": "div-bin", "status": "resolved", "chosenFrom": "incoming",
            "resolution": "applied-incoming", "updatedAtMs": 4_000, "targetVersionId": "main"
        }),
    );
    let outcome = apply_conflict_envelope(&mut store, &divergent, &NoFaults)
        .expect("divergent resolution must defer, not Err");
    assert_eq!(deferred_reason(&outcome), PendingResolveReason::StaleHead);
    assert_eq!(
        job_count(&store),
        jobs_before,
        "divergent replay must not re-stage"
    );
    assert_eq!(acked_seq(&store, "peer-b"), 0);
}

/// PROBE 6 / F1 (text apply-time defer, NOT Err-rollback). A sync mirrored
/// conflict whose path is non-tracked (an ignored path) passes `conflict.open`
/// but the text apply's `validate_write_input` rejects the path. Per the
/// ABSOLUTE invariant the resolve MUST defer + ack, never Err-rollback the ack
/// (which would infinitely redeliver — a poison pill). The M1 fix wraps the
/// text apply in a savepoint→defer, so this now surfaces `TextApplyRejected`
/// and the ack advances. The same class holds for text over `MAX_TEXT_BYTES`.
#[test]
fn mirrored_text_resolve_on_ignored_path_defers_and_acks() {
    let (_s, mut store) = store();
    let path = "node_modules/pkg/index.js"; // classified Ignored
    let payload = json!({
        "id": "ignored-path-c", "workspaceId": "ws", "path": path,
        "targetVersionId": "main", "sourceVersionId": "peer",
        "createdAtMs": 2_000, "updatedAtMs": 2_000,
        "base": { "exists": false, "path": path, "contentKind": "text" },
        "current": { "exists": false, "path": path, "contentKind": "text" },
        "incoming": {
            "exists": true, "path": path, "objectId": "incoming-object",
            "contentKind": "text", "text": "origin content", "updatedAtMs": 1_900,
            "latestMomentId": "incoming-moment", "metadata": { "origin": "sync" }
        },
        "status": "open", "chosenFrom": "current", "metadata": { "origin": "sync" }
    });
    apply_conflict_envelope(
        &mut store,
        &envelope("peer", 0, "conflict.open", payload),
        &NoFaults,
    )
    .expect("ignored-path conflict opens and acks");
    assert_eq!(acked_seq(&store, "peer"), 0);

    let outcome = apply_conflict_envelope(
        &mut store,
        &resolve_env("peer", 1, "ignored-path-c"),
        &NoFaults,
    )
    .expect("mirrored resolve on an ignored path must NOT Err-rollback the ack");
    // Invariant: Ok + defer + ack advances (no poison pill).
    assert_eq!(
        deferred_reason(&outcome),
        PendingResolveReason::TextApplyRejected
    );
    assert_eq!(conflict_status(&store, "ignored-path-c"), "open");
    assert_eq!(
        acked_seq(&store, "peer"),
        1,
        "the ack must advance even when the text apply cannot proceed"
    );
}

/// Finding B (ACK-and-defer liveness): a mirrored binary resolve whose derived
/// moment id (== job id) collides with a moment id already in this workspace
/// must ACK-and-DEFER (`BinaryApplyFailed`), NOT fatally `Err`. Before the
/// precheck, the `INSERT INTO moments` hit the UNIQUE constraint → `Storage`
/// (fatal) → the replicated resolve retried forever (poison pill). The binary
/// write now prechecks `moment_exists` and returns `DuplicateMomentId` (a
/// validation rejection), which `apply_within_savepoint` routes to defer.
#[test]
fn binary_apply_defers_on_duplicate_moment_id_instead_of_poison_pilling() {
    let (_s, mut store) = store();
    // Pre-seed a moment with EXACTLY the id the mirrored binary write will derive
    // for resolve coord (peer, seq=1): mirrored_id(envelope, "binary-materialize")
    // = sha256("ws:peer:1:binary-materialize"). A real local write at a different
    // path is the cleanest way to occupy that moment id with a valid row.
    let colliding_moment = format!(
        "sync-conflict-binary-materialize-{}",
        hex_sha256(b"ws:peer:1:binary-materialize")
    );
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "collide-obj".to_owned(),
                path: "other.md".to_owned(),
                text: "occupant".to_owned(),
                moment_id: colliding_moment,
                metadata_origin: "local".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_600,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("pre-seed colliding moment id");

    // current absent → the binary write takes the new-object branch and reaches
    // the moment INSERT (where the collision would otherwise be fatal).
    open_mirrored(&mut store, "dupmoment-bin", false);
    make_incoming_binary(&mut store, "dupmoment-bin", b"\x00dup moment binary\xff");
    let jobs_before = job_count(&store);

    let outcome = apply_conflict_envelope(
        &mut store,
        &resolve_env("peer", 1, "dupmoment-bin"),
        &NoFaults,
    )
    .expect("a duplicate moment id must DEFER, never propagate as Err");

    assert_eq!(
        deferred_reason(&outcome),
        PendingResolveReason::BinaryApplyFailed
    );
    // The conflict stays open and the ack advances — no infinite retry.
    assert_eq!(conflict_status(&store, "dupmoment-bin"), "open");
    assert_eq!(acked_seq(&store, "peer"), 1);
    assert_eq!(
        job_count(&store),
        jobs_before,
        "no binary job may be staged from the rolled-back apply"
    );
}
