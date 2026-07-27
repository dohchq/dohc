//! REVIEW-ONLY: minimal dangling-dependency update. yjs parks it (renders "");
//! does the gate accept it and does yrs render it (divergence)?

mod common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::{
    ensure_marker, load_persisted, record_local_update, validate_replay_parity, ContentKind,
    Regime, Ydoc,
};
use dohc_engine_storage::NoFaults;

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

#[test]
fn minimal_dangling_dependency() {
    let v: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("DOHC_MIN").unwrap()).unwrap(),
    )
    .unwrap();
    let diff_q = b64(v["diffQ"].as_str().unwrap());

    // gate on empty base
    let base = Ydoc::wire();
    let verdict = validate_replay_parity(&base, &diff_q);
    eprintln!("gate(empty, diffQ): {verdict:?}");

    // direct yrs replay
    let doc = Ydoc::wire();
    doc.apply(&diff_q).unwrap();
    eprintln!(
        "yrs empty+diffQ text: {:x?}  has_missing={}",
        doc.plaintext_string().encode_utf16().collect::<Vec<u16>>(),
        doc.plaintext_string().encode_utf16().count()
    );

    // real durable path
    let mut ts = fresh_store("min-dangling");
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
    .unwrap();
    let outcome = record_local_update(&mut ts.store, &key, &diff_q, &NoFaults, 1_001);
    eprintln!("record_local_update(diffQ): {outcome:?}");
    if let Ok(loaded) = load_persisted(&ts.store, &key) {
        if let Some(l) = loaded {
            eprintln!(
                "REAL DURABLE reconstructed: {:x?}",
                l.doc.plaintext_string().encode_utf16().collect::<Vec<u16>>()
            );
        }
    }
    eprintln!("yjs oracle for the same bytes: \"\" (item parked, missing client7 clock4)");
}
