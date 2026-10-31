// What a held proof's memory peaks at, measured beside what it reserved, to
// calibrate the factors `preservation.rs` reserves by.
//
// Each case loads a lineage and merges it with the work a hold covers, as
// inspection does, then encodes the contribution artifact, inside one proof
// whose limit never refuses. The tail's work is built before the profiler
// starts and reserved as the window keeps it. dhat, the unit tests' global
// allocator under the `held-proof-memory` feature, measures the heap's peak
// over the proof; the proof's limit records the most it reserved.
//
// Before that, what the merged state keeps is measured on its own, kept as
// the proof keeps it: the lineage loaded from its store as the proof loads
// it, its snapshot and then each journal row after it one by one, and then
// every contribution applied. With S the stored bytes loading reads and Σb
// the contributions', it reports the kept state per stored byte over S + Σb,
// what the factor 22 reserves for, and what the contributions added per
// byte of Σb on its own. The rest of the peak is reported as the
// projection's. A measurement counts only once its preservation is complete,
// with the Markdown the case expects and every contribution merged, or, for
// work the lineage already holds, none.
//
// Two stages the projection's peak hides are measured on their own as well.
// The index of the ranges the merged state deleted is built from empty on
// that state, under a profiler that sees only it, and what it holds once
// built and the most it held while it grew are reported against what
// `Deletes::growth` reserves: the deleting cases, the 2,000-client ones
// above all, calibrate the 256 B per client and 64 B per range. And the
// lineage is loaded again and each contribution applied as the merge
// applies it, the index grown with it: the most the heap held over the
// loaded state is reported against what the merge reserves beside it then,
// and the largest rise of one application over the heap before it against
// 35·b + 2·M and the index's growth, what it reserves to apply and to keep.
// That profiler starts after the load, so what the heap still held at the
// end is reported too: well above the contributions' growth and the index,
// a reallocation of loaded state was counted whole and the rises read high.
//
// Calibrate against the measured peak, not the reserved one: at the
// projection's peak the proof reserves the state it kept, 17·M for the
// projection and `retained_bytes()` for the preservation, and the
// projection's 17·M already counts the merged full state and Markdown the
// preservation keeps, so about M and the Markdown are reserved twice.
//
// The cases: plaintext and rich documents of 1, 5 and 10 MiB of content;
// documents of 1 and 3 MiB rewritten from exact Markdown source the
// projection writes otherwise, whose preservation rebuilds and reprojects
// that source; documents of 1 and 3 MiB from exact source given only a
// source-preserving frontmatter edit, merged fresh and already contained,
// where rebuilding the source is most of the proof; one typed a keystroke
// at a time by interleaved clients, with backspaces, merged with an edit and
// a removal of what they typed; two whose
// deletions span 2,000 clients, over 64 KiB and over 4 KiB of content, where
// the clients outweigh the content, merged with an edit and a removal; one with
// heavy history; a snapshot with many journal rows after it; holds of 10,000
// and 50,000 small contributions; and a real released hold of 50,000 stored
// entries, measured through the whole inspection. Only that last case reads a
// window and validates, and SQLite's own copies of what it reads never reach
// the heap profile, so validation's factors stay estimates.
//
// Run it through the Rust gate with `cargo test -p dohc-engine-collab
// --release --lib --features held-proof-memory held_proof_memory --
// --ignored --nocapture --test-threads=1`: one profiler runs at a time. Each
// case prints one `HELD_PROOF_MEMORY` line of JSON.

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

