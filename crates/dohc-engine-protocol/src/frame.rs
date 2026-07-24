//! Length-framed, codec-agnostic binary framing with a fuzz-friendly
//! incremental decoder: arbitrary input yields typed errors, never panics.
//!
//! Frame layout (all integers little-endian):
//!
//! ```text
//! [0..4)   magic     b"DOP1"
//! [4]      type      1 = Control, 2 = BlobChunk
//! [5]      flags     Control: must be 0.
//!                    BlobChunk: bit0 = FIN (final chunk); rest must be 0.
//! [6..8)   reserved  must be 0
//! [8..12)  len       payload byte length
//! [12..)   payload   Control: encoded envelope (JSON in protocol v1).
//!                    BlobChunk: stream_id u64 LE, then raw bytes.
//! ```
//!
//! The header is deliberately codec-agnostic: a future negotiated envelope
//! encoding (e.g. CBOR) changes only how Control payloads are produced and
//! consumed, not the framing. Blob bytes never pass through the envelope
//! codec at all — no base64, no re-encoding.

use crate::error::{FrameDecodeError, LimitKind, LimitViolation};
use crate::limits::{MAX_WIRE_INTEGER, WireLimits};

/// Frame header magic: "dohc protocol 1".
pub const FRAME_MAGIC: [u8; 4] = *b"DOP1";
/// Fixed header size in bytes.
pub const FRAME_HEADER_LEN: usize = 12;
/// Blob-chunk payload prefix size (stream id) in bytes.
pub const BLOB_STREAM_ID_LEN: usize = 8;

const FRAME_TYPE_CONTROL: u8 = 1;
const FRAME_TYPE_BLOB_CHUNK: u8 = 2;
const BLOB_FLAG_FIN: u8 = 0b0000_0001;

/// A decoded frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// An encoded envelope; decode further with [`crate::wire::decode_control`].
    Control(Vec<u8>),
    /// A raw chunk of a blob stream announced by a `blobStart` envelope.
    BlobChunk {
        stream_id: u64,
        /// True on the final chunk of the stream.
        fin: bool,
        bytes: Vec<u8>,
    },
}

/// Encode a control frame around an already-encoded envelope payload.
pub fn encode_control_frame(
    payload: &[u8],
    limits: &WireLimits,
) -> Result<Vec<u8>, LimitViolation> {
    if payload.len() as u64 > u64::from(limits.max_frame_bytes) {
        return Err(LimitViolation {
            limit: LimitKind::FrameBytes,
            field: "control frame payload",
            actual: payload.len() as u64,
            max: u64::from(limits.max_frame_bytes),
        });
    }
    let mut frame = Vec::with_capacity(FRAME_HEADER_LEN + payload.len());
    push_header(&mut frame, FRAME_TYPE_CONTROL, 0, payload.len() as u32);
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// Encode one blob-chunk frame. `bytes` is raw blob content (never base64).
pub fn encode_blob_chunk_frame(
    stream_id: u64,
    fin: bool,
    bytes: &[u8],
    limits: &WireLimits,
) -> Result<Vec<u8>, LimitViolation> {
    if stream_id > MAX_WIRE_INTEGER {
        return Err(LimitViolation {
            limit: LimitKind::IntegerRange,
            field: "blob chunk stream id",
            actual: stream_id,
            max: MAX_WIRE_INTEGER,
        });
    }
    if bytes.len() as u64 > u64::from(limits.max_blob_chunk_bytes) {
        return Err(LimitViolation {
            limit: LimitKind::BlobChunkBytes,
            field: "blob chunk bytes",
            actual: bytes.len() as u64,
            max: u64::from(limits.max_blob_chunk_bytes),
        });
    }
    let payload_len = (BLOB_STREAM_ID_LEN + bytes.len()) as u32;
    let flags = if fin { BLOB_FLAG_FIN } else { 0 };
    let mut frame = Vec::with_capacity(FRAME_HEADER_LEN + payload_len as usize);
    push_header(&mut frame, FRAME_TYPE_BLOB_CHUNK, flags, payload_len);
    frame.extend_from_slice(&stream_id.to_le_bytes());
    frame.extend_from_slice(bytes);
    Ok(frame)
}

/// Plan ordered chunks for one non-empty blob, marking exactly the final
/// chunk with FIN. Callers encode/write each item incrementally.
pub fn blob_chunks(bytes: &[u8], max_chunk_bytes: usize) -> impl Iterator<Item = (bool, &[u8])> {
    assert!(max_chunk_bytes > 0, "blob chunk limit must be positive");
    bytes
        .chunks(max_chunk_bytes)
        .enumerate()
        .map(move |(index, chunk)| {
            let fin = (index + 1) * max_chunk_bytes >= bytes.len();
            (fin, chunk)
        })
}

fn push_header(out: &mut Vec<u8>, frame_type: u8, flags: u8, payload_len: u32) {
    out.extend_from_slice(&FRAME_MAGIC);
    out.push(frame_type);
    out.push(flags);
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&payload_len.to_le_bytes());
}

