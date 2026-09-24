//! Frontmatter presentation matching js-yaml 5.2.3, with dohc's lossless schema.
//! Scalar style rules adapted from nodeca/js-yaml commit
//! 6740445e7bf0ec701f14226e1dfa7ef50f7068cc. See js-yaml-LICENSE.txt.
use super::*;
use dohc_engine_domain::collections::markdown_frontmatter_block;

pub(super) fn compare_keys(left: &str, right: &str, root: bool) -> std::cmp::Ordering {
    let index = |key: &str| {
        key.parse::<u32>()
            .ok()
            .filter(|value| *value < u32::MAX && value.to_string() == key)
    };
    match (index(left), index(right)) {
        (Some(left), Some(right)) => return left.cmp(&right),
        (Some(_), None) => return std::cmp::Ordering::Less,
        (None, Some(_)) => return std::cmp::Ordering::Greater,
        _ => {}
    }
    let priority = |key: &str| {
        if root {
            ["id", "title", "icon"]
                .iter()
                .position(|candidate| *candidate == key)
                .unwrap_or(3)
        } else {
            3
        }
    };
    priority(left)
        .cmp(&priority(right))
        .then_with(|| left.encode_utf16().cmp(right.encode_utf16()))
}

pub(super) fn entry(
    output: &mut ProjectionBuffer,
    key: &str,
    value: &Value,
    indent: usize,
) -> ProjectionResult<()> {
    output.push_repeat(' ', indent)?;
    let rendered = scalar(key, indent + 2, true)?;
    let explicit = key.contains('\n') || rendered.encode_utf16().count() > 1024;
    if explicit {
        output.push_str("? ")?;
    }
    output.push_str(&rendered)?;
    if explicit {
        output.push('\n')?;
        output.push_repeat(' ', indent)?;
    }
    output.push(':')?;
    value_after(output, value, indent + 2, explicit)?;
    output.push('\n')
}

fn value_after(
    output: &mut ProjectionBuffer,
    value: &Value,
    indent: usize,
    compact: bool,
) -> ProjectionResult<()> {
    match value {
        Value::Object(map) if !map.is_empty() => {
            let mut first = true;
            let mut ordered: Vec<_> = map.iter().collect();
            ordered.sort_by(|(left, _), (right, _)| compare_keys(left, right, false));
            for (key, value) in ordered {
                if first && compact {
                    output.push(' ')?;
                } else if !first || !compact {
                    output.push('\n')?;
                }
                let start = output.value.len();
                entry(output, key, value, indent)?;
                output.value.pop();
                if first && compact {
                    output.value.drain(start..start + indent);
                }
                first = false;
            }
        }
        Value::Array(items) if !items.is_empty() => {
            for (index, item) in items.iter().enumerate() {
                if index == 0 && compact {
                    output.push(' ')?;
                } else {
                    output.push('\n')?;
                    output.push_repeat(' ', indent)?;
                }
                output.push('-')?;
                value_after(output, item, indent + 2, true)?;
            }
        }
        _ => {
            output.push(' ')?;
            output.push_str(&atom(value, indent)?)?;
        }
    }
    Ok(())
}

fn atom(value: &Value, indent: usize) -> ProjectionResult<String> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::String(value) => scalar(value, indent, false)?,
        Value::Number(value) => {
            if value.is_i64() || value.is_u64() {
                value.to_string()
            } else {
                let value = value.as_f64().ok_or_else(|| CollabError::MalformedUpdate {
                    reason: "invalid frontmatter number".into(),
                })?;
                if value == 0.0 && value.is_sign_negative() {
                    "-0.0".into()
                } else {
                    let mut text = ryu_js::Buffer::new().format_finite(value).to_owned();
                    if let Some(index) = text.find('e') {
                        if !text[..index].contains('.') {
                            text.insert(index, '.');
                        }
                    }
                    if value.fract() == 0.0
                        && value.abs() > 9_007_199_254_740_991.0
                        && !text.contains('.')
                    {
                        text.push_str(".0");
                    }
                    text
                }
            }
        }
        Value::Object(_) => "{}".into(),
        Value::Array(_) => "[]".into(),
    })
}

fn printable(c: char) -> bool {
    let c = c as u32;
    (0x20..=0x7e).contains(&c)
        || ((0xa1..=0xd7ff).contains(&c) && c != 0x2028 && c != 0x2029)
        || ((0xe000..=0xfffd).contains(&c) && c != 0xfeff)
        || c >= 0x10000
}

