//! Emit the language-neutral schema artifacts consumed by TypeScript:
//!
//! - `generated/engine-protocol.schema.json` — JSON Schema for the envelope
//!   union (runtime validation on the TS side; ajv-compatible).
//! - `generated/limits.json` — protocol version, wire-integer bound, and the
//!   spike default limits, so the TS bounds walker enforces the same numbers.
//!
//! The TypeScript *types* are emitted by ts-rs derive tests:
//! `TS_RS_EXPORT_DIR=generated/ts cargo test --features bindings export_bindings`
//!
//! Usage: `cargo run --example generate_bindings --features bindings`

use dohc_engine_protocol::limits::MAX_WIRE_INTEGER;
use dohc_engine_protocol::wire::PROTOCOL_VERSION;
use dohc_engine_protocol::{Envelope, WireLimits};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("generated");
    std::fs::create_dir_all(&dir)?;

    let schema = schemars::schema_for!(Envelope);
    let mut schema_json = serde_json::to_string_pretty(&schema)?;
    schema_json.push('\n');
    std::fs::write(dir.join("engine-protocol.schema.json"), schema_json)?;

    let limits = serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION,
        "maxWireInteger": MAX_WIRE_INTEGER,
        "limits": WireLimits::SPIKE_DEFAULTS,
    });
    let mut limits_json = serde_json::to_string_pretty(&limits)?;
    limits_json.push('\n');
    std::fs::write(dir.join("limits.json"), limits_json)?;

    println!("wrote {}", dir.display());
    Ok(())
}