/// Incremental frame decoder.
///
/// Feed arbitrary bytes with [`push`](Self::push), then drain frames with
/// [`next_frame`](Self::next_frame). Malformed input produces a typed error
/// and poisons the decoder: framing carries no resynchronization points, so
/// the only safe reaction is to tear the connection down. Size bounds are
/// checked from the header alone, before any payload is buffered.
#[derive(Debug)]
pub struct FrameDecoder {
    limits: WireLimits,
    buf: Vec<u8>,
    read: usize,
    poisoned: Option<FrameDecodeError>,
}

impl FrameDecoder {
    pub fn new(limits: WireLimits) -> Self {
        FrameDecoder {
            limits,
            buf: Vec::new(),
            read: 0,
            poisoned: None,
        }
    }

    /// Append received bytes. Ignored once the decoder is poisoned.
    pub fn push(&mut self, bytes: &[u8]) {
        if self.poisoned.is_none() {
            self.buf.extend_from_slice(bytes);
        }
    }

    /// Decode the next complete frame, if one is buffered.
    ///
    /// `Ok(None)` means "need more bytes". Any `Err` is fatal for the
    /// connection and is repeated on every subsequent call.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameDecodeError> {
        if let Some(error) = &self.poisoned {
            return Err(error.clone());
        }
        match self.decode_next() {
            Ok(frame) => Ok(frame),
            Err(error) => {
                self.poisoned = Some(error.clone());
                self.buf = Vec::new();
                self.read = 0;
                Err(error)
            }
        }
    }

    fn decode_next(&mut self) -> Result<Option<Frame>, FrameDecodeError> {
        let pending = &self.buf[self.read..];
        if pending.len() < FRAME_HEADER_LEN {
            return Ok(None);
        }
        let magic: [u8; 4] = pending[0..4]
            .try_into()
            .map_err(|_| FrameDecodeError::TruncatedHeader)?;
        if magic != FRAME_MAGIC {
            return Err(FrameDecodeError::BadMagic(magic));
        }
        let frame_type = pending[4];
        let flags = pending[5];
        if pending[6] != 0 || pending[7] != 0 {
            return Err(FrameDecodeError::NonZeroReserved);
        }
        let payload_len = u32::from_le_bytes(
            pending[8..12]
                .try_into()
                .map_err(|_| FrameDecodeError::TruncatedHeader)?,
        );

        // Validate everything derivable from the header before buffering the
        // payload, so an adversarial length can never force allocation.
        match frame_type {
            FRAME_TYPE_CONTROL => {
                if flags != 0 {
                    return Err(FrameDecodeError::UnsupportedFlags { frame_type, flags });
                }
                if u64::from(payload_len) > u64::from(self.limits.max_frame_bytes) {
                    return Err(FrameDecodeError::ControlFrameTooLarge {
                        len: payload_len,
                        max: self.limits.max_frame_bytes,
                    });
                }
            }
            FRAME_TYPE_BLOB_CHUNK => {
                if flags & !BLOB_FLAG_FIN != 0 {
                    return Err(FrameDecodeError::UnsupportedFlags { frame_type, flags });
                }
                if (payload_len as usize) < BLOB_STREAM_ID_LEN {
                    return Err(FrameDecodeError::BlobChunkMissingStreamId { len: payload_len });
                }
                let chunk_bytes = payload_len as u64 - BLOB_STREAM_ID_LEN as u64;
                if chunk_bytes > u64::from(self.limits.max_blob_chunk_bytes) {
                    return Err(FrameDecodeError::BlobChunkTooLarge {
                        len: payload_len,
                        max: self.limits.max_blob_chunk_bytes,
                    });
                }
            }
            other => return Err(FrameDecodeError::UnknownFrameType(other)),
        }

        let total = FRAME_HEADER_LEN + payload_len as usize;
        if pending.len() < total {
            return Ok(None);
        }
        let payload = pending[FRAME_HEADER_LEN..total].to_vec();
        self.read += total;
        self.compact();

        let frame = match frame_type {
            FRAME_TYPE_CONTROL => Frame::Control(payload),
            _ => {
                let stream_id = u64::from_le_bytes(
                    payload[0..BLOB_STREAM_ID_LEN]
                        .try_into()
                        .map_err(|_| FrameDecodeError::TruncatedHeader)?,
                );
                // Wire integers must stay JS-number safe; a stream id above
                // 2^53-1 could never match its announced blobStart.streamId.
                if stream_id > MAX_WIRE_INTEGER {
                    return Err(FrameDecodeError::BlobStreamIdTooLarge { stream_id });
                }
                Frame::BlobChunk {
                    stream_id,
                    fin: flags & BLOB_FLAG_FIN != 0,
                    bytes: payload[BLOB_STREAM_ID_LEN..].to_vec(),
                }
            }
        };
        Ok(Some(frame))
    }

    fn compact(&mut self) {
        // Reclaim consumed prefix once it dominates the buffer, keeping
        // amortized cost linear without copying on every frame.
        if self.read > 4096 && self.read * 2 > self.buf.len() {
            self.buf.drain(..self.read);
            self.read = 0;
        }
    }
}
