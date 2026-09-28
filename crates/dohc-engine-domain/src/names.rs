use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
use unicode_segmentation::UnicodeSegmentation;

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

fn is_default_ignorable(ch: char) -> bool {
    // Unicode Default_Ignorable_Code_Point, matching JavaScript's \p{DI}.
    matches!(ch,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}'..='\u{1160}'
        | '\u{17B4}'..='\u{17B5}' | '\u{180B}'..='\u{180F}'
        | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{206F}' | '\u{3164}' | '\u{FE00}'..='\u{FE0F}'
        | '\u{FEFF}' | '\u{FFA0}' | '\u{FFF0}'..='\u{FFF8}'
        | '\u{1BCA0}'..='\u{1BCA3}' | '\u{1D173}'..='\u{1D17A}'
        | '\u{E0000}'..='\u{E0FFF}')
}

pub fn truncate_name(value: &str, max_bytes: usize) -> &str {
    for (offset, grapheme) in value.grapheme_indices(true) {
        if offset + grapheme.len() > max_bytes {
            return &value[..offset];
        }
    }
    value
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
        if is_default_ignorable(ch) {
            continue;
        }
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
    let slug: String = slug.nfc().collect();
    let mut slug = truncate_name(&slug, max_bytes)
        .trim_end_matches('-')
        .to_owned();
    if is_reserved_windows_name(&slug) {
        slug = format!("name-{slug}");
        slug = truncate_name(&slug, max_bytes).to_owned();
    }
    slug
}
