use dohc_engine_domain::is_js_trim_ws;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const MAX_RETRIEVAL_QUERY_CHARS: usize = 512;
pub const MAX_QUERY_TERMS: usize = 16;
pub const MAX_FTS_TERMS: usize = 8;
pub const MAX_TITLE_CHARS: usize = 160;
pub const MAX_SNIPPET_CHARS: usize = 260;
pub const MAX_NEIGHBOR_SNIPPET_CHARS: usize = 160;
pub const MAX_FIELD_VALUE_CHARS: usize = 120;
const MAX_JSON_VALUE_BYTES: usize = 16 * 1024;
const MAX_JSON_DEPTH: usize = 8;

const STOPWORDS: &[&str] = &[
    "a", "about", "an", "and", "are", "as", "at", "be", "been", "by", "did", "do", "does", "for",
    "from", "had", "has", "have", "how", "in", "into", "is", "it", "its", "my", "of", "on", "or",
    "our", "that", "the", "their", "this", "to", "was", "we", "were", "what", "when", "where",
    "which", "who", "with", "your",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryTerm {
    pub raw: String,
    pub stem: String,
    pub is_cjk: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedQuery {
    pub normalized: String,
    pub phrases: Vec<String>,
    pub terms: Vec<QueryTerm>,
    pub fts_terms: Vec<String>,
}

pub fn is_cjk_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3040..=0x309F
            | 0x30A0..=0x30FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xAC00..=0xD7AF
            | 0xF900..=0xFAFF
    )
}

fn is_stopword(term: &str) -> bool {
    STOPWORDS.binary_search(&term).is_ok()
}

pub fn stem_term(raw: &str) -> String {
    if !raw.is_ascii() || !raw.bytes().all(|b| b.is_ascii_alphabetic()) {
        return raw.to_owned();
    }
    if raw.len() >= 5
        && let Some(root) = raw.strip_suffix("ies")
        && root.len() >= 3
    {
        return root.to_owned();
    }
    if raw.len() >= 4
        && let Some(root) = raw.strip_suffix('y')
        && root.len() >= 3
        && !matches!(
            root.as_bytes().last(),
            Some(b'a' | b'e' | b'i' | b'o' | b'u')
        )
    {
        return root.to_owned();
    }
    if raw.len() >= 6
        && let Some(root) = raw.strip_suffix("ing")
        && root.len() >= 3
    {
        return collapse_double_consonant(root);
    }
    if raw.len() >= 5
        && let Some(root) = raw.strip_suffix("ed")
        && root.len() >= 3
    {
        return collapse_double_consonant(root);
    }
    if raw.len() >= 5
        && let Some(root) = raw.strip_suffix("es")
        && root.len() >= 3
        && (root.ends_with("ch")
            || root.ends_with("sh")
            || root.ends_with('x')
            || root.ends_with('z')
            || root.ends_with("ss"))
    {
        return root.to_owned();
    }
    if raw.len() >= 4
        && let Some(root) = raw.strip_suffix('s')
        && root.len() >= 3
        && !raw.ends_with("ss")
        && !raw.ends_with("us")
        && !raw.ends_with("is")
    {
        return root.to_owned();
    }
    raw.to_owned()
}

fn collapse_double_consonant(root: &str) -> String {
    let bytes = root.as_bytes();
    if bytes.len() >= 4 {
        let last = bytes[bytes.len() - 1];
        let prev = bytes[bytes.len() - 2];
        if last == prev && !matches!(last, b'l' | b's' | b'z' | b'a' | b'e' | b'i' | b'o' | b'u') {
            return root[..root.len() - 1].to_owned();
        }
    }
    root.to_owned()
}

pub fn tokenize_words(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut compound = String::new();
    let mut split_count = 0usize;
    let mut prev_lower = false;

    let flush_run = |current: &mut String,
                     compound: &mut String,
                     split_count: &mut usize,
                     tokens: &mut Vec<String>| {
        if !current.is_empty() {
            tokens.push(current.to_lowercase());
            current.clear();
        }
        if *split_count > 0 && !compound.is_empty() {
            tokens.push(compound.to_lowercase());
        }
        compound.clear();
        *split_count = 0;
    };

    for ch in text.chars() {
        if is_cjk_char(ch) {
            flush_run(&mut current, &mut compound, &mut split_count, &mut tokens);
            tokens.push(ch.to_string());
            prev_lower = false;
            continue;
        }
        if ch.is_alphanumeric() {
            if ch.is_uppercase() && prev_lower && !current.is_empty() {
                tokens.push(current.to_lowercase());
                current.clear();
                split_count += 1;
            }
            current.push(ch);
            compound.push(ch);
            prev_lower = ch.is_lowercase();
        } else {
            flush_run(&mut current, &mut compound, &mut split_count, &mut tokens);
            prev_lower = false;
        }
    }
    flush_run(&mut current, &mut compound, &mut split_count, &mut tokens);
    tokens
}

