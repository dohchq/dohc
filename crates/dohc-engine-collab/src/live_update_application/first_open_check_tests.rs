//! Set `DOHC_WRITE_FIRST_OPEN_FIXTURES=1` to rewrite `candidate-verdicts.json`.
use super::*;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::path::PathBuf;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, Options, ReadTxn, StateVector, Text, Transact, Update};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/first-open-base")
        .join(name)
}

fn writing() -> bool {
    std::env::var("DOHC_WRITE_FIRST_OPEN_FIXTURES").as_deref() == Ok("1")
}

fn check(candidate: &[u8], source: &str, cap: usize) -> FirstOpenCandidateVerdict {
    check_first_open_candidate(
        FirstOpenCandidate {
            candidate,
            candidate_sha256: &hex_sha256(candidate),
            source: source.as_bytes(),
            source_sha256: &hex_sha256(source.as_bytes()),
            max_full_state_bytes: cap,
        },
        &|| false,
    )
    .unwrap()
}

fn checked(candidate: &[u8], source: &str) -> FirstOpenCandidateEvidence {
    match check(candidate, source, MAX_YDOC_UPDATE_BYTES) {
        FirstOpenCandidateVerdict::Checked(evidence) => evidence,
        other => panic!("{source:?}: {other:?}"),
    }
}

fn refusal(candidate: &[u8], source: &str) -> FirstOpenCandidateRefusal {
    match check(candidate, source, MAX_YDOC_UPDATE_BYTES) {
        FirstOpenCandidateVerdict::Refused(cause) => cause,
        other => panic!("{source:?}: {other:?}"),
    }
}

/// A document the engine itself seeds with an exact-source witness.
fn seeded(markdown: &str) -> Vec<u8> {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, markdown)
        .unwrap();
    doc.encode_full_state()
}

