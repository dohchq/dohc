//! Fuzz-friendliness smoke tests: the frame decoder and envelope decoder
//! must return typed errors (never panic, never allocate unboundedly) for
//! arbitrary, truncated, or mutated input. A real cargo-fuzz target with
//! these properties becomes cutover-blocking later; this is the seed corpus
//! logic.

use dohc_engine_protocol::wire::decode_control;
use dohc_engine_protocol::{Envelope, Frame, FrameDecoder, WireLimits};

/// Deterministic 64-bit LCG (no rand dependency, reproducible corpus).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }

    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| (self.next() >> 33) as u8).collect()
    }
}

fn valid_frames() -> Vec<u8> {
    let limits = WireLimits::SPIKE_DEFAULTS;
    let envelope: Envelope = serde_json::from_value(serde_json::json!({
        "type": "cancel",
        "id": 5
    }))
    .expect("valid envelope");
    let mut buffer =
        dohc_engine_protocol::wire::encode_control(&envelope, &limits).expect("encodes");
    buffer.extend(
        dohc_engine_protocol::frame::encode_blob_chunk_frame(3, true, b"blob-bytes", &limits)
            .expect("encodes"),
    );
    buffer
}

#[test]
fn random_garbage_never_panics_and_poisons_deterministically() {
    let mut rng = Lcg(0xD0C_5EED);
    for round in 0..500 {
        let mut decoder = FrameDecoder::new(WireLimits::SPIKE_DEFAULTS);
        let mut first_error = None;
        for _ in 0..8 {
            let chunk_len = (rng.next() % 64) as usize;
            decoder.push(&rng.bytes(chunk_len));
            loop {
                match decoder.next_frame() {
                    Ok(Some(_)) => continue,
                    Ok(None) => break,
                    Err(error) => {
                        first_error.get_or_insert(error.clone());
                        // Poisoned: the same typed error repeats forever.
                        assert_eq!(decoder.next_frame(), Err(error), "round {round}");
                        break;
                    }
                }
            }
        }
    }
}

#[test]
fn every_truncation_of_valid_frames_is_incomplete_not_an_error() {
    let buffer = valid_frames();
    for cut in 0..buffer.len() {
        let mut decoder = FrameDecoder::new(WireLimits::SPIKE_DEFAULTS);
        decoder.push(&buffer[..cut]);
        loop {
            match decoder.next_frame() {
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(error) => panic!("prefix of valid stream errored at cut {cut}: {error}"),
            }
        }
    }
    // And the full buffer yields exactly the two frames.
    let mut decoder = FrameDecoder::new(WireLimits::SPIKE_DEFAULTS);
    decoder.push(&buffer);
    assert!(matches!(decoder.next_frame(), Ok(Some(Frame::Control(_)))));
    assert!(matches!(
        decoder.next_frame(),
        Ok(Some(Frame::BlobChunk { fin: true, .. }))
    ));
    assert!(matches!(decoder.next_frame(), Ok(None)));
}

#[test]
fn header_byte_mutations_never_panic() {
    let buffer = valid_frames();
    for position in 0..dohc_engine_protocol::frame::FRAME_HEADER_LEN {
        for mutation in [0x00u8, 0x01, 0x7F, 0xFF] {
            let mut mutated = buffer.clone();
            mutated[position] ^= mutation;
            let mut decoder = FrameDecoder::new(WireLimits::SPIKE_DEFAULTS);
            decoder.push(&mutated);
            // Drain until quiescent; outcomes may be frames, incompleteness,
            // or a typed error — anything but a panic.
            while let Ok(Some(_frame)) = decoder.next_frame() {}
        }
    }
}

#[test]
fn envelope_decoding_of_hostile_payloads_yields_typed_errors() {
    let limits = WireLimits::SPIKE_DEFAULTS;
    let mut rng = Lcg(0xBADC0DE);
    for _ in 0..500 {
        let junk_len = (rng.next() % 512) as usize;
        let junk = rng.bytes(junk_len);
        let _ = decode_control(&junk, &limits);
    }
    // Structurally valid JSON, invalid envelopes.
    for payload in [
        &b"{}"[..],
        br#"{"type":"nope"}"#,
        br#"{"type":"cancel"}"#,
        br#"{"type":"cancel","id":"not-a-number"}"#,
        br#"[1,2,3]"#,
        br#"null"#,
    ] {
        assert!(decode_control(payload, &limits).is_err());
    }
    // Pathologically deep JSON must be a typed error, not a stack overflow.
    let mut deep = String::new();
    deep.push_str(&"[".repeat(4000));
    deep.push_str(&"]".repeat(4000));
    assert!(decode_control(deep.as_bytes(), &limits).is_err());
    // A valid cancel decodes and validates.
    assert!(decode_control(br#"{"type":"cancel","id":5}"#, &limits).is_ok());
}
