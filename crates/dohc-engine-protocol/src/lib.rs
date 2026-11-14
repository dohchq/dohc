//! dohc engine protocol: the wire contract between the daemon and its clients.
//!
//! Wire types, error taxonomy, bounds, a framed codec with fuzz-friendly
//! parsing, and the transport seams (including the in-process direct-call
//! transport).
//!
//! Design summary:
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
//!   [`wire::decode_control`] return typed errors for arbitrary input.
//! - **Transports**: [`transport::EngineTransport`] is the client-side trait.
//!   [`transport::InProcessTransport`] implements it and passes typed structs
//!   to the service directly, so same-process callers never serialize. The
//!   framed IPC client is TypeScript (`EngineClient` in
//!   `packages/workspace-engine-client`), so it does not implement this trait.
//! - **Supervision**: [`supervisor::Supervisor`] (feature `supervisor`) is a
//!   tokio-based bounded dispatch skeleton: bounded queue + bounded
//!   in-flight concurrency, deadlines, cooperative cancellation, and typed
//!   `OVERLOADED` backpressure errors.

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
