use std::convert::Infallible;
use yrs::types::text::{Diff, TextDiffChunk, YChange};
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{Any, ArrayPrelim, Doc, Out, ReadTxn, StateVector, Text, Transact, Update};

fn collected<T: ReadTxn, R: Text>(text: &R, txn: &T) -> Vec<Diff<YChange>> {
    let mut result: Vec<Diff<YChange>> = Vec::new();
    text.try_visit_diff(txn, |chunk| -> Result<(), Infallible> {
        match chunk {
            TextDiffChunk::Text {
                text,
                continues_previous: true,
                ..
            } => {
                let previous = result.last_mut().expect("continuation follows text");
                let Out::Any(Any::String(value)) = &previous.insert else {
                    panic!("continuation follows a text insert");
                };
                let mut value = value.to_string();
                value.push_str(text);
                previous.insert = value.into();
            }
            TextDiffChunk::Text {
                text, attributes, ..
            } => result.push(Diff::new(
                text.into(),
                (!attributes.is_empty()).then(|| Box::new(attributes.clone())),
            )),
            TextDiffChunk::Embed { insert, attributes } => result.push(Diff::new(
                insert,
                (!attributes.is_empty()).then(|| Box::new(attributes.clone())),
            )),
        }
        Ok(())
    })
    .unwrap();
    result
}

#[test]
fn borrowed_visitor_matches_current_diff_with_formats_embeds_and_deletions() {
    let doc = Doc::with_client_id(1);
    let text = doc.get_or_insert_text("text");
    let mut txn = doc.transact_mut();
    text.insert_with_attributes(
        &mut txn,
        0,
        "hello world",
        Attrs::from([("italic".into(), true.into())]),
    );
    text.format(&mut txn, 6, 5, Attrs::from([("bold".into(), true.into())]));
    text.insert_embed(&mut txn, 5, vec![1_u8, 2, 3]);
    text.insert_embed(&mut txn, 5, ArrayPrelim::from([1, 2]));
    assert_eq!(collected(&text, &txn), text.diff(&txn, YChange::identity));
    text.remove_range(&mut txn, 1, 2);
    text.format(&mut txn, 0, 3, Attrs::from([("italic".into(), Any::Null)]));
    assert_eq!(collected(&text, &txn), text.diff(&txn, YChange::identity));
}

#[test]
fn fragments_from_multiple_clients_keep_one_logical_run() {
    let first = Doc::with_client_id(1);
    let first_text = first.get_or_insert_text("text");
    first_text.insert(&mut first.transact_mut(), 0, "ab");
    let second = Doc::with_client_id(2);
    let second_text = second.get_or_insert_text("text");
    let update = first
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    second
        .transact_mut()
        .apply_update(Update::decode_v1(&update).unwrap())
        .unwrap();
    second_text.insert(&mut second.transact_mut(), 2, "cd");
    let update = second
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    first
        .transact_mut()
        .apply_update(Update::decode_v1(&update).unwrap())
        .unwrap();
    first_text.insert(&mut first.transact_mut(), 4, "é😀");
    let txn = first.transact();
    let mut fragments = 0;
    let mut runs = 0;
    first_text
        .try_visit_diff(&txn, |chunk| -> Result<(), Infallible> {
            if let TextDiffChunk::Text {
                continues_previous, ..
            } = chunk
            {
                fragments += 1;
                runs += usize::from(!continues_previous);
            }
            Ok(())
        })
        .unwrap();
    assert!(fragments >= 2, "different clients retain distinct items");
    assert_eq!(runs, 1);
    let delta = collected(&first_text, &txn);
    assert_eq!(delta, first_text.diff(&txn, YChange::identity));
    assert_eq!(delta[0].insert, "abcdé😀".into());
}

#[test]
fn error_stops_before_later_runs_and_preserves_the_borrowed_fragment() {
    let doc = Doc::with_client_id(1);
    let text = doc.get_or_insert_text("text");
    let body = "x".repeat(2 * 1024 * 1024);
    let mut txn = doc.transact_mut();
    text.insert(&mut txn, 0, &body);
    text.insert_with_attributes(
        &mut txn,
        body.len() as u32,
        "later",
        Attrs::from([("bold".into(), true.into())]),
    );
    let mut calls = 0;
    let result = text.try_visit_diff(&txn, |chunk| {
        calls += 1;
        let TextDiffChunk::Text {
            text,
            continues_previous,
            ..
        } = chunk
        else {
            panic!("first item is text");
        };
        assert_eq!(text, body);
        assert!(!continues_previous);
        Err::<(), _>("budget exhausted")
    });
    assert_eq!(result, Err("budget exhausted"));
    assert_eq!(calls, 1);
}
