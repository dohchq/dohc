//! Storage-layer bounds. Every value the compound-write API accepts is
//! bounded; violations are typed errors, never silent truncation (plan
//! §"Rust policy": bounded everything).

/// Maximum document body size accepted by [`crate::EngineStore::commit_compound`],
/// in UTF-8 bytes. Compared against `str::len()` — already the UTF-8 byte
/// length, so no re-encoding is needed (`PORTING.md` §6: this is a place Rust
/// is simpler than the TS `Buffer.byteLength` detour).
pub const MAX_DOCUMENT_BODY_BYTES: usize = 256 * 1024;

/// Maximum length of an identifier accepted on the write path (`doc_id`,
/// `request_id`, `op_kind`), in UTF-8 bytes. A generous cap that still refuses
/// unbounded input.
pub const MAX_IDENTIFIER_BYTES: usize = 512;

/// The schema fingerprint this build owns. Persisted in `PRAGMA user_version`
/// and re-validated on every open: a store stamped with any other value is
/// rejected by the v1-vs-v2 fence (`plan §Day-one Rust schema`), never
/// auto-migrated.
pub const ENGINE_SCHEMA_VERSION: i64 = 2;

/// `busy_timeout` applied to the writer connection, in milliseconds. Matches
/// the TS engine's `ENGINE_SQLITE_BUSY_TIMEOUT_MS` (`engineDbSchema.ts:15`) so
/// external-process contention waits rather than failing instantly.
pub const ENGINE_SQLITE_BUSY_TIMEOUT_MS: u32 = 5000;
