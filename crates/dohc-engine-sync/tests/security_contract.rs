use dohc_engine_domain::{AGENT_CHANNEL_WIRE_ID, GENERAL_CHANNEL_WIRE_ID};
use dohc_engine_files::policy::{PathClassification, classify_engine_file_path};
use dohc_engine_sync::{
    MAX_SHARE_VERSION_ID_CHARS, PathClass, ShareAccess, classify_share_path,
    is_valid_share_version_id,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    wire_ids: WireIds,
    vectors: Vec<Vector>,
    share_version_ids: ShareVersionIds,
    share_access: ShareAccessFixture,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareAccessFixture {
    values: Vec<String>,
    vectors: Vec<ShareAccessVector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareAccessVector {
    value: String,
    valid: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareVersionIds {
    max_chars: usize,
    vectors: Vec<ShareVersionIdVector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareVersionIdVector {
    value: String,
    valid: bool,
    utf16_length: usize,
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

/// The share boundary refuses a served `moment.append` whose claimed
/// `versionId` is not one the relay could have issued, and "could have issued"
/// is the selector rule the relay itself applies —
/// `isValidShareVersionId` in `packages/security-contract/src/shareSelector.ts`.
/// One rule, one place, two processes: this holds the Rust twin to the live
/// TypeScript oracle vector by vector, so widening or narrowing the rule on
/// either side moves a vector and fails here.
#[test]
fn generated_ts_share_version_id_rule_matches_the_rust_twin() {
    let fixture = fixture();
    assert_eq!(
        fixture.share_version_ids.max_chars, MAX_SHARE_VERSION_ID_CHARS,
        "the version-id budget must be the same number on both sides"
    );
    for vector in fixture.share_version_ids.vectors {
        assert_eq!(
            is_valid_share_version_id(&vector.value),
            vector.valid,
            "the share version-id rule disagrees with the TypeScript oracle for {:?}",
            vector.value
        );
        // The verdict alone would let the two sides agree while measuring
        // different things. The unit the budget counts is UTF-16 code units —
        // `String.length` in the oracle — and the boundary reports that number
        // when it refuses, so the twin must agree on the NUMBER too.
        assert_eq!(
            vector.value.encode_utf16().count(),
            vector.utf16_length,
            "the version-id length unit disagrees with the TypeScript oracle for {:?}",
            vector.value
        );
    }
}

/// The file-share access level (#646, S7): both sides must accept EXACTLY
/// `view`, `comment`, `edit` and refuse everything else, including the case
/// variants and padded values a lax parser would let through. This holds the
/// Rust twin (`ShareAccess::parse`) to the TypeScript oracle
/// (`isShareAccessValue` in `packages/security-contract/src/shareSelector.ts`)
/// vector by vector — a level added, removed, or renamed on either side moves
/// a vector and fails here.
#[test]
fn generated_ts_share_access_rule_matches_the_rust_twin() {
    let fixture = fixture();
    // The level SET, not just the parse rule: each value the TypeScript side
    // offers must name a distinct Rust variant, in the same order. A level
    // added on one side only cannot pass this.
    let parsed: Vec<Option<ShareAccess>> = fixture
        .share_access
        .values
        .iter()
        .map(|value| ShareAccess::parse(value))
        .collect();
    assert_eq!(
        parsed,
        vec![
            Some(ShareAccess::View),
            Some(ShareAccess::Comment),
            Some(ShareAccess::Edit)
        ],
        "the accepted level set must be the same three levels, in the same order, on both sides"
    );
    for vector in fixture.share_access.vectors {
        assert_eq!(
            ShareAccess::parse(&vector.value).is_some(),
            vector.valid,
            "the share access rule disagrees with the TypeScript oracle for {:?}",
            vector.value
        );
    }
}
