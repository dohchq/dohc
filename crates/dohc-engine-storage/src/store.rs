//! [`EngineStore`]: sole owner of one writable SQLite connection to a
//! workspace's `engine.db`. Exposes the day-one open ritual and one generic
//! transactional write API — the compound commit — that exercises atomicity
//! (domain mutation + replication journal entry + idempotency-ledger row all
//! commit together, or none do).

use crate::error::StorageError;
use crate::faults::{FaultAction, FaultInjector, FaultPoint};
use crate::limits::{MAX_DOCUMENT_BODY_BYTES, MAX_IDENTIFIER_BYTES};
use crate::schema::open_engine_db;
use rusqlite::{Connection, TransactionBehavior};
use std::path::Path;

/// A single owned writable connection. Not `Sync`, not cloneable: the workspace
/// actor owns exactly one and never lets it cross threads
/// (`STATE_OWNERSHIP.tsv` row `sqlite-conn-versioned-text` → Rust: one writer
/// per actor). Dropping it closes the connection deterministically.
#[derive(Debug)]
pub struct EngineStore {
    conn: Connection,
}

/// Inputs to one compound write. A faithful minimal analog of the engine's
/// compound-commit invariant: a domain mutation (`documents` upsert) plus its
/// replication journal entry, recorded exactly-once under `request_id`.
#[derive(Debug, Clone)]
pub struct CompoundWrite {
    /// Idempotency key. A retry carrying the same key is exactly-once.
    pub request_id: String,
    /// The document being written.
    pub doc_id: String,
    /// The document body (UTF-8; bounded by [`MAX_DOCUMENT_BODY_BYTES`]).
    pub body: String,
    /// The replication op kind journaled alongside the mutation.
    pub op_kind: String,
    /// Injected wall-clock timestamp (`PORTING.md` §3: one injected clock;
    /// negative/fractional-in-f64 values are the domain's concern, here the
    /// calibration slice uses integral millis).
    pub now_ms: i64,
}

impl CompoundWrite {
    fn validate(&self) -> Result<(), StorageError> {
        check_identifier(&self.request_id, "request_id")?;
        check_identifier(&self.doc_id, "doc_id")?;
        check_identifier(&self.op_kind, "op_kind")?;
        if self.body.len() > MAX_DOCUMENT_BODY_BYTES {
            return Err(StorageError::DocumentTooLarge {
                actual: self.body.len(),
            });
        }
        Ok(())
    }
}

fn check_identifier(value: &str, field: &'static str) -> Result<(), StorageError> {
    if value.is_empty() {
        return Err(StorageError::InvalidInput {
            reason: match field {
                "request_id" => "request_id must not be empty",
                "doc_id" => "doc_id must not be empty",
                _ => "op_kind must not be empty",
            },
        });
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(StorageError::InvalidInput {
            reason: match field {
                "request_id" => "request_id exceeds the identifier length limit",
                "doc_id" => "doc_id exceeds the identifier length limit",
                _ => "op_kind exceeds the identifier length limit",
            },
        });
    }
    Ok(())
}

/// The outcome of a compound write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteOutcome {
    /// The transaction committed durably and the ack was delivered. `deduped`
    /// is true when the request key was already recorded (a retry replayed to
    /// the stored result without re-applying).
    Acked { seq: i64, deduped: bool },
    /// A crash fault fired before the ack was delivered. `committed` reports
    /// the durable truth for test assertions only — durability is proven by
    /// reopening, never by trusting this flag.
    Crashed { committed: bool },
}

/// A materialized document row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Document {
    pub doc_id: String,
    pub body: String,
    pub updated_at_ms: i64,
}

impl EngineStore {
    /// Open-or-create the store at `path`, applying the full open ritual and
    /// the v1-vs-v2 fingerprint fence (`open_engine_db`).
    pub fn open(path: &Path, now_ms: i64) -> Result<Self, StorageError> {
        Ok(EngineStore {
            conn: open_engine_db(path, now_ms)?,
        })
    }

