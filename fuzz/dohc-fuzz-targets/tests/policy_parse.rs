//! Fuzz coverage for untrusted search-policy TOML, globs, and paths.
//!
//! Plain proptest keeps this target native-Windows compatible. The default is
//! 256 cases per property and can be scaled with `PROPTEST_CASES`.

use dohc_engine_runtime::search::policy::{
    classify_engine_file_path, parse_files_policy, parse_visibility_policy, policy_glob_matches,
    validate_policy_glob,
};
use proptest::prelude::*;

fn arbitrary_text() -> impl Strategy<Value = String> {
    prop_oneof![
        prop::collection::vec(any::<char>(), 0..512).prop_map(|chars| chars.into_iter().collect()),
        Just("\0\n..\\.dohc/%252e%252e/秘密/🦀".to_owned()),
        prop::collection::vec(any::<char>(), 2048..4096)
            .prop_map(|chars| chars.into_iter().collect()),
    ]
}

fn structured_policy_toml() -> impl Strategy<Value = String> {
    prop::collection::vec(
        (
            prop::bool::ANY,
            "[a-zA-Z0-9_./* -]{0,64}",
            0u8..4,
            0u8..4,
            prop::bool::ANY,
        ),
        0..10,
    )
    .prop_map(|rules| {
        let mut text = String::new();
        for (files_rule, path, first, second, unknown) in rules {
            text.push_str("[[rule]]\n");
            match first {
                0 => text.push_str(&format!("path = \"{path}\"\n")),
                1 => text.push_str("path = 17\n"),
                2 => text.push_str("path = \"\"\n"),
                _ => text.push_str("path = \"../**\"\n"),
            }
            if files_rule {
                text.push_str(if second & 1 == 0 {
                    "tracked = true\n"
                } else {
                    "tracked = \"yes\"\n"
                });
                text.push_str(if second < 2 {
                    "searchable = false\n"
                } else {
                    "searchable = 1\n"
                });
            } else {
                text.push_str(if second & 1 == 0 {
                    "visibility = \"visible\"\n"
                } else {
                    "visibility = \"private\"\n"
                });
                text.push_str(if second < 2 {
                    "export = \"redacted\"\n"
                } else {
                    "export = true\n"
                });
            }
            if unknown {
                text.push_str("future_key = \"value\"\n");
            }
        }
        text
    })
}

fn assert_typed_parse<T>(result: Result<Vec<T>, Vec<String>>) {
    if let Err(errors) = result {
        assert!(
            !errors.is_empty(),
            "a typed parse error must explain the rejection"
        );
        assert!(
            errors.iter().all(|error| !error.is_empty()),
            "typed parse errors must contain non-empty messages"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Arbitrary Unicode/control-heavy text either parses completely or
    /// returns a populated typed error vector; neither parser may panic.
    #[test]
    fn arbitrary_policy_text_parses_or_returns_typed_errors(text in arbitrary_text()) {
        assert_typed_parse(parse_files_policy(&text));
        assert_typed_parse(parse_visibility_policy(&text));
    }

    /// Valid TOML structure with generated sections and values reaches rule
    /// shape validation instead of stopping exclusively at the TOML lexer.
    #[test]
    fn structured_policy_toml_reaches_rule_validation(text in structured_policy_toml()) {
        assert_typed_parse(parse_files_policy(&text));
        assert_typed_parse(parse_visibility_policy(&text));
    }

    /// Validation, matching, and path-floor classification are total for
    /// arbitrary strings. Matching is exercised even for rejected globs.
    #[test]
    fn arbitrary_globs_and_paths_are_total(pattern in arbitrary_text(), path in arbitrary_text()) {
        let validation = validate_policy_glob(&pattern);
        let _ = policy_glob_matches(&pattern, &path);
        if validation.is_ok() {
            let _ = policy_glob_matches(&pattern, &path);
        }
        let _ = classify_engine_file_path(&path);
    }
}

#[test]
fn seed_valid_files_policy_parses() {
    let policy = "[[rule]]\npath = \"notes/**\"\ntracked = true\nsearchable = false\n";
    assert_eq!(parse_files_policy(policy).expect("valid policy").len(), 1);
}

#[test]
fn seed_malformed_policy_returns_typed_error() {
    let error = parse_visibility_policy("[[rule]\npath =").expect_err("malformed policy");
    assert!(!error.is_empty());
}

#[test]
fn seed_known_good_glob_matches() {
    let pattern = "notes/**";
    assert!(validate_policy_glob(pattern).is_ok());
    assert!(policy_glob_matches(pattern, "notes/project/plan.md"));
}
