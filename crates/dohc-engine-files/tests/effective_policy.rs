//! Differential test: `search_policy.rs` against the live TypeScript
//! `effectivePolicy.ts` oracle.
//!
//! The Rust module states in its own header that it ports `effectivePolicy.ts`.
//! Without this test that claim is unchecked: glob validation, glob matching,
//! TOML rule parsing, and effective-policy resolution could drift apart while
//! the canonical gate stayed green (issue #477).
//!
//! The fixture is REGENERATED from the TypeScript oracle by
//! `tests/fixtures/gen-fixtures.mjs` and drift-checked by
//! `tools/rust-engine-program/check-fixture-drift.mjs`, so it cannot freeze into
//! output nothing can reproduce.
//!
//! Every deserialized struct is `deny_unknown_fields`: a field the generator
//! emits and this test does not read fails here instead of becoming a column
//! asserted by nothing.

use dohc_engine_files::search_policy::{
    Export, FilesPolicyRule, PathFloor, Visibility, VisibilityPolicyRule, parse_files_policy,
    parse_visibility_policy, policy_glob_matches, resolve_effective_policy, validate_policy_glob,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    glob_validation: Vec<GlobValidationCase>,
    glob_matches: Vec<GlobMatchCase>,
    files_policy: Vec<ParseCase<FilesRuleJson>>,
    visibility_policy: Vec<ParseCase<VisibilityRuleJson>>,
    resolution: Vec<ResolutionCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GlobValidationCase {
    pattern: String,
    ok: bool,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GlobMatchCase {
    pattern: String,
    path: String,
    matches: bool,
}

#[derive(Deserialize)]
#[serde(
    rename_all = "camelCase",
    deny_unknown_fields,
    bound(deserialize = "R: Deserialize<'de>")
)]
struct ParseCase<R> {
    name: String,
    toml: String,
    ok: bool,
    /// The oracle failed inside the TOML PARSER, not in shape validation.
    /// smol-toml and the Rust `toml` crate word syntax errors differently, so
    /// only the failure and the shared `invalid TOML: ` prefix are asserted.
    #[serde(default)]
    parser_message: bool,
    #[serde(default)]
    rules: Option<Vec<R>>,
    #[serde(default)]
    errors: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilesRuleJson {
    path: String,
    #[serde(default)]
    tracked: Option<bool>,
    #[serde(default)]
    searchable: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisibilityRuleJson {
    path: String,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    export: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolutionCase {
    name: String,
    path: String,
    #[serde(default)]
    files_policy: Option<Vec<FilesRuleJson>>,
    #[serde(default)]
    visibility_policy: Option<Vec<VisibilityRuleJson>>,
    result: ResolutionResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolutionResult {
    path: String,
    tracked: bool,
    versioned: bool,
    searchable: bool,
    visibility: String,
    export: String,
    capture_owned: bool,
    floor: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/effective-policy.json"))
        .expect("generated fixture parses")
}

impl FilesRuleJson {
    fn to_rule(&self) -> FilesPolicyRule {
        FilesPolicyRule {
            path: self.path.clone(),
            tracked: self.tracked,
            searchable: self.searchable,
        }
    }
}

impl VisibilityRuleJson {
    fn to_rule(&self) -> VisibilityPolicyRule {
        VisibilityPolicyRule {
            path: self.path.clone(),
            visibility: self.visibility.as_deref().map(visibility_from_ts),
            export: self.export.as_deref().map(export_from_ts),
        }
    }
}

fn visibility_from_ts(value: &str) -> Visibility {
    match value {
        "visible" => Visibility::Visible,
        "hidden" => Visibility::Hidden,
        other => panic!("unexpected TS visibility {other}"),
    }
}

fn export_from_ts(value: &str) -> Export {
    match value {
        "included" => Export::Included,
        "excluded" => Export::Excluded,
        "redacted" => Export::Redacted,
        other => panic!("unexpected TS export {other}"),
    }
}

fn floor_from_ts(value: &str) -> PathFloor {
    match value {
        "tracked" => PathFloor::Tracked,
        "ignored" => PathFloor::Ignored,
        "secret" => PathFloor::Secret,
        other => panic!("unexpected TS floor {other}"),
    }
}

#[test]
fn generated_ts_glob_validation_matches_the_rust_port() {
    for case in fixture().glob_validation {
        let actual = validate_policy_glob(&case.pattern);
        match (case.ok, &case.reason) {
            (true, None) => assert_eq!(
                actual,
                Ok(()),
                "glob {:?} is accepted by the TypeScript oracle",
                case.pattern
            ),
            (false, Some(reason)) => assert_eq!(
                actual,
                Err(reason.clone()),
                "glob {:?} rejection reason disagrees with the TypeScript oracle",
                case.pattern
            ),
            _ => panic!("malformed glob validation fixture for {:?}", case.pattern),
        }
    }
}

#[test]
fn generated_ts_glob_matching_matches_the_rust_port() {
    for case in fixture().glob_matches {
        assert_eq!(
            policy_glob_matches(&case.pattern, &case.path),
            case.matches,
            "glob {:?} against path {:?} disagrees with the TypeScript oracle",
            case.pattern,
            case.path
        );
    }
}

/// Both ports must collect the SAME errors in the SAME order: the first error is
/// what a user's agent reads back from a rejected policy file.
fn assert_parse_case<R, T>(
    case: &ParseCase<R>,
    actual: Result<Vec<T>, Vec<String>>,
    expect_rules: impl FnOnce(&[R]) -> Vec<T>,
    file: &str,
) where
    T: std::fmt::Debug + PartialEq,
{
    match (case.ok, actual) {
        (true, Ok(rules)) => {
            let expected = expect_rules(
                case.rules
                    .as_deref()
                    .expect("an accepted fixture case carries its rules"),
            );
            assert_eq!(rules, expected, "{file} {}: parsed rules differ", case.name);
        }
        (false, Err(errors)) => {
            if case.parser_message {
                assert_eq!(
                    errors.len(),
                    1,
                    "{file} {}: a TOML syntax failure is one error",
                    case.name
                );
                assert!(
                    errors[0].starts_with("invalid TOML: "),
                    "{file} {}: TOML syntax failure must carry the shared prefix, got {:?}",
                    case.name,
                    errors[0]
                );
            } else {
                let expected = case
                    .errors
                    .as_deref()
                    .expect("a rejected fixture case carries its errors");
                assert_eq!(
                    errors, expected,
                    "{file} {}: errors disagree with the TypeScript oracle",
                    case.name
                );
            }
        }
        (true, Err(errors)) => panic!(
            "{file} {}: the TypeScript oracle accepts this policy, the Rust port rejected it: {errors:?}",
            case.name
        ),
        (false, Ok(rules)) => panic!(
            "{file} {}: the TypeScript oracle rejects this policy, the Rust port accepted it: {rules:?}",
            case.name
        ),
    }
}

#[test]
fn generated_ts_files_policy_parsing_matches_the_rust_port() {
    for case in &fixture().files_policy {
        let actual = parse_files_policy(&case.toml);
        assert_parse_case(
            case,
            actual,
            |rules| rules.iter().map(FilesRuleJson::to_rule).collect(),
            "files.toml",
        );
    }
}

#[test]
fn generated_ts_visibility_policy_parsing_matches_the_rust_port() {
    for case in &fixture().visibility_policy {
        let actual = parse_visibility_policy(&case.toml);
        assert_parse_case(
            case,
            actual,
            |rules| rules.iter().map(VisibilityRuleJson::to_rule).collect(),
            "visibility.toml",
        );
    }
}

#[test]
fn generated_ts_policy_resolution_matches_the_rust_port() {
    for case in fixture().resolution {
        let files: Option<Vec<FilesPolicyRule>> = case
            .files_policy
            .as_ref()
            .map(|rules| rules.iter().map(FilesRuleJson::to_rule).collect());
        let visibility: Option<Vec<VisibilityPolicyRule>> = case
            .visibility_policy
            .as_ref()
            .map(|rules| rules.iter().map(VisibilityRuleJson::to_rule).collect());
        let actual = resolve_effective_policy(&case.path, files.as_deref(), visibility.as_deref());

        assert_eq!(
            case.result.path, case.path,
            "{}: the oracle echoes the input path",
            case.name
        );
        assert_eq!(
            actual.floor,
            floor_from_ts(&case.result.floor),
            "{}: floor disagrees with the TypeScript oracle",
            case.name
        );
        assert_eq!(
            actual.tracked, case.result.tracked,
            "{}: tracked disagrees with the TypeScript oracle",
            case.name
        );
        assert_eq!(
            actual.searchable, case.result.searchable,
            "{}: searchable disagrees with the TypeScript oracle",
            case.name
        );
        assert_eq!(
            actual.visibility,
            visibility_from_ts(&case.result.visibility),
            "{}: visibility disagrees with the TypeScript oracle",
            case.name
        );
        assert_eq!(
            actual.export,
            export_from_ts(&case.result.export),
            "{}: export disagrees with the TypeScript oracle",
            case.name
        );
        // The Rust port models version and capture ownership as post-policy
        // tracked ownership, exactly as the oracle documents. Asserting the
        // mirror keeps a future oracle change from splitting them silently.
        assert_eq!(
            case.result.versioned, actual.tracked,
            "{}: the oracle stopped mirroring versioned onto tracked",
            case.name
        );
        assert_eq!(
            case.result.capture_owned, actual.tracked,
            "{}: the oracle stopped mirroring captureOwned onto tracked",
            case.name
        );
    }
}
