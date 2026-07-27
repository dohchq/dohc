//! REVIEW-ONLY: for named cases, show WHICH base update the gate rejects
//! (proving the divergent state is unreachable through the durable gate).

mod common;

use base64::Engine as _;
use dohc_engine_collab::{validate_replay_parity, Ydoc};

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

#[test]
fn show_base_gate_path() {
    let names: Vec<String> = std::env::var("DOHC_NAMES")
        .unwrap()
        .split(',')
        .map(String::from)
        .collect();
    let corpus: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(std::env::var("DOHC_FUZZ").unwrap()).unwrap())
            .unwrap();
    let arr = corpus.as_array().unwrap();
    for name in &names {
        let c = arr.iter().find(|x| x["name"] == name.as_str()).unwrap();
        let base: Vec<Vec<u8>> = c["base"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| b64(u.as_str().unwrap()))
            .collect();
        eprintln!("=== {name}  ({} base updates)", base.len());
        let acc = Ydoc::wire();
        let mut rejected_at = None;
        for (i, u) in base.iter().enumerate() {
            match validate_replay_parity(&acc, u) {
                Ok(()) => {
                    acc.apply(u).unwrap();
                    eprintln!(
                        "  base[{i}] ACCEPTED -> text now {:x?}",
                        acc.plaintext_string().encode_utf16().collect::<Vec<u16>>()
                    );
                }
                Err(e) => {
                    eprintln!("  base[{i}] REJECTED: {e}");
                    rejected_at = Some(i);
                    break;
                }
            }
        }
        eprintln!(
            "  => base reachable through gate: {}",
            rejected_at.is_none()
        );
    }
}