    /// The one generic transactional write API. Applies the domain mutation,
    /// appends the replication journal entry, and records the idempotency
    /// ledger row atomically, consulting the two named storage fault points.
    pub fn commit_compound(
        &mut self,
        write: &CompoundWrite,
        faults: &dyn FaultInjector,
    ) -> Result<WriteOutcome, StorageError> {
        write.validate()?;

        // Idempotency pre-check: a retry whose ledger row was committed by a
        // prior attempt replays to the recorded result and never re-applies.
        if let Some(seq) = self.lookup_request(&write.request_id)? {
            return Ok(WriteOutcome::Acked { seq, deduped: true });
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StorageError::persist)?;

        tx.execute(
            "INSERT INTO documents (doc_id, body, updated_at_ms) VALUES (?1, ?2, ?3) \
             ON CONFLICT(doc_id) DO UPDATE SET body = excluded.body, \
             updated_at_ms = excluded.updated_at_ms",
            rusqlite::params![write.doc_id, write.body, write.now_ms],
        )
        .map_err(StorageError::persist)?;

        tx.execute(
            "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
             VALUES (?1, ?2, ?3)",
            rusqlite::params![write.doc_id, write.op_kind, write.now_ms],
        )
        .map_err(StorageError::persist)?;
        let seq = tx.last_insert_rowid();

        tx.execute(
            "INSERT INTO engine_requests (request_id, result_seq, committed_at) \
             VALUES (?1, ?2, ?3)",
            rusqlite::params![write.request_id, seq, write.now_ms],
        )
        .map_err(StorageError::persist)?;

        // Fault point: inside the open transaction, before commit. A crash
        // here rolls back (dropping the transaction) — restart shows no
        // partial state.
        if faults.poll(FaultPoint::StorageBeforePersist) == FaultAction::Crash {
            drop(tx); // explicit rollback
            return Ok(WriteOutcome::Crashed { committed: false });
        }

        tx.commit().map_err(StorageError::persist)?;

        // Fault point: durably committed, ack not yet delivered. A crash here
        // leaves the committed state; a retry is exactly-once via the ledger.
        if faults.poll(FaultPoint::StorageAfterCommitBeforeAck) == FaultAction::Crash {
            return Ok(WriteOutcome::Crashed { committed: true });
        }

        Ok(WriteOutcome::Acked {
            seq,
            deduped: false,
        })
    }

    fn lookup_request(&self, request_id: &str) -> Result<Option<i64>, StorageError> {
        self.conn
            .query_row(
                "SELECT result_seq FROM engine_requests WHERE request_id = ?1",
                [request_id],
                |row| row.get::<_, i64>(0),
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(StorageError::corrupt(other)),
            })
    }

    /// Read a document by id (read-your-writes on the owned connection).
    pub fn read_document(&self, doc_id: &str) -> Result<Option<Document>, StorageError> {
        self.conn
            .query_row(
                "SELECT doc_id, body, updated_at_ms FROM documents WHERE doc_id = ?1",
                [doc_id],
                |row| {
                    Ok(Document {
                        doc_id: row.get(0)?,
                        body: row.get(1)?,
                        updated_at_ms: row.get(2)?,
                    })
                },
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(StorageError::corrupt(other)),
            })
    }

    /// Number of `documents` rows.
    pub fn document_count(&self) -> Result<i64, StorageError> {
        self.scalar_count("SELECT COUNT(*) FROM documents")
    }

    /// Number of `replication_journal` rows.
    pub fn journal_len(&self) -> Result<i64, StorageError> {
        self.scalar_count("SELECT COUNT(*) FROM replication_journal")
    }

    /// Number of `engine_requests` (idempotency ledger) rows.
    pub fn request_ledger_len(&self) -> Result<i64, StorageError> {
        self.scalar_count("SELECT COUNT(*) FROM engine_requests")
    }

    /// Number of `engine_migrations` (migration ledger) rows.
    pub fn migration_ledger_len(&self) -> Result<i64, StorageError> {
        self.scalar_count("SELECT COUNT(*) FROM engine_migrations")
    }

    fn scalar_count(&self, sql: &str) -> Result<i64, StorageError> {
        self.conn
            .query_row(sql, [], |row| row.get(0))
            .map_err(StorageError::corrupt)
    }
}
