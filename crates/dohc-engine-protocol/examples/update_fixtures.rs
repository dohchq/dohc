//! Regenerate the `canonicalJson` field of every fixture entry from the
//! typed wire structs. This is the only writer of that field; the Rust and
//! TypeScript fixture tests both verify against it.
//!
//! Usage: `cargo run --example update_fixtures`

use dohc_engine_protocol::{Envelope, WireLimits};
use serde_json::Value;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/envelopes.json");
    let mut document: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let limits = WireLimits::SPIKE_DEFAULTS;

    let entries = document
        .get_mut("entries")
        .and_then(Value::as_array_mut)
        .ok_or("fixtures file has no entries array")?;
    for entry in entries {
        let name = entry["name"].as_str().unwrap_or("<unnamed>").to_string();
        let envelope: Envelope = serde_json::from_value(entry["envelope"].clone())
            .map_err(|error| format!("fixture {name}: {error}"))?;
        envelope
            .validate(&limits)
            .map_err(|violation| format!("fixture {name}: {violation}"))?;
        // Canonical form: encode the typed value back to a serde_json::Value
        // (whose object representation sorts keys) and stringify compactly.
        let canonical = serde_json::to_string(&serde_json::to_value(&envelope)?)?;
        entry["canonicalJson"] = Value::String(canonical);
    }

    let mut output = serde_json::to_string_pretty(&document)?;
    output.push('\n');
    std::fs::write(&path, output)?;
    println!("updated {}", path.display());
    Ok(())
}
