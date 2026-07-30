//! dohc engine protocol — R03 spike crate.
//!
//! This crate is the dormant seed of `dohc-engine-protocol` from the rewrite
//! plan's crate graph: wire types, error taxonomy, bounds, a minimal framed
//! codec with fuzz-friendly parsing, and the transport seams (including the
//! in-process direct-call transport required by portability guardrail 3).
//!
//! Design summary (full rationale in
//! `docs/superpowers/plans/rust-engine/ENGINE_PROTOCOL.md`):
//!
//! - **Envelope encoding**: length-framed JSON control frames. The frame
//!   header is codec-agnostic; a future CBOR envelope encoding can be
//!   negotiated via `hello` capabilities without redesigning the framing.
//! - **Blobs**: never base64. Blob payloads ride dedicated binary chunk
//!   frames (`FrameType::BlobChunk`) announced by a `blobStart` envelope.
//! - **Bounds**: every frame, string, collection, batch, blob chunk, and
//!   JSON tree is bounded by [`limits::WireLimits`]; violations are typed
//!   errors, enforced by both encoder and decoder.
//! - **No panics on malformed input**: [`frame::FrameDecoder`] and
//!   [`wire::decode_control`] return typed errors for arbitrary input. This
//!   is the future fuzz target.
//! - **Transports**: [`transport::EngineTransport`] is implemented both by a
//!   framed IPC client (future) and by [`transport::InProcessTransport`],
//!   which passes typed structs to the service directly — same-process
//!   callers never serialize.
//! - **Supervision**: [`supervisor::Supervisor`] (feature `supervisor`) is a
//!   tokio-based bounded dispatch skeleton — bounded queue + bounded
//!   in-flight concurrency, deadlines, cooperative cancellation, and typed
//!   `OVERLOADED` backpressure errors — replacing the retired accelerator
//!   spike's thread-per-request model.
//!
//! The crate is standalone (no repo-level Cargo workspace yet; R02 owns
//! that) and is not reachable from any product code path.

#![forbid(unsafe_code)]

pub mod cancel;
pub mod error;
pub mod frame;
pub mod limits;
#[cfg(feature = "supervisor")]
pub mod supervisor;
pub mod transport;
pub mod wire;

pub use error::{ErrorCode, FrameDecodeError, Retryability, WireError};
pub use frame::{Frame, FrameDecoder};
pub use limits::{MAX_WIRE_INTEGER, WireLimits};
pub use wire::{Envelope, PROTOCOL_VERSION, Request, Response};
