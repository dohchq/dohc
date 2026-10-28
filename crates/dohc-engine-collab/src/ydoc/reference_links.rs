use super::*;
use yrs::types::Attrs;

impl Ydoc {
    // The desktop keeps definitions as paragraphs but resolves their uses to
    // link marks. Reconstruct plain full references for the local source proof;
    // unsupported syntax still needs the existing reconstruction checks.
    pub(super) fn resolve_reference_links(&self, source: &str) -> bool {
        let (_, _, body_source) = split_markdown_frontmatter(source);
        // These blocks can hide a definition across paragraph boundaries.
        // Leave them to the full desktop reader rather than guess their scope.
        let lower = body_source.to_ascii_lowercase();
        if body_source.contains(['`', '~', '\\'])
            || ["<!", "<?", "<script", "<style", "<pre", "<textarea"]
                .iter()
                .any(|&opener| lower.contains(opener))
        {
            return false;
        }
        let normalized = body_source.replace("\r\n", "\n");
        let mut definitions = BTreeMap::new();
        for block in normalized.split("\n\n") {
            if !block.contains("]:") {
                continue;
            }
            // A definition must be a whole, plain source paragraph. An
            // unsupported earlier definition must not expose a later duplicate.
            let Some((key, href)) = plain_definition(block.trim_matches('\n')) else {
                return false;
            };
            // marked uses the first definition for a label.
            definitions.entry(key).or_insert(href);
        }
        if definitions.is_empty() {
            return false;
        }
        let body = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let mut txn = self.doc.transact_mut();
        let paragraphs: Vec<_> = body
            .children(&txn)
            .enumerate()
            .filter_map(|(index, node)| match node {
                XmlOut::Element(element) if element.tag().as_ref() == "paragraph" => {
                    let mut children = element.children(&txn);
                    match (children.next(), children.next()) {
                        (Some(XmlOut::Text(text)), None) => {
                            let source = text.get_string(&txn);
                            Some((index as u32, text, source))
                        }
                        _ => None,
                    }
                }
                _ => None,
            })
            .collect();
        // Block HTML interrupts desktop paragraph text. A closing tag after
        // prose, as in the saved desktop seed, therefore starts its own paragraph.
        for (index, text, source) in paragraphs.iter().rev() {
            if source.lines().next().is_some_and(html_block) {
                continue;
            }
            let mut offset = 0;
            for line in source.split_inclusive('\n') {
                if offset > 0 && html_block(line.trim_end_matches('\n')) {
                    let at = source[..offset].encode_utf16().count() as u32;
                    let len = text.len(&txn);
                    text.remove_range(&mut txn, at - 1, len - at + 1);
                    insert_md_paragraph(&mut txn, &body, *index + 1, &source[offset..]);
                    break;
                }
                offset += line.len();
            }
        }
        let mut changed = false;
        let mut resolved_bytes = 0;
        for (_, text, source) in paragraphs {
            // Other inline syntax needs the desktop reader's full parse.
            if definition_paragraph(&source)
                || source.contains(['\\', '`', '!', '<', '>', '&', '*', '_', '~', '{', '}'])
            {
                continue;
            }
            let mut rest = source.as_str();
            let mut offset = 0_u32;
            let mut edits = Vec::new();
            while let Some(start) = rest.find('[') {
                let Some((label, after)) = rest[start + 1..].split_once("][") else {
                    break;
                };
                let Some((key, tail)) = after.split_once(']') else {
                    break;
                };
                if !label.is_empty() && !label.contains(['[', ']', '\n', '\r']) {
                    if let Some(href) = reference_key(key).and_then(|key| definitions.get(&key)) {
                        let end = rest.len() - tail.len();
                        let Ok(bytes) = checked_projection_len(resolved_bytes, href.len())
                            .and_then(|bytes| checked_projection_len(bytes, label.len()))
                        else {
                            return false;
                        };
                        resolved_bytes = bytes;
                        edits.push((
                            offset + rest[..start].encode_utf16().count() as u32,
                            rest[start..end].encode_utf16().count() as u32,
                            label,
                            href,
                        ));
                    }
                }
                offset += rest[..rest.len() - tail.len()].encode_utf16().count() as u32;
                rest = tail;
            }
            // Apply from the end; Y.Doc offsets count UTF-16 code units.
            for (at, len, label, href) in edits.into_iter().rev() {
                text.remove_range(&mut txn, at, len);
                text.insert_with_attributes(
                    &mut txn,
                    at,
                    label,
                    Attrs::from([(
                        "link".into(),
                        json_to_any(&json!({
                            "href": href,
                            "target": "_blank",
                            "rel": "noopener noreferrer nofollow",
                            "class": null,
                            "title": null,
                        })),
                    )]),
                );
                changed = true;
            }
        }
        changed
    }
}

// Only plain labels and destinations need no inline decoding. More complex
// references remain subject to the existing reconstruction checks.
fn plain_definition(text: &str) -> Option<(String, String)> {
    if !definition_paragraph(text) {
        return None;
    }
    let (label, href) = text
        .trim_start_matches(' ')
        .strip_prefix('[')?
        .split_once("]:")?;
    let key = reference_key(label)?;
    let href = href.trim_matches(is_js_whitespace);
    if href.is_empty()
        || !href
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b":/.-_?#=+%@~".contains(&byte))
    {
        return None;
    }
    Some((key, href.to_owned()))
}

fn reference_key(label: &str) -> Option<String> {
    if !label
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"-_ \t\n\r".contains(&byte))
    {
        return None;
    }
    let key = label.split_ascii_whitespace().collect::<Vec<_>>().join(" ");
    (!key.is_empty()).then(|| key.to_ascii_lowercase())
}