/// A rich document of one paragraph typed `keystrokes` keystrokes at a time
/// at its end by `clients` writers in turn, every eighth a backspace over the
/// character before it: no two neighbouring characters share a client, so
/// none merge, and the backspaces delete across clients. Each keystroke goes
/// to the document and every other writer as it is typed, so typing costs
/// each keystroke's own size and the walk to the paragraph's end.
fn typed(keystrokes: usize, clients: usize) -> Ydoc {
    const LETTERS: &[u8] = b"abcdefghij ";
    let doc = Ydoc::wire();
    let _ = doc.richdoc_append_paragraph("");
    let writers: Vec<Ydoc> = (0..clients)
        .map(|_| {
            let writer = Ydoc::wire();
            writer.apply(&doc.encode_full_state()).unwrap();
            writer
        })
        .collect();
    let mut rng = Rng(4);
    let mut length = 0u32;
    for index in 0..keystrokes {
        let typist = index % clients;
        let (offset, delete, text) = if index % 8 == 7 && length > 0 {
            length -= 1;
            (length, 1, String::new())
        } else {
            length += 1;
            (length - 1, 0, char::from(LETTERS[rng.below(LETTERS.len())]).to_string())
        };
        let keystroke = writers[typist]
            .richdoc_keystroke(0, offset, delete, &text)
            .expect("a paragraph to type in");
        doc.apply(&keystroke).expect("keystroke");
        for (other, writer) in writers.iter().enumerate() {
            if other != typist {
                writer.apply(&keystroke).expect("keystroke");
            }
        }
    }
    doc
}

/// A rich document of `content` bytes over which `clients` other writers
/// each wrote a paragraph and removed it: its deletions span `clients`
/// clients, one range each, what keeps most per range in the index of what
/// the merge deleted.
fn sparse_deletions(content: usize, clients: usize) -> Ydoc {
    let doc = rich(content, 400);
    for _ in 0..clients {
        let writer = Ydoc::wire();
        let _ = writer.richdoc_append_paragraph("A note someone removed.");
        let _ = writer.richdoc_remove_block(0);
        doc.apply(&writer.encode_full_state()).expect("a removed note");
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

/// Exact Markdown source of about `content` bytes that the projection writes
/// otherwise: a list marked with `*`, which it writes with `-`.
fn lexical_source(content: usize) -> String {
    let mut rng = Rng(3);
    let mut source = String::from("# A plan someone wrote\n\n");
    while source.len() < content {
        source.push_str("* ");
        source.push_str(&block(&mut rng, 120));
        source.push('\n');
    }
    source
}

/// A rich document rewritten from exact source of about `content` bytes,
/// the edit another writer makes rewriting it from that source with one
/// more item, and that source: the merged state's exact source is fresh and
/// differs from its projection, so preserving it rebuilds and reprojects
/// another document from it.
fn reprojected(content: usize) -> (Ydoc, Vec<Vec<u8>>, String) {
    let source = lexical_source(content);
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &source)
        .expect("rewrite from source");
    let writer = Ydoc::wire();
    writer.apply(&doc.encode_full_state()).unwrap();
    let edited = format!("{source}* A retained edit.\n");
    let edit = writer
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &edited)
        .expect("edit from source");
    (doc, vec![edit], edited)
}

/// A rich document rewritten from exact source of about `content` bytes,
/// the small source-preserving frontmatter edit another writer makes over
/// it, and the source that edit binds: the merged state's exact source is
/// fresh and differs from its projection, so preserving it rebuilds a whole
/// document from that source against little retained work.
fn frontmatter_edited(content: usize) -> (Ydoc, Vec<Vec<u8>>, String) {
    let source = lexical_source(content);
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &source)
        .expect("rewrite from source");
    let writer = Ydoc::wire();
    writer.apply(&doc.encode_full_state()).unwrap();
    let edited = format!("---\ntitle: changed\n---\n{source}");
    let edit = writer
        .frontmatter_set_preserving_markdown_source("title", "changed", &edited)
        .expect("a source-preserving frontmatter edit");
    (doc, vec![edit], edited)
}

/// A document's lineage as a store keeps it, with the blobs of the work a
/// hold covers.
struct Lineage {
    store: EngineStore,
    key: DocKey,
    claim: String,
    /// The full state the lineage loads to.
    full_state: Vec<u8>,
    /// Dropped last, once the store has closed.
    _directory: ScratchDir,
}

