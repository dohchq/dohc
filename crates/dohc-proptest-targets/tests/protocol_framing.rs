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

use dohc_engine_protocol::error::FrameDecodeError;
use dohc_engine_protocol::frame::{
    Frame, FrameDecoder, encode_blob_chunk_frame, encode_control_frame,
};
use dohc_engine_protocol::limits::WireLimits;
use dohc_engine_protocol::wire::{
    Cancel, Envelope, Hello, PROTOCOL_VERSION, decode_control, encode_control,
};
use proptest::prelude::*;

fn valid_hello_frame() -> Vec<u8> {
    let limits = WireLimits::default();
    encode_control(
        &Envelope::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            auth_token: "fuzz-seed-token".to_owned(),
            capabilities: vec!["blobs".to_owned()],
            last_session_generation: None,
            max_frame_bytes: None,
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

/// Ignore transient "need more bytes" results, retaining all frames and the
/// first terminal error. Later pushes must not recover a poisoned decoder.
fn decode_schedule(
    chunks: impl IntoIterator<Item = impl AsRef<[u8]>>,
) -> (Vec<Frame>, Option<FrameDecodeError>) {
    let mut decoder = FrameDecoder::new(WireLimits::default());
    let mut frames = Vec::new();
    let mut terminal = None;
    for chunk in chunks {
        decoder.push(chunk.as_ref());
        if let Some(error) = &terminal {
            assert_eq!(
                &decoder.next_frame().expect_err("stays poisoned after push"),
                error
            );
            continue;
        }
        loop {
            match decoder.next_frame() {
                Ok(Some(frame)) => frames.push(frame),
                Ok(None) => break,
                Err(error) => {
                    for _ in 0..3 {
                        assert_eq!(decoder.next_frame().expect_err("stays poisoned"), error);
                    }
                    terminal = Some(error);
                    break;
                }
            }
        }
    }
    (frames, terminal)
}

fn schedule_chunks<'a>(bytes: &'a [u8], widths: &[usize]) -> Vec<&'a [u8]> {
    let mut chunks = Vec::new();
    let mut start = 0usize;
    for width in widths {
        let end = start.saturating_add(*width).min(bytes.len());
        chunks.push(&bytes[start..end]);
        start = end;
    }
    chunks.push(&bytes[start..]);
    chunks
}

fn valid_frames() -> impl Strategy<Value = Vec<Frame>> {
    prop::collection::vec(
        prop_oneof![
            prop::collection::vec(any::<u8>(), 0..128).prop_map(Frame::Control),
            (
                0u64..1000,
                any::<bool>(),
                prop::collection::vec(any::<u8>(), 0..128)
            )
                .prop_map(|(stream_id, fin, bytes)| Frame::BlobChunk {
                    stream_id,
                    fin,
                    bytes
                }),
        ],
        1..8,
    )
}