pub fn parse_query(raw: &str) -> Option<ParsedQuery> {
    let trimmed = raw.trim_matches(is_js_trim_ws);
    if trimmed.is_empty() || trimmed.chars().count() > MAX_RETRIEVAL_QUERY_CHARS {
        return None;
    }

    let mut phrases = Vec::new();
    let mut in_quote = false;
    let mut current_phrase = String::new();
    for ch in trimmed.chars() {
        if ch == '"' {
            if in_quote {
                let p = current_phrase.trim_matches(is_js_trim_ws).to_lowercase();
                if !p.is_empty() && !phrases.contains(&p) {
                    phrases.push(p);
                }
                current_phrase.clear();
            }
            in_quote = !in_quote;
        } else if in_quote {
            current_phrase.push(ch);
        }
    }

    let mut raw_tokens: Vec<(String, bool)> = Vec::new();
    let mut buf = String::new();
    let mut cjk_buf = String::new();
    let flush_alpha = |buf: &mut String, out: &mut Vec<(String, bool)>| {
        if !buf.is_empty() {
            let lowered = buf.to_lowercase();
            out.push((lowered, false));
            buf.clear();
        }
    };
    let flush_cjk = |buf: &mut String, out: &mut Vec<(String, bool)>| {
        if !buf.is_empty() {
            out.push((buf.clone(), true));
            buf.clear();
        }
    };

    for ch in trimmed.chars() {
        if is_cjk_char(ch) {
            flush_alpha(&mut buf, &mut raw_tokens);
            cjk_buf.push(ch);
        } else if ch.is_alphanumeric() {
            flush_cjk(&mut cjk_buf, &mut raw_tokens);
            buf.push(ch);
        } else {
            flush_alpha(&mut buf, &mut raw_tokens);
            flush_cjk(&mut cjk_buf, &mut raw_tokens);
        }
    }
    flush_alpha(&mut buf, &mut raw_tokens);
    flush_cjk(&mut cjk_buf, &mut raw_tokens);

    if raw_tokens.is_empty() {
        return None;
    }

    let has_non_stopword = raw_tokens
        .iter()
        .any(|(tok, is_cjk)| *is_cjk || !is_stopword(tok));

    let mut seen = HashSet::new();
    let mut terms = Vec::new();
    for (tok, is_cjk) in raw_tokens {
        if has_non_stopword && !is_cjk && is_stopword(&tok) {
            continue;
        }
        if !seen.insert(tok.clone()) {
            continue;
        }
        let stem = if is_cjk { tok.clone() } else { stem_term(&tok) };
        terms.push(QueryTerm {
            raw: tok,
            stem,
            is_cjk,
        });
        if terms.len() >= MAX_QUERY_TERMS {
            break;
        }
    }

    if terms.is_empty() {
        return None;
    }

    let mut fts_candidates: Vec<String> = Vec::new();
    let mut seen_fts = HashSet::new();
    for term in &terms {
        let probe = if term.stem.chars().count() >= 3 {
            term.stem.clone()
        } else if term.raw.chars().count() >= 3 {
            term.raw.clone()
        } else {
            continue;
        };
        if seen_fts.insert(probe.clone()) {
            fts_candidates.push(probe);
        }
    }
    fts_candidates.sort_by(|a, b| {
        b.chars()
            .count()
            .cmp(&a.chars().count())
            .then_with(|| a.cmp(b))
    });
    fts_candidates.truncate(MAX_FTS_TERMS);

    let normalized = trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if terms.len() >= 2 && phrases.is_empty() {
        let joined = terms
            .iter()
            .map(|t| t.raw.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if joined.chars().count() >= 4 {
            phrases.push(joined);
        }
    }

    Some(ParsedQuery {
        normalized,
        phrases,
        terms,
        fts_terms: fts_candidates,
    })
}

pub fn fts_quote(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

pub fn fts_match_and(terms: &[String]) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    Some(
        terms
            .iter()
            .map(|term| fts_quote(term))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

pub fn fts_match_or(terms: &[String]) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    Some(
        terms
            .iter()
            .map(|term| fts_quote(term))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

pub fn escape_like_pattern(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 2);
    out.push('%');
    for ch in term.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            other => out.push(other),
        }
    }
    out.push('%');
    out
}

pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let taken: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() && max_chars > 1 {
        let mut clipped: String = taken.chars().take(max_chars - 1).collect();
        clipped.push('…');
        clipped
    } else {
        taken
    }
}

