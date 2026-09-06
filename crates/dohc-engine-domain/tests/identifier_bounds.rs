//! The refusal `MAX_IDENTIFIER_BYTES` produces, and the bounds on moment
//! metadata and author fields.
//!
//! Identifiers a caller mints are ECHOED. A `versionedText.write` answer
//! repeats the object id across `object.id`, `snapshot.objectId` and
//! `moment.objectId`, and the moment id across the snapshot and the moment,
//! and reserves no response bytes for either. So an identifier no rule bounds
//! turns a request that fits its 8 MiB control frame into a response that
//! cannot — after the write has committed.
//!
//! This is not the bound on a conflict row's identifiers.
//! `CONFLICT_METADATA_BUDGET_BYTES` owns those, derived from what one
//! `conflicts.list` page can serve, and it admits a far longer id on purpose.

use dohc_engine_domain::{
    DomainError, MAX_AUTHOR_FIELD_BYTES, MAX_AUTHOR_JSON_BYTES, MAX_METADATA_FIELD_BYTES, NoFaults,
    VersionedTextStore, WriteText,
};
use dohc_engine_storage::{EngineStore, MAX_IDENTIFIER_BYTES};
use dohc_engine_testkit::{ScratchDir, engine_db_path};

const NO_FAULTS: NoFaults = NoFaults;
const WS: &str = "ws-identifier-bounds";

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
    let mut store = EngineStore::open(&engine_db_path(scratch).expect("db"), 1).expect("open");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NO_FAULTS)
        .expect("ensure main");
    store
}

/// One byte past the bound is refused, and the refusal names the field, the
/// constraint, the limit, the unit and the observed length — everything an
/// agent needs to shorten the id it sent.
///
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

#[test]
fn an_over_long_metadata_origin_is_refused_with_its_measurements() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open(&scratch);
    let mut input = write("object-origin", "moment-origin");
    input.metadata_origin = "o".repeat(MAX_METADATA_FIELD_BYTES + 1);

    let error = match VersionedTextStore::new(&mut store).write_text(&input, &NO_FAULTS) {
        Err(error) => error,
        Ok(_) => panic!("over-long metadata origin was accepted"),
    };
    assert!(matches!(
        error,
        DomainError::PayloadTooLarge {
            constraint: "MAX_METADATA_FIELD_BYTES",
            limit_bytes: MAX_METADATA_FIELD_BYTES,
            observed_bytes,
        } if observed_bytes == MAX_METADATA_FIELD_BYTES + 1
    ));
}

#[test]
fn an_over_large_author_json_is_refused_with_its_measurements() {
    let mut author = serde_json::Map::new();
    for (field, value) in [
        ("kind", "agent"),
        ("agentId", "agent-1"),
        ("onBehalfOf", "local"),
        ("agentRunId", "run-1"),
    ] {
        author.insert(field.to_owned(), serde_json::json!(value));
    }
    for index in 0..400 {
        author.insert(
            format!("padding-{index}"),
            serde_json::json!("x".repeat(32)),
        );
    }
    assert!(author.values().all(|value| {
        value
            .as_str()
            .is_some_and(|field| field.len() < MAX_AUTHOR_FIELD_BYTES)
    }));
    let author_json = serde_json::Value::Object(author).to_string();
    assert!(author_json.len() > MAX_AUTHOR_JSON_BYTES);

    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open(&scratch);
    let mut input = write("object-author", "moment-author");
    input.author_json = Some(author_json.clone());
    let error = match VersionedTextStore::new(&mut store).write_text(&input, &NO_FAULTS) {
        Err(error) => error,
        Ok(_) => panic!("over-large author JSON was accepted"),
    };
    assert!(matches!(
        error,
        DomainError::PayloadTooLarge {
            constraint: "MAX_AUTHOR_JSON_BYTES",
            limit_bytes: MAX_AUTHOR_JSON_BYTES,
            observed_bytes,
        } if observed_bytes == author_json.len()
    ));
}