/// A store whose document `object` claims `base` as its base, of `kind`,
/// with `rows` journaled after it and `updates` held as blobs.
fn lineage(base: &Ydoc, kind: ContentKind, rows: &[Vec<u8>], updates: &[Vec<u8>]) -> Lineage {
    let directory = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&directory.path().join("engine.db"), 1).unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    // The document's file, which its lineage's base claims. The proof never
    // reads it, and the largest cases pass the limit a file's text has.
    VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "plan.md".into(),
                text: "A plan.".into(),
                moment_id: "file".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    durable::claim_base(&mut store, &key, kind, &base.encode_full_state(), &NoFaults, 2).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            for row in rows {
                durable::record_update_in_tx(tx, &key, row, None, None, 2)?;
            }
            for update in updates {
                dohc_engine_storage::put_binary_blob_with_sha(tx, update, &hex_sha256(update))?;
            }
            Ok::<_, CollabError>(())
        })
        .unwrap();
    let claim = store
        .read_with(|conn| durable::read_marker_in(conn, &key))
        .unwrap()
        .and_then(|marker| marker.lineage_claim_id)
        .expect("a claimed lineage");
    Lineage {
        store,
        key,
        claim,
        full_state: head_of(base, rows).encode_full_state(),
        _directory: directory,
    }
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
            update_digest: hex_sha256(update),
            authors: RetainedAuthors::credited(None, None).unwrap(),
        })
        .collect()
}

/// A binding naming `lineage` and `tail`.
fn bound(lineage: &Lineage, tail: ProtectedTail) -> ReleasedLineageBinding {
    ReleasedLineageBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: lineage.claim.clone(),
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
        head_digest: hex_sha256(&lineage.full_state),
        tails: std::sync::Arc::new(ProtectedTails::Listed(vec![tail])),
    }
}