fn scalar(value: &str, indent: usize, key: bool) -> ProjectionResult<String> {
    checked_projection_len(0, value.len())?;
    if value.chars().any(|c| !printable(c) && (key || c != '\n')) {
        return double(value);
    }
    if !key && value.contains('\n') {
        let needs_indent = value.trim_start_matches('\n').starts_with(' ');
        let mut out = ProjectionBuffer::new();
        out.push('|')?;
        if needs_indent {
            out.push('2')?;
        }
        if !value.ends_with('\n') {
            out.push('-')?;
        } else if value.ends_with("\n\n") || value == "\n" {
            out.push('+')?;
        }
        out.push('\n')?;
        for line in value.split_inclusive('\n') {
            if line != "\n" {
                out.push_repeat(' ', indent)?;
            }
            out.push_str(line)?;
        }
        if value.ends_with('\n') {
            out.value.pop();
        }
        return Ok(out.into_string());
    }
    let first = value.chars().next();
    let mut plain =
        first.is_some_and(|c| !c.is_ascii_whitespace() && !",[]{}#&*!|=>'\"%@`".contains(c));
    if value.starts_with(['-', '?', ':']) {
        plain &= value.chars().nth(1).is_some_and(|c| c != ' ' && c != '\t');
    }
    plain &= !value.ends_with([' ', '\t', ':']);
    plain &= dohc_engine_domain::collections::plain_yaml_scalar_is_string(value);
    for marker in ["---", "..."] {
        if let Some(rest) = value.strip_prefix(marker) {
            plain &= !rest.is_empty() && !rest.starts_with([' ', '\t', '\r', '\n']);
        }
    }
    let mut previous = None;
    for c in value.chars() {
        if (c == '#' && previous.is_none_or(|p| p == ' ' || p == '\t'))
            || (previous == Some(':') && (c == ' ' || c == '\t'))
        {
            plain = false;
        }
        previous = Some(c);
    }
    if plain {
        let source = format!("---\nvalue: {value}\n---\n");
        plain = matches!(dohc_engine_domain::collections::markdown_frontmatter_json(&source),Some(Value::Object(map)) if map.get("value").and_then(Value::as_str)==Some(value));
    }
    if plain {
        ensure_projection_string(value.to_owned())
    } else {
        let apostrophes = value.bytes().filter(|byte| *byte == b'\'').count();
        let escaped_len = checked_projection_len(value.len(), apostrophes)?;
        let mut out = ProjectionBuffer::with_capacity(checked_projection_len(escaped_len, 2)?)?;
        out.push('\'')?;
        for (index, part) in value.split('\'').enumerate() {
            if index > 0 {
                out.push_str("''")?;
            }
            out.push_str(part)?;
        }
        out.push('\'')?;
        Ok(out.into_string())
    }
}

fn double(value: &str) -> ProjectionResult<String> {
    let mut out = ProjectionBuffer::new();
    out.push('"')?;
    for c in value.chars() {
        let escape = match c {
            '\0' => Some("\\0"),
            '\u{7}' => Some("\\a"),
            '\u{8}' => Some("\\b"),
            '\t' => Some("\\t"),
            '\n' => Some("\\n"),
            '\u{b}' => Some("\\v"),
            '\u{c}' => Some("\\f"),
            '\r' => Some("\\r"),
            '\u{1b}' => Some("\\e"),
            '"' => Some("\\\""),
            '\\' => Some("\\\\"),
            '\u{85}' => Some("\\N"),
            '\u{a0}' => Some("\\_"),
            '\u{2028}' => Some("\\L"),
            '\u{2029}' => Some("\\P"),
            _ => None,
        };
        if let Some(escape) = escape {
            out.push_str(escape)?;
        } else if printable(c) {
            out.push(c)?;
        } else {
            out.push_str(&if (c as u32) <= 255 {
                format!("\\x{:02X}", c as u32)
            } else {
                format!("\\u{:04X}", c as u32)
            })?;
        }
    }
    out.push('"')?;
    Ok(out.into_string())
}

/// The frontmatter block and blank lines a document starts with, when the
/// projection would write them differently. Import keeps them as the
/// document's frontmatter source.
pub(super) fn source(
    prefix: &str,
    frontmatter: &serde_json::Map<String, Value>,
    uses_crlf: bool,
) -> ProjectionResult<Option<String>> {
    let mut canonical = String::new();
    if !frontmatter.is_empty() {
        let mut ordered: Vec<_> = frontmatter.iter().collect();
        ordered.sort_by(|(left, _), (right, _)| compare_keys(left, right, true));
        canonical.push_str("---\n");
        for (key, value) in ordered {
            canonical.push_str(&project_frontmatter(key, value)?);
        }
        canonical.push_str("---\n\n");
    }
    if uses_crlf {
        canonical = canonical.replace('\n', "\r\n");
    }
    Ok((prefix != canonical).then(|| prefix.to_owned()))
}

