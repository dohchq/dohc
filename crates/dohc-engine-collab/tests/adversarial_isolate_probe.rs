//! REVIEW-ONLY: isolate specific fuzz cases; dump yrs SV + text vs yjs oracle
//! and the gate verdict, to classify accepted-divergent cases as either a
//! content-divergence-with-matching-clocks bypass or a coverage-check hole.

mod common;

use base64::Engine as _;
use dohc_engine_collab::{validate_replay_parity, Ydoc};

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}
fn u16s(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

#[test]
fn isolate_named_cases() {
    let names: Vec<String> = std::env::var("DOHC_NAMES")
        .expect("DOHC_NAMES")
        .split(',')
        .map(String::from)
        .collect();
    let corpus: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("DOHC_FUZZ").expect("DOHC_FUZZ")).unwrap(),
    )
    .unwrap();
    let arr = corpus.as_array().unwrap();
    for name in &names {
        let c = arr.iter().find(|x| x["name"] == name.as_str()).expect("case");
        let base: Vec<Vec<u8>> = c["base"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| b64(u.as_str().unwrap()))
            .collect();
        let cand = b64(c["candidate"].as_str().unwrap());
        let yjs: Vec<u16> = c["yjsUnits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect();

        // gate's own base doc + verdict
        let gate_base = Ydoc::wire();
        for u in &base {
            gate_base.apply(u).unwrap();
        }
        let verdict = validate_replay_parity(&gate_base, &cand);

        // independent replay
        let doc = Ydoc::wire();
        for u in &base {
            doc.apply(u).unwrap();
        }
        let sv_before = doc.encode_state_vector();
        doc.apply(&cand).unwrap();
        let sv_after = doc.encode_state_vector();
        let yrs = u16s(&doc.plaintext_string());

        eprintln!("=== {name}");
        eprintln!("  gate: {verdict:?}");
        eprintln!("  yjs units: {:x?}", yjs);
        eprintln!("  yrs units: {:x?}", yrs);
        eprintln!("  diverged: {}", yrs != yjs);
        eprintln!("  yrs sv before: {:x?}  after: {:x?}", sv_before, sv_after);
    }
}