/// What a case's preserved Markdown must be.
enum Expected<'a> {
    Containing(&'a str),
    Exactly(&'a str),
}

/// What the merged state keeps, kept as a proof keeps it: `key`'s lineage,
/// the head's, which must be `claim`, loaded from `store` as a proof loads
/// it, then every one of `updates` applied. The stored bytes loading reads,
/// and the heap still held once the lineage loaded and once every update
/// applied; what loading and applying only read is not counted. Then, on
/// that merged state, what the index of the ranges it deleted holds once
/// built. Then, loaded again before the profiler starts, what applying each
/// update as the merge applies it holds: the most the heap held once it
/// applied, over what it held before.
fn kept_state(store: &EngineStore, key: &DocKey, claim: &str, updates: &[Vec<u8>]) -> Kept {
    let head = store
        .read_with(|conn| durable::read_marker_in(conn, key))
        .expect("the marker reads")
        .and_then(|marker| marker.lineage_claim_id);
    assert_eq!(head.as_deref(), Some(claim), "the proof loads the head's lineage");
    let (_, stored, _) = store
        .read_with(|conn| released_protection::lineage_workload(conn, key, claim))
        .expect("the lineage's stored length");
    let load = || {
        store
            .read_with(|conn| durable::load_doc_between::<CollabError>(conn, key, &mut || Ok(())))
            .expect("the lineage loads")
    };
    let heap = || dhat::HeapStats::get().curr_bytes as u64;
    let profiler = dhat::Profiler::builder().testing().build();
    let state = load();
    let loaded = heap();
    for update in updates {
        state.apply(update).expect("each contribution applies");
    }
    let merged = heap();
    drop(profiler);
    // Under a profiler of its own, which sees nothing else: the old table
    // of clients is held beside the new one while it doubles.
    let (index, index_reserved) = released_protection::deletion_index_bytes(&state, |build| {
        let profiler = dhat::Profiler::builder().testing().build();
        build();
        let built = dhat::HeapStats::get();
        drop(profiler);
        Index { held: built.curr_bytes as u64, peak: built.max_bytes as u64 }
    });
    drop(state);

    let state = load();
    // M, the encoded bytes the merge holds: the full state, then each
    // update's as it applies.
    let mut merging = state.encode_full_state().len() as u64;
    let (mut growing, mut reserved) = (0u64, 0u64);
    let mut worst = Applying { rise: 0, allowance: 1 };
    let mut applications = released_protection::Applications::default();
    let profiler = dhat::Profiler::builder().testing().build();
    for update in updates {
        let bytes = update.len() as u64;
        merging += bytes;
        let before = heap();
        let indexed = applications.apply(&state, update);
        let rise = (dhat::HeapStats::get().max_bytes as u64).saturating_sub(before);
        // 22·b for what it adds to the state, and the index's growth, kept;
        // 13·b + 2·M, as `preservation.rs` reserves applying.
        growing += 22 * bytes + indexed;
        reserved = reserved.max(growing + 13 * bytes + 2 * merging);
        // Its rise counts what it adds to the state and the index too.
        let allowance = 35 * bytes + 2 * merging + indexed;
        if u128::from(rise) * u128::from(worst.allowance) > u128::from(worst.rise) * u128::from(allowance) {
            worst = Applying { rise, allowance };
        }
    }
    let applying_peak = dhat::HeapStats::get().max_bytes as u64;
    let applying_retained = heap();
    drop(applications);
    drop(state);
    drop(profiler);
    Kept {
        stored,
        loaded,
        merged,
        index,
        index_reserved,
        applying_peak,
        applying_reserved: reserved,
        applying_retained,
        worst,
    }
}

/// What the index of the ranges the merged state deleted held once built,
/// and the most it held while it was built.
#[derive(Clone, Copy)]
struct Index {
    held: u64,
    peak: u64,
}

/// What [`kept_state`] measured.
#[derive(Clone, Copy)]
struct Kept {
    stored: u64,
    loaded: u64,
    merged: u64,
    /// What the index of the ranges the merged state deleted holds, and
    /// what the merge reserves for it.
    index: Index,
    index_reserved: u64,
    /// The most the heap held over the loaded state while the updates
    /// applied, and the most the merge reserves beside that state while
    /// they do: 22·b for each so far and the index's growth, and 13·b + 2·M
    /// for the one applying.
    applying_peak: u64,
    applying_reserved: u64,
    /// What the heap held over the loaded state once every update applied
    /// that way. Well above the contributions' growth and the index means a
    /// reallocation of state loaded before the profiler started was counted
    /// whole, so the rises read high.
    applying_retained: u64,
    /// The application whose rise is largest against what it reserves.
    worst: Applying,
}

/// What applying one update held: the most the heap held once it applied
/// over what it held before, which counts what it adds to the state and
/// any earlier application's higher peak, so it never reads low, against
/// 35·b + 2·M and the index's growth: its 13·b + 2·M, and the 22·b and the
/// growth the merge keeps.
#[derive(Clone, Copy)]
struct Applying {
    rise: u64,
    allowance: u64,
}

/// Refuse a measurement whose preservation is not the complete one its case
/// expects: `merged` merged, and its Markdown as `expected` says.
fn accepted(case: &str, preservation: &Preservation, merged: &[RetainedContribution], expected: &Expected<'_>) {
    assert_eq!(preservation.status, PreservationStatus::Complete, "{case}: {:?}", preservation.findings);
    assert_eq!(preservation.merged, merged, "{case}: what it merged");
    let markdown = &preservation.preserved.as_ref().expect("a complete preservation keeps its state").markdown;
    match expected {
        Expected::Containing(text) => assert!(markdown.contains(text), "{case}: {text:?} is missing"),
        Expected::Exactly(source) => assert!(markdown == source, "{case}: not its exact source"),
    }
}

/// What one measured proof found.
struct Measured<'a> {
    case: &'a str,
    full_state: usize,
    /// The contributions' bytes.
    merged: usize,
    contributions: usize,
    kept: Kept,
    peak: u64,
    reserved: u64,
    markdown: usize,
    artifact: Option<usize>,
}

