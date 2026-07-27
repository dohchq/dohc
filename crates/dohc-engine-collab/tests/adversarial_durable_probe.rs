//! REVIEW-ONLY probe (not part of the PR): prove the overlap-slice divergence
//! traverses BOTH durable wiring sites (record_local_update and
//! apply_remote_update) — i.e. the accepted-but-divergent candidate is
//! journaled into the durable lineage, and the reconstructed doc carries the
//! silently-corrupted text.

mod common;

use common::*;
use dohc_engine_collab::{
    apply_remote_update, claim_base, ensure_marker, load_persisted, record_local_update,
    ContentKind, Regime, RemoteUpdate, Ydoc,
};
use dohc_engine_storage::NoFaults;

fn corpus_case(name: &str) -> (Vec<Vec<u8>>, Vec<u8>) {
    let path = std::env::var("DOHC_PARITY_CORPUS").expect("DOHC_PARITY_CORPUS");
    let corpus: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse");
    let case = corpus
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .expect("case");
    let base = case["base"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| decode_b64(u.as_str().unwrap()))
        .collect();
    let candidate = decode_b64(case["candidate"].as_str().unwrap());
    (base, candidate)
}

fn units(s: &str) -> Vec<u32> {
    s.encode_utf16().map(u32::from).collect()
}

#[test]
fn overlap_slice_is_journaled_via_record_local_update() {
    let (base, candidate) = corpus_case("overlap-slice-full-resend");
    let mut ts = fresh_store("overlap-local");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    ensure_marker(
        &mut ts.store,
        &key,
        ContentKind::Plaintext,
        Regime::LocalOnly,
        &NoFaults,
        1_000,
    )
    .expect("marker");
    for (i, u) in base.iter().enumerate() {
        record_local_update(&mut ts.store, &key, u, &NoFaults, 1_001 + i as i64)
            .expect("base journals");
    }
    let outcome = record_local_update(&mut ts.store, &key, &candidate, &NoFaults, 1_100);
    eprintln!("LOCAL PATH outcome: {outcome:?}");
    let loaded = load_persisted(&ts.store, &key)
        .expect("load")
        .expect("doc");
    let text = loaded.doc.plaintext_string();
    eprintln!(
        "LOCAL PATH persisted text units: {:x?} (yjs oracle: [61, fffd, fffd])",
        units(&text)
    );
    eprintln!(
        "LOCAL PATH persisted sv: {:x?}",
        loaded.doc.encode_state_vector()
    );
    assert!(
        outcome.is_err(),
        "P0: divergent overlap-slice update was journaled by record_local_update; \
         persisted text {:x?} != yjs [61, fffd, fffd]",
        units(&text)
    );
}

#[test]
fn overlap_slice_is_journaled_via_apply_remote_update() {
    let (base, candidate) = corpus_case("overlap-slice-full-resend");
    let mut ts = fresh_store("overlap-remote");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    claim_base(
        &mut ts.store,
        &key,
        ContentKind::Plaintext,
        &base[0],
        &NoFaults,
        1_000,
    )
    .expect("claim base");
    let remote = RemoteUpdate {
        origin_id: "peer-a".to_owned(),
        origin_seq: 1,
        bytes: candidate.clone(),
    };
    let outcome = apply_remote_update(&mut ts.store, &key, &remote, &NoFaults, 1_100);
    eprintln!("REMOTE PATH outcome: {outcome:?}");
    let loaded = load_persisted(&ts.store, &key)
        .expect("load")
        .expect("doc");
    let text = loaded.doc.plaintext_string();
    eprintln!(
        "REMOTE PATH persisted text units: {:x?} (yjs oracle: [61, fffd, fffd])",
        units(&text)
    );
    assert!(
        outcome.is_err(),
        "P0: divergent overlap-slice update was journaled by apply_remote_update; \
         persisted text {:x?} != yjs [61, fffd, fffd]",
        units(&text)
    );
}

/// After the corrupt apply, what does the yrs doc CLAIM to have? If its state
/// vector says clock 3 while holding 2 units, every future clock-3+ edit from a
/// yjs peer compounds the divergence silently.
#[test]
fn overlap_slice_state_vector_after_apply() {
    let (base, candidate) = corpus_case("overlap-slice-full-resend");
    let doc = Ydoc::wire();
    for u in &base {
        doc.apply(u).expect("base");
    }
    let sv_before = doc.encode_state_vector();
    doc.apply(&candidate).expect("candidate applied cleanly");
    let sv_after = doc.encode_state_vector();
    eprintln!(
        "sv before: {sv_before:x?}  after: {sv_after:x?}  text: {:x?}",
        doc.plaintext_string().encode_utf16().collect::<Vec<_>>()
    );
}
