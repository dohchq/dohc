//! REVIEW-ONLY probe: after the accepted overlap-slice divergence, does the
//! durable doc WEDGE — rejecting every subsequent valid edit from peers whose
//! clock advanced past the discarded unit?

mod common;

use common::*;
use dohc_engine_collab::{validate_replay_parity, Ydoc};

#[test]
fn post_overlap_wedge() {
    let path = std::env::var("DOHC_WEDGE").expect("DOHC_WEDGE");
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse");
    let u1 = decode_b64(v["U1"].as_str().unwrap());
    let u2 = decode_b64(v["U2"].as_str().unwrap());
    let u3 = decode_b64(v["U3"].as_str().unwrap());

    let base = Ydoc::wire();
    base.apply(&u1).unwrap();
    eprintln!("gate(U2): {:?}", validate_replay_parity(&base, &u2));
    base.apply(&u2).unwrap();
    // The peer's next ORDINARY edit ("Z" appended after the pair):
    eprintln!("gate(U3): {:?}", validate_replay_parity(&base, &u3));
    let replay = Ydoc::wire();
    replay.apply(&u1).unwrap();
    replay.apply(&u2).unwrap();
    replay.apply(&u3).unwrap();
    eprintln!(
        "yrs text after U3: {:x?}  (yjs oracle [61, fffd, fffd, 5a])",
        replay.plaintext_string().encode_utf16().collect::<Vec<u16>>()
    );
    eprintln!("yrs sv after U3: {:x?}", replay.encode_state_vector());
}