/// `base` with its metadata edited by a second client.
fn with_meta(base: &[u8], edit: impl FnOnce(&yrs::MapRef, &mut yrs::TransactionMut)) -> Vec<u8> {
    let doc = Doc::with_options(Options {
        client_id: yrs::ClientID::new(77),
        offset_kind: yrs::OffsetKind::Utf16,
        skip_gc: true,
        ..Options::default()
    });
    let meta = doc.get_or_insert_map("meta");
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(Update::decode_v1(base).unwrap()).unwrap();
        edit(&meta, &mut txn);
    }
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TsBase {
    name: String,
    markdown: String,
    #[allow(dead_code)]
    canonical: String,
    #[allow(dead_code)]
    client_id: u32,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YrsBase {
    name: String,
    bytes: Vec<u8>,
}

#[test]
fn every_seed_settles_exactly_or_refuses_and_measures_the_native_full_state() {
    let bases: Vec<TsBase> =
        serde_json::from_slice(&std::fs::read(fixture("ts-bases.json")).unwrap()).unwrap();
    let native: Vec<YrsBase> =
        serde_json::from_slice(&std::fs::read(fixture("yrs-bases.json")).unwrap()).unwrap();
    assert_eq!(bases.len(), native.len());
    for (base, native) in bases.iter().zip(&native) {
        assert_eq!(base.name, native.name);
        let verdict = check(&base.bytes, &base.markdown, MAX_YDOC_UPDATE_BYTES);
        // The engine reads the autolink differently, so the file is not what
        // it would write back.
        if base.name == "links" {
            assert_eq!(
                verdict,
                FirstOpenCandidateVerdict::Refused(FirstOpenCandidateRefusal::SettlementMismatch)
            );
            continue;
        }
        let FirstOpenCandidateVerdict::Checked(evidence) = verdict else {
            panic!("{}: {verdict:?}", base.name);
        };
        assert_eq!(
            evidence.settled_source_sha256,
            hex_sha256(base.markdown.as_bytes())
        );
        assert_eq!(evidence.settled_source_byte_length, base.markdown.len());
        // The measured state is native's own encoding, not the candidate.
        assert_eq!(
            evidence.full_state_byte_length,
            native.bytes.len(),
            "{}",
            base.name
        );
    }
    let length = |name: &str| {
        bases
            .iter()
            .find(|base| base.name == name)
            .unwrap()
            .bytes
            .len()
    };
    let measured = |name: &str| {
        let base = bases.iter().find(|base| base.name == name).unwrap();
        checked(&base.bytes, &base.markdown).full_state_byte_length
    };
    assert_eq!(
        measured("integer-2147483648"),
        length("integer-2147483648") + 1
    );
    assert_eq!(
        measured("float32-integers"),
        length("float32-integers") + 300 * 4
    );
}

/// yrs writes map entries in its own order, so native's re-encoding is a
/// valid variant of each candidate with other bytes: it gets the same verdict
/// and the same measured length.
#[test]
fn map_order_variants_get_the_same_verdict() {
    let bases: Vec<TsBase> =
        serde_json::from_slice(&std::fs::read(fixture("ts-bases.json")).unwrap()).unwrap();
    let native: Vec<YrsBase> =
        serde_json::from_slice(&std::fs::read(fixture("yrs-bases.json")).unwrap()).unwrap();
    for (base, native) in bases.iter().zip(&native) {
        let (ts, yrs) = (
            check(&base.bytes, &base.markdown, MAX_YDOC_UPDATE_BYTES),
            check(&native.bytes, &base.markdown, MAX_YDOC_UPDATE_BYTES),
        );
        match (&ts, &yrs) {
            (FirstOpenCandidateVerdict::Checked(ts), FirstOpenCandidateVerdict::Checked(yrs)) => {
                assert_eq!(ts.settled_source_sha256, yrs.settled_source_sha256);
                assert_eq!(ts.full_state_byte_length, yrs.full_state_byte_length);
            }
            _ => assert_eq!(ts, yrs, "{}", base.name),
        }
    }
    assert!(["frontmatter-nested", "links"]
        .iter()
        .all(|name| bases.iter().any(|base| base.name == *name)));
}

#[test]
fn the_full_state_is_measured_up_to_the_relays_bound() {
    let candidate = seeded("Title\n=====\n\nBody\n");
    let full = checked(&candidate, "Title\n=====\n\nBody\n").full_state_byte_length;
    assert!(matches!(
        check(&candidate, "Title\n=====\n\nBody\n", full),
        FirstOpenCandidateVerdict::Checked(_)
    ));
    assert_eq!(
        check(&candidate, "Title\n=====\n\nBody\n", full - 1),
        FirstOpenCandidateVerdict::TooLarge { limit: full - 1 }
    );
}

#[test]
fn settlement_keeps_a_file_body_the_engine_reads_as_text() {
    // The strict rule drops this witness; the snapshot rule keeps the file.
    const SOURCE: &str = "# Shared\n\nHello <b>hidden</b> world\n";
    let candidate = seeded(SOURCE);
    let doc = Ydoc::wire();
    doc.apply(&candidate).unwrap();
    let projection = doc.project(ContentKind::Richdoc).unwrap().content;
    assert_ne!(projection, SOURCE);
    assert_eq!(doc.preserved_markdown_source(&projection), None);
    assert_eq!(
        checked(&candidate, SOURCE).settled_source_sha256,
        hex_sha256(SOURCE.as_bytes())
    );
}

#[test]
fn the_file_must_be_the_exact_bytes_the_candidate_settles_to() {
    let markdown = "Title\n=====\n\nBody\n";
    let candidate = seeded(markdown);
    for other in [
        "Title\n=====\n\nBody",
        "Title\n=====\n\nBody\n\n",
        "Title\r\n=====\r\n\r\nBody\r\n",
        "Title\n=====\n\nBody \n",
        "# Title\n\nBody\n",
        "Title\n=====\n\nOther\n",
    ] {
        assert_eq!(
            refusal(&candidate, other),
            FirstOpenCandidateRefusal::SettlementMismatch,
            "{other:?}"
        );
    }
    // A snapshot whose body matches cannot carry other frontmatter.
    let source = "---\ntitle: A\n---\n\nHello <b>x</b>\n";
    let changed = seeded("---\ntitle: B\n---\n\nHello <b>x</b>\n");
    assert_eq!(
        refusal(&changed, source),
        FirstOpenCandidateRefusal::SettlementMismatch
    );
    checked(&seeded(source), source);
}

#[test]
fn spellings_survive_byte_for_byte() {
    for markdown in [
        "",
        "Title\r\n=====\r\n\r\nBody & more\r\n",
        "Title\n=====\n\nNo final newline",
        "Title\n=====\n\nBody\n\n\n",
        "Title  \n=====\n\nTrailing spaces   \n",
        "Café\n====\n\nnaïve 中文 — 🎉 & <ok>\n",
        "---\ntitle: R&D <draft>\n---\n\nTitle\n=====\n\nBody\n",
    ] {
        let evidence = checked(&seeded(markdown), markdown);
        assert_eq!(evidence.settled_source_byte_length, markdown.len());
    }
    // The empty update is the empty file's baseline.
    checked(&[0, 0], "");
}

#[test]
fn a_witness_counts_only_when_it_rebuilds_the_document() {
    let markdown = "Title\n=====\n\nBody\n";
    let candidate = seeded(markdown);
    let doc = Ydoc::wire();
    doc.apply(&candidate).unwrap();
    let projection = &doc.project(ContentKind::Richdoc).unwrap().content;
    assert_ne!(projection, markdown);
    // Without a witness the file must be the projection.
    let absent = with_meta(&candidate, |meta, txn| {
        for key in [
            "dohcMarkdownSource",
            "dohcMarkdownSourceSha256",
            "dohcMarkdownSourceProjectionSha256",
        ] {
            meta.remove(txn, key);
        }
    });
    assert_eq!(
        refusal(&absent, markdown),
        FirstOpenCandidateRefusal::SettlementMismatch
    );
    checked(&absent, projection);
    // A stale witness names another projection, so the projection settles.
    let stale = with_meta(&candidate, |meta, txn| {
        meta.insert(
            txn,
            "dohcMarkdownSourceProjectionSha256",
            hex_sha256(b"# Other\n"),
        );
    });
    assert_eq!(
        refusal(&stale, markdown),
        FirstOpenCandidateRefusal::SettlementMismatch
    );
    checked(&stale, projection);
    // Self-consistent digests over bytes that do not rebuild the document.
    let forged_source = "Title\n=====\n\nForged\n";
    let forged = with_meta(&candidate, |meta, txn| {
        meta.insert(txn, "dohcMarkdownSource", forged_source);
        meta.insert(
            txn,
            "dohcMarkdownSourceSha256",
            hex_sha256(forged_source.as_bytes()),
        );
    });
    for source in [forged_source, markdown] {
        assert_eq!(
            refusal(&forged, source),
            FirstOpenCandidateRefusal::SettlementMismatch
        );
    }
}

#[test]
fn the_public_baseline_schema_is_enforced() {
    let candidate = seeded("Title\n=====\n\nBody\n");
    let unknown = with_meta(&candidate, |meta, txn| {
        meta.insert(txn, "dohcAuthority", "owner");
    });
    let partial = with_meta(&candidate, |meta, txn| {
        meta.remove(txn, "dohcMarkdownSourceSha256");
    });
    let rogue = {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("rogue");
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, "x");
        drop(txn);
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    };
    for bytes in [&unknown, &partial, &rogue] {
        assert_eq!(
            refusal(bytes, "Title\n=====\n\nBody\n"),
            FirstOpenCandidateRefusal::InvalidPublicBaseline
        );
    }
}