fn encode_frames(frames: &[Frame]) -> Vec<u8> {
    let limits = WireLimits::default();
    frames
        .iter()
        .flat_map(|frame| match frame {
            Frame::Control(payload) => encode_control_frame(payload, &limits).unwrap(),
            Frame::BlobChunk {
                stream_id,
                fin,
                bytes,
            } => encode_blob_chunk_frame(*stream_id, *fin, bytes, &limits).unwrap(),
        })
        .collect()
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
    fn arbitrary_bytes_have_equivalent_chunk_schedules(
        bytes in prop::collection::vec(any::<u8>(), 0..2048),
        widths in prop::collection::vec(0usize..256, 0..32),
    ) {
        prop_assert_eq!(decode_schedule(schedule_chunks(&bytes, &widths)), decode_schedule([&bytes]));
    }

    #[test]
    fn valid_streams_preserve_every_frame_across_chunk_schedules(
        frames in valid_frames(),
        widths in prop::collection::vec(0usize..128, 0..64),
        tail in 0u8..3,
    ) {
        let mut bytes = encode_frames(&frames);
        let expected_error = match tail {
            0 => None,
            1 => {
                bytes.extend_from_slice(b"BAD!\x01\0\0\0\0\0\0\0");
                Some(FrameDecodeError::BadMagic(*b"BAD!"))
            }
            _ => {
                // A valid but unfinished next frame is not an error.
                let partial = encode_control_frame(b"unfinished", &WireLimits::default()).unwrap();
                bytes.extend_from_slice(&partial[..partial.len() - 1]);
                None
            }
        };
        let expected = (frames, expected_error);
        prop_assert_eq!(decode_schedule([&bytes]), expected.clone());
        prop_assert_eq!(decode_schedule(schedule_chunks(&bytes, &widths)), expected);
    }

    /// A single-byte flip anywhere in a real, valid encoded frame must never
    /// panic. When the mutated frame still yields a decodable control
    /// envelope, that envelope must be a COMPLETE, self-consistent value: its
    /// JSON re-encoding decodes back to an equal envelope (no partially-
    /// populated / lossy decode from adversarial-but-parseable input).
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
        if let Ok(Some(Frame::Control(payload))) = decoder.next_frame() {
            // Either a typed error (fail-closed) or a bit flip that still
            // happens to be well-formed -- if it decoded, prove the value is
            // complete by round-tripping it through its own JSON encoding.
            if let Ok(envelope) = decode_control(&payload, &WireLimits::default()) {
                let reencoded =
                    serde_json::to_vec(&envelope).expect("a decoded envelope re-serializes");
                let roundtrip = decode_control(&reencoded, &WireLimits::default())
                    .expect("re-decode of a self-produced encoding");
                prop_assert_eq!(
                    envelope,
                    roundtrip,
                    "a decoded envelope must round-trip losslessly"
                );
            }
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

    /// An over-limit payload-length claim in a tiny 12-byte header (with NO
    /// payload bytes following) must be rejected immediately with an `Err`,
    /// decided from the header alone rather than waiting for the claimed bytes
    /// to arrive. (This asserts header-driven rejection; it does not directly
    /// measure the decoder's internal buffer size, which is private.)
    #[test]
    fn oversized_length_claim_is_refused_from_the_header(claimed_len in any::<u32>()) {
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

#[test]
fn every_split_preserves_frames_and_terminal_error() {
    let frames = vec![
        Frame::Control(b"first".to_vec()),
        Frame::BlobChunk {
            stream_id: 7,
            fin: false,
            bytes: vec![0, 255, 3],
        },
        Frame::BlobChunk {
            stream_id: 7,
            fin: true,
            bytes: Vec::new(),
        },
        Frame::Control(b"last".to_vec()),
    ];
    for malformed_tail in [false, true] {
        let mut bytes = encode_frames(&frames);
        let terminal = if malformed_tail {
            bytes.extend_from_slice(b"BAD!\x01\0\0\0\0\0\0\0");
            // A valid frame after the error must never resynchronize.
            bytes.extend(encode_frames(&frames[..1]));
            Some(FrameDecodeError::BadMagic(*b"BAD!"))
        } else {
            None
        };
        let expected = (frames.clone(), terminal);
        assert_eq!(decode_schedule([&bytes]), expected);
        assert_eq!(decode_schedule(bytes.chunks(1)), expected);
        for split in 0..=bytes.len() {
            assert_eq!(
                decode_schedule([&bytes[..split], &bytes[split..]]),
                expected,
                "split {split}, malformed tail {malformed_tail}"
            );
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

/// A prefix of a valid multi-frame stream is incomplete, never an error: the
/// decoder must wait for the rest, not refuse a partial read. The proptest
/// above only proves a prefix is never *complete*; this proves it is never
/// *refused*, over a control frame followed by a blob chunk.
#[test]
fn every_prefix_of_a_valid_stream_is_incomplete_not_an_error() {
    let limits = WireLimits::default();
    let envelope = Envelope::Cancel(Cancel { id: 5 });
    let mut buffer = encode_control(&envelope, &limits).expect("encodes");
    buffer.extend(
        dohc_engine_protocol::frame::encode_blob_chunk_frame(3, true, b"blob-bytes", &limits)
            .expect("encodes"),
    );
    for cut in 0..buffer.len() {
        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(&buffer[..cut]);
        loop {
            match decoder.next_frame() {
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(error) => panic!("prefix of a valid stream errored at cut {cut}: {error}"),
            }
        }
    }
    let mut decoder = FrameDecoder::new(limits);
    decoder.push(&buffer);
    assert!(matches!(decoder.next_frame(), Ok(Some(Frame::Control(_)))));
    assert!(matches!(
        decoder.next_frame(),
        Ok(Some(Frame::BlobChunk { fin: true, .. }))
    ));
    assert!(matches!(decoder.next_frame(), Ok(None)));
}

/// Structurally valid JSON that is not a valid envelope, and pathologically
/// deep JSON, both decode to a typed error rather than a panic or a stack
/// overflow.
#[test]
fn hostile_envelope_payloads_yield_typed_errors() {
    let limits = WireLimits::default();
    for payload in [
        &b"{}"[..],
        br#"{"type":"nope"}"#,
        br#"{"type":"cancel"}"#,
        br#"{"type":"cancel","id":"not-a-number"}"#,
        br#"[1,2,3]"#,
        br#"null"#,
    ] {
        assert!(
            decode_control(payload, &limits).is_err(),
            "{payload:?} must be refused"
        );
    }
    let mut deep = String::new();
    deep.push_str(&"[".repeat(4000));
    deep.push_str(&"]".repeat(4000));
    assert!(decode_control(deep.as_bytes(), &limits).is_err());
    assert!(decode_control(br#"{"type":"cancel","id":5}"#, &limits).is_ok());
}
