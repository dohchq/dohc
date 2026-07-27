//! REVIEW-ONLY probe (not part of the PR): replay-parity gate differential
//! harness. Reads a yjs-generated corpus (DOHC_PARITY_CORPUS), runs the gate +
//! a yrs replay for each case, and writes verdicts + yrs UTF-16 units to
//! DOHC_PARITY_RESULTS for comparison against the yjs oracle.

mod common;

use base64::Engine as _;
use dohc_engine_collab::{validate_replay_parity, Ydoc};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Case {
    name: String,
    probe: String,
    base: Vec<String>,
    candidate: String,
    #[serde(rename = "yjsUnits")]
    yjs_units: Vec<u32>,
    expect: String,
}

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .expect("b64")
}

fn probe_units(doc: &Ydoc, probe: &str) -> Vec<u32> {
    let s: String = match probe {
        "plaintext" => doc.plaintext_string(),
        "body" => doc
            .body_paragraph_runs()
            .into_iter()
            .flatten()
            .map(|(t, _, _)| t)
            .collect(),
        "fmtext" => {
            let canon = doc.canonical_content();
            let delta = canon
                .pointer("/frontmatter/value/t/delta")
                .cloned()
                .unwrap_or(Value::Array(vec![]));
            delta
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|d| d.get("insert").and_then(|i| i.as_str()).map(String::from))
                .collect()
        }
        _ => panic!("bad probe"),
    };
    s.encode_utf16().map(u32::from).collect()
}

#[test]
fn adversarial_parity_differential() {
    let corpus_path = std::env::var("DOHC_PARITY_CORPUS").expect("DOHC_PARITY_CORPUS");
    let out_path = std::env::var("DOHC_PARITY_RESULTS").expect("DOHC_PARITY_RESULTS");
    let corpus: Vec<Case> =
        serde_json::from_str(&std::fs::read_to_string(&corpus_path).expect("read corpus"))
            .expect("parse corpus");

    let mut results = Vec::new();
    for case in &corpus {
        // Base lineage exactly as the durable layer reconstructs it.
        let base = Ydoc::wire();
        for u in &case.base {
            base.apply(&b64(u)).expect("base update must apply");
        }
        let candidate = b64(&case.candidate);
        let verdict = validate_replay_parity(&base, &candidate);
        let gate = match &verdict {
            Ok(()) => "accept".to_string(),
            Err(e) => format!("reject: {e}"),
        };
        // Independent yrs replay (what the durable doc would become if the
        // update were journaled): base + candidate on a fresh wire doc.
        let replay = Ydoc::wire();
        let mut replay_err = None;
        for u in &case.base {
            replay.apply(&b64(u)).expect("base update must apply");
        }
        if let Err(e) = replay.apply(&candidate) {
            replay_err = Some(e.to_string());
        }
        let yrs_units = probe_units(&replay, &case.probe);
        let diverged = yrs_units != case.yjs_units.clone();
        results.push(json!({
            "name": case.name,
            "expect": case.expect,
            "gate": gate,
            "gateAccepted": verdict.is_ok(),
            "yrsApplyError": replay_err,
            "yrsUnits": yrs_units,
            "yjsUnits": case.yjs_units,
            "diverged": diverged,
        }));
    }
    std::fs::write(&out_path, serde_json::to_string_pretty(&results).unwrap()).unwrap();
    // Summarize: any accepted+diverged case is a P0; print all rows.
    for r in &results {
        eprintln!(
            "{:36} expect={:8} gateAccepted={:5} diverged={:5} {}",
            r["name"].as_str().unwrap(),
            r["expect"].as_str().unwrap(),
            r["gateAccepted"],
            r["diverged"],
            r["yrsApplyError"].as_str().unwrap_or("")
        );
    }
}
