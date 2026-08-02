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

/// The share boundary is the single gate every op kind passes before replay,
/// and `replay_share_delete` carries no floor of its own. So a relay-sent
/// delete is refused only while `classify_share_path` calls secret everything
/// the files policy calls secret.
///
/// `classify_share_path` reads that verdict from
/// `dohc_engine_files::policy::normalized_path_is_secret`, so the two sets are
/// equal by construction and a new secret class reaches both callers at once.
/// A vector list cannot claim that — it proves only the shapes it names.
///
/// This test guards the one thing construction cannot: a future edit that
/// restates the rules at the boundary instead of calling the shared one, which
/// is the #484 shape returning. A widened pre-check is deliberately not
/// guarded — the grammar and ignored-segment checks run first, so widening one
/// turns a secret verdict into `Unsafe` or `Ignored`, which is still refused.
///
/// Both directions are asserted, because either side gaining a class alone is
/// drift. `Ignored` and `Unsafe` count as agreement: both gates admit only
/// `Tracked`, so a path either of them refuses can be neither written nor
/// deleted, whichever word it is refused under. That absorbs the two places
/// the domains genuinely differ, and each has a vector here:
///
/// - `shared-with-me/...` is a write reservation the files policy owns and the
///   share classifier knows nothing about, so the classifier reads such a path
///   structurally (`shared-with-me/alex/.env` is secret) while the write floor
///   calls the whole mount ignored.
/// - The share classifier accepts only already-normalized paths, so secret
///   material the files policy reaches through normalization (`./config/.env`)
///   is unsafe at the boundary.
#[test]
fn the_share_secret_set_and_the_files_policy_secret_set_agree() {
    for vector in fixture().vectors {
        let share = classify_share_path(&vector.path);
        let files = classify_engine_file_path(&vector.path);
        assert!(
            !(files == PathClassification::Secret && share == PathClass::Tracked),
            "the files policy calls {} secret, so the share boundary must not \
             replay a delete of it as tracked",
            vector.path
        );
        assert!(
            !(share == PathClass::Secret && files == PathClassification::Tracked),
            "the share boundary calls {} secret, so the files policy must not \
             store it as tracked",
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
