//! The measurement behind `MAX_IDENTIFIER_BYTES`, and the refusal it produces.
//!
//! Identifiers a caller mints are ECHOED. A `versionedText.write` answer
//! repeats the object id across `object.id`, `snapshot.objectId` and
//! `moment.objectId`, and the moment id across the snapshot and the moment,
//! and reserves no response bytes for either. So an identifier no rule bounds
//! turns a request that fits its 8 MiB control frame into a response that
//! cannot — after the write has committed (#654).
//!
//! This is NOT the bound on a conflict row's identifiers.
//! `CONFLICT_METADATA_BUDGET_BYTES` owns those, derived from what one
//! `conflicts.list` page can serve, and it admits a far longer id on purpose.
//!
//! AGENTS.md ("Measure limits that reject work") governs a bound that refuses
//! otherwise-valid work, so the healthy range is measured here rather than
//! assumed, and the bound sits past it.

use dohc_engine_domain::{
    DomainError, MAX_AUTHOR_FIELD_BYTES, MAX_METADATA_FIELD_BYTES, NoFaults, VersionedTextStore,
    WriteText, derive_capture_object_id,
};
use dohc_engine_storage::{EngineStore, MAX_IDENTIFIER_BYTES};
use dohc_engine_testkit::ScratchDir;

const NO_FAULTS: NoFaults = NoFaults;
const WS: &str = "ws-identifier-bounds";

/// Every identifier shape the product mints, at its real length.
///
/// `randomUUID()` is 36 bytes. The desktop prefixes it where the id needs to
/// say what it names (`workspaceEngineCaptureLiveStore.ts` mints
/// `object-<uuid>`, `moment-<uuid>`; `liveAgentDispatchStore.ts` mints
/// `run_<uuid>`). The engine's own widest is `derive_capture_object_id`: an
/// `object-` prefix over a hex SHA-256.
fn healthy_identifiers() -> Vec<(&'static str, String)> {
    let uuid = "6f1c7f6e-1f2b-4a9a-9a4e-2f9c0b7d5e13";
    assert_eq!(uuid.len(), 36, "a v4 UUID is 36 bytes");
    vec![
        ("bare uuid (workspaceId, versionId)", uuid.to_owned()),
        ("object-<uuid> (desktop objectId)", format!("object-{uuid}")),
        ("moment-<uuid> (desktop momentId)", format!("moment-{uuid}")),
        ("run_<uuid> (agent run id)", format!("run_{uuid}")),
        (
            "derive_capture_object_id (engine-minted, widest)",
            derive_capture_object_id(WS, "main", "notes/a-fairly-long-document-name.md"),
        ),
    ]
}

fn write(object: &str, moment: &str) -> WriteText {
    WriteText {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        object_id: object.to_owned(),
        path: "notes/a.md".to_owned(),
        text: "body".to_owned(),
        moment_id: moment.to_owned(),
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 1_000,
        request_id: None,
    }
}

fn open(scratch: &ScratchDir) -> EngineStore {
    let mut store = EngineStore::open(&scratch.engine_db_path().expect("db"), 1).expect("open");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NO_FAULTS)
        .expect("ensure main");
    store
}

/// THE MEASUREMENT. Every identifier the product mints is far inside the
/// bound, and the store accepts the widest of them.
///
/// MUTATION: set `MAX_IDENTIFIER_BYTES` below the measured range — anything
/// under 71 — and this fails twice over: the headroom assertion, and the write
/// that carries the engine's own widest identifier.
#[test]
fn every_identifier_the_product_mints_sits_far_inside_the_bound() {
    let widest = healthy_identifiers()
        .into_iter()
        .max_by_key(|(_, id)| id.len())
        .expect("at least one identifier shape");
    assert_eq!(
        widest.1.len(),
        71,
        "the widest identifier the engine mints is `object-` over a hex SHA-256: {}",
        widest.0
    );
    assert!(
        MAX_IDENTIFIER_BYTES > widest.1.len() * 4,
        "the bound must sit well past the measured healthy range: \
         MAX_IDENTIFIER_BYTES = {MAX_IDENTIFIER_BYTES}, widest healthy identifier = {} bytes ({})",
        widest.1.len(),
        widest.0
    );

    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open(&scratch);
    VersionedTextStore::new(&mut store)
        .write_text(
            &write(&widest.1, &format!("moment-{}", widest.1)),
            &NO_FAULTS,
        )
        .expect("the widest healthy identifier is accepted");
}

