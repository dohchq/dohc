use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub(crate) fn is_name_letter_or_number(ch: char) -> bool {
    // Alphabetic also includes marks and enclosed letter symbols (category So).
    // The slug keeps marks only after a letter or number and drops symbols.
    ch.is_alphanumeric()
        && !is_combining_mark(ch)
        && !matches!(ch, '\u{24B6}'..='\u{24E9}' | '\u{1F130}'..='\u{1F149}'
            | '\u{1F150}'..='\u{1F169}' | '\u{1F170}'..='\u{1F189}')
}

pub(crate) fn is_name_mark(ch: char) -> bool {
    is_combining_mark(ch)
}

pub(crate) fn is_reserved_windows_name(value: &str) -> bool {
    let stem = value.split('.').next().unwrap_or_default().to_lowercase();
    matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul" | "clock$" | "conin$" | "conout$"
    ) || ["com", "lpt"].iter().any(|prefix| {
        stem.strip_prefix(prefix)
            .is_some_and(|rest| rest.chars().count() == 1 && "123456789¹²³".contains(rest))
    })
}

pub fn name_slug(value: &str, max_bytes: usize) -> String {
    let lowered: String = value
        .nfc()
        .collect::<String>()
        .to_lowercase()
        .nfc()
        .collect();
    let mut slug = String::new();
    for ch in lowered.chars() {
        if ch.is_whitespace() || matches!(ch, '_' | '-') {
            if !slug.is_empty() && !slug.ends_with('-') {
                slug.push('-');
            }
        } else if is_name_letter_or_number(ch)
            || (is_name_mark(ch) && !slug.is_empty() && !slug.ends_with('-'))
        {
            slug.push(ch);
        }
    }
    let mut slug: String = slug.nfc().collect();
    let mut end = max_bytes.min(slug.len());
    while !slug.is_char_boundary(end) {
        end -= 1;
    }
    slug.truncate(end);
    let mut slug = slug.trim_end_matches('-').to_owned();
    if is_reserved_windows_name(&slug) {
        slug = format!("name-{slug}");
        let mut end = max_bytes.min(slug.len());
        while !slug.is_char_boundary(end) {
            end -= 1;
        }
        slug.truncate(end);
    }
    slug
}
