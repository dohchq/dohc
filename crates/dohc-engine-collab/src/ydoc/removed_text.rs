//! Text a merged change removed without its author having seen it (#3983).
//!
//! The rule is packages/ydoc-projection/src/removedText.ts's. Deleting a line
//! or a text piece also deletes, and lists in the same change, every item
//! inside it that the change's author had. Text the author never had is
//! deleted only by the merge, or as it arrives inside a line already deleted.
//! So the removed text is the text this merge deleted that the change's own
//! delete set does not list.

use super::Ydoc;
use crate::replay_parity::MergeDeletions;
use yrs::deleted_content::{deleted_runs, DeletedElement, DeletedRun, Places};
use yrs::{Any, StateVector, Transact, ID};

/// The editor's inline nodes, as in removedText.ts's `INLINE_NODES`.
const INLINE_NODES: [&str; 7] = [
    "hardBreak",
    "image",
    "wikilink",
    "inlineAtom",
    "mathInline",
    "escapedPunctuation",
    "rawInline",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovedText {
    /// In note order. Lines are joined by a line break; inline items appear
    /// as their Markdown.
    pub text: String,
    /// Some of it stood in the note before this change, so this change
    /// deleted the line it was in. Otherwise all of it arrived with this
    /// change, inside a line an earlier change deleted.
    pub deleted_by_change: bool,
}

impl Ydoc {
    /// The text `deletions` removed unseen in this document, which the merge
    /// left with its deleted content. `before` is the state the change was
    /// merged into.
    pub(crate) fn removed_text(
        &self,
        deletions: &MergeDeletions,
        before: &StateVector,
    ) -> Option<RemovedText> {
        if deletions.merged.is_empty() {
            return None;
        }
        let txn = self.doc.transact();
        if !deleted_runs(&txn, &deletions.merged).iter().any(holds_text) {
            return None;
        }
        let unseen = deletions.merged.diff(&deletions.named);
        let mut places = Places::default();
        // A piece that shows nothing, such as an embed the note never writes,
        // is not removed text.
        let mut pieces: Vec<(Vec<u32>, Option<ID>, DeletedRun<'_>, String)> =
            deleted_runs(&txn, &unseen)
                .into_iter()
                .filter(holds_text)
                .map(|run| (shown(&run), run))
                .filter(|(shown, _)| !shown.is_empty())
                .map(|(shown, run)| (run.place(&mut places), run.line(), run, shown))
                .collect();
        if pieces.is_empty() {
            return None;
        }
        pieces.sort_by(|left, right| left.0.cmp(&right.0));
        let mut text = String::new();
        let mut line = None;
        for (_, piece_line, _, shown) in &pieces {
            if line.is_some_and(|line| line != *piece_line) {
                text.push('\n');
            }
            line = Some(*piece_line);
            text.push_str(shown);
        }
        let deleted_by_change = pieces
            .iter()
            .any(|(_, _, piece, _)| piece.id().clock < before.get(&piece.id().client));
        Some(RemovedText {
            text,
            deleted_by_change,
        })
    }
}

/// Characters, and inline items such as an image, a link or a line break.
fn holds_text(run: &DeletedRun<'_>) -> bool {
    if run.keyed() {
        return false;
    }
    if run.text().is_some() || run.embed().is_some() {
        return run.in_xml_text();
    }
    run.element()
        .is_some_and(|element| INLINE_NODES.contains(&element.name()))
}

/// What the piece shows in the note. The note's Markdown writes a string embed
/// as its text and leaves out any other.
fn shown(run: &DeletedRun<'_>) -> String {
    if let Some(characters) = run.text() {
        return characters.to_owned();
    }
    if let Some(element) = run.element() {
        return inline(element);
    }
    match run.embed() {
        Some(Any::String(text)) => text.to_string(),
        _ => String::new(),
    }
}

/// A deleted element's attributes are deleted too; read the last value written.
fn attribute(element: DeletedElement<'_>, key: &str) -> String {
    match element.attribute(key) {
        Some(Any::String(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn inline(element: DeletedElement<'_>) -> String {
    match element.name() {
        "hardBreak" => "\n".to_owned(),
        "image" => format!(
            "![{}]({})",
            attribute(element, "alt"),
            attribute(element, "src")
        ),
        "wikilink" => {
            let label = attribute(element, "label");
            let target = attribute(element, "target");
            if label.is_empty() {
                format!("[[{target}]]")
            } else {
                format!("[[{target}|{label}]]")
            }
        }
        "mathInline" => format!("${}$", attribute(element, "tex")),
        "inlineAtom" => {
            let source = attribute(element, "source");
            if source.is_empty() {
                format!("{{{{atom:{}}}}}", attribute(element, "atomId"))
            } else {
                format!("{{{{{source}}}}}")
            }
        }
        "escapedPunctuation" => attribute(element, "value"),
        "rawInline" => attribute(element, "source"),
        name => format!("[{name}]"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay_parity::validate_replay_parity_seeing_deletions;
    use crate::ydoc::ROOT_BODY;
    use yrs::types::Attrs;
    use yrs::{ReadTxn, Text, Xml, XmlElementPrelim, XmlFragment, XmlOut, XmlTextPrelim};

    /// The engine that keeps the note, and two people who share it.
    fn shared(lines: &[&str]) -> (Ydoc, Ydoc, Ydoc) {
        let host = Ydoc::with_client_id(1);
        for line in lines {
            host.richdoc_append_paragraph(line);
        }
        let ana = Ydoc::with_client_id(2);
        let ben = Ydoc::with_client_id(3);
        for person in [&ana, &ben] {
            person.apply(&host.encode_full_state()).unwrap();
        }
        (host, ana, ben)
    }

    /// Merge `update` into the host the way the engine does, and return what it removed unseen.
    fn merge(host: &Ydoc, update: &[u8]) -> Option<RemovedText> {
        let (scratch, deletions) = validate_replay_parity_seeing_deletions(host, update).unwrap();
        let removed = scratch.removed_text(&deletions, &host.state_vector());
        host.apply(update).unwrap();
        removed
    }

    fn removed(text: &str, deleted_by_change: bool) -> Option<RemovedText> {
        Some(RemovedText {
            text: text.into(),
            deleted_by_change,
        })
    }

    fn paragraph(doc: &Ydoc, index: u32) -> yrs::XmlElementRef {
        let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = doc.doc.transact();
        match body.get(&txn, index) {
            Some(XmlOut::Element(element)) => element,
            _ => panic!("no paragraph at {index}"),
        }
    }

    #[test]
    fn keeps_typing_whose_line_someone_else_deleted() {
        let (host, ana, ben) = shared(&["Hello"]);
        let typed = ana.richdoc_insert_text(0, 5, " world").unwrap();
        let deleted = ben.richdoc_remove_block(0);
        assert_eq!(merge(&host, &typed), None);
        assert_eq!(merge(&host, &deleted), removed(" world", true));
    }

    #[test]
    fn keeps_typing_that_arrives_inside_a_deleted_line() {
        let (host, ana, ben) = shared(&["Hello"]);
        let typed = ana.richdoc_insert_text(0, 5, " world").unwrap();
        let deleted = ben.richdoc_remove_block(0);
        assert_eq!(merge(&host, &deleted), None);
        assert_eq!(merge(&host, &typed), removed(" world", false));
    }

    #[test]
    fn a_persons_own_delete_removes_nothing_unseen() {
        let (host, ana, _) = shared(&["Hello"]);
        let typed = ana.richdoc_insert_text(0, 5, " world").unwrap();
        let deleted = ana.richdoc_remove_block(0);
        assert_eq!(merge(&host, &typed), None);
        assert_eq!(merge(&host, &deleted), None);
    }

    #[test]
    fn a_delete_made_after_seeing_the_text_removes_nothing_unseen() {
        let (host, ana, ben) = shared(&["Hello"]);
        let typed = ana.richdoc_insert_text(0, 5, " world").unwrap();
        ben.apply(&typed).unwrap();
        let deleted = ben.richdoc_remove_block(0);
        assert_eq!(merge(&host, &typed), None);
        assert_eq!(merge(&host, &deleted), None);
    }

    #[test]
    fn keeps_only_the_part_the_delete_never_saw() {
        let (host, ana, ben) = shared(&["Hello"]);
        let seen = ana.richdoc_insert_text(0, 5, "ab").unwrap();
        ben.apply(&seen).unwrap();
        let unseen = ana.richdoc_insert_text(0, 7, "c").unwrap();
        let deleted = ben.richdoc_remove_block(0);
        for update in [&seen, &unseen] {
            assert_eq!(merge(&host, update), None);
        }
        assert_eq!(merge(&host, &deleted), removed("c", true));
    }

    #[test]
    fn two_people_typing_in_one_piece_remove_nothing() {
        let (host, ana, ben) = shared(&["Hello"]);
        let from_ana = ana.richdoc_keystroke(0, 1, 3, "ipp").unwrap();
        let from_ben = ben.richdoc_insert_text(0, 2, "X").unwrap();
        assert_eq!(merge(&host, &from_ben), None);
        assert_eq!(merge(&host, &from_ana), None);
    }

    #[test]
    fn formatting_removes_nothing() {
        let (host, ana, ben) = shared(&["Hello"]);
        let typed = ana.richdoc_insert_text(0, 5, " world").unwrap();
        let text = match paragraph(&ben, 0).get(&ben.doc.transact(), 0) {
            Some(XmlOut::Text(text)) => text,
            _ => panic!("no text"),
        };
        let before = ben.state_vector();
        let bold = Attrs::from([("bold".into(), yrs::Any::Bool(true))]);
        text.format(&mut ben.doc.transact_mut(), 0, 5, bold);
        let unbold = Attrs::from([("bold".into(), yrs::Any::Null)]);
        text.format(&mut ben.doc.transact_mut(), 0, 5, unbold);
        let formatted = ben.doc.transact().encode_state_as_update_v1(&before);
        assert_eq!(merge(&host, &typed), None);
        assert_eq!(merge(&host, &formatted), None);
    }

    #[test]
    fn an_empty_piece_holds_no_text_to_remove() {
        let (host, ana, ben) = shared(&["Hello"]);
        let before = ana.state_vector();
        paragraph(&ana, 0).insert(&mut ana.doc.transact_mut(), 1, XmlTextPrelim::new(""));
        let empty = ana.doc.transact().encode_state_as_update_v1(&before);
        let deleted = ben.richdoc_remove_block(0);
        assert_eq!(merge(&host, &empty), None);
        assert_eq!(merge(&host, &deleted), None);
    }

    #[test]
    fn an_embed_the_note_leaves_out_removes_nothing_and_a_text_embed_reads_as_written() {
        for (embed, expected) in [
            (Any::Number(7.0), None),
            (Any::String("kept".into()), removed("kept", true)),
        ] {
            let (host, ana, ben) = shared(&[""]);
            let before = ana.state_vector();
            let line = paragraph(&ana, 0);
            {
                let mut txn = ana.doc.transact_mut();
                match line.get(&txn, 0) {
                    Some(XmlOut::Text(text)) => text.insert_embed(&mut txn, 0, embed),
                    _ => panic!("no text"),
                };
                line.insert(&mut txn, 1, XmlElementPrelim::empty("escapedPunctuation"));
            }
            let typed = ana.doc.transact().encode_state_as_update_v1(&before);
            let deleted = ben.richdoc_remove_block(0);
            assert_eq!(merge(&host, &typed), None);
            assert_eq!(merge(&host, &deleted), expected);
        }
    }

    #[test]
    fn a_change_that_deletes_nothing_removes_nothing() {
        let (host, ana, _) = shared(&["Hello"]);
        let typed = ana.richdoc_append_paragraph("more");
        let (_, deletions) = validate_replay_parity_seeing_deletions(&host, &typed).unwrap();
        assert!(deletions.merged.is_empty());
        assert!(deletions.named.is_empty());
        assert_eq!(merge(&host, &typed), None);
    }

    #[test]
    fn quotes_lines_in_note_order_with_inline_items_as_markdown() {
        let (host, ana, ben) = shared(&["one", "two"]);
        let before = ana.state_vector();
        // Read the paragraphs first: a read waits on an open write.
        let (first, second) = (paragraph(&ana, 0), paragraph(&ana, 1));
        {
            let mut txn = ana.doc.transact_mut();
            let image = second.insert(&mut txn, 1, XmlElementPrelim::empty("image"));
            image.insert_attribute(&mut txn, "alt", "cat");
            image.insert_attribute(&mut txn, "src", "c.png");
            second.insert(&mut txn, 2, XmlTextPrelim::new(" after"));
            let raw = second.insert(&mut txn, 3, XmlElementPrelim::empty("rawInline"));
            raw.insert_attribute(&mut txn, "source", "<kbd>");
            match first.get(&txn, 0) {
                Some(XmlOut::Text(text)) => text.insert(&mut txn, 3, " more"),
                _ => panic!("no text"),
            }
        }
        let typed = ana.doc.transact().encode_state_as_update_v1(&before);
        let before = ben.state_vector();
        ben.doc.get_or_insert_xml_fragment(ROOT_BODY).remove_range(
            &mut ben.doc.transact_mut(),
            0,
            2,
        );
        let deleted = ben.doc.transact().encode_state_as_update_v1(&before);
        assert_eq!(merge(&host, &typed), None);
        assert_eq!(
            merge(&host, &deleted),
            removed(" more\n![cat](c.png) after<kbd>", true)
        );
    }
}
