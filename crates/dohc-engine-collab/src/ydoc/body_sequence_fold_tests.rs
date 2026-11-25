use super::body_sequence::tests::{same_document, shown};
use super::*;
use base64::Engine as _;

const FOLDS: &str =
    include_str!("../../../../packages/ydoc-projection/src/fixtures/body-sequence-folds.json");

#[derive(serde::Deserialize)]
struct Fold {
    name: String,
    before: String,
    file: String,
    after: After,
}

#[derive(serde::Deserialize)]
struct After {
    document: serde_json::Value,
    markdown: String,
}

fn note(before: &str) -> Ydoc {
    let doc = Ydoc::wire();
    let update = base64::engine::general_purpose::STANDARD
        .decode(before)
        .expect("base64");
    doc.apply(&update).expect("the note applies");
    doc
}

fn reading(doc: &Ydoc) -> Result<(serde_json::Value, String), CollabError> {
    let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
    let containers = doc.doc.get_or_insert_map(ROOT_CONTAINERS);
    let (mut nodes, mut bytes) = (MAX_PROJECTION_NODES, 0);
    let read = {
        let txn = doc.doc.transact();
        body_sequence::blocks(&txn, &sequence, &containers, &mut nodes, &mut bytes)?
    };
    let document = serde_json::json!({ "type": "doc", "content": shown(&read) });
    Ok((document, doc.project(ContentKind::Richdoc)?.content))
}

fn folded(fold: &Fold) -> Result<(serde_json::Value, String), CollabError> {
    let doc = note(&fold.before);
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &fold.file)?;
    reading(&doc)
}

#[test]
fn each_shared_fold_reads_as_its_document_after() {
    let folds = shared_folds();
    let mut differing = Vec::new();
    reading_body_sequence_here(|| {
        for fold in &folds {
            match folded(fold) {
                Ok((document, markdown))
                    if same_document(&fold.after.document, &document)
                        && markdown == fold.after.markdown => {}
                Ok((document, markdown)) => {
                    differing.push(format!("{}: read {document} as {markdown:?}", fold.name))
                }
                Err(error) => differing.push(format!("{}: {error:?}", fold.name)),
            }
        }
    });
    assert_eq!(folds.len(), 27);
    assert!(differing.is_empty(), "{}", differing.join("\n"));
}

fn shared_folds() -> Vec<Fold> {
    serde_json::from_str(FOLDS).expect("the shared folds")
}

#[test]
fn an_outside_save_format_two_cannot_hold_keeps_its_file_as_the_source() {
    let file = "Run [`npm install`](https://example.com) first\n";
    reading_body_sequence_here(|| {
        let doc = note(&shared_folds()[0].before);
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, file)
            .expect("the nearest reading");
        let projection = doc.project(ContentKind::Richdoc).unwrap().content;
        assert_eq!(projection, "Run `npm install` first\n");
        doc.preserve_folded_markdown_source(file)
            .expect("the source");
        assert_eq!(doc.note_schema_version(), 2);
        assert_eq!(
            doc.settled_markdown_source(&projection, || Ok::<_, ()>(Some(file.to_owned())))
                .unwrap()
                .as_deref(),
            Some(file)
        );
    });
}

#[test]
fn a_format_two_note_takes_new_frontmatter_without_a_new_body() {
    reading_body_sequence_here(|| {
        let fold = &shared_folds()[0];
        let doc = note(&fold.before);
        let (_, before) = reading(&doc).unwrap();
        let file = format!("---\ntitle: A\n---\n\n{before}");
        doc.replace_frontmatter_for_fold(&file)
            .expect("frontmatter");
        assert_eq!(doc.note_schema_version(), 2);
        assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, file);
    });
}

const LINES: usize = 10_000;

fn numbered(line: usize) -> String {
    format!("{line:0>59}a")
}

fn long_note(line: impl Fn(usize) -> String) -> Vec<String> {
    (0..LINES).map(line).collect()
}

fn markdown(lines: &[String]) -> String {
    format!("{}\n", lines.join("\n\n"))
}

enum Bar {
    Runs { runs: usize, lines: usize },
    Whole,
}

