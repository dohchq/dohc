extern crate dohc_heap_profiler;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use dohc_engine_collab::{CollabError, ContentKind, Projection, Ydoc, ROOT_BODY};
use yrs::types::Attrs;
use yrs::{
    Any, Doc, ReadTxn, StateVector, Text, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

const HREF_BYTES: usize = 64 * 1024;

static ONE_PROFILER: Mutex<()> = Mutex::new(());

fn alone() -> MutexGuard<'static, ()> {
    ONE_PROFILER.lock().unwrap_or_else(PoisonError::into_inner)
}

fn note_of_one_linked_run(block: &str, text: &str) -> Ydoc {
    let source = Doc::new();
    let body = source.get_or_insert_xml_fragment(ROOT_BODY);
    {
        let mut txn = source.transact_mut();
        let block = body.push_back(&mut txn, XmlElementPrelim::empty(block));
        let run = block.push_back(&mut txn, XmlTextPrelim::new(""));
        let href = Any::String("h".repeat(HREF_BYTES).into());
        let link = Any::Map(Arc::new(HashMap::from([("href".to_owned(), href)])));
        let linked = Attrs::from([("link".into(), link)]);
        run.insert_with_attributes(&mut txn, 0, text, linked);
    }
    let update = source
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let note = Ydoc::wire();
    note.apply(&update).expect("the note applies");
    note
}

fn peak_heap_bytes_writing(note: &Ydoc) -> (usize, Result<Projection, CollabError>) {
    let profiler = dhat::Profiler::builder().testing().build();
    let written = note.project(ContentKind::Richdoc);
    let peak = dhat::HeapStats::get().max_bytes;
    drop(profiler);
    (peak, written)
}

fn a_quarter_of_a_link_for_each(repeat: usize) -> usize {
    repeat * HREF_BYTES / 4
}

#[test]
fn writes_a_linked_paragraph_of_block_openers_without_a_link_for_each_piece() {
    let _alone = alone();
    let note = note_of_one_linked_run("paragraph", &"\n#".repeat(500));
    let (peak, written) = peak_heap_bytes_writing(&note);
    let written = written.expect("it writes").content;
    assert_eq!(written.matches("&#35;").count(), 500, "{written:.80}");
    assert_eq!(written.matches("](").count(), 1, "{written:.80}");
    assert!(peak < a_quarter_of_a_link_for_each(500), "{peak} bytes");
}

#[test]
fn writes_a_linked_heading_of_links_without_text_without_a_link_for_each_piece() {
    let _alone = alone();
    let note = note_of_one_linked_run("heading", &"[](u \"a\n# b\")".repeat(500));
    let (peak, written) = peak_heap_bytes_writing(&note);
    let written = written.expect("it writes").content;
    assert_eq!(written.matches("&#35; b").count(), 500, "{written:.80}");
    assert!(peak < a_quarter_of_a_link_for_each(500), "{peak} bytes");
}

#[test]
fn refuses_linked_tab_indents_too_large_to_write_without_a_link_for_each_piece() {
    let _alone = alone();
    let note = note_of_one_linked_run("paragraph", &"\n\tx".repeat(4_000));
    let (peak, written) = peak_heap_bytes_writing(&note);
    let written = written.map(|written| written.content.len());
    let too_large = matches!(written, Err(CollabError::ProjectionTooLarge { .. }));
    assert!(too_large, "{written:?}");
    assert!(peak < a_quarter_of_a_link_for_each(4_000), "{peak} bytes");
}
