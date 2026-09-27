use dohc_engine_domain::chats::{
    channel_slug_for_name, is_replicated_channel_slug, parse_mention_handles,
};

#[test]
fn shared_unicode_name_fixtures() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/names.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let expected = case["slug"].as_str().unwrap();
        let actual = channel_slug_for_name(input);
        assert_eq!(actual, expected, "{}", case["name"]);
        assert!(actual.len() <= 200);
        assert_eq!(channel_slug_for_name(&actual), actual);
        if !actual.is_empty() {
            assert!(is_replicated_channel_slug(&actual));
            assert_eq!(parse_mention_handles(&format!("@{actual}")), vec![actual]);
        }
    }
}

#[test]
fn unicode_mentions_preserve_marks_and_normalize_keys() {
    assert_eq!(
        parse_mention_handles("Hi @हिन्दी @Cafe\u{301} @𐐀𐐁."),
        vec!["हिन्दी", "café", "𐐨𐐩"]
    );
    assert!(parse_mention_handles(&format!("@{}", "界".repeat(67))).is_empty());
    assert_eq!(
        parse_mention_handles("@CON @nul @aux.txt"),
        vec!["con", "nul", "aux.txt"]
    );
    assert!(parse_mention_handles("@\u{0345}abc").is_empty());
}

#[test]
fn shared_name_byte_boundaries() {
    use dohc_engine_domain::names::truncate_name;
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/name-boundaries.json")).unwrap();
    let (major, minor, patch) = unicode_segmentation::UNICODE_VERSION;
    assert_eq!(
        format!("{major}.{minor}.{patch}"),
        cases["unicodeVersion"].as_str().unwrap(),
        "Re-check the shared boundary fixtures in TypeScript and Rust before updating unicodeVersion."
    );
    for case in cases["cases"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let expected = case["expected"].as_str().unwrap();
        let max_bytes = case["maxBytes"].as_u64().unwrap() as usize;
        assert_eq!(
            truncate_name(input, max_bytes),
            expected,
            "{}",
            case["name"]
        );
        assert!(truncate_name(input, max_bytes).len() <= max_bytes);
    }
}
