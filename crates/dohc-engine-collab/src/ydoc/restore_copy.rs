use super::*;
use yrs::{ArrayPrelim, In, MapPrelim, TransactionMut, XmlFragmentPrelim};

struct Budget {
    nodes: usize,
    bytes: usize,
}

fn unsupported() -> CollabError {
    CollabError::MalformedUpdate {
        reason: "unsupported restore point value".into(),
    }
}

impl Budget {
    fn node(&mut self, depth: usize) -> Result<(), CollabError> {
        consume_projection_value_node(depth, &mut self.nodes)
    }

    fn bytes(&mut self, count: usize) -> Result<(), CollabError> {
        self.bytes = self
            .bytes
            .checked_sub(count)
            .ok_or_else(|| CollabError::MalformedUpdate {
                reason: "restore structure exceeds configured byte budget".into(),
            })?;
        Ok(())
    }

    fn any(&mut self, value: &Any, depth: usize) -> Result<(), CollabError> {
        self.node(depth)?;
        match value {
            Any::String(value) => self.bytes(value.len()),
            Any::Buffer(value) => self.bytes(value.len()),
            Any::Array(values) => {
                for value in values.iter() {
                    self.any(value, depth + 1)?;
                }
                Ok(())
            }
            Any::Map(values) => {
                for (key, value) in values.iter() {
                    self.bytes(key.len())?;
                    self.any(value, depth + 1)?;
                }
                Ok(())
            }
            _ => self.bytes(8),
        }
    }
}

pub(super) fn copy(point: &Ydoc, staged: &Ydoc, max_bytes: usize) -> Result<(), CollabError> {
    let source_body = point.doc.get_or_insert_xml_fragment(ROOT_BODY);
    let source_frontmatter = point.doc.get_or_insert_map(ROOT_FRONTMATTER);
    let source_meta = point.doc.get_or_insert_map(ROOT_META);
    let source = point.doc.transact();
    let body = staged.doc.get_or_insert_xml_fragment(ROOT_BODY);
    let frontmatter = staged.doc.get_or_insert_map(ROOT_FRONTMATTER);
    let meta = staged.doc.get_or_insert_map(ROOT_META);
    let mut target = staged.doc.transact_mut();
    let mut budget = Budget {
        nodes: MAX_PROJECTION_NODES,
        bytes: max_bytes.min(MAX_PROJECTION_BYTES),
    };
    frontmatter.clear(&mut target);
    for (key, value) in source_frontmatter.iter(&source) {
        budget.bytes(key.len())?;
        let value = copy_value(&source, value, 0, &mut budget)?;
        frontmatter.insert(&mut target, key, value);
    }
    let length = body.len(&target);
    body.remove_range(&mut target, 0, length);
    copy_children(&source, &source_body, &mut target, &body, 0, &mut budget)?;
    match source_meta.get(&source, MARKDOWN_CRLF_META_KEY) {
        Some(Out::Any(Any::Bool(true))) => {
            meta.insert(&mut target, MARKDOWN_CRLF_META_KEY, true);
        }
        None => {
            meta.remove(&mut target, MARKDOWN_CRLF_META_KEY);
        }
        _ => return Err(unsupported()),
    }
    Ok(())
}

fn copy_value<T: ReadTxn>(
    source: &T,
    value: Out,
    depth: usize,
    budget: &mut Budget,
) -> Result<In, CollabError> {
    budget.node(depth)?;
    match value {
        Out::Any(value) => {
            budget.any(&value, depth + 1)?;
            Ok(In::Any(value))
        }
        Out::YMap(map) => {
            let mut values = MapPrelim::default();
            for (key, value) in map.iter(source) {
                budget.bytes(key.len())?;
                values.insert(key.into(), copy_value(source, value, depth + 1, budget)?);
            }
            Ok(In::Map(values))
        }
        Out::YArray(array) => {
            let mut values = ArrayPrelim::default();
            for value in array.iter(source) {
                values.push(copy_value(source, value, depth + 1, budget)?);
            }
            Ok(In::Array(values))
        }
        _ => Err(unsupported()),
    }
}

fn copy_attributes<T: ReadTxn, S: Xml, D: Xml>(
    source: &T,
    from: &S,
    target: &mut TransactionMut,
    to: &D,
    depth: usize,
    budget: &mut Budget,
) -> Result<(), CollabError> {
    for (key, value) in from.attributes(source) {
        budget.bytes(key.len())?;
        let Out::Any(value) = value else {
            return Err(unsupported());
        };
        budget.any(&value, depth)?;
        to.insert_attribute(target, key, value);
    }
    Ok(())
}

