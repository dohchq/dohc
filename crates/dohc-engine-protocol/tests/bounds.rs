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

#[test]
fn blob_stream_id_boundary_on_encode_and_decode() {
    let limits = WireLimits::SPIKE_DEFAULTS;
    for (stream_id, ok) in [
        (MAX_WIRE_INTEGER - 1, true),
        (MAX_WIRE_INTEGER, true),
        (MAX_WIRE_INTEGER + 1, false),
    ] {
        let encoded = encode_blob_chunk_frame(stream_id, true, b"x", &limits);
        assert_eq!(encoded.is_ok(), ok, "encode stream id {stream_id}");
        if let Err(violation) = encoded {
            assert_eq!(violation.limit, LimitKind::IntegerRange);
        }

        // Decoder side: craft the frame bytes directly so out-of-range ids
        // (which the encoder now refuses) are still exercised.
        let mut frame = Vec::new();
        frame.extend_from_slice(&FRAME_MAGIC);
        frame.extend_from_slice(&[2, 1, 0, 0]);
        frame.extend_from_slice(&9u32.to_le_bytes()); // stream id + 1 byte
        frame.extend_from_slice(&stream_id.to_le_bytes());
        frame.push(b'x');
        let mut decoder = FrameDecoder::new(limits.clone());
        decoder.push(&frame);
        let result = decoder.next_frame();
        if ok {
            assert!(
                matches!(
                    result,
                    Ok(Some(dohc_engine_protocol::Frame::BlobChunk { .. }))
                ),
                "decode stream id {stream_id}: {result:?}"
            );
        } else {
            assert_eq!(
                result,
                Err(FrameDecodeError::BlobStreamIdTooLarge { stream_id }),
                "decode stream id {stream_id}"
            );
        }
    }
}

#[test]
fn float_form_integers_respect_wire_integer_bound() {
    let limits = WireLimits::SPIKE_DEFAULTS;
    // Integer-valued floats beyond 2^53-1 are rejected, matching the TS
    // walker's Number.isInteger check.
    for params in [json!({ "n": 1e20 }), json!({ "n": -1e20 }), json!(1e100)] {
        let violation = request_with(params)
            .validate(&limits)
            .expect_err("oversized float-form integer must be rejected");
        assert_eq!(violation.limit, LimitKind::IntegerRange);
    }
    // Non-integer floats and in-range integer-valued floats pass.
    for params in [json!(0.5), json!(-2.25), json!(9007199254740991.0_f64)] {
        assert!(request_with(params).validate(&limits).is_ok());
    }
}

#[test]
fn encode_control_refuses_aggregate_payload_beyond_frame_bound() {
    // Each string is within max_string_bytes and the array is within
    // max_collection_len, but the serialized payload exceeds
    // max_frame_bytes: the bounded writer must refuse mid-serialization.
    let limits = WireLimits {
        max_frame_bytes: 128,
        max_blob_chunk_bytes: 16,
        max_string_bytes: 100,
        max_collection_len: 4,
        max_batch_len: 2,
        max_json_depth: 8,
    };
    let envelope = request_with(json!(["y".repeat(100), "y".repeat(100)]));
    let error = dohc_engine_protocol::wire::encode_control(&envelope, &limits)
        .expect_err("aggregate oversize must be refused");
    match error {
        dohc_engine_protocol::error::EnvelopeDecodeError::Limit(violation) => {
            assert_eq!(violation.limit, LimitKind::FrameBytes);
            assert!(violation.actual > violation.max);
        }
        other => panic!("expected frame-bytes violation, got {other:?}"),
    }
    // A small envelope under the same limits still encodes.
    let small = request_with(json!("ok"));
    assert!(dohc_engine_protocol::wire::encode_control(&small, &limits).is_ok());
}

#[test]
fn omitted_nullable_fields_decode_as_none() {
    let limits = WireLimits::SPIKE_DEFAULTS;
    let decoded = dohc_engine_protocol::wire::decode_control(
        br#"{"type":"request","id":1,"method":"m","params":null}"#,
        &limits,
    )
    .expect("omitted nullable fields are accepted");
    let Envelope::Request(request) = decoded else {
        panic!("expected request envelope");
    };
    assert_eq!(request.workspace, None);
    assert_eq!(request.deadline_ms, None);
    assert_eq!(request.idempotency_key, None);
}