fn brake_cases() -> Vec<(&'static str, String, Bar)> {
    let note = long_note(numbered);
    let edited = |edit: &dyn Fn(&mut Vec<String>)| {
        let mut lines = note.clone();
        edit(&mut lines);
        markdown(&lines)
    };
    let runs = |lines| Bar::Runs { runs: 1, lines };
    vec![
        (
            "one letter",
            edited(&|lines| lines[LINES / 2].push('b')),
            runs(0),
        ),
        (
            "a line at the top",
            edited(&|lines| lines.insert(0, "new".into())),
            runs(1),
        ),
        (
            "a join",
            edited(&|lines| {
                let below = lines.remove(LINES / 2 + 1);
                lines[LINES / 2].push_str(&below);
            }),
            runs(0),
        ),
        (
            "an edit at line 1",
            edited(&|lines| lines[0].insert(0, 'b')),
            runs(0),
        ),
        (
            "an edit at the last line",
            edited(&|lines| lines[LINES - 1].push('b')),
            runs(0),
        ),
        (
            "the whole file replaced",
            markdown(&long_note(|line| format!("{line:z<60}"))),
            Bar::Whole,
        ),
    ]
}

const CLIENTS: [u64; 3] = [
    0x1A_2B3C_4D5E_6F70,
    0x1A_2B3C_4D5E_6F71,
    0x1A_2B3C_4D5E_6F72,
];

fn seeded(format: u8, file: &str) -> Ydoc {
    let doc = Ydoc::with_client_id(CLIENTS[0]);
    if format == 2 {
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        meta.insert(
            &mut doc.doc.transact_mut(),
            "schemaVersion",
            Any::Number(2.0),
        );
    }
    doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, file)
        .expect("the seed");
    doc
}

fn copy(doc: &Ydoc, client: u64) -> Ydoc {
    let copy = Ydoc::with_client_id(client);
    copy.apply(&doc.encode_full_state()).expect("the copy");
    copy
}

fn sequence_length(doc: &Ydoc) -> usize {
    let sequence = doc.doc.get_or_insert_text(ROOT_SEQUENCE);
    let length = sequence.len(&doc.doc.transact());
    length as usize
}

#[test]
fn a_fold_of_a_long_note_does_work_and_writes_bytes_in_proportion_to_its_change() {
    reading_body_sequence_here(|| {
        let file = markdown(&long_note(numbered));
        let (one, two) = (seeded(1, &file), seeded(2, &file));
        let boundary = {
            let note = seeded(2, "a\n");
            let fold = |file: &str| {
                copy(&note, CLIENTS[1])
                    .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, file)
                    .expect("a small fold")
                    .len()
            };
            fold("a\n\nb\n") - fold("ab\n")
        };
        let mut over = Vec::new();
        for (name, edited, bar) in brake_cases() {
            let format_one = copy(&one, CLIENTS[1])
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &edited)
                .expect("format 1")
                .len();
            let doc = copy(&two, CLIENTS[1]);
            let before = sequence_length(&doc);
            body_sequence_fold::SLOTS_VISITED.with(|visited| visited.set(0));
            let format_two = doc
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &edited)
                .expect("format 2")
                .len();
            let visited = body_sequence_fold::SLOTS_VISITED.with(std::cell::Cell::get);
            let allowed = 2 * (before + sequence_length(&doc));
            assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, edited);
            let bytes = match bar {
                Bar::Runs { runs, lines } => format_one * 11 / 10 + 16 * runs + boundary * lines,
                Bar::Whole => format_one * 13 / 10,
            };
            if visited > allowed || format_two > bytes {
                over.push(format!(
                    "{name}: {visited} slots of {allowed}, {format_two} bytes of {bytes} beside {format_one}"
                ));
            }
        }
        assert!(over.is_empty(), "{}", over.join("\n"));
    });
}

#[test]
fn a_fold_keeps_the_letters_a_peer_is_typing_into() {
    let note = "one\n\ntwo\n\nthree\n";
    reading_body_sequence_here(|| {
        for (folded, typed, merged) in [
            (
                "two\n\nthree\n",
                "one\n\ntwoX\n\nthree\n",
                "twoX\n\nthree\n",
            ),
            (
                "one\n\nTWO\n\nthree\n",
                "one\n\ntwo\n\nthreeX\n",
                "one\n\nTWO\n\nthreeX\n",
            ),
            (
                "one\n\n- two\n\nthree\n",
                "one\n\ntwo\n\nXthree\n",
                "one\n\n- two\n\nXthree\n",
            ),
        ] {
            let base = seeded(2, note);
            let (ours, theirs) = (copy(&base, CLIENTS[1]), copy(&base, CLIENTS[2]));
            let ours_update = ours
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, folded)
                .expect("our fold");
            let theirs_update = theirs
                .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, typed)
                .expect("their typing");
            ours.apply(&theirs_update).unwrap();
            theirs.apply(&ours_update).unwrap();
            for doc in [&ours, &theirs] {
                assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, merged);
            }
        }
    });
}