fn report(measured: &Measured<'_>) {
    let ratio = |bytes: u64, of: u64| bytes as f64 / of.max(1) as f64;
    let Kept {
        stored,
        loaded,
        merged: kept,
        index,
        index_reserved,
        applying_peak,
        applying_reserved,
        applying_retained,
        worst,
    } = measured.kept;
    let contributed = measured.merged as u64;
    let growth = kept.saturating_sub(loaded);
    let projection = measured.peak.saturating_sub(kept);
    println!(
        "HELD_PROOF_MEMORY {}",
        serde_json::json!({
            "case": measured.case,
            "storedBytes": stored,
            "fullStateBytes": measured.full_state,
            "contributions": measured.contributions,
            "contributionBytes": contributed,
            "markdownBytes": measured.markdown,
            "artifactBytes": measured.artifact,
            "keptLoadedBytes": loaded,
            "keptStateBytes": kept,
            "keptPerStoredByte": ratio(kept, stored + contributed),
            "contributionGrowthBytes": growth,
            "contributionGrowthPerContributionByte": ratio(growth, contributed),
            "applyingPeakBytes": applying_peak,
            "applyingReservedBytes": applying_reserved,
            "applyingPeakPerReserved": ratio(applying_peak, applying_reserved),
            "applyingRetainedBytes": applying_retained,
            "applyingRiseBytes": worst.rise,
            "applyingAllowanceBytes": worst.allowance,
            "applyingRisePerAllowance": ratio(worst.rise, worst.allowance),
            "deletionIndexBytes": index.held,
            "deletionIndexPeakBytes": index.peak,
            "deletionIndexReservedBytes": index_reserved,
            "deletionIndexPerReserved": ratio(index.held, index_reserved),
            "deletionIndexPeakPerReserved": ratio(index.peak, index_reserved),
            "measuredPeakBytes": measured.peak,
            "projectionBytes": projection,
            "projectionPerMergedByte": ratio(projection, measured.full_state as u64 + contributed),
            "reservedPeakBytes": measured.reserved,
        })
    );
}

/// Measure one hold: `lineage` merged with `updates`, whose preserved
/// Markdown must be as `expected` says.
fn measure(case: &str, lineage: &Lineage, updates: &[Vec<u8>], expected: &Expected<'_>) {
    measure_hold(case, lineage, updates, true, expected);
}

/// Measure one hold whose `updates` `lineage` already contains: the merge
/// applies each and adds nothing, so it merges none.
fn measure_contained(case: &str, lineage: &Lineage, updates: &[Vec<u8>], expected: &Expected<'_>) {
    measure_hold(case, lineage, updates, false, expected);
}

fn measure_hold(case: &str, lineage: &Lineage, updates: &[Vec<u8>], merges: bool, expected: &Expected<'_>) {
    let kept = kept_state(&lineage.store, &lineage.key, &lineage.claim, updates);
    let covered = covered(updates);
    let tail = ProtectedTail {
        namespace: "relay".into(),
        activation_id: "activation".into(),
        release: None,
        coverage: RetainedCoverage::Unproven(UnprovenCommitment::of(covered.clone()).expect("covered work")),
    };
    let binding = bound(lineage, tail.clone());
    // Built before the profiler starts, as validation builds it.
    let tails = vec![(
        tail,
        released_protection::TailWork {
            contributions: covered.clone(),
            contradictions: Vec::new(),
        },
    )];
    let limit = HeldProofLimit::new(1, 1 << 40, 0);
    let proofs: HeldProofs<(), ()> = HeldProofs::new(limit.clone());
    proofs.set_proof_deadline(std::time::Duration::from_secs(3_600));
    let HeldProofAdmission::Started(run, _wait) = proofs.admit(&lineage.store, "workspace", ()).unwrap() else {
        panic!("a free workspace starts its proof")
    };
    let profiler = dhat::Profiler::builder().testing().build();
    let mut answer = None;
    run.prove(|job| {
        let stop = job.stop();
        let preserved = lineage.store.read_with(|conn| {
            released_protection::preserve_lineage(conn, &lineage.key, &lineage.claim, tails, stop)
        });
        let artifact = preserved
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .map(|preservation| ContributionArtifact::of(&binding, preservation, stop));
        answer = Some((preserved, artifact, job.stopped()));
        ((), 0)
    });
    let heap = dhat::HeapStats::get();
    drop(profiler);
    let (preserved, artifact, stopped) = answer.expect("the proof ran");
    assert_eq!(stopped, None, "{case}: nothing stops it");
    let preservation = preserved.unwrap().expect("the lineage loads");
    accepted(case, &preservation, if merges { &covered[..] } else { &[] }, expected);
    let artifact = artifact.expect("encoded").unwrap();
    report(&Measured {
        case,
        full_state: lineage.full_state.len(),
        merged: updates.iter().map(Vec::len).sum(),
        contributions: covered.len(),
        kept,
        peak: heap.max_bytes as u64,
        reserved: limit.peak_reserved_bytes(),
        markdown: preservation.preserved.as_ref().map_or(0, |kept| kept.markdown.len()),
        artifact: artifact.as_ref().map(|artifact| artifact.bytes.len()),
    });
}