pub fn strip_markdown_frontmatter(text: &str) -> &str {
    let rest = if let Some(after) = text.strip_prefix("---\r\n") {
        after
    } else if let Some(after) = text.strip_prefix("---\n") {
        after
    } else {
        return text;
    };

    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" || trimmed == "..." {
            return &rest[offset + line.len()..];
        }
        offset += line.len();
    }
    text
}

pub fn extract_markdown_heading(text: &str) -> Option<String> {
    let body = strip_markdown_frontmatter(text);
    for line in body.lines().take(24) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let cleaned = heading.trim().trim_end_matches('#').trim();
            if !cleaned.is_empty() {
                return Some(truncate_chars(cleaned, MAX_REF_SCAN_BYTES));
            }
        }
        break;
    }
    None
}

pub fn fallback_title_from_path(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = match name.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty()
                && matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "md" | "markdown" | "mdx" | "txt" | "excalidraw"
                ) =>
        {
            stem
        }
        _ => name,
    };
    truncate_chars(stem, MAX_TITLE_CHARS)
}

pub fn render_field_value_json(
    value_json: &str,
    record_titles: &HashMap<String, String>,
) -> Option<String> {
    if value_json.len() > MAX_JSON_VALUE_BYTES {
        return None;
    }
    let parsed: Value = serde_json::from_str(value_json).ok()?;
    let mut parts = Vec::new();
    collect_json_scalars(&parsed, record_titles, 0, &mut parts);
    if parts.is_empty() {
        return None;
    }
    let joined = parts.join(", ");
    let collapsed = collapse_whitespace(&joined);
    if collapsed.is_empty() {
        return None;
    }
    Some(truncate_chars(&collapsed, MAX_FIELD_VALUE_CHARS))
}

fn collect_json_scalars(
    value: &Value,
    record_titles: &HashMap<String, String>,
    depth: usize,
    out: &mut Vec<String>,
) {
    if depth > MAX_JSON_DEPTH || out.len() >= 12 {
        return;
    }
    match value {
        Value::Null => {}
        Value::Bool(flag) => out.push(flag.to_string()),
        Value::Number(num) => out.push(num.to_string()),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return;
            }
            if let Some(title) = record_titles.get(trimmed) {
                out.push(title.clone());
            } else if !is_opaque_record_id(trimmed) {
                out.push(truncate_chars(trimmed, MAX_FIELD_VALUE_CHARS));
            }
        }
        Value::Array(items) => {
            for item in items.iter().take(8) {
                collect_json_scalars(item, record_titles, depth + 1, out);
            }
        }
        Value::Object(map) => {
            if map.len() == 1 {
                if let Some(Value::String(decimal)) = map.get("$dohcInt64") {
                    out.push(decimal.clone());
                    return;
                }
                if let Some(float_val) = map.get("$dohcFloat64") {
                    if let Some(s) = float_val.as_str() {
                        out.push(s.to_owned());
                    } else if let Some(n) = float_val.as_f64() {
                        out.push(n.to_string());
                    }
                    return;
                }
            }
            for (k, v) in map.iter().take(6) {
                if k.starts_with("$dohc") {
                    continue;
                }
                let mut nested = Vec::new();
                collect_json_scalars(v, record_titles, depth + 1, &mut nested);
                if !nested.is_empty() {
                    out.push(format!("{k}: {}", nested.join(", ")));
                }
            }
        }
    }
}

fn is_opaque_record_id(value: &str) -> bool {
    value.len() == 30
        && value.starts_with("rec_")
        && value[4..]
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'2'..=b'7'))
}

