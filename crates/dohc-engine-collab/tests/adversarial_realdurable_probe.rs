//! REVIEW-ONLY: drive a sequence through the REAL durable path
//! (record_local_update, LocalOnly) — skipping gate-rejected updates — then
//! load_persisted and read the reconstructed text. This is ground truth for
//! what the durable engine actually stores, vs the yjs oracle over the same
//! accepted subset.

mod common;

use common::*;
use dohc_engine_collab::{
    ensure_marker, load_persisted, record_local_update, CollabError, ContentKind, Regime,
};
use dohc_engine_storage::NoFaults;

#[test]
fn real_durable_sequence() {
    let seed_target: i64 = std::env::var("DOHC_SEED").unwrap().parse().unwrap();
    let seqs: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(std::env::var("DOHC_SEQS").unwrap()).unwrap())
            .unwrap();
    let s = seqs
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["seed"].as_i64() == Some(seed_target))
        .unwrap();
    let updates: Vec<Vec<u8>> = s["updates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| decode_b64(u.as_str().unwrap()))
        .collect();

    let mut ts = fresh_store("real-durable");
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

    let mut accepted = Vec::new();
    for (i, u) in updates.iter().enumerate() {
        match record_local_update(&mut ts.store, &key, u, &NoFaults, 1_001 + i as i64) {
            Ok(_) => accepted.push(i),
            Err(CollabError::ReplayParityViolation { .. }) => {}
            Err(e) => eprintln!("  [{i}] other error: {e}"),
        }
    }
    eprintln!("accepted indices: {accepted:?}");

    let loaded = load_persisted(&ts.store, &key).expect("load").expect("doc");
    let text: Vec<u16> = loaded.doc.plaintext_string().encode_utf16().collect();
    eprintln!("REAL DURABLE reconstructed text: {:x?}", text);
    eprintln!("has_missing (durable doc): journaled {} updates", accepted.len());
}