/// AND THE REFUSAL. One byte past the bound is refused, and the refusal names
/// the field, the constraint, the limit, the unit and the observed length —
/// everything an agent needs to shorten the id it sent.
///
/// MUTATION: drop the `bounded_identifier` call from `normalized_write_input`
/// and the object-id case commits instead of refusing.
#[test]
fn an_over_long_identifier_is_refused_with_its_measurements() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open(&scratch);
    let over_cap = "x".repeat(MAX_IDENTIFIER_BYTES + 1);

    for (field, input) in [
        ("object_id", write(&over_cap, "moment-1")),
        ("moment_id", write("object-1", &over_cap)),
    ] {
        let error = VersionedTextStore::new(&mut store)
            .write_text(&input, &NO_FAULTS)
            .expect_err("an identifier past the bound is refused");
        match error {
            DomainError::IdentifierTooLong {
                field: reported,
                limit_bytes,
                observed_bytes,
            } => {
                assert_eq!(reported, field);
                assert_eq!(limit_bytes, MAX_IDENTIFIER_BYTES);
                assert_eq!(observed_bytes, MAX_IDENTIFIER_BYTES + 1);
            }
            other => panic!("{field} must name its bound, got {other:?}"),
        }
        assert_eq!(
            DomainError::IdentifierTooLong {
                field,
                limit_bytes: MAX_IDENTIFIER_BYTES,
                observed_bytes: MAX_IDENTIFIER_BYTES + 1,
            }
            .to_string(),
            format!(
                "identifier {field} exceeds MAX_IDENTIFIER_BYTES: limit {MAX_IDENTIFIER_BYTES} \
                 bytes, observed {} bytes",
                MAX_IDENTIFIER_BYTES + 1
            ),
        );
    }
}

/// The bound is a length, not a shape: an identifier exactly at it is work the
/// engine still has to do.
#[test]
fn an_identifier_exactly_at_the_bound_is_accepted() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open(&scratch);
    let at_cap = "x".repeat(MAX_IDENTIFIER_BYTES);
    VersionedTextStore::new(&mut store)
        .write_text(&write(&at_cap, &at_cap), &NO_FAULTS)
        .expect("an identifier at the bound is inside it");
}

#[test]
fn moment_metadata_bounds_clear_measured_agent_identifiers_and_report_overruns() {
    let healthy = [
        ("agentId", "dohc-chat-runner-self-test"),
        ("onBehalfOf", "local"),
        ("agentRunId", "run_6f1c7f6e-1f2b-4a9a-9a4e-2f9c0b7d5e13"),
    ];
    let widest = healthy
        .iter()
        .max_by_key(|(_, value)| value.len())
        .expect("healthy author fields");
    assert_eq!(widest.1.len(), 40);
    assert!(MAX_AUTHOR_FIELD_BYTES > widest.1.len() * 4);

    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open(&scratch);
    let mut input = write("object-metadata", "moment-metadata");
    input.metadata_summary = Some("s".repeat(MAX_METADATA_FIELD_BYTES + 1));
    let error = VersionedTextStore::new(&mut store)
        .write_text(&input, &NO_FAULTS)
        .expect_err("over-long metadata is refused");
    assert!(matches!(
        error,
        DomainError::PayloadTooLarge {
            constraint: "MAX_METADATA_FIELD_BYTES",
            limit_bytes: MAX_METADATA_FIELD_BYTES,
            observed_bytes,
        } if observed_bytes == MAX_METADATA_FIELD_BYTES + 1
    ));

    input.metadata_summary = None;
    input.author_json = Some(
        serde_json::json!({
            "kind": "agent",
            "agentId": "a".repeat(MAX_AUTHOR_FIELD_BYTES + 1),
            "onBehalfOf": "local",
        })
        .to_string(),
    );
    let error = VersionedTextStore::new(&mut store)
        .write_text(&input, &NO_FAULTS)
        .expect_err("over-long author field is refused");
    assert!(matches!(
        error,
        DomainError::PayloadTooLarge {
            constraint: "MAX_AUTHOR_FIELD_BYTES",
            limit_bytes: MAX_AUTHOR_FIELD_BYTES,
            observed_bytes,
        } if observed_bytes == MAX_AUTHOR_FIELD_BYTES + 1
    ));
}
