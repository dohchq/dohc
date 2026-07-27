//! REVIEW-ONLY minimal Skip-gap repro through base + candidate + real durable.

mod common;

use base64::Engine as _;
use common::*;
use dohc_engine_collab::{
    claim_base, ensure_marker, load_persisted, record_local_update, validate_replay_parity,
    apply_remote_update, ContentKind, Regime, RemoteUpdate, Ydoc,
};
use dohc_engine_storage::NoFaults;

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

#[test]
fn skip_gap_minimal() {
    let v: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("DOHC_MIN").unwrap()).unwrap(),
    )
    .unwrap();
    let base: Vec<Vec<u8>> = v["base"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| b64(u.as_str().unwrap()))
        .collect();
    let cand = b64(v["candidate"].as_str().unwrap());

    let gbase = Ydoc::wire();
    for u in &base {
        gbase.apply(u).unwrap();
    }
    eprintln!("gate(base, cand): {:?}", validate_replay_parity(&gbase, &cand));

    let doc = Ydoc::wire();
    for u in &base {
        doc.apply(u).unwrap();
    }
    doc.apply(&cand).unwrap();
    eprintln!(
        "yrs base+cand text: {:x?}",
        doc.plaintext_string().encode_utf16().collect::<Vec<u16>>()
    );

    // real durable via LOCAL path
    let mut ts = fresh_store("skipmin-local");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    ensure_marker(&mut ts.store, &key, ContentKind::Plaintext, Regime::LocalOnly, &NoFaults, 1_000).unwrap();
    for (i, u) in base.iter().enumerate() {
        record_local_update(&mut ts.store, &key, u, &NoFaults, 1_001 + i as i64).unwrap();
    }
    let out = record_local_update(&mut ts.store, &key, &cand, &NoFaults, 1_100);
    eprintln!("record_local_update(cand): {out:?}");
    let l = load_persisted(&ts.store, &key).unwrap().unwrap();
    eprintln!(
        "REAL DURABLE (local) text: {:x?}",
        l.doc.plaintext_string().encode_utf16().collect::<Vec<u16>>()
    );

    // real durable via REMOTE path (replicated)
    let mut ts2 = fresh_store("skipmin-remote");
    let key2 = test_key();
    seed_parents(&mut ts2.store, &key2, 1_000);
    claim_base(&mut ts2.store, &key2, ContentKind::Plaintext, &base[0], &NoFaults, 1_000).unwrap();
    for (i, u) in base.iter().enumerate().skip(1) {
        let r = RemoteUpdate { origin_id: "peer".into(), origin_seq: i as i64, bytes: u.clone() };
        apply_remote_update(&mut ts2.store, &key2, &r, &NoFaults, 1_010 + i as i64).unwrap();
    }
    let r = RemoteUpdate { origin_id: "peer".into(), origin_seq: 99, bytes: cand.clone() };
    let out2 = apply_remote_update(&mut ts2.store, &key2, &r, &NoFaults, 1_200);
    eprintln!("apply_remote_update(cand): {out2:?}");
    let l2 = load_persisted(&ts2.store, &key2).unwrap().unwrap();
    eprintln!(
        "REAL DURABLE (remote) text: {:x?}",
        l2.doc.plaintext_string().encode_utf16().collect::<Vec<u16>>()
    );

    eprintln!("yjs oracle base+cand: \"ab\" (item Q parked, missing client7 clock4)");
}