fn copy_children<T: ReadTxn, S: XmlFragment, D: XmlFragment>(
    source: &T,
    from: &S,
    target: &mut TransactionMut,
    to: &D,
    depth: usize,
    budget: &mut Budget,
) -> Result<(), CollabError> {
    for (index, child) in from.children(source).enumerate() {
        budget.node(depth)?;
        match child {
            XmlOut::Element(element) => {
                budget.bytes(element.tag().len())?;
                let fresh = to.insert(
                    target,
                    index as u32,
                    XmlElementPrelim::empty(element.tag().clone()),
                );
                copy_attributes(source, &element, target, &fresh, depth + 1, budget)?;
                copy_children(source, &element, target, &fresh, depth + 1, budget)?;
            }
            XmlOut::Fragment(fragment) => {
                let XmlOut::Fragment(fresh) = to.insert(
                    target,
                    index as u32,
                    yrs::types::xml::XmlIn::Fragment(XmlFragmentPrelim::default()),
                ) else {
                    return Err(unsupported());
                };
                copy_children(source, &fragment, target, &fresh, depth + 1, budget)?;
            }
            XmlOut::Text(text) => {
                let fresh = to.insert(target, index as u32, XmlTextPrelim::default());
                copy_attributes(source, &text, target, &fresh, depth + 1, budget)?;
                let mut offset = 0;
                text.try_visit_diff(source, |chunk| -> Result<(), CollabError> {
                    let TextDiffChunk::Text {
                        text, attributes, ..
                    } = chunk
                    else {
                        return Err(unsupported());
                    };
                    budget.node(depth + 1)?;
                    budget.bytes(text.len())?;
                    for (key, value) in attributes {
                        budget.bytes(key.len())?;
                        budget.any(value, depth + 2)?;
                    }
                    fresh.insert_with_attributes(target, offset, text, attributes.clone());
                    offset += text.encode_utf16().count() as u32;
                    Ok(())
                })?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::types::Attrs;

    #[test]
    fn restore_copy_keeps_nested_blocks_marks_and_typed_attributes() {
        let point = Ydoc::wire();
        let body = point.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let frontmatter = point.doc.get_or_insert_map(ROOT_FRONTMATTER);
        {
            let mut txn = point.doc.transact_mut();
            let nested = frontmatter.insert(&mut txn, "nested", MapPrelim::default());
            nested.insert(
                &mut txn,
                "values",
                ArrayPrelim::from([In::from(true), In::from(42)]),
            );
            let quote = body.push_back(&mut txn, XmlElementPrelim::empty("blockquote"));
            let list = quote.push_back(&mut txn, XmlElementPrelim::empty("orderedList"));
            list.insert_attribute(&mut txn, "start", 3);
            let item = list.push_back(&mut txn, XmlElementPrelim::empty("listItem"));
            let paragraph = item.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            paragraph.insert_attribute(&mut txn, "checked", true);
            let text = paragraph.push_back(&mut txn, XmlTextPrelim::default());
            text.insert_attribute(&mut txn, "custom", Any::Number(42.0));
            text.insert_with_attributes(
                &mut txn,
                0,
                "世界🦀",
                Attrs::from([
                    ("bold".into(), yrs::any!({})),
                    (
                        "link".into(),
                        yrs::any!({"href": "https://example.test/a", "title": "Link"}),
                    ),
                ]),
            );
            text.insert_with_attributes(&mut txn, 4, " plain", Attrs::default());
        }
        let markdown = point.project(ContentKind::Richdoc).unwrap().content;
        let frozen = Ydoc::wire();
        frozen.apply(&point.encode_full_state()).unwrap();
        frozen.richdoc_append_paragraph("later");
        let before = frozen.state_vector();
        let delta = frozen
            .rewrite_richdoc_preserving_source_bounded(&markdown, &point, 2_000_000)
            .unwrap();
        assert_eq!(
            frozen.canonical_content()[ROOT_BODY],
            point.canonical_content()[ROOT_BODY]
        );
        assert_eq!(
            frozen.canonical_content()[ROOT_FRONTMATTER],
            point.canonical_content()[ROOT_FRONTMATTER]
        );
        assert_eq!(
            frozen.preserved_markdown_source(&markdown).as_deref(),
            Some(markdown.as_str())
        );
        for (client, end) in frozen.state_vector().iter() {
            assert!(before.get(client) == 0 || before.get(client) == *end);
        }
        frozen.apply(&delta).unwrap();
        assert_eq!(
            frozen.canonical_content()[ROOT_BODY],
            point.canonical_content()[ROOT_BODY]
        );
        let body = frozen.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = frozen.doc.transact();
        let XmlOut::Element(quote) = body.get(&txn, 0).unwrap() else {
            panic!()
        };
        let XmlOut::Element(list) = quote.get(&txn, 0).unwrap() else {
            panic!()
        };
        let XmlOut::Element(item) = list.get(&txn, 0).unwrap() else {
            panic!()
        };
        let XmlOut::Element(paragraph) = item.get(&txn, 0).unwrap() else {
            panic!()
        };
        let XmlOut::Text(text) = paragraph.get(&txn, 0).unwrap() else {
            panic!()
        };
        assert_eq!(
            text.get_attribute(&txn, "custom"),
            Some(Out::Any(Any::Number(42.0)))
        );
    }

    #[test]
    fn restore_copy_preserves_crlf_and_clears_stale_crlf() {
        for source in ["# Point\r\n\r\nText.\r\n", "# Point\n\nText.\n"] {
            let point = Ydoc::wire();
            point
                .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
                .unwrap();
            let frozen = Ydoc::wire();
            frozen
                .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "# Later\r\n")
                .unwrap();
            frozen
                .rewrite_richdoc_preserving_source_bounded(source, &point, 2_000_000)
                .unwrap();
            let projection = frozen.project(ContentKind::Richdoc).unwrap().content;
            assert_eq!(
                projection,
                point.project(ContentKind::Richdoc).unwrap().content
            );
            assert_eq!(
                frozen.preserved_markdown_source(&projection).as_deref(),
                Some(source)
            );
        }
    }

    #[test]
    fn restore_copy_refuses_string_embed_even_when_projection_can_render_it() {
        let point = Ydoc::wire();
        point.richdoc_append_paragraph("point");
        {
            let body = point.doc.get_or_insert_xml_fragment(ROOT_BODY);
            let mut txn = point.doc.transact_mut();
            let XmlOut::Element(paragraph) = body.get(&txn, 0).unwrap() else {
                panic!()
            };
            let XmlOut::Text(text) = paragraph.get(&txn, 0).unwrap() else {
                panic!()
            };
            text.insert_embed(&mut txn, 0, Any::String("embedded ".into()));
        }
        let source = point.project(ContentKind::Richdoc).unwrap().content;
        assert!(source.contains("embedded"));
        let frozen = Ydoc::wire();
        frozen.richdoc_append_paragraph("unchanged");
        let before = frozen.encode_full_state();
        assert!(matches!(
            frozen.rewrite_richdoc_preserving_source_bounded(&source,&point,2_000_000),
            Err(CollabError::MalformedUpdate {reason}) if reason == "unsupported restore point value"
        ));
        assert_eq!(before, frozen.encode_full_state());
    }

    #[test]
    fn restore_copy_refuses_unsupported_values_and_excess_depth_without_mutating_frozen() {
        for case in 0..4 {
            let point = Ydoc::wire();
            point.richdoc_append_paragraph("point");
            {
                let body = point.doc.get_or_insert_xml_fragment(ROOT_BODY);
                let frontmatter = point.doc.get_or_insert_map(ROOT_FRONTMATTER);
                let mut txn = point.doc.transact_mut();
                let XmlOut::Element(paragraph) = body.get(&txn, 0).unwrap() else {
                    panic!()
                };
                let XmlOut::Text(text) = paragraph.get(&txn, 0).unwrap() else {
                    panic!()
                };
                match case {
                    0 => {
                        frontmatter.insert(&mut txn, "unsupported", yrs::TextPrelim::new("text"));
                    }
                    1 => {
                        text.insert_embed(&mut txn, 0, Any::Number(1.0));
                    }
                    2 => {
                        paragraph.insert_attribute(&mut txn, "unsupported", MapPrelim::default());
                    }
                    _ => {
                        let deep = (0..=MAX_PROJECTION_DEPTH)
                            .fold(Any::Null, |value, _| Any::Array(vec![value].into()));
                        paragraph.insert_attribute(&mut txn, "deep", deep);
                    }
                }
            }
            let frozen = Ydoc::wire();
            frozen.richdoc_append_paragraph("unchanged");
            let before = frozen.encode_full_state();
            assert!(
                frozen
                    .rewrite_richdoc_preserving_source_bounded("point\n", &point, 2_000_000)
                    .is_err(),
                "case {case}"
            );
            assert_eq!(before, frozen.encode_full_state());
        }
    }
}