#[test]
fn a_valid_baseline_too_deep_to_project_is_refused_as_projection_failed() {
    let candidate = first_open_candidate_too_deep_to_project();
    let doc = Ydoc::wire();
    doc.apply(&candidate).unwrap();
    assert!(!doc.has_missing_updates());
    assert!(doc.validate_public_baseline(&candidate).is_ok());
    assert!(doc.project(ContentKind::Richdoc).is_err());
    assert_eq!(
        refusal(&candidate, "deep\n"),
        FirstOpenCandidateRefusal::ProjectionFailed
    );
    assert_eq!(
        FirstOpenCandidateRefusal::ProjectionFailed.as_str(),
        "projection-failed"
    );
}

#[test]
fn malformed_and_incomplete_updates_are_refused() {
    let candidate = seeded("Body\n");
    for bytes in [
        vec![1, 2, 3],
        candidate[..candidate.len() - 1].to_vec(),
        vec![0xff; 16],
    ] {
        assert_eq!(
            refusal(&bytes, "Body\n"),
            FirstOpenCandidateRefusal::MalformedCandidate
        );
    }
    // A later client's update without the structs it builds on.
    let first = Ydoc::wire();
    let base = first.richdoc_append_paragraph("one");
    let second = Ydoc::wire();
    second.apply(&base).unwrap();
    let before = second.encode_state_vector();
    second.richdoc_append_paragraph("two");
    let dependent = second.diff(&before).unwrap();
    assert_eq!(
        refusal(&dependent, "one\n\ntwo\n"),
        FirstOpenCandidateRefusal::IncompleteCandidate
    );
    // A deletion of structs the update does not carry.
    let deleting = Doc::with_options(Options {
        client_id: yrs::ClientID::new(5),
        skip_gc: true,
        ..Options::default()
    });
    let text = deleting.get_or_insert_text("t");
    text.insert(&mut deleting.transact_mut(), 0, "abc");
    let inserted = deleting.transact().state_vector();
    text.remove_range(&mut deleting.transact_mut(), 0, 2);
    let deletion = deleting.transact().encode_state_as_update_v1(&inserted);
    assert_eq!(
        refusal(&deletion, ""),
        FirstOpenCandidateRefusal::IncompleteCandidate
    );
}