pub fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn extract_best_snippet(text: &str, query: &ParsedQuery, max_chars: usize) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    let mut best_line: Option<(usize, &str)> = None;
    let mut first_non_empty: Option<&str> = None;

    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if first_non_empty.is_none() {
            first_non_empty = Some(trimmed);
        }
        let lowered = trimmed.to_lowercase();
        let mut score = 0usize;
        for phrase in &query.phrases {
            if lowered.contains(phrase) {
                score += 6;
            }
        }
        for term in &query.terms {
            if lowered.contains(&term.raw) {
                score += 3;
            } else if term.stem != term.raw && lowered.contains(&term.stem) {
                score += 2;
            }
        }
        if score > 0 {
            match best_line {
                None => best_line = Some((score, trimmed)),
                Some((best_score, _)) if score > best_score => best_line = Some((score, trimmed)),
                _ => {}
            }
        }
    }

    let chosen = best_line
        .map(|(_, line)| line)
        .or(first_non_empty)
        .unwrap_or("");
    let cleaned = collapse_whitespace(chosen);
    if cleaned.chars().count() <= max_chars {
        return cleaned;
    }

    let lowered = cleaned.to_lowercase();
    let match_byte = query
        .phrases
        .iter()
        .find_map(|p| lowered.find(p))
        .or_else(|| {
            query
                .terms
                .iter()
                .find_map(|t| lowered.find(&t.raw).or_else(|| lowered.find(&t.stem)))
        })
        .unwrap_or(0);

    let chars: Vec<char> = cleaned.chars().collect();
    let match_char = lowered[..match_byte.min(lowered.len())].chars().count();
    let start = match_char.saturating_sub(max_chars / 3).min(chars.len());
    let end = (start + max_chars).min(chars.len());
    let mut window: String = chars[start..end].iter().collect();
    if start > 0 {
        window = format!("…{}", window.trim_start());
    }
    if end < chars.len() {
        window = format!("{}…", window.trim_end());
    }
    truncate_chars(&window, max_chars)
}

pub fn normalize_filter_prefix(raw: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim_matches(is_js_trim_ws).trim_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 1024 || trimmed.contains(['\\', '\0']) {
        return Err("invalid path filter");
    }
    for (idx, segment) in trimmed.split('/').enumerate() {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err("invalid path filter");
        }
        if idx == 0
            && segment
                .trim_end_matches(['.', ' '])
                .eq_ignore_ascii_case("shared-with-me")
        {
            return Err("mounted shared folders under shared-with-me/ are not searched");
        }
    }
    Ok(Some(trimmed.to_owned()))
}

pub fn path_matches_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

const MAX_REF_SCAN_BYTES: usize = 2048;
const MAX_MD_LABEL_BYTES: usize = MAX_REF_SCAN_BYTES * 2;

fn extract_markdown_link_dest(raw: &str) -> String {
    let trimmed = raw.trim();
    let href = if let Some(inside) = trimmed.strip_prefix('<') {
        inside.split('>').next().unwrap_or("")
    } else {
        let mut end = trimmed.len();
        let mut escaped = false;
        for (k, ch) in trimmed.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch.is_whitespace() {
                end = k;
                break;
            }
        }
        &trimmed[..end]
    };
    let mut dest = String::with_capacity(href.len());
    let mut chars = href.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                dest.push(next);
            }
        } else {
            dest.push(ch);
        }
    }
    dest
}

fn scan_markdown_target_end(bytes: &[u8], url_start: usize, line_end: usize) -> Option<usize> {
    let mut j = url_start;
    let mut depth = 0usize;
    let mut angle = false;
    let mut escaped = false;
    while j < line_end && j - url_start <= MAX_REF_SCAN_BYTES {
        if escaped {
            escaped = false;
            j += 1;
            continue;
        }
        match bytes[j] {
            b'\\' => escaped = true,
            b'<' if depth == 0 => angle = true,
            b'>' if angle => angle = false,
            b'(' if !angle => depth += 1,
            b')' if !angle && depth == 0 => return Some(j),
            b')' if !angle => depth -= 1,
            _ => {}
        }
        j += 1;
    }
    None
}

fn is_external_markdown_dest(dest: &str) -> bool {
    dest.starts_with("http://")
        || dest.starts_with("https://")
        || dest.starts_with("mailto:")
        || dest.starts_with('#')
}