/// Measure a real released hold of `count` pending entries through the
/// whole inspection: its window, each activation, validating every entry,
/// the tail's commitment, the merge, the projection and the artifact.
fn measure_released_hold(count: usize) {
    let case = format!("released hold of {count} stored entries");
    let (f, binding, entries) = released_with_pending_entries(count);
    let full_state = local_doc(&f).encode_full_state();
    let updates = f
        .store
        .read_with(|conn| {
            entries
                .iter()
                .map(|entry| {
                    conn.query_row("SELECT bytes FROM binary_blobs WHERE sha256=?1", [entry.update_digest()], |row| {
                        row.get::<_, Vec<u8>>(0)
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    let kept = kept_state(&f.store, &f.key, &binding.lineage_claim_id, &updates);
    let limit = HeldProofLimit::new(1, 1 << 40, 0);
    let proofs: HeldProofs<(), ()> = HeldProofs::new(limit.clone());
    proofs.set_proof_deadline(std::time::Duration::from_secs(3_600));
    let HeldProofAdmission::Started(run, _wait) = proofs.admit(&f.store, "workspace", ()).unwrap() else {
        panic!("a free workspace starts its proof")
    };
    let profiler = dhat::Profiler::builder().testing().build();
    let mut answer = None;
    run.prove(|job| {
        let stop = job.stop();
        let inspected = f.store.read_with(|conn| inspect_held(conn, &binding, stop));
        let artifact = match &inspected {
            Ok(HeldInspection::Current(preservation)) => Some(ContributionArtifact::of(&binding, preservation, stop)),
            _ => None,
        };
        answer = Some((inspected, artifact, job.stopped()));
        ((), 0)
    });
    let heap = dhat::HeapStats::get();
    drop(profiler);
    let (inspected, artifact, stopped) = answer.expect("the proof ran");
    assert_eq!(stopped, None, "{case}: nothing stops it");
    let HeldInspection::Current(preservation) = inspected.unwrap() else {
        panic!("{case}: the binding was just derived")
    };
    accepted(&case, &preservation, &entries, &Expected::Containing(&format!("Pending entry {}", count - 1)));
    let artifact = artifact.expect("encoded").unwrap();
    report(&Measured {
        case: &case,
        full_state: full_state.len(),
        merged: updates.iter().map(Vec::len).sum(),
        contributions: entries.len(),
        kept,
        peak: heap.max_bytes as u64,
        reserved: limit.peak_reserved_bytes(),
        markdown: preservation.preserved.as_ref().map_or(0, |kept| kept.markdown.len()),
        artifact: artifact.as_ref().map(|artifact| artifact.bytes.len()),
    });
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

/// A small edit and the removal of `state`'s first block, each by another
/// writer, for a hold to cover: the removal deletes everything that block
/// holds, and with it the merge reads the state's deletions.
fn edit_and_removal(state: &Ydoc) -> Vec<Vec<u8>> {
    let mut edits = one_edit(state, ContentKind::Richdoc);
    let remover = Ydoc::wire();
    remover.apply(&state.encode_full_state()).unwrap();
    edits.push(remover.richdoc_remove_block(0));
    edits
}

/// `count` small paragraphs one writer appended over `state`, in order.
fn many_edits(state: &Ydoc, count: usize) -> Vec<Vec<u8>> {
    let writer = Ydoc::wire();
    writer.apply(&state.encode_full_state()).unwrap();
    (0..count)
        .map(|index| writer.richdoc_append_paragraph(&format!("Retained item {index}.")))
        .collect()
}

/// A state of `base` with `rows` applied.
fn head_of(base: &Ydoc, rows: &[Vec<u8>]) -> Ydoc {
    let head = Ydoc::wire();
    head.apply(&base.encode_full_state()).unwrap();
    for row in rows {
        head.apply(row).unwrap();
    }
    head
}

#[test]
#[ignore = "measurement: run with --release --ignored --nocapture --test-threads=1"]
fn measure_held_proof_peak_heap() {
    let mib = 1 << 20;
    let edited = Expected::Containing("A retained edit.");
    for size in [mib, 5 * mib, 10 * mib] {
        for (shape, kind, state) in [
            ("plaintext", ContentKind::Plaintext, plaintext(size, 65_536)),
            ("rich, 700 B paragraphs", ContentKind::Richdoc, rich(size, 700)),
            ("rich, 400 B paragraphs", ContentKind::Richdoc, rich(size, 400)),
            ("rich, 120 B paragraphs", ContentKind::Richdoc, rich(size, 120)),
        ] {
            let edit = one_edit(&state, kind);
            let stored = lineage(&state, kind, &[], &edit);
            measure(&format!("{shape}, {} MiB", size / mib), &stored, &edit, &edited);
        }
    }
    // Rewriting from exact source sends an update about five times the
    // source, and an update stays within 20 MiB.
    for size in [mib, 3 * mib] {
        let (state, edit, source) = reprojected(size);
        let stored = lineage(&state, ContentKind::Richdoc, &[], &edit);
        measure(
            &format!("exact source reprojected, {} MiB", size / mib),
            &stored,
            &edit,
            &Expected::Exactly(&source),
        );
    }
    // Exact source with little retained work, where rebuilding the source
    // costs most per merged byte: a frontmatter edit, then the same edit
    // already journaled in the lineage.
    for size in [mib, 3 * mib] {
        let (state, edit, source) = frontmatter_edited(size);
        let fresh = lineage(&state, ContentKind::Richdoc, &[], &edit);
        let case = format!("exact source, then a frontmatter edit, {} MiB", size / mib);
        measure(&case, &fresh, &edit, &Expected::Exactly(&source));
        drop(fresh);
        let contained = lineage(&state, ContentKind::Richdoc, &edit, &edit);
        let case = format!("exact source, its frontmatter edit already contained, {} MiB", size / mib);
        measure_contained(&case, &contained, &edit, &Expected::Exactly(&source));
    }
    let keystrokes = typed(64 * 1024, 4);
    let edits = edit_and_removal(&keystrokes);
    let stored = lineage(&keystrokes, ContentKind::Richdoc, &[], &edits);
    measure(
        "64 Ki keystrokes by 4 clients, every eighth a backspace, then an edit and the paragraph's removal",
        &stored,
        &edits,
        &edited,
    );
    for content in [64, 4] {
        let sparse = sparse_deletions(content * 1024, 2_000);
        let edits = edit_and_removal(&sparse);
        let stored = lineage(&sparse, ContentKind::Richdoc, &[], &edits);
        measure(
            &format!("{content} KiB with deletions by 2,000 clients, then an edit and a removal"),
            &stored,
            &edits,
            &edited,
        );
    }
    let history = rewritten(256 * 1024, 32);
    let edit = one_edit(&history, ContentKind::Richdoc);
    let stored = lineage(&history, ContentKind::Richdoc, &[], &edit);
    measure("heavy history: 256 KiB rewritten 32 times", &stored, &edit, &edited);
    let base = rich(mib, 400);
    let rows = many_edits(&base, 2_000);
    let edit = one_edit(&head_of(&base, &rows), ContentKind::Richdoc);
    let stored = lineage(&base, ContentKind::Richdoc, &rows, &edit);
    measure("1 MiB snapshot and 2,000 journal rows", &stored, &edit, &edited);
    let small = rich(4 * 1024, 400);
    for count in [10_000, 50_000] {
        let edits = many_edits(&small, count);
        let stored = lineage(&small, ContentKind::Richdoc, &[], &edits);
        let last = format!("Retained item {}.", count - 1);
        measure(&format!("{count} small contributions"), &stored, &edits, &Expected::Containing(&last));
    }
    measure_released_hold(50_000);
}

/// A measurement counts only a complete preservation: a contribution whose
/// dependency never arrives leaves the merge pending, and `measure` refuses
/// it before it reports anything.
#[test]
#[ignore = "measurement: run with --release --ignored --nocapture --test-threads=1"]
#[should_panic(expected = "PendingContributionDependencies")]
fn a_measurement_refuses_an_incomplete_preservation() {
    let small = rich(4 * 1024, 400);
    let edits = many_edits(&small, 2);
    let stored = lineage(&small, ContentKind::Richdoc, &[], &edits);
    measure("the second of two edits alone", &stored, &edits[1..], &Expected::Containing("Retained item 1."));
}
