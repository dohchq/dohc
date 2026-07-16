//! Wire-level bounds. Every frame, string, collection, batch, blob chunk,
//! and JSON tree on the wire is bounded; violations are typed errors.

use serde::{Deserialize, Serialize};

/// Largest integer representable exactly by a JavaScript `number`
/// (`Number.MAX_SAFE_INTEGER`). All wire integers (request ids, sequence
/// numbers, session generations, byte counts) are bounded by this so the
/// TypeScript side can use plain `number` without silent precision loss.
pub const MAX_WIRE_INTEGER: u64 = (1 << 53) - 1;

/// Bounds enforced by both encoder and decoder, and advertised to the client
/// in `helloAck` so both sides agree on what a well-formed peer may send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "bindings", ts(export))]
#[serde(rename_all = "camelCase")]
pub struct WireLimits {
    /// Maximum control-frame payload size in bytes (the encoded envelope).
    pub max_frame_bytes: u32,
    /// Maximum blob-chunk payload size in bytes (raw bytes, excluding the
    /// 8-byte stream-id prefix).
    pub max_blob_chunk_bytes: u32,
    /// Maximum size of any single string on the wire, in UTF-8 bytes.
    pub max_string_bytes: u32,
    /// Maximum length of any array or object on the wire.
    pub max_collection_len: u32,
    /// Maximum number of envelopes in one `batch` envelope.
    pub max_batch_len: u32,
    /// Maximum nesting depth of any JSON value on the wire.
    pub max_json_depth: u32,
}

impl WireLimits {
    /// Spike defaults. Real values are frozen with the protocol at Gate 0.
    pub const SPIKE_DEFAULTS: WireLimits = WireLimits {
        max_frame_bytes: 1024 * 1024,
        max_blob_chunk_bytes: 256 * 1024,
        max_string_bytes: 64 * 1024,
        max_collection_len: 16_384,
        max_batch_len: 64,
        max_json_depth: 32,
    };
}

impl Default for WireLimits {
    fn default() -> Self {
        Self::SPIKE_DEFAULTS
    }
}