pub fn redact_file_references(
    input: &str,
    mut allow_wikilink: impl FnMut(&str) -> bool,
    mut allow_markdown_link: impl FnMut(&str) -> bool,
    mut allow_chat_mention: impl FnMut(&str) -> bool,
) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let mut line_end = 0usize;
    let mut next_chat_close: Option<usize> = None;
    let mut chat_scanned_to = 0usize;
    let mut next_wiki_close: Option<usize> = None;
    let mut wiki_scanned_to = 0usize;
    let mut next_md_sep: Option<usize> = None;
    let mut md_scanned_to = 0usize;

    while i < bytes.len() {
        if i >= line_end {
            line_end = input[i..]
                .find(['\n', '\r'])
                .map_or(bytes.len(), |rel| i + rel);
            next_chat_close = None;
            chat_scanned_to = i;
            next_wiki_close = None;
            wiki_scanned_to = i;
            next_md_sep = None;
            md_scanned_to = i;
        }

        if i + 2 <= line_end && &bytes[i..i + 2] == b"@[" {
            let search_from = i + 2;
            if next_chat_close.is_none_or(|pos| pos < search_from) && chat_scanned_to < line_end {
                let start = search_from.max(chat_scanned_to);
                next_chat_close = input[start..line_end].find(']').map(|rel| start + rel);
                chat_scanned_to = next_chat_close.unwrap_or(line_end);
            }
            if let Some(close) = next_chat_close
                && close >= search_from
                && close - search_from <= MAX_REF_SCAN_BYTES
            {
                let target = &input[search_from..close];
                if !target.contains('[') && !target.trim().is_empty() {
                    if allow_chat_mention(target.trim()) {
                        out.push_str(&input[i..close + 1]);
                    }
                    i = close + 1;
                    continue;
                }
            }
        }

        if i + 2 <= line_end && &bytes[i..i + 2] == b"[[" {
            let search_from = i + 2;
            if next_wiki_close.is_none_or(|pos| pos < search_from) && wiki_scanned_to < line_end {
                let start = search_from.max(wiki_scanned_to);
                next_wiki_close = input[start..line_end].find("]]").map(|rel| start + rel);
                wiki_scanned_to = next_wiki_close.unwrap_or(line_end);
            }
            if let Some(close) = next_wiki_close
                && close >= search_from
                && close - search_from <= MAX_REF_SCAN_BYTES
            {
                let inner = &input[search_from..close];
                if !inner.contains('[') && !inner.contains(']') && !inner.trim().is_empty() {
                    let target = inner.split('|').next().unwrap_or(inner).trim();
                    if allow_wikilink(target) {
                        out.push_str(&input[i..close + 2]);
                    }
                    i = close + 2;
                    continue;
                }
            }
        }

        if bytes[i] == b'[' && i + 1 < line_end {
            let search_from = i + 1;
            if next_md_sep.is_none_or(|pos| pos < search_from) && md_scanned_to < line_end {
                let start = search_from.max(md_scanned_to);
                next_md_sep = input[start..line_end].find("](").map(|rel| start + rel);
                md_scanned_to = next_md_sep.unwrap_or(line_end);
            }
            if let Some(sep) = next_md_sep
                && sep >= search_from
                && sep - search_from <= MAX_MD_LABEL_BYTES
            {
                let label = &input[search_from..sep];
                if !label.contains('[')
                    && let Some(j) = scan_markdown_target_end(bytes, sep + 2, line_end)
                    && input.is_char_boundary(j)
                {
                    let dest = extract_markdown_link_dest(&input[sep + 2..j]);
                    if is_external_markdown_dest(&dest) || allow_markdown_link(&dest) {
                        out.push_str(&input[i..j + 1]);
                    }
                    i = j + 1;
                    continue;
                }
            }
        }

        if i + 2 <= line_end
            && &bytes[i..i + 2] == b"]("
            && let Some(j) = scan_markdown_target_end(bytes, i + 2, line_end)
            && input.is_char_boundary(j)
        {
            let dest = extract_markdown_link_dest(&input[i + 2..j]);
            if is_external_markdown_dest(&dest) || allow_markdown_link(&dest) {
                out.push_str(&input[i..j + 1]);
            }
            i = j + 1;
            continue;
        }

        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}
