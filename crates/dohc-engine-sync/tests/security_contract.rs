use dohc_engine_domain::{AGENT_CHANNEL_WIRE_ID, GENERAL_CHANNEL_WIRE_ID};
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
    read: String,
}

#[test]
fn generated_ts_security_contract_matches_claimed_rust_floor() {
    let fixture: Fixture = serde_json::from_str(include_str!("fixtures/security-contract.json"))
        .expect("generated fixture parses");
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
