//! Bound enforcement at limit-1 / limit / limit+1 for every wire bound:
//! frame bytes, blob chunk bytes, string bytes, collection length, batch
//! length, JSON depth, and integer range.

use dohc_engine_protocol::error::{FrameDecodeError, LimitKind};
use dohc_engine_protocol::frame::{
    FRAME_HEADER_LEN, FRAME_MAGIC, encode_blob_chunk_frame, encode_control_frame,
};
use dohc_engine_protocol::limits::MAX_WIRE_INTEGER;
use dohc_engine_protocol::wire::{Batch, Cancel, Request};
use dohc_engine_protocol::{Envelope, FrameDecoder, WireLimits};
use serde_json::{Value, json};

fn tiny_limits() -> WireLimits {
    WireLimits {
        max_frame_bytes: 64,
        max_blob_chunk_bytes: 16,
        max_string_bytes: 8,
        max_collection_len: 2,
        max_batch_len: 2,
        max_json_depth: 3,
    }
}

fn request_with(params: Value) -> Envelope {
    Envelope::Request(Request {
        id: 1,
        method: "m".to_string(),
        workspace: None,
        deadline_ms: None,
        idempotency_key: None,
        params,
    })
}

#[test]
fn control_frame_payload_boundary() {
    let limits = tiny_limits();
    for (len, ok) in [(63usize, true), (64, true), (65, false)] {
        let payload = vec![b'x'; len];
        let encoded = encode_control_frame(&payload, &limits);
        assert_eq!(encoded.is_ok(), ok, "encode len {len}");
    }

    // Decoder rejects an oversized header before any payload arrives.
    let mut header = Vec::new();
    header.extend_from_slice(&FRAME_MAGIC);
    header.extend_from_slice(&[1, 0, 0, 0]);
    header.extend_from_slice(&65u32.to_le_bytes());
    let mut decoder = FrameDecoder::new(limits);
    decoder.push(&header);
    assert_eq!(
        decoder.next_frame(),
        Err(FrameDecodeError::ControlFrameTooLarge { len: 65, max: 64 })
    );
}

#[test]
fn blob_chunk_boundary() {
    let limits = tiny_limits();
    for (len, ok) in [(15usize, true), (16, true), (17, false)] {
        let encoded = encode_blob_chunk_frame(9, false, &vec![0u8; len], &limits);
        assert_eq!(encoded.is_ok(), ok, "encode blob len {len}");
    }
    // At the limit the frame round-trips.
    let frame = encode_blob_chunk_frame(9, true, &[7u8; 16], &limits).expect("at limit");
    assert_eq!(frame.len(), FRAME_HEADER_LEN + 8 + 16);
    let mut decoder = FrameDecoder::new(tiny_limits());
    decoder.push(&frame);
    match decoder.next_frame() {
        Ok(Some(dohc_engine_protocol::Frame::BlobChunk {
            stream_id,
            fin,
            bytes,
        })) => {
            assert_eq!((stream_id, fin, bytes.len()), (9, true, 16));
        }
        other => panic!("expected blob chunk, got {other:?}"),
    }
}

#[test]
fn string_bytes_boundary() {
    let limits = tiny_limits();
    for (len, ok) in [(7usize, true), (8, true), (9, false)] {
        let envelope = Envelope::Request(Request {
            id: 1,
            method: "x".repeat(len),
            workspace: None,
            deadline_ms: None,
            idempotency_key: None,
            params: Value::Null,
        });
        let result = envelope.validate(&limits);
        assert_eq!(result.is_ok(), ok, "method len {len}");
        if let Err(violation) = result {
            assert_eq!(violation.limit, LimitKind::StringBytes);
        }
    }
}

#[test]
fn collection_len_boundary() {
    let limits = tiny_limits();
    for (len, ok) in [(1usize, true), (2, true), (3, false)] {
        let params = Value::Array(vec![Value::Bool(true); len]);
        let result = request_with(params).validate(&limits);
        assert_eq!(result.is_ok(), ok, "array len {len}");
        if let Err(violation) = result {
            assert_eq!(violation.limit, LimitKind::CollectionLen);
        }
    }
}

#[test]
fn batch_len_boundary_and_no_nesting() {
    let limits = tiny_limits();
    let cancel = Envelope::Cancel(Cancel { id: 1 });
    for (len, ok) in [(1usize, true), (2, true), (3, false)] {
        let batch = Envelope::Batch(Batch {
            envelopes: vec![cancel.clone(); len],
        });
        let result = batch.validate(&limits);
        assert_eq!(result.is_ok(), ok, "batch len {len}");
        if let Err(violation) = result {
            assert_eq!(violation.limit, LimitKind::BatchLen);
        }
    }
    let nested = Envelope::Batch(Batch {
        envelopes: vec![Envelope::Batch(Batch {
            envelopes: vec![cancel],
        })],
    });
    assert!(nested.validate(&limits).is_err(), "batches must not nest");
}

#[test]
fn json_depth_boundary() {
    let limits = tiny_limits();
    // nest(n) wraps null in n arrays; total depth = n + 1 (null counts).
    fn nest(n: usize) -> Value {
        let mut value = Value::Null;
        for _ in 0..n {
            value = Value::Array(vec![value]);
        }
        value
    }
    for (n, ok) in [(1usize, true), (2, true), (3, false)] {
        let result = request_with(nest(n)).validate(&limits);
        assert_eq!(result.is_ok(), ok, "nesting {n}");
        if let Err(violation) = result {
            assert_eq!(violation.limit, LimitKind::JsonDepth);
        }
    }
}

#[test]
fn wire_integer_boundary() {
    let limits = WireLimits::SPIKE_DEFAULTS;
    for (id, ok) in [
        (MAX_WIRE_INTEGER - 1, true),
        (MAX_WIRE_INTEGER, true),
        (MAX_WIRE_INTEGER + 1, false),
    ] {
        let envelope = Envelope::Cancel(Cancel { id });
        let result = envelope.validate(&limits);
        assert_eq!(result.is_ok(), ok, "id {id}");
        if let Err(violation) = result {
            assert_eq!(violation.limit, LimitKind::IntegerRange);
        }
    }
    // Integers inside params are bounded too.
    let over = request_with(json!({ "n": MAX_WIRE_INTEGER + 1 }));
    assert!(over.validate(&limits).is_err());
}
