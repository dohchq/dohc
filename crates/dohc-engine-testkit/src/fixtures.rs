//! Shared scratch stores and byte fixtures for engine tests.

use std::path::PathBuf;

use dohc_engine_storage::EngineStore;

use crate::scratch::{ScratchDir, engine_db_path};

/// A fresh engine store under a scratch workspace, opened at `now_ms = 1_000`.
/// The path is returned so a test can reopen the same database.
pub fn open_store() -> (ScratchDir, PathBuf, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    let store = EngineStore::open(&path, 1_000).expect("open");
    (scratch, path, store)
}

/// Decode a lowercase-hex fixture into bytes.
pub fn decode_hex(encoded: &str) -> Vec<u8> {
    assert_eq!(encoded.len() % 2, 0, "hex fixture must have complete bytes");
    encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).expect("hex utf8");
            u8::from_str_radix(pair, 16).expect("hex byte")
        })
        .collect()
}

/// Replace the unique occurrence of a byte in a fixture.
pub fn flip_byte(update: &[u8], from: u8, to: u8) -> Vec<u8> {
    let positions: Vec<usize> = update
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == from).then_some(index))
        .collect();
    assert_eq!(
        positions.len(),
        1,
        "payload byte must be unambiguous in the wire bytes"
    );
    let mut hostile = update.to_vec();
    hostile[positions[0]] = to;
    hostile
}