#[test]
fn inconsistent_inputs_and_bounds_are_failures_not_refusals() {
    let markdown = "Body\n";
    let candidate = seeded(markdown);
    let run =
        |candidate: &[u8], candidate_sha256: &str, source: &[u8], source_sha256: &str, cap| {
            check_first_open_candidate(
                FirstOpenCandidate {
                    candidate,
                    candidate_sha256,
                    source,
                    source_sha256,
                    max_full_state_bytes: cap,
                },
                &|| false,
            )
        };
    let (c, s) = (hex_sha256(&candidate), hex_sha256(markdown.as_bytes()));
    let other = hex_sha256(b"other");
    assert_eq!(
        run(&candidate, &other, markdown.as_bytes(), &s, 1000),
        Err(FirstOpenCheckError::Integrity)
    );
    assert_eq!(
        run(&candidate, &c, markdown.as_bytes(), &other, 1000),
        Err(FirstOpenCheckError::Integrity)
    );
    let invalid = [b'B', 0xff, b'\n'];
    assert_eq!(
        run(&candidate, &c, &invalid, &hex_sha256(&invalid), 1000),
        Err(FirstOpenCheckError::Integrity)
    );
    let large = vec![b'a'; MAX_PUBLIC_MARKDOWN_BYTES + 1];
    for (candidate, source, cap) in [
        (&candidate[..1], markdown.as_bytes(), 1000),
        (&candidate[..], &large[..], 1000),
        (&candidate[..], markdown.as_bytes(), 1),
        (
            &candidate[..],
            markdown.as_bytes(),
            MAX_YDOC_UPDATE_BYTES + 1,
        ),
    ] {
        assert_eq!(
            run(
                candidate,
                &hex_sha256(candidate),
                source,
                &hex_sha256(source),
                cap
            ),
            Err(FirstOpenCheckError::InvalidBounds)
        );
    }
}

