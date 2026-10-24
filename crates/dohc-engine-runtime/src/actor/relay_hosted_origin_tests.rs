//! #2088: creating a hosted replica asks the relay for the highest position
//! at its origin, on every attach.

use super::*;
use dohc_engine_testkit::{ScratchDir, engine_db_path};

const ORIGIN: &str = "service-host:host";

fn create(new_origin_id: &str) -> RelayOperation {
    RelayOperation::CreateHostedReplica {
        workspace_id: "ws".to_owned(),
        new_origin_id: new_origin_id.to_owned(),
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
        created_at_ms: 1_000,
    }
}

/// The probe of the replica created under `ORIGIN`.
fn probe() -> RelayIoRequest {
    RelayIoRequest::PushHosted(PushRequest {
        workspace_id: "ws".to_owned(),
        replication_epoch: "epoch".to_owned(),
        stream_identity: "stream".to_owned(),
        origin_id: ORIGIN.to_owned(),
        after_seq: -1,
        ops: Vec::new(),
    })
}

fn relay_max(current_max_origin_seq: i64) -> Result<RelayIoResponse, RelayError> {
    Ok(RelayIoResponse::Push(PushResponse {
        settlement_refusals: Vec::new(),
        hosted_refusals: Vec::new(),
        redundant_recoveries: Vec::new(),
        accepted: 0,
        inserted: 0,
        skipped: 0,
        current_max_origin_seq,
    }))
}

/// Run one create to its end as the actor does, answering each request it
/// sends with `answer`. Returns its outcome and every request it sent.
fn create_answering(
    store: &mut EngineStore,
    new_origin_id: &str,
    answer: Result<RelayIoResponse, RelayError>,
) -> (
    Result<RelayOperationOutcome, RuntimeError>,
    Vec<RelayIoRequest>,
) {
    let transport = DeferredRelayTransport::default();
    let mut sent = Vec::new();
    for _ in 0..4 {
        let outcome = execute_relay_operation(
            store,
            &mut WriterDocCache::new(),
            transport.clone(),
            create(new_origin_id),
            &LeaseRegistry::default(),
            &ClaimAnnouncer::default(),
            &mut crate::actor::live_application::Registry::default(),
        );
        match outcome {
            Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING => {
                let request = transport.take_pending().expect("a pending request");
                sent.push(request.clone());
                transport.complete(request, answer.clone());
            }
            outcome => {
                if outcome.is_ok() {
                    assert!(
                        transport.state.lock().unwrap().completed.is_empty(),
                        "the replay used the answer and let it go"
                    );
                }
                return (outcome, sent);
            }
        }
    }
    panic!("the create did not finish: {sent:?}");
}

fn store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().unwrap();
    let store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1_000).unwrap();
    (scratch, store)
}

#[test]
fn every_create_probes_the_origin_once_and_replays_with_its_answer() {
    let (_scratch, mut store) = store();
    let (created, sent) = create_answering(&mut store, ORIGIN, relay_max(-1));
    assert!(
        matches!(created, Ok(RelayOperationOutcome::HostedReplicaCreated)),
        "{created:?}"
    );
    assert_eq!(sent, [probe()]);

    // A later attach mints another origin; the replica keeps its own, and
    // the relay is asked again.
    let (again, sent) = create_answering(&mut store, "service-host:other", relay_max(-1));
    assert!(
        matches!(again, Ok(RelayOperationOutcome::HostedReplicaCreated)),
        "{again:?}"
    );
    assert_eq!(sent, [probe()]);
}

#[test]
fn a_relay_past_the_replicas_origin_fails_the_create() {
    let (_scratch, mut store) = store();
    let (created, _) = create_answering(&mut store, ORIGIN, relay_max(-1));
    assert!(created.is_ok(), "{created:?}");

    let (diverged, sent) = create_answering(&mut store, ORIGIN, relay_max(3));
    assert!(
        matches!(
            diverged,
            Err(RuntimeError::Relay(RelayError::OriginDiverged))
        ),
        "{diverged:?}"
    );
    assert_eq!(sent, [probe()]);
}

#[test]
fn a_probe_error_leaves_the_replica_created_and_a_retry_succeeds() {
    let (_scratch, mut store) = store();
    let (failed, sent) =
        create_answering(&mut store, ORIGIN, Err(RelayError::WorkspaceUnavailable));
    assert!(
        matches!(
            failed,
            Err(RuntimeError::Relay(RelayError::WorkspaceUnavailable))
        ),
        "{failed:?}"
    );
    assert_eq!(sent, [probe()]);
    assert!(is_hosted_replica(&store, "ws").unwrap());

    let (retried, sent) = create_answering(&mut store, "service-host:retry", relay_max(-1));
    assert!(
        matches!(retried, Ok(RelayOperationOutcome::HostedReplicaCreated)),
        "{retried:?}"
    );
    assert_eq!(sent, [probe()]);
}
