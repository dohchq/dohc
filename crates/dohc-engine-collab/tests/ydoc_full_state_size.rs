//! The evidence behind [`MAX_YDOC_UPDATE_BYTES`] (#549).
//!
//! A Y.Doc base is a FULL STATE, so its size tracks the whole document rather
//! than one edit. The bound therefore has to be measured against the largest
//! document the rest of the engine accepts — `MAX_TEXT_BYTES` — instead of
//! inherited from a cap written for a single update.
//!
//! [`the_bound_covers_the_largest_document_the_engine_accepts`] is the check.
//! It measures the encoding ratio on a small corpus and projects it onto
//! `MAX_TEXT_BYTES`, because the ratio is near-constant in document size: the
//! same shape measured 1.121 at 64 KiB, 1.123 at 1 MiB, 1.127 at 4 MiB and
//! 1.129 at 10 MiB. That is what makes a fast corpus load-bearing.
//!
//! The trend is slightly upward, so a small corpus UNDERSTATES the real ratio —
//! by under 1% across two orders of magnitude. The churn-headroom assertion is
//! measured in MiB and absorbs it many times over.
//!
//! [`full_size_measurement_harness`] is the recorded evidence itself, at the
//! real `MAX_TEXT_BYTES`. It is `#[ignore]`d because it runs for minutes; it is
//! not a check, and the check above does not depend on it. Re-run it with
//! `cargo test -p dohc-engine-collab --release --test ydoc_full_state_size --
//! --ignored --nocapture` to reproduce the table in `limits.rs`.

use dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
use dohc_engine_collab::{ContentKind, Ydoc};
use dohc_engine_domain::MAX_TEXT_BYTES;

/// Deterministic 64-bit LCG, so the corpus is reproducible without a
/// dev-dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}

const WORDS: &[&str] = &[
    "workspace",
    "agent",
    "document",
    "provenance",
    "lineage",
    "review",
    "decision",
    "sync",
    "relay",
    "snapshot",
    "markdown",
    "structure",
    "inspectable",
    "durable",
    "boundary",
    "capture",
    "session",
    "artifact",
    "primitive",
    "operator",
    "measure",
    "threshold",
    "evidence",
    "content",
];

/// A block of at least `target` bytes of prose.
fn block(rng: &mut Rng, target: usize) -> String {
    let mut out = String::new();
    while out.len() < target {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(WORDS[rng.below(WORDS.len())]);
    }
    out.push('.');
    out
}

struct Sample {
    label: String,
    markdown_bytes: usize,
    full_state_bytes: usize,
    blocks: usize,
}

impl Sample {
    fn ratio(&self) -> f64 {
        self.full_state_bytes as f64 / self.markdown_bytes as f64
    }
}

/// A rich document grown the way one is written: one paragraph per edit
/// transaction, appended at the end of the body fragment. `block_bytes` is the
/// fragmentation axis — the same finished document composed in larger or
/// smaller units. Fragmentation dominates the encoding overhead, because every
/// block costs an XML element plus its text item.
fn grow_rich(target_markdown_bytes: usize, block_bytes: usize, seed: u64) -> Sample {
    let doc = Ydoc::wire();
    let mut rng = Rng(seed);
    let mut blocks = 0_usize;
    let mut approx = 0_usize;
    while approx < target_markdown_bytes {
        let text = block(&mut rng, block_bytes);
        approx += text.len() + 2;
        doc.richdoc_append_paragraph(&text);
        blocks += 1;
    }
    let markdown = doc.project(ContentKind::Richdoc).expect("project").markdown;
    Sample {
        label: format!(
            "rich {} / {block_bytes} B blocks",
            human(target_markdown_bytes)
        ),
        markdown_bytes: markdown.len(),
        full_state_bytes: doc.encode_full_state().len(),
        blocks,
    }
}

/// A plaintext lineage grown by typed runs, then REVISED: each interior delete
/// and re-insert splits the item it lands in and leaves a delete-set range
/// behind. This is the churn axis — what a long-lived document accumulates
/// beyond its content.
fn grow_plaintext(
    target_markdown_bytes: usize,
    block_bytes: usize,
    revisions: usize,
    seed: u64,
) -> Sample {
    let doc = Ydoc::wire();
    let mut rng = Rng(seed);
    let mut approx = 0_usize;
    let mut blocks = 0_usize;
    while approx < target_markdown_bytes {
        let text = format!("{}\n\n", block(&mut rng, block_bytes));
        doc.plaintext_insert(u32::try_from(approx).expect("index"), &text);
        approx += text.len();
        blocks += 1;
    }
    for _ in 0..revisions {
        let span = 16 + rng.below(48);
        let at = rng.below(approx.saturating_sub(span + 1));
        doc.plaintext_delete(
            u32::try_from(at).expect("index"),
            u32::try_from(span).expect("span"),
        );
        let replacement = block(&mut rng, span);
        doc.plaintext_insert(u32::try_from(at).expect("index"), &replacement);
        approx = approx - span + replacement.len();
    }
    let markdown = doc
        .project(ContentKind::Plaintext)
        .expect("project")
        .markdown;
    Sample {
        label: format!(
            "plaintext {} / {block_bytes} B blocks / {revisions} revisions",
            human(target_markdown_bytes)
        ),
        markdown_bytes: markdown.len(),
        full_state_bytes: doc.encode_full_state().len(),
        blocks,
    }
}