/// The frontmatter a person wrote, kept through a settle. While it still
/// reads as `current`, the text comes back unchanged. Otherwise a key whose
/// value did not change keeps its lines and the comments above them, a
/// changed key gets its canonical entry in place, a removed key loses its
/// lines, and a new key is added after the others. When one key is removed
/// and one added, the new key takes the removed key's place. `None` when the source is
/// too large or unreadable, when no key or comment is left, or when the
/// result would not read back as `current`; the caller then writes canonical
/// frontmatter. The desktop keeps frontmatter the same way (`keptFrontmatter`
/// in packages/ydoc-projection/src/frontmatter.ts).
pub(super) fn kept(source: &str, current: &BTreeMap<String, Value>) -> Option<String> {
    if source.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES {
        return None;
    }
    let same = |key: &str, left: &Value, right: &Value| {
        matches!(
            (project_frontmatter(key, left), project_frontmatter(key, right)),
            (Ok(left), Ok(right)) if left == right
        )
    };
    let reads_as_current = |value: &serde_json::Map<String, Value>| {
        value.len() == current.len()
            && current
                .iter()
                .all(|(key, right)| value.get(key).is_some_and(|left| same(key, left, right)))
    };
    let block = markdown_frontmatter_block(source).filter(|block| only_line_breaks(block.body))?;
    if reads_as_current(&block.value) {
        return Some(source.to_owned());
    }
    let entries = block.entries.as_ref()?;
    let yaml = block.yaml;
    let canonical = |key: &str, value: &Value| {
        let entry = project_frontmatter(key, value).ok()?;
        Some(if block.open.ends_with("\r\n") {
            entry.replace('\n', "\r\n")
        } else {
            entry
        })
    };
    let mut added: Vec<_> = current
        .iter()
        .filter(|(key, _)| !block.value.contains_key(*key))
        .collect();
    added.sort_by(|(left, _), (right, _)| compare_keys(left, right, true));
    let mut removed = entries.iter().filter(|(key, _)| !current.contains_key(key));
    // One key removed and one added is a rename: the new key keeps the place.
    let renamed = match (removed.next(), removed.next(), added.as_slice()) {
        (Some((from, _)), None, [(to, value)]) => Some((from, canonical(to, value)?)),
        _ => None,
    };
    let mut kept = String::from(&yaml[..entries.first().map_or(yaml.len(), |(_, start)| *start)]);
    let mut lead = "";
    for (index, (key, start)) in entries.iter().enumerate() {
        let end = entries.get(index + 1).map_or(yaml.len(), |(_, next)| *next);
        // Blank lines and column-0 comments at the end of an entry belong to
        // the entry below it.
        let region = &yaml[*start..end];
        let (text, trivia) = region.split_at(trailing_trivia_start(region));
        if let Some((_, entry)) = renamed.as_ref().filter(|(from, _)| *from == key) {
            kept.push_str(lead);
            kept.push_str(entry);
        } else if let Some(value) = current.get(key) {
            kept.push_str(lead);
            if block
                .value
                .get(key)
                .is_some_and(|left| same(key, left, value))
            {
                kept.push_str(text);
            } else {
                kept.push_str(&canonical(key, value)?);
            }
        }
        lead = trivia;
    }
    if renamed.is_none() {
        for (key, value) in added {
            kept.push_str(&canonical(key, value)?);
        }
    }
    kept.push_str(lead);
    if kept.is_empty() {
        return None;
    }
    let candidate = format!("{}{kept}{}", block.open, block.closing);
    if candidate.len() > MAX_PROJECTION_BYTES {
        return None;
    }
    let reread = markdown_frontmatter_block(&candidate)?;
    (only_line_breaks(reread.body) && reads_as_current(&reread.value)).then_some(candidate)
}

/// Where the trailing blank lines and column-0 comments of an entry start.
fn trailing_trivia_start(region: &str) -> usize {
    let mut start = region.len();
    while start > 0 {
        let line_start = region[..start - 1].rfind('\n').map_or(0, |index| index + 1);
        let line = region[line_start..start].trim_end_matches(['\r', '\n']);
        if line_start == 0 || !(line.trim().is_empty() || line.starts_with('#')) {
            break;
        }
        start = line_start;
    }
    start
}

fn only_line_breaks(mut text: &str) -> bool {
    while let Some(rest) = text
        .strip_prefix("\r\n")
        .or_else(|| text.strip_prefix('\n'))
    {
        text = rest;
    }
    text.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_quoted_scalar_preserves_escaping_and_exact_byte_limit() {
        assert_eq!(scalar("'a💡'", 0, true).unwrap(), "'''a💡'''");
        let value = "'".repeat((MAX_PROJECTION_BYTES - 2) / 2);
        let rendered = scalar(&value, 0, false).unwrap();
        assert_eq!(rendered.len(), MAX_PROJECTION_BYTES);
        assert!(rendered.bytes().all(|byte| byte == b'\''));
        let overflow = format!("{value}x");
        assert!(matches!(
            scalar(&overflow, 0, false),
            Err(CollabError::ProjectionTooLarge { actual, max })
                if actual == MAX_PROJECTION_BYTES + 1 && max == MAX_PROJECTION_BYTES
        ));
    }
}