/// Stop at each poll in turn: every poll ends the check, and the snapshot
/// rule polls between its readings of the source.
#[test]
fn the_check_stops_at_every_poll() {
    let polls = |markdown: &str, candidate: &[u8]| {
        let count = Cell::new(0);
        let (candidate_sha256, source_sha256) =
            (hex_sha256(candidate), hex_sha256(markdown.as_bytes()));
        let input = || FirstOpenCandidate {
            candidate,
            candidate_sha256: &candidate_sha256,
            source: markdown.as_bytes(),
            source_sha256: &source_sha256,
            max_full_state_bytes: MAX_YDOC_UPDATE_BYTES,
        };
        let verdict = check_first_open_candidate(input(), &|| {
            count.set(count.get() + 1);
            false
        })
        .unwrap();
        assert!(matches!(verdict, FirstOpenCandidateVerdict::Checked(_)));
        let total = count.get();
        for stop in 1..=total {
            let seen = Cell::new(0);
            let result = check_first_open_candidate(input(), &|| {
                seen.set(seen.get() + 1);
                seen.get() == stop
            });
            assert_eq!(result, Err(FirstOpenCheckError::Stopped), "poll {stop}");
            assert_eq!(seen.get(), stop);
        }
        total
    };
    let plain = "Body\n";
    let simple = polls(plain, &seeded(plain));
    let html = "# Shared\n\nHello <b>hidden</b> world\n";
    let readings = polls(html, &seeded(html));
    // Two strict readings fail before the snapshot rule reads it again.
    assert!(readings >= simple + 2, "{simple} {readings}");
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    name: String,
    corpus: Option<CorpusSource>,
    markdown: String,
    old_guard: String,
    candidate: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CorpusSource {
    path: String,
    revision: String,
    sha256: String,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Verdict {
    name: String,
    old_guard: String,
    verdict: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cause: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    full_state_byte_length: Option<usize>,
}

fn verdict(row: &Candidate, verdict: &FirstOpenCandidateVerdict) -> Verdict {
    let (kind, cause, full) = match verdict {
        FirstOpenCandidateVerdict::Checked(evidence) => {
            ("checked", None, Some(evidence.full_state_byte_length))
        }
        FirstOpenCandidateVerdict::Refused(cause) => {
            ("refused", Some(cause.as_str().to_owned()), None)
        }
        FirstOpenCandidateVerdict::TooLarge { .. } => ("too-large", None, None),
    };
    Verdict {
        name: row.name.clone(),
        old_guard: row.old_guard.clone(),
        verdict: kind.to_owned(),
        cause,
        full_state_byte_length: full,
    }
}

/// The old guard refused these; the engine settles them exactly.
const NEWLY_CHECKED: [&str; 14] = [
    "amp-fenced",
    "lt-fenced",
    "refdef-fenced",
    "refdef-inline",
    "amp-bare",
    "lt-bare",
    "html-inline",
    "html-block",
    "literal-punctuation",
    "frontmatter",
    "crlf",
    "no-final-newline",
    "extra-final-newlines",
    "unicode",
];
/// The old guard built these; the engine does not settle them to the file.
const NEWLY_REFUSED: [&str; 2] = ["corpus:SECURITY.md", "corpus:docs/README.md"];
/// Both refuse these.
const STILL_REFUSED: [&str; 19] = [
    "corpus:docs/reference/usage-and-error-reports.md",
    "corpus:vendor/yrs-0.27.3/README.md",
    "corpus:vendor/notify-8.2.0/README.md",
    "corpus:vendor/file-guard-0.2.0/README.md",
    "corpus:tools/rust-engine-program/README.md",
    "corpus:CONTEXT.md",
    "corpus:.agents/skills/verification-triage/SKILL.md",
    "corpus:services/share-web/README.md",
    "corpus:tools/perf-profiling/README.md",
    "autolink",
    "amp-indented",
    "lt-indented",
    "refdef-indented",
    "amp-inline",
    "lt-inline",
    "amp-entity",
    "refdef",
    "mixed-technical",
    "trailing-whitespace",
];

/// TypeScript builds each candidate with the relay's construction; the engine
/// checks those exact bytes against the original file.
#[test]
fn shared_candidates_match_the_engines_verdicts() {
    let candidates: Vec<Candidate> =
        serde_json::from_slice(&std::fs::read(fixture("candidates.json")).unwrap()).unwrap();
    assert!(candidates.iter().filter(|row| row.corpus.is_some()).count() >= 6);
    let results: Vec<(&Candidate, FirstOpenCandidateVerdict)> = candidates
        .iter()
        .map(|row| {
            if let Some(corpus) = &row.corpus {
                assert_eq!(
                    corpus.sha256,
                    hex_sha256(row.markdown.as_bytes()),
                    "{}@{}",
                    corpus.path,
                    corpus.revision
                );
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&row.candidate)
                .unwrap();
            (row, check(&bytes, &row.markdown, MAX_YDOC_UPDATE_BYTES))
        })
        .collect();
    let actual: Vec<Verdict> = results
        .iter()
        .map(|(row, result)| verdict(row, result))
        .collect();
    let path = fixture("candidate-verdicts.json");
    if writing() {
        let lines: Vec<String> = actual
            .iter()
            .map(|row| serde_json::to_string(row).unwrap())
            .collect();
        std::fs::write(&path, format!("[\n{}\n]\n", lines.join(",\n"))).unwrap();
    }
    let mismatch =
        FirstOpenCandidateVerdict::Refused(FirstOpenCandidateRefusal::SettlementMismatch);
    for (row, result) in &results {
        let name = row.name.as_str();
        let built = row.old_guard == "built";
        if NEWLY_CHECKED.contains(&name) {
            assert!(!built, "{name}");
            assert!(
                matches!(result, FirstOpenCandidateVerdict::Checked(_)),
                "{name}: {result:?}"
            );
        } else if NEWLY_REFUSED.contains(&name) {
            assert!(built, "{name}");
            assert_eq!(result, &mismatch, "{name}");
        } else if STILL_REFUSED.contains(&name) {
            assert!(!built, "{name}");
            assert_eq!(result, &mismatch, "{name}");
        } else {
            // The rest are files both accept.
            assert!(built, "{name}");
            assert!(
                matches!(result, FirstOpenCandidateVerdict::Checked(_)),
                "{name}: {result:?}"
            );
        }
    }
    let committed: Vec<Verdict> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(committed, actual);
}
