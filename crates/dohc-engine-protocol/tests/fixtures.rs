//! Deterministic fixture round-trip: the same fixtures file is consumed by
//! the TypeScript suite (`ts/roundtrip.test.mts`). Each entry must decode
//! into the typed envelope, validate within spike bounds, re-encode to the
//! committed canonical JSON, and survive a full frame round-trip.

use dohc_engine_protocol::wire::{decode_control, encode_control};
use dohc_engine_protocol::{Envelope, Frame, FrameDecoder, WireLimits};
use serde_json::Value;
use std::path::Path;

fn canonicalize(value: &Value) -> String {
    // serde_json's default object representation is key-sorted, so a
    // Value -> String pass is canonical (compact, sorted keys).
    let reparsed: Value = serde_json::from_str(&value.to_string()).expect("valid JSON");
    reparsed.to_string()
}

#[test]
fn fixture_entries_round_trip_typed_canonical_and_framed() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/envelopes.json");
    let document: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixtures readable"))
            .expect("fixtures parse");
    let limits = WireLimits::SPIKE_DEFAULTS;
    let entries = document["entries"].as_array().expect("entries array");
    assert!(entries.len() >= 8, "fixture corpus unexpectedly small");

    for entry in entries {
        let name = entry["name"].as_str().expect("entry name");
        let raw = &entry["envelope"];
        let committed = entry["canonicalJson"].as_str().expect("canonicalJson");
        assert!(
            !committed.is_empty(),
            "fixture {name}: canonicalJson not generated; run cargo run --example update_fixtures"
        );

        // Typed decode + validation.
        let envelope: Envelope = serde_json::from_value(raw.clone())
            .unwrap_or_else(|error| panic!("fixture {name} failed typed decode: {error}"));
        envelope
            .validate(&limits)
            .unwrap_or_else(|violation| panic!("fixture {name} violates bounds: {violation}"));

        // Typed re-encode matches the committed canonical form, and the raw
        // fixture text canonicalizes to the same string (no drift between
        // the human-authored value and the typed value).
        let typed_value = serde_json::to_value(&envelope).expect("serializes");
        assert_eq!(
            typed_value.to_string(),
            committed,
            "fixture {name}: typed canonical encoding drifted"
        );
        assert_eq!(
            canonicalize(raw),
            committed,
            "fixture {name}: raw fixture value drifted from canonical form"
        );

        // Full frame round-trip.
        let frame_bytes = encode_control(&envelope, &limits)
            .unwrap_or_else(|error| panic!("fixture {name} failed to frame: {error}"));
        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(&frame_bytes);
        let frame = decoder
            .next_frame()
            .expect("frame decodes")
            .expect("frame complete");
        let Frame::Control(payload) = frame else {
            panic!("fixture {name}: expected control frame");
        };
        let decoded = decode_control(&payload, &limits)
            .unwrap_or_else(|error| panic!("fixture {name} failed decode_control: {error}"));
        assert_eq!(
            decoded, envelope,
            "fixture {name}: frame round-trip drifted"
        );
    }
}
