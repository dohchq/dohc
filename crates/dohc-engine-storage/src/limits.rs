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

/// The storage/protocol compatibility version recorded in every migration
/// ledger row (`plan §Day-one Rust schema`: "engine build/protocol version").
/// Distinct from [`ENGINE_SCHEMA_VERSION`] (the on-file fingerprint fence):
/// this tracks the *contract* the migration was written against, so a ledger is
/// legible to a later build even before it re-derives the schema.
pub const ENGINE_STORAGE_PROTOCOL_VERSION: i64 = 1;

/// The engine build string stamped into migration ledger rows. The crate
/// version is a stable, redaction-safe build identifier (no host paths).
pub const ENGINE_BUILD: &str = env!("CARGO_PKG_VERSION");

/// Maximum size of a single content-addressed blob, in bytes. Bounds both the
/// write (reject over-cap) and the read buffer. Generous but never unbounded.
pub const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;

/// The bounded, normative maximum number of atomic-replace attempts in the
/// materialization pipeline before failing closed with [`crate::StorageError::FileLocked`]
/// and leaving the job pending for startup replay. Windows AV/indexer sharing
/// violations are retried up to this many times; two engines that retry a
/// different number of times cannot both pass the differential
/// (`TEST_ORACLE.md` §3.10 `env.sharing-violation-transient`: "normative
/// maximum of 5 attempts"). Shared by `dohc-engine-files::materialize`.
pub const MAX_REPLACE_ATTEMPTS: u32 = 5;

/// Maximum size of a materialization target the pipeline will write in one job,
/// in bytes. Mirrors the blob cap: the content it materializes came from a
/// bounded blob.
pub const MAX_MATERIALIZE_BYTES: usize = MAX_BLOB_BYTES;
