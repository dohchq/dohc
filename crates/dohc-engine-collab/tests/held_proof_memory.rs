//! What a held proof's memory peaks at, measured beside what it reserved.
//!
//! Each case loads a lineage and merges it with the work a hold covers, as
//! inspection does, then encodes the contribution artifact, inside one proof
//! whose limit never refuses. dhat, this binary's global allocator, measures
//! the heap's peak over the proof; the proof's limit records the most it
//! reserved. The cases are the documents `limits.rs` measures, at 1, 5 and
//! 10 MiB of content, a document with heavy history, and holds of 10,000
//! and 50,000 small contributions. Validating a window's evidence is not
//! measured here: no case has a window.
//!
//! Run it through the Rust gate with `cargo test -p dohc-engine-collab
//! --release --test held_proof_memory -- --ignored --nocapture`. Each case
//! prints one `HELD_PROOF_MEMORY` line of JSON.

use dohc_engine_collab::live_update_application::{
    preserve_lineage, ContributionArtifact, HeldProofAdmission, HeldProofLimit, HeldProofs,
    IncomingCoordinate, ProtectedTail, ProtectedTails, ReleasedLineageBinding, RetainedAuthors,
    RetainedContribution, RetainedCoverage, UnprovenCommitment,
};
use dohc_engine_collab::{durable, ContentKind, DocKey, Ydoc};
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_storage::{EngineStore, NoFaults};
use std::sync::Arc;

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

/// Deterministic prose, as `ydoc_full_state_size.rs` writes it.
struct Rng(u64);

impl Rng {
    fn below(&mut self, bound: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 11) % bound as u64) as usize
    }
}

const WORDS: &[&str] = &[
    "workspace", "agent", "document", "provenance", "lineage", "review", "decision", "sync",
    "relay", "snapshot", "markdown", "structure", "inspectable", "durable", "boundary", "capture",
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

/// A rich document of `content` bytes, one paragraph of `block_bytes` per
/// edit, as `limits.rs` measures it.
fn rich(content: usize, block_bytes: usize) -> Ydoc {
    let doc = Ydoc::wire();
    let mut rng = Rng(1);
    let mut written = 0;
    while written < content {
        let text = block(&mut rng, block_bytes);
        written += text.len() + 2;
        let _ = doc.richdoc_append_paragraph(&text);
    }
    doc
}

/// A plaintext document of `content` bytes, typed in runs of `block_bytes`.
fn plaintext(content: usize, block_bytes: usize) -> Ydoc {
    let doc = Ydoc::wire();
    let mut rng = Rng(2);
    let mut written = 0;
    while written < content {
        let text = format!("{}\n\n", block(&mut rng, block_bytes));
        let _ = doc.plaintext_insert(u32::try_from(written).expect("index"), &text);
        written += text.len();
    }
    doc
}

/// A rich document of `content` bytes rewritten whole `revisions` times:
/// its full state carries every earlier version's structure.
fn rewritten(content: usize, revisions: usize) -> Ydoc {
    let doc = rich(content, 400);
    let mut markdown = doc.project(ContentKind::Richdoc).expect("project").content;
    for revision in 0..revisions {
        markdown.push_str(&format!("\n\nRevision {revision}.\n"));
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
            .expect("rewrite");
    }
    doc
}

/// A store whose document `object` claims `state` as its base, of `kind`,
/// and holds `updates` as blobs; the lineage it claimed.
fn stored(
    state: &Ydoc,
    kind: ContentKind,
    updates: &[Vec<u8>],
) -> (dohc_test_scratch::ScratchDir, EngineStore, DocKey, String) {
    let directory = dohc_test_scratch::ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&directory.path().join("engine.db"), 1).unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    durable::claim_base(&mut store, &key, kind, &state.encode_full_state(), &NoFaults, 2).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            for update in updates {
                let digest = dohc_engine_storage::hex_sha256(update);
                dohc_engine_storage::put_binary_blob_with_sha(tx, update, &digest)?;
            }
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    let lineage = store
        .read_with(|conn| durable::read_marker_in(conn, &key))
        .unwrap()
        .and_then(|marker| marker.lineage_claim_id)
        .expect("a claimed lineage");
    (directory, store, key, lineage)
}

/// The contributions an outbox names for `updates`.
fn covered(updates: &[Vec<u8>]) -> Vec<RetainedContribution> {
    updates
        .iter()
        .enumerate()
        .map(|(index, update)| RetainedContribution::Outbox {
            outbox_id: format!("owner-outbox-{}", "f".repeat(64)),
            sequence: index as i64 + 1,
            delivery_id: format!("owner-delivery-{index:08}"),
            update_digest: dohc_engine_storage::hex_sha256(update),
            authors: RetainedAuthors::credited(None, None).unwrap(),
        })
        .collect()
}

