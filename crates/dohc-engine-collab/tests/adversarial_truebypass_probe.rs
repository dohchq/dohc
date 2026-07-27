//! REVIEW-ONLY: classify fuzz accepted-divergent cases as TRUE gate bypasses.
//! A true bypass requires a legitimately-reachable, convergent base:
//!   (1) every base update passes the gate when journaled sequentially,
//!   (2) base-only yrs text == base-only yjs text (base converges),
//!   (3) base+candidate: yrs text != yjs text,
//!   (4) the gate ACCEPTS the candidate.
//! Emits the count and the first N true bypasses with full detail.

mod common;

use base64::Engine as _;
use dohc_engine_collab::{validate_replay_parity, Ydoc};
use serde_json::json;

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}
fn u16s(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn arr16(v: &serde_json::Value) -> Vec<u16> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_u64().unwrap() as u16)
        .collect()
}

#[test]
fn classify_true_bypasses() {
    let corpus: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("DOHC_FUZZ").expect("DOHC_FUZZ")).unwrap(),
    )
    .unwrap();
    let mut true_bypass = Vec::new();
    let mut base_diverged_skipped = 0usize;
    let mut base_gate_rejected_skipped = 0usize;
    let mut candidate_rejected = 0usize;
    let mut clean = 0usize;

    for c in corpus.as_array().unwrap() {
        let base: Vec<Vec<u8>> = c["base"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| b64(u.as_str().unwrap()))
            .collect();
        let cand = b64(c["candidate"].as_str().unwrap());
        let base_yjs = arr16(&c["baseYjsUnits"]);
        let full_yjs = arr16(&c["yjsUnits"]);

        // (1) sequential gate journaling of the base
        let acc = Ydoc::wire();
        let mut base_ok = true;
        for u in &base {
            if validate_replay_parity(&acc, u).is_err() {
                base_ok = false;
                break;
            }
            acc.apply(u).unwrap();
        }
        if !base_ok {
            base_gate_rejected_skipped += 1;
            continue;
        }
        // (2) base convergence
        let base_yrs = u16s(&acc.plaintext_string());
        if base_yrs != base_yjs {
            base_diverged_skipped += 1;
            continue;
        }
        // (4) candidate gate verdict
        let verdict = validate_replay_parity(&acc, &cand);
        // (3) full divergence
        let full_doc = Ydoc::wire();
        for u in &base {
            full_doc.apply(u).unwrap();
        }
        full_doc.apply(&cand).unwrap();
        let full_yrs = u16s(&full_doc.plaintext_string());
        let diverged = full_yrs != full_yjs;

        if verdict.is_ok() && diverged {
            true_bypass.push(json!({
                "name": c["name"],
                "baseYjs": base_yjs.iter().map(|u| format!("{u:x}")).collect::<Vec<_>>(),
                "yjs": full_yjs.iter().map(|u| format!("{u:x}")).collect::<Vec<_>>(),
                "yrs": full_yrs.iter().map(|u| format!("{u:x}")).collect::<Vec<_>>(),
            }));
        } else if !verdict.is_ok() {
            candidate_rejected += 1;
        } else {
            clean += 1;
        }
    }

    eprintln!("TRUE BYPASSES (convergent+gate-passing base, accepted+diverged candidate): {}", true_bypass.len());
    eprintln!("skipped: base-diverged={base_diverged_skipped} base-gate-rejected={base_gate_rejected_skipped}");
    eprintln!("candidate rejected(caught)={candidate_rejected} clean-accept={clean}");
    for b in true_bypass.iter().take(12) {
        eprintln!("  {}", serde_json::to_string(b).unwrap());
    }
    std::fs::write(
        std::env::var("DOHC_TRUEBYPASS_OUT").unwrap(),
        serde_json::to_string_pretty(&true_bypass).unwrap(),
    )
    .unwrap();
}
