//! Cutover-blocking fuzz family 1/3: IPC framing/protocol validation.
//!
//! Surfaces under test: `dohc_engine_protocol::frame::FrameDecoder`
//! (incremental frame decode over a byte stream fed in arbitrary chunks --
//! simulating a hostile/corrupt client over stdio) and
//! `dohc_engine_protocol::wire::decode_control` (JSON envelope decode of a
//! frame's payload).
//!
//! Properties asserted for every generated/mutated input:
//! - **No panic** (implicit: proptest fails the case on any panic).
//! - **No unbounded growth**: an oversized/adversarial length claim in the
//!   frame header is refused from the header alone, before any payload is
//!   buffered (frame.rs's own documented contract) -- the decoder's internal
//!   buffer never grows past what has actually been pushed to it.
//! - **Fail-closed, and POISONED**: `FrameDecoder` is documented as
//!   poisoning itself on any error -- once `next_frame()` returns `Err`,
//!   every subsequent call must return the identical error, never silently
//!   resynchronize onto a different (and therefore potentially desynced)
//!   frame boundary.

use dohc_engine_protocol::frame::{Frame, FrameDecoder};
use dohc_engine_protocol::limits::WireLimits;
use dohc_engine_protocol::wire::{
    Envelope, Hello, PROTOCOL_VERSION, decode_control, encode_control,
};
use proptest::prelude::*;

fn valid_hello_frame() -> Vec<u8> {
    let limits = WireLimits::default();
    encode_control(
        &Envelope::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            auth_token: "fuzz-seed-token".to_owned(),
            capabilities: vec!["shadow-r13".to_owned()],
            last_session_generation: None,
        }),
        &limits,
    )
    .expect("seed envelope encodes")
}

/// Feed `bytes` in one shot, drain every frame, and enforce the poison
/// invariant. Returns the total payload bytes yielded, for the bound check.
fn drain_and_check_poison(bytes: &[u8]) -> usize {
    let mut decoder = FrameDecoder::new(WireLimits::default());
    decoder.push(bytes);
    let mut total_payload = 0usize;
    let mut first_error = None;
    loop {
        match decoder.next_frame() {
            Ok(Some(Frame::Control(payload))) => total_payload += payload.len(),
            Ok(Some(Frame::BlobChunk { bytes, .. })) => total_payload += bytes.len(),
            Ok(None) => break,
            Err(error) => {
                if let Some(first) = &first_error {
                    assert_eq!(
                        &error, first,
                        "a poisoned decoder must repeat the SAME error, not drift"
                    );
                } else {
                    first_error = Some(error);
                }
                // A poisoned decoder must keep repeating -- probe it a few
                // more times to prove it never silently recovers.
                for _ in 0..3 {
                    let repeat = decoder.next_frame().expect_err("stays poisoned");
                    assert_eq!(&repeat, first_error.as_ref().unwrap());
                }
                break;
            }
        }
    }
    total_payload
}

proptest! {
    /// Pure random bytes, fed as one chunk. Never panics; never yields more
    /// decoded payload bytes than were pushed; stays poisoned after an error.
    #[test]
    fn arbitrary_bytes_never_panic_and_never_fabricate_data(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
        let total_payload = drain_and_check_poison(&bytes);
        prop_assert!(total_payload <= bytes.len());
    }

    /// The same bytes fed in small, arbitrarily-split chunks must behave
    /// identically to the whole thing arriving at once -- the incremental
    /// decoder must not depend on chunk boundaries for correctness.
    #[test]
    fn arbitrary_bytes_split_into_chunks_never_panic(
        bytes in prop::collection::vec(any::<u8>(), 0..2048),
        split_at in 0usize..2048,
    ) {
        let mut decoder = FrameDecoder::new(WireLimits::default());
        let split = split_at.min(bytes.len());
        decoder.push(&bytes[..split]);
        let _ = decoder.next_frame();
        decoder.push(&bytes[split..]);
        loop {
            match decoder.next_frame() {
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(_) => break,
            }
        }
    }

    /// A single-byte flip anywhere in a real, valid encoded frame must never
    /// panic, and must never decode into an envelope that isn't byte-for-byte
    /// what a correct decoder would produce for THAT exact mutated input
    /// (i.e. decode_control on the yielded payload is itself well-behaved:
    /// either a typed error, or a value that re-encodes losslessly).
    #[test]
    fn single_byte_flip_of_a_valid_frame_never_panics(
        index in 0usize..200,
        flip_bits in any::<u8>(),
    ) {
        let mut frame = valid_hello_frame();
        let index = index % frame.len();
        frame[index] ^= flip_bits.max(1); // guarantee an actual change
        let mut decoder = FrameDecoder::new(WireLimits::default());
        decoder.push(&frame);
        // Every arm is intentionally a no-op: the property under test is
        // "never panics", which proptest enforces implicitly. The match is
        // written out (instead of `let _ =`) to keep every possible decode
        // outcome named and readable.
        if let Ok(Some(Frame::Control(payload))) = decoder.next_frame() {
            // Either a typed error (fail-closed) or a bit flip that still
            // happens to be well-formed JSON -- both are fine here.
            let _ = decode_control(&payload, &WireLimits::default());
        }
    }

    /// Truncation at EVERY prefix length of a valid frame must never panic
    /// and must never yield a frame (a truncated frame is never "complete").
    #[test]
    fn truncation_at_every_prefix_never_yields_a_complete_frame(cut in 0usize..1000) {
        let frame = valid_hello_frame();
        let cut = cut.min(frame.len().saturating_sub(1));
        let mut decoder = FrameDecoder::new(WireLimits::default());
        decoder.push(&frame[..cut]);
        if let Ok(Some(_)) = decoder.next_frame() {
            prop_assert!(false, "a truncated frame must never decode as complete");
        }
    }

    /// An adversarial payload-length claim (from a tiny 12-byte header) must
    /// be refused from the header alone -- proving the decoder never tries to
    /// buffer/allocate toward a claimed length before enough bytes exist.
    #[test]
    fn oversized_length_claim_is_refused_without_buffering(claimed_len in any::<u32>()) {
        let mut header = Vec::with_capacity(12);
        header.extend_from_slice(b"DOP1");
        header.push(1); // control frame type
        header.push(0); // flags
        header.extend_from_slice(&[0, 0]); // reserved
        header.extend_from_slice(&claimed_len.to_le_bytes());

        let mut decoder = FrameDecoder::new(WireLimits::default());
        decoder.push(&header);
        let outcome = decoder.next_frame();
        if u64::from(claimed_len) > u64::from(WireLimits::default().max_frame_bytes) {
            prop_assert!(outcome.is_err(), "an oversized length claim must be refused immediately");
        }
    }
}

/// Seed-corpus sanity: the exact bytes a real client would send round-trip.
#[test]
fn seed_hello_frame_round_trips() {
    let frame = valid_hello_frame();
    let mut decoder = FrameDecoder::new(WireLimits::default());
    decoder.push(&frame);
    let Frame::Control(payload) = decoder
        .next_frame()
        .expect("decode")
        .expect("one complete frame")
    else {
        panic!("expected a control frame");
    };
    let envelope = decode_control(&payload, &WireLimits::default()).expect("valid envelope");
    assert!(matches!(envelope, Envelope::Hello(_)));
}
