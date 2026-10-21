use super::*;
use std::ops::Range;

type WikilinkProjection = (String, Vec<(Range<usize>, usize)>);

impl Ydoc {
    fn wikilink_elements(&self) -> Vec<yrs::XmlElementRef> {
        let body = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = self.doc.transact();
        let mut pending: Vec<_> = body.children(&txn).collect();
        pending.reverse();
        let mut elements = Vec::new();
        while let Some(child) = pending.pop() {
            if let XmlOut::Element(element) = child {
                if element.tag().as_ref() == "wikilink" {
                    elements.push(element.clone());
                }
                let children: Vec<_> = element.children(&txn).collect();
                pending.extend(children.into_iter().rev());
            }
        }
        elements
    }

    /// Locate element targets in the projection without searching their literals.
    /// Each span carries its element's ordinal in the XML traversal.
    pub fn wikilink_spans(&self) -> Result<WikilinkProjection, CollabError> {
        let original = self.project_richdoc()?;
        let staged = Ydoc::wire();
        staged.apply(&self.encode_full_state())?;
        let elements = staged.wikilink_elements();
        let mut prefix = "dohcWikilinkSpan".to_owned();
        while original.contains(&prefix) {
            prefix.push('x');
        }
        let targets: Vec<String> = {
            let txn = staged.doc.transact();
            elements
                .iter()
                .map(|e| {
                    e.get_attribute(&txn, "target")
                        .map(|v| v.to_string(&txn))
                        .unwrap_or_default()
                })
                .collect()
        };
        {
            let mut txn = staged.doc.transact_mut();
            for (i, element) in elements.iter().enumerate() {
                element.insert_attribute(&mut txn, "target", format!("{prefix}{i}End"));
            }
        }
        let marked = staged.project_richdoc()?;
        let mut occurrences = Vec::new();
        for (i, target) in targets.iter().enumerate() {
            let marker = format!("{prefix}{i}End");
            if let Some(start) = marked.find(&marker) {
                if marked[start + marker.len()..].contains(&marker) {
                    return Err(CollabError::Corrupt {
                        reason: "ambiguous wikilink element".into(),
                    });
                }
                occurrences.push((start..start + marker.len(), i, escape_wikilink_part(target)));
            }
        }
        occurrences.sort_by_key(|(range, _, _)| range.start);
        let mut rebuilt = String::new();
        let mut spans = Vec::new();
        let mut cursor = 0;
        for (range, ordinal, target) in occurrences {
            rebuilt.push_str(&marked[cursor..range.start]);
            let start = rebuilt.len();
            rebuilt.push_str(&target);
            spans.push((start..rebuilt.len(), ordinal));
            cursor = range.end;
        }
        rebuilt.push_str(&marked[cursor..]);
        if rebuilt != original {
            return Err(CollabError::Corrupt {
                reason: "wikilink projection changed".into(),
            });
        }
        Ok((original, spans))
    }

    /// Stage target attributes and a source witness; preserve every XML item.
    pub fn stage_wikilink_targets(
        &self,
        markdown: &str,
        edits: &[(usize, String)],
    ) -> Result<Vec<u8>, CollabError> {
        self.stage_source_preserving_edit(markdown, |staged| {
            let elements = staged.wikilink_elements();
            let mut txn = staged.doc.transact_mut();
            for (ordinal, target) in edits {
                let element = elements.get(*ordinal).ok_or_else(|| CollabError::Corrupt {
                    reason: "wikilink element disappeared".into(),
                })?;
                element.insert_attribute(&mut txn, "target", target.clone());
            }
            Ok(())
        })
    }
}

#[cfg(any(test, feature = "test-support"))]
impl Ydoc {
    /// Build the editor's native inline nodes for single-paragraph fixtures.
    pub fn richdoc_wikilinks_for_test(&self, markdown: &str) -> Result<Vec<u8>, CollabError> {
        assert!(!markdown.contains(['\n', '\r']));
        self.stage_source_preserving_edit(markdown, |staged| {
            let body = staged.doc.get_or_insert_xml_fragment(ROOT_BODY);
            let meta = staged.doc.get_or_insert_map(ROOT_META);
            let mut txn = staged.doc.transact_mut();
            meta.insert(&mut txn, "schemaVersion", Any::Number(1.0));
            let len = body.len(&txn);
            body.remove_range(&mut txn, 0, len);
            let paragraph = body.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
            let mut rest = markdown;
            while let Some(start) = rest.find("[[") {
                if start > 0 {
                    let index = paragraph.len(&txn);
                    paragraph.insert(&mut txn, index, XmlTextPrelim::new(&rest[..start]));
                }
                let end = rest[start + 2..].find("]]").unwrap() + start + 2;
                let (target, label) = rest[start + 2..end]
                    .split_once('|')
                    .map_or((&rest[start + 2..end], None), |(t, l)| (t, Some(l)));
                let index = paragraph.len(&txn);
                let element =
                    paragraph.insert(&mut txn, index, XmlElementPrelim::empty("wikilink"));
                element.insert_attribute(&mut txn, "target", target);
                if let Some(label) = label {
                    element.insert_attribute(&mut txn, "label", label);
                }
                rest = &rest[end + 2..];
            }
            if !rest.is_empty() {
                let index = paragraph.len(&txn);
                paragraph.insert(&mut txn, index, XmlTextPrelim::new(rest));
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_edit_preserves_the_existing_xml_element_and_concurrent_edits() {
        let doc = Ydoc::wire();
        doc.richdoc_wikilinks_for_test("[[old#part|label]]")
            .unwrap();
        let element = doc.wikilink_elements()[0].clone();
        let peer = Ydoc::wire();
        peer.apply(&doc.encode_full_state()).unwrap();
        let concurrent = peer.richdoc_append_paragraph("unrelated typing");
        let (text, spans) = doc.wikilink_spans().unwrap();
        assert_eq!(&text[spans[0].0.clone()], "old#part");
        doc.stage_wikilink_targets("[[new#part|label]]", &[(spans[0].1, "new#part".into())])
            .unwrap();
        element.insert_attribute(&mut doc.doc.transact_mut(), "label", "edited label");
        doc.apply(&concurrent).unwrap();
        let text = doc.project_richdoc().unwrap();
        assert!(text.contains("[[new#part|edited label]]"));
        assert!(text.contains("unrelated typing"));
    }
}