fn human(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{} MiB", bytes / (1024 * 1024))
    } else {
        format!("{} KiB", bytes / 1024)
    }
}

fn report(samples: &[Sample]) {
    println!(
        "\n{:<48} {:>12} {:>14} {:>8} {:>8}",
        "document", "markdown B", "full state B", "ratio", "blocks"
    );
    for sample in samples {
        println!(
            "{:<48} {:>12} {:>14} {:>8.3} {:>8}",
            sample.label,
            sample.markdown_bytes,
            sample.full_state_bytes,
            sample.ratio(),
            sample.blocks
        );
    }
}

/// The check. A document at `MAX_TEXT_BYTES` — the largest body the store
/// accepts — must encode to a Y.Doc full state the collab layer still admits,
/// or a document the engine happily holds cannot originate a shared lineage.
///
/// MUTATION: set `MAX_YDOC_UPDATE_BYTES` back to 5 MiB and this fails, naming
/// the projected size (~14.7 MiB) against the cap. Drop the 120-byte-block
/// sample and the worst ratio falls from ~1.41 to ~1.13, which would let a
/// 12 MiB bound look sufficient.
#[test]
fn the_bound_covers_the_largest_document_the_engine_accepts() {
    let mib = 1024 * 1024;
    // 512 KiB: enough to hold the ratio steady (see the module comment), small
    // enough that the whole corpus builds in seconds under a debug profile.
    let corpus = 512 * 1024;
    let samples = vec![
        grow_rich(corpus, 700, 1),
        grow_rich(corpus, 400, 2),
        // The fragmentation the worst measured document has: a heavily broken
        // outline, one short block per edit.
        grow_rich(corpus, 120, 3),
        grow_plaintext(corpus, 4096, 0, 4),
        grow_plaintext(corpus, 4096, 1_000, 5),
    ];
    report(&samples);

    let worst = samples
        .iter()
        .max_by(|left, right| left.ratio().total_cmp(&right.ratio()))
        .expect("samples");
    // The ratio is scale-stable, so the largest accepted body projects through
    // it. Rounded UP to the byte, never down.
    let projected = (worst.ratio() * MAX_TEXT_BYTES as f64).ceil() as usize;
    println!(
        "\nworst ratio {:.3} ({}) projects a {MAX_TEXT_BYTES}-byte document to \
         {projected} bytes of Y.Doc state; the bound is {MAX_YDOC_UPDATE_BYTES}",
        worst.ratio(),
        worst.label.trim()
    );

    assert!(
        MAX_YDOC_UPDATE_BYTES > projected,
        "MAX_YDOC_UPDATE_BYTES ({MAX_YDOC_UPDATE_BYTES} bytes) does not cover a \
         document at MAX_TEXT_BYTES ({MAX_TEXT_BYTES} bytes): the worst measured \
         encoding ratio {:.3} ({}) projects it to {projected} bytes of Y.Doc \
         state. A document the store accepts would fail to originate a shared \
         lineage.",
        worst.ratio(),
        worst.label.trim()
    );

    // Headroom for revision churn, which adds state without adding content
    // (~60 bytes per interior edit, measured). Without a stated margin the
    // bound could sit one byte above the content projection and still pass.
    let churn_headroom = MAX_YDOC_UPDATE_BYTES - projected;
    assert!(
        churn_headroom >= 5 * mib,
        "only {churn_headroom} bytes of churn headroom above the projected \
         {projected}: a long-lived document at MAX_TEXT_BYTES would stop \
         replicating after roughly {} revisions",
        churn_headroom / 60
    );
}

/// The recorded evidence for `limits.rs`, at the real `MAX_TEXT_BYTES`. Runs
/// for minutes, so it is not a gate — the check above is. Re-run with
/// `--ignored --nocapture` to reproduce the table.
#[test]
#[ignore = "evidence harness: minutes of encoding work, not a check"]
fn full_size_measurement_harness() {
    let mib = 1024 * 1024;
    let samples = vec![
        grow_rich(64 * 1024, 400, 1),
        grow_rich(mib, 400, 2),
        grow_rich(4 * mib, 400, 3),
        grow_rich(10 * mib, 700, 4),
        grow_rich(10 * mib, 400, 5),
        grow_rich(10 * mib, 120, 6),
        grow_plaintext(10 * mib, 65_536, 0, 7),
        grow_plaintext(mib, 4096, 0, 8),
        grow_plaintext(mib, 4096, 2_000, 8),
    ];
    report(&samples);
    let worst = samples
        .iter()
        .max_by_key(|sample| sample.full_state_bytes)
        .expect("samples");
    println!(
        "\nworst full state: {} bytes ({})",
        worst.full_state_bytes,
        worst.label.trim()
    );
}
