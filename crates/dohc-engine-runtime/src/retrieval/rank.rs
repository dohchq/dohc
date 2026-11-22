use super::text::{ParsedQuery, QueryTerm, tokenize_words};
use std::collections::{HashMap, HashSet};

pub const RRF_K: f64 = 60.0;

#[derive(Debug, Clone, Default)]
pub struct ScoreDocument {
    pub title: String,
    pub path: String,
    pub fields_text: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct LexicalScore {
    pub score: f64,
    pub matched_terms: Vec<String>,
    pub has_strong_match: bool,
}

#[derive(Debug, Clone, Copy)]
struct FieldSpec<'a> {
    text: &'a str,
    weight: f64,
    avg_len: f64,
    b: f64,
}

pub fn score_document_bm25f(doc: &ScoreDocument, query: &ParsedQuery) -> LexicalScore {
    if query.terms.is_empty() {
        return LexicalScore {
            score: 0.0,
            matched_terms: Vec::new(),
            has_strong_match: false,
        };
    }

    let fields = [
        FieldSpec {
            text: &doc.title,
            weight: 4.0,
            avg_len: 8.0,
            b: 0.5,
        },
        FieldSpec {
            text: &doc.path,
            weight: 3.0,
            avg_len: 8.0,
            b: 0.4,
        },
        FieldSpec {
            text: &doc.fields_text,
            weight: 2.8,
            avg_len: 24.0,
            b: 0.5,
        },
        FieldSpec {
            text: &doc.body,
            weight: 1.2,
            avg_len: 180.0,
            b: 0.75,
        },
    ];

    let tokenized: Vec<(Vec<String>, String, FieldSpec<'_>)> = fields
        .iter()
        .map(|spec| {
            let lowered = spec.text.to_lowercase();
            let tokens = tokenize_words(spec.text);
            (tokens, lowered, *spec)
        })
        .collect();

    let mut total_bm25 = 0.0f64;
    let mut matched_terms = Vec::new();
    let mut strong_terms = 0usize;
    let mut title_or_path_terms = 0usize;

    for term in &query.terms {
        let mut pseudo_tf = 0.0f64;
        let mut term_strong = false;
        let mut in_title_or_path = false;

        for (idx, (tokens, lowered, spec)) in tokenized.iter().enumerate() {
            if lowered.is_empty() {
                continue;
            }
            let (raw_tf, strong) = field_term_tf(tokens, lowered, term);
            if raw_tf <= 0.0 {
                continue;
            }
            if strong {
                term_strong = true;
                if idx <= 1 {
                    in_title_or_path = true;
                }
            }
            let len = tokens.len().max(1) as f64;
            let norm = (1.0 - spec.b) + spec.b * (len / spec.avg_len);
            pseudo_tf += (spec.weight * raw_tf) / norm.max(0.25);
        }

        if pseudo_tf > 0.0 {
            let k1 = 1.2;
            let idf = term_length_idf(term);
            let term_score = idf * ((pseudo_tf * (k1 + 1.0)) / (pseudo_tf + k1));
            total_bm25 += term_score;
            if term_strong {
                strong_terms += 1;
                matched_terms.push(term.raw.clone());
                if in_title_or_path {
                    title_or_path_terms += 1;
                }
            }
        }
    }

    if strong_terms == 0 {
        return LexicalScore {
            score: 0.0,
            matched_terms: Vec::new(),
            has_strong_match: false,
        };
    }

    let coverage = (strong_terms as f64) / (query.terms.len() as f64);
    let mut score = total_bm25 * (0.35 + 0.65 * coverage.powf(1.5));

    if title_or_path_terms == query.terms.len() {
        score += 1.25;
    }

    for phrase in &query.phrases {
        if tokenized[0].1.contains(phrase) || tokenized[1].1.contains(phrase) {
            score += 2.5;
        } else if tokenized[2].1.contains(phrase) {
            score += 2.0;
        } else if tokenized[3].1.contains(phrase) {
            score += 1.4;
        }
    }

    LexicalScore {
        score,
        matched_terms,
        has_strong_match: true,
    }
}

fn term_length_idf(term: &QueryTerm) -> f64 {
    let chars = term.raw.chars().count();
    if term.is_cjk {
        1.5 + (chars.min(6) as f64) * 0.25
    } else {
        1.0 + ((chars.min(12) as f64) / 8.0)
    }
}

fn field_term_tf(tokens: &[String], lowered: &str, term: &QueryTerm) -> (f64, bool) {
    if term.is_cjk {
        let count = lowered.matches(&term.raw).count().min(12);
        return (count as f64 * 0.95, count > 0);
    }

    let mut exact = 0usize;
    let mut prefix = 0usize;
    let allow_prefix = term.stem.chars().count() >= 3;
    for token in tokens {
        if token == &term.raw {
            exact += 1;
        } else if allow_prefix
            && (token.starts_with(&term.stem)
                || crate::retrieval::text::stem_term(token) == term.stem)
        {
            prefix += 1;
        }
        if exact + prefix >= 16 {
            break;
        }
    }

    if exact > 0 || prefix > 0 {
        let tf = (exact as f64) + (prefix as f64) * 0.78;
        return (tf, true);
    }

    if term.raw.chars().count() >= 4 && lowered.contains(&term.raw) {
        return (0.05, false);
    }

    (0.0, false)
}

/// Pure reciprocal rank fusion combiner. Any additional retrieval signal (such
/// as a future opt-in vector/semantic candidate list) plugs in as another
/// weighted ranked list here.
pub fn rrf_fuse(lists: &[(&[String], f64)], k: f64) -> HashMap<String, f64> {
    let mut scores: HashMap<String, f64> = HashMap::new();
    for (ranked, weight) in lists {
        if *weight <= 0.0 {
            continue;
        }
        let mut seen = HashSet::with_capacity(ranked.len());
        for (rank, id) in ranked.iter().enumerate() {
            if !seen.insert(id.as_str()) {
                continue;
            }
            let contribution = *weight / (k + (rank as f64) + 1.0);
            *scores.entry(id.clone()).or_insert(0.0) += contribution;
        }
    }
    scores
}
