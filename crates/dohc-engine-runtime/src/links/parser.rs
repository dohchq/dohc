use super::{Head, Work};
use dohc_engine_storage::{StorageError, hex_sha256};

pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024;
const MAX_OCCURRENCES: usize = 4096;
const MAX_LITERAL_BYTES: usize = 2048;

#[derive(Debug, Clone)]
pub struct Occurrence {
    pub literal: String,
    pub kind: &'static str,
    pub fragment: Option<String>,
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub line: usize,
    pub snippet: String,
}
pub struct Parsed {
    pub work: Work,
    pub head: Option<Head>,
    pub title: String,
    pub reason: Option<&'static str>,
    pub occurrences: Vec<Occurrence>,
}
pub fn parse(work: Work, mut head: Option<Head>) -> Result<Parsed, StorageError> {
    let mut title = String::new();
    let mut reason = None;
    let mut occurrences = Vec::new();
    if let Some(h) = head.as_mut() {
        title = h.path.rsplit('/').next().unwrap_or(&h.path).to_owned();
        if h.unindexed_reason.is_some() {
            reason = h.unindexed_reason;
        } else if h.kind == "text" && h.byte_length > MAX_DOCUMENT_BYTES as i64 {
            reason = Some("byte-bound");
        } else if let Some(text) = h.text.take() {
            if hex_sha256(text.as_bytes()) != h.hash {
                return Err(StorageError::BlobIntegrity {
                    sha256: h.hash.clone(),
                });
            }
            let extension = h.path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if matches!(extension.as_str(), "md" | "markdown" | "mdx") {
                if let Some(t) = text.lines().find_map(|l| l.strip_prefix("# ")) {
                    title = t.chars().take(160).collect();
                }
                match extract(&text) {
                    Ok(rows) => occurrences = rows,
                    Err(()) => reason = Some("parse-refused"),
                }
            }
        }
    }
    Ok(Parsed {
        work,
        head,
        title,
        reason,
        occurrences,
    })
}
// Code masking preserves offsets into the original document.
fn code_mask(text: &str) -> Vec<bool> {
    let b = text.as_bytes();
    let mut mask = vec![false; b.len()];
    let mut fence: Option<(u8, usize)> = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let bytes = line.as_bytes();
        let indent = bytes.iter().take_while(|&&c| c == b' ').count();
        let trimmed = &bytes[indent..];
        let marker = trimmed.first().copied().unwrap_or(0);
        let count = trimmed.iter().take_while(|&&c| c == marker).count();
        if let Some((m, n)) = fence {
            mask[offset..offset + line.len()].fill(true);
            if indent <= 3
                && marker == m
                && count >= n
                && trimmed[count..].iter().all(u8::is_ascii_whitespace)
            {
                fence = None;
            }
        } else if indent >= 4 || (indent <= 3 && matches!(marker, b'`' | b'~') && count >= 3) {
            mask[offset..offset + line.len()].fill(true);
            if indent <= 3 {
                fence = Some((marker, count));
            }
        }
        offset += line.len();
    }
    let mut i = 0;
    while i < b.len() {
        if mask[i] {
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"<!--") {
            let end = text[i + 4..].find("-->").map_or(b.len(), |n| i + 4 + n + 3);
            mask[i..end].fill(true);
            i = end;
        } else if b[i] == b'`' && !escaped(b, i) {
            let n = b[i..].iter().take_while(|&&c| c == b'`').count();
            let mut j = i + n;
            let mut end = None;
            while j < b.len() {
                if b[j] == b'`' {
                    let m = b[j..].iter().take_while(|&&c| c == b'`').count();
                    if n == m {
                        end = Some(j + m);
                        break;
                    }
                    j += m;
                } else {
                    j += 1;
                }
            }
            if let Some(end) = end {
                mask[i..end].fill(true);
                i = end;
            } else {
                i += n;
            }
        } else {
            i += 1;
        }
    }
    mask
}
fn escaped(b: &[u8], i: usize) -> bool {
    b[..i].iter().rev().take_while(|&&c| c == b'\\').count() % 2 == 1
}
fn local(literal: &str) -> bool {
    let s = literal.trim();
    if s.is_empty() || s.starts_with("//") || s.contains('\0') {
        return false;
    }
    if let Some((scheme, _)) = s.split_once(':') {
        if scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            return false;
        }
    }
    true
}
pub fn extract(text: &str) -> Result<Vec<Occurrence>, ()> {
    let b = text.as_bytes();
    let mask = code_mask(text);
    let mut utf16 = vec![0; b.len() + 1];
    let mut lines = vec![1; b.len() + 1];
    let mut units = 0;
    let mut line = 1;
    for (i, c) in text.char_indices() {
        for j in i..i + c.len_utf8() {
            utf16[j] = units;
            lines[j] = line;
        }
        units += c.len_utf16();
        if c == '\n' || (c == '\r' && b.get(i + 1) != Some(&b'\n')) {
            line += 1;
        }
    }
    utf16[b.len()] = units;
    lines[b.len()] = line;
    let mut out = Vec::new();
    let mut i = 0;
    let mut wiki_close = usize::MAX;
    while i < b.len() {
        if mask[i] || b[i] != b'[' || escaped(b, i) {
            i += 1;
            continue;
        }
        let (kind, literal, end) = if b[i..].starts_with(b"[[") {
            if wiki_close == usize::MAX || wiki_close < i + 2 {
                wiki_close = text[i + 2..].find("]]").map_or(b.len(), |n| i + 2 + n);
            }
            if wiki_close == b.len() {
                i += 2;
                continue;
            }
            let end = wiki_close + 2;
            let literal = text[i + 2..end - 2]
                .split('|')
                .next()
                .unwrap_or("")
                .trim()
                .to_owned();
            ("wikilink", literal, end)
        } else {
            if i > 0 && b[i - 1] == b'!' {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            let mut depth = 1;
            while j < b.len() && depth > 0 && j - i <= MAX_LITERAL_BYTES * 2 {
                if !escaped(b, j) {
                    if b[j] == b'[' {
                        depth += 1;
                    } else if b[j] == b']' {
                        depth -= 1;
                    }
                }
                j += 1;
            }
            if j - i > MAX_LITERAL_BYTES * 2 {
                return Err(());
            }
            if depth != 0 || b.get(j) != Some(&b'(') {
                i += 1;
                continue;
            }
            let start = j + 1;
            j = start;
            let mut depth = 0;
            let mut angle = false;
            while j < b.len() && j - start <= MAX_LITERAL_BYTES && b[j] != b'\n' {
                if !escaped(b, j) {
                    match b[j] {
                        b'<' if depth == 0 => angle = true,
                        b'>' if angle => angle = false,
                        b'(' if !angle => depth += 1,
                        b')' if !angle && depth == 0 => break,
                        b')' if !angle => depth -= 1,
                        _ => {}
                    }
                }
                j += 1;
            }
            if b.get(j) != Some(&b')') || !text.is_char_boundary(j) {
                i += 1;
                continue;
            }
            let raw = text[start..j].trim();
            let href = if let Some(inside) = raw.strip_prefix('<') {
                inside.split('>').next().unwrap_or("")
            } else {
                let mut end = raw.len();
                for (k, c) in raw.char_indices() {
                    if c.is_whitespace() && !escaped(raw.as_bytes(), k) {
                        end = k;
                        break;
                    }
                }
                &raw[..end]
            };
            let mut dest = String::new();
            let mut chars = href.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    if let Some(next) = chars.next() {
                        dest.push(next);
                    }
                } else {
                    dest.push(c);
                }
            }
            ("markdown", dest, j + 1)
        };
        if end - i > MAX_LITERAL_BYTES * 2 || literal.len() > MAX_LITERAL_BYTES {
            return Err(());
        }
        if !mask[i..end].iter().any(|x| *x) && local(&literal) {
            if out.len() == MAX_OCCURRENCES {
                return Err(());
            }
            let start_line = text[..i].rfind(['\n', '\r']).map_or(0, |n| n + 1);
            let snippet: String = text[start_line..]
                .split(['\n', '\r'])
                .next()
                .unwrap_or("")
                .chars()
                .take(240)
                .collect();
            let fragment = literal.split_once('#').map(|(_, f)| f.to_owned());
            out.push(Occurrence {
                literal,
                kind,
                fragment,
                start_utf16: utf16[i],
                end_utf16: utf16[end],
                line: lines[i],
                snippet,
            });
        }
        i = end;
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_spans_code_and_local_links() {
        let text = "😀 [[folder/A#part|alias]]\r\n[go](<a b.md> \"title\")\n`[[hidden]]`\n~~~\n[[fenced]]\n~~~\n<!-- [[comment]] -->\n[web](https://x)\n[[#section]]";
        let rows = extract(text).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].start_utf16, 3);
        assert_eq!(rows[0].end_utf16, 26);
        assert_eq!(rows[0].fragment.as_deref(), Some("part"));
        assert_eq!(rows[1].literal, "a b.md");
        assert_eq!(rows[1].line, 2);
        assert_eq!(rows[2].literal, "#section");
    }
    #[test]
    fn nested_destinations_and_escaped_markup() {
        let rows = extract(r"\[[escaped]] [nested [label]](a(b).md) ![image](ignore.md)").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].literal, "a(b).md");
    }
    #[test]
    fn refuses_instead_of_certifying_a_truncated_document() {
        assert!(extract(&"[[a]] ".repeat(MAX_OCCURRENCES + 1)).is_err());
    }
}
