use dohc_engine_domain::{AGENT_CHANNEL_WIRE_ID, GENERAL_CHANNEL_WIRE_ID};
use dohc_engine_files::policy::{PathClassification, classify_engine_file_path};
use dohc_engine_sync::{PathClass, classify_share_path};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    wire_ids: WireIds,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct WireIds {
    agent: String,
    general: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    path: String,
    rust_claimed: bool,
    write: String,
    read: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/security-contract.json"))
        .expect("generated fixture parses")
}

/// The write floor is the deliberate Rust twin of the TypeScript
/// `classifyEngineFilePath`, so it must agree on EVERY vector. `rustClaimed`
/// narrows the share classifier asserted below, not this one: the write floor
/// normalizes backslashes and percent-encoding itself, platform-independently.
///
/// Without this the generated `write` column was deserialized by nothing, so
/// the two write classifiers could diverge, someone could regenerate the
/// fixture, and the gate would stay green — the silent divergence #368 exists
/// to close.
#[test]
fn generated_ts_write_floor_matches_the_rust_write_floor() {
    for vector in fixture().vectors {
        let expected = match vector.write.as_str() {
            "tracked" => PathClassification::Tracked,
            "secret" => PathClassification::Secret,
            "ignored" => PathClassification::Ignored,
            other => panic!("unexpected TS fixture class {other}"),
        };
        assert_eq!(
            classify_engine_file_path(&vector.path),
            expected,
            "write floor disagrees with the TypeScript oracle for {}",
            vector.path
        );
    }
}

#[test]
fn generated_ts_security_contract_matches_claimed_rust_floor() {
    let fixture = fixture();
    assert_eq!(fixture.wire_ids.agent, AGENT_CHANNEL_WIRE_ID);
    assert_eq!(fixture.wire_ids.general, GENERAL_CHANNEL_WIRE_ID);
    for vector in fixture.vectors {
        let actual = classify_share_path(&vector.path);
        if vector.rust_claimed {
            let expected = match vector.read.as_str() {
                "tracked" => PathClass::Tracked,
                "secret" => PathClass::Secret,
                "ignored" => PathClass::Ignored,
                other => panic!("unexpected TS fixture class {other}"),
            };
            assert_eq!(actual, expected, "path {}", vector.path);
        } else {
            assert_eq!(
                actual,
                PathClass::Unsafe,
                "unclaimed path must fail closed: {}",
                vector.path
            );
        }
    }
}