/// A binding naming `lineage` and one tail covering `covered`.
fn binding(lineage: &str, state: &Ydoc, covered: &[RetainedContribution]) -> ReleasedLineageBinding {
    ReleasedLineageBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: lineage.to_owned(),
        current_path: Some("plan.md".into()),
        restore_generation: Some(0),
        incoming: IncomingCoordinate {
            relay_namespace: Some("relay".into()),
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            origin_id: "desktop".into(),
            origin_seq: 0,
            relay_seq: 1,
        },
        head_digest: dohc_engine_storage::hex_sha256(&state.encode_full_state()),
        tails: Arc::new(ProtectedTails::Listed(vec![ProtectedTail {
            namespace: "relay".into(),
            activation_id: "activation".into(),
            release: None,
            coverage: RetainedCoverage::Unproven(
                UnprovenCommitment::of(covered.to_vec()).expect("covered work"),
            ),
        }])),
    }
}

/// Measure one hold: `state` of `kind`, merged with `updates`.
fn measure(case: &str, state: &Ydoc, kind: ContentKind, updates: Vec<Vec<u8>>) {
    let (_directory, store, key, lineage) = stored(state, kind, &updates);
    let covered = covered(&updates);
    let bound = binding(&lineage, state, &covered);
    let full_state = state.encode_full_state().len();
    drop(updates);

    let profiler = dhat::Profiler::builder().testing().build();
    let limit = HeldProofLimit::new(1, 1 << 40, 0);
    let proofs: HeldProofs<(), ()> = HeldProofs::new(limit.clone());
    proofs.set_proof_deadline(std::time::Duration::from_secs(3_600));
    let HeldProofAdmission::Started(run, _wait) = proofs.admit(&store, "workspace", ()).unwrap() else {
        panic!("a free workspace starts its proof")
    };
    let mut answer = None;
    run.prove(|job| {
        let stop = job.stop();
        let work = vec![("relay".to_owned(), covered.clone())];
        let preserved = store
            .read_with(|conn| preserve_lineage(conn, &key, &lineage, work, stop))
            .unwrap()
            .expect("the lineage loads");
        stop.reserve(preserved.retained_bytes()).unwrap();
        let artifact = ContributionArtifact::of(&bound, &preserved, stop).unwrap();
        answer = Some((
            preserved.preserved.as_ref().map(|kept| kept.markdown.len()),
            artifact.as_ref().map(|artifact| artifact.bytes.len()),
            job.stopped(),
        ));
        ((), 0)
    });
    let heap = dhat::HeapStats::get();
    drop(profiler);
    let (markdown, artifact, stopped) = answer.expect("the proof ran");
    assert_eq!(stopped, None, "{case}: nothing stops it");
    println!(
        "HELD_PROOF_MEMORY {}",
        serde_json::json!({
            "case": case,
            "fullStateBytes": full_state,
            "contributions": covered.len(),
            "markdownBytes": markdown,
            "artifactBytes": artifact,
            "measuredPeakBytes": heap.max_bytes,
            "reservedPeakBytes": limit.peak_reserved_bytes(),
        })
    );
}

/// One small edit appended to `state` by another writer, for a hold to cover.
fn one_edit(state: &Ydoc, kind: ContentKind) -> Vec<Vec<u8>> {
    let writer = Ydoc::wire();
    writer.apply(&state.encode_full_state()).unwrap();
    vec![match kind {
        ContentKind::Plaintext => writer.plaintext_insert(0, "A retained edit.\n\n"),
        _ => writer.richdoc_append_paragraph("A retained edit."),
    }]
}

/// `count` small paragraphs one writer appended over `state`, in order.
fn many_edits(state: &Ydoc, count: usize) -> Vec<Vec<u8>> {
    let writer = Ydoc::wire();
    writer.apply(&state.encode_full_state()).unwrap();
    (0..count)
        .map(|index| writer.richdoc_append_paragraph(&format!("Retained item {index}.")))
        .collect()
}

#[test]
#[ignore = "measurement: run with --release --ignored --nocapture"]
fn measure_held_proof_peak_heap() {
    let mib = 1 << 20;
    for size in [mib, 5 * mib, 10 * mib] {
        for (shape, kind, state) in [
            ("plaintext", ContentKind::Plaintext, plaintext(size, 65_536)),
            ("rich, 700 B paragraphs", ContentKind::Richdoc, rich(size, 700)),
            ("rich, 400 B paragraphs", ContentKind::Richdoc, rich(size, 400)),
            ("rich, 120 B paragraphs", ContentKind::Richdoc, rich(size, 120)),
        ] {
            let edit = one_edit(&state, kind);
            measure(&format!("{shape}, {} MiB", size / mib), &state, kind, edit);
        }
    }
    let history = rewritten(256 * 1024, 32);
    let edit = one_edit(&history, ContentKind::Richdoc);
    measure("heavy history: 256 KiB rewritten 32 times", &history, ContentKind::Richdoc, edit);
    let small = rich(4 * 1024, 400);
    for count in [10_000, 50_000] {
        let edits = many_edits(&small, count);
        measure(&format!("{count} small contributions"), &small, ContentKind::Richdoc, edits);
    }
}
