//! REVIEW-ONLY: stateful inductive differential. For each sequence, feed every
//! update through the gate; apply to the yrs doc ONLY when the gate accepts.
//! Record the accepted mask + final yrs text. Node then replays the exact
//! accepted subset into a fresh yjs doc and compares — divergence from a
//! gate-sanctioned lineage is a TRUE bypass.

mod common;

use base64::Engine as _;
use dohc_engine_collab::{validate_replay_parity, Ydoc};
use serde_json::json;

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

#[test]
fn drive_sequences_through_gate() {
    let seqs: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("DOHC_SEQS").unwrap()).unwrap(),
    )
    .unwrap();
    let mut out = Vec::new();
    let mut total_accepted = 0u64;
    let mut total_rejected = 0u64;
    for s in seqs.as_array().unwrap() {
        let seed = s["seed"].as_i64().unwrap();
        let updates: Vec<Vec<u8>> = s["updates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| b64(u.as_str().unwrap()))
            .collect();
        let doc = Ydoc::wire();
        let mut mask = Vec::with_capacity(updates.len());
        for u in &updates {
            let accepted = validate_replay_parity(&doc, u).is_ok();
            if accepted {
                // record_local_update also re-decodes+applies; mirror that.
                doc.apply(u).unwrap();
                total_accepted += 1;
            } else {
                total_rejected += 1;
            }
            mask.push(accepted);
        }
        let yrs_units: Vec<u16> = doc.plaintext_string().encode_utf16().collect();
        out.push(json!({
            "seed": seed,
            "mask": mask,
            "yrsUnits": yrs_units,
        }));
    }
    eprintln!("accepted={total_accepted} rejected={total_rejected}");
    std::fs::write(
        std::env::var("DOHC_SEQ_OUT").unwrap(),
        serde_json::to_string(&out).unwrap(),
    )
    .unwrap();
}
