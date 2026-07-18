use super::RehearsalError;
use crate::shadow_fence::{ShadowFenceError, ValidatedShadowRoot, validate_shadow_root};
use dohc_engine_storage::ENGINE_SCHEMA_VERSION;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};

pub const REHEARSAL_TOKEN_RELATIVE_PATH: &str = ".dohc/engine/CUTOVER_REHEARSAL_TOKEN";
const TOKEN_LEN: u64 = 64;

#[derive(Debug, thiserror::Error)]
pub enum FenceError {
    #[error("shadow-clone fence refused the root")]
    Shadow(#[from] ShadowFenceError),
    #[error("cutover rehearsal token is missing")]
    TokenMissing,
    #[error("cutover rehearsal token is malformed")]
    TokenMalformed,
    #[error("cutover rehearsal token could not be read")]
    TokenUnreadable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedRehearsalRoot {
    pub root: PathBuf,
    pub shadow_token: String,
    pub rehearsal_token: String,
}

/// The only R15-REHEARSE entry fence. The real `--cutover` tier with Ice's
/// signed Gate 6 authorization is R15 work and intentionally has no bypass here.
pub fn validate_rehearsal_root(root: &Path) -> Result<ValidatedRehearsalRoot, FenceError> {
    let ValidatedShadowRoot { root, token } = validate_shadow_root(root)?;
    let marker = root.join(REHEARSAL_TOKEN_RELATIVE_PATH);
    let metadata = match std::fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(FenceError::TokenMissing);
        }
        Err(_) => return Err(FenceError::TokenUnreadable),
    };
    if !metadata.file_type().is_file() || metadata.len() != TOKEN_LEN {
        return Err(FenceError::TokenMalformed);
    }
    let bytes = std::fs::read(marker).map_err(|_| FenceError::TokenUnreadable)?;
    if !valid_token(&bytes) {
        return Err(FenceError::TokenMalformed);
    }
    let rehearsal_token = String::from_utf8(bytes).map_err(|_| FenceError::TokenMalformed)?;
    Ok(ValidatedRehearsalRoot {
        root,
        shadow_token: token,
        rehearsal_token,
    })
}

/// The plaintext markers alone must never authorize touching a store: the live
/// `engine.db` has to prove — via its own `shadow_clone` binding, read
/// strictly read-only — that it IS the clone the fence validated. Called
/// before the backup is taken and again before the destructive move-aside.
pub(crate) fn verify_live_clone_binding(
    db: &Path,
    expected_token: &str,
) -> Result<(), RehearsalError> {
    // Alias-safe: a symlinked, special, or (Unix) hard-linked live db is a
    // store reachable outside the clone and is refused before any open.
    if super::require_real_file(db, "live-db-not-regular")?.is_none() {
        return Err(RehearsalError::Io {
            code: "live-db-missing",
        });
    }
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| {
        RehearsalError::Io {
            code: "live-db-open-read-only-failed",
        }
    })?;
    let fingerprint: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| RehearsalError::Io {
            code: "live-db-fingerprint-unreadable",
        })?;
    if fingerprint != ENGINE_SCHEMA_VERSION {
        return Err(RehearsalError::Io {
            code: "live-db-foreign-fingerprint",
        });
    }
    let token: Option<String> = conn
        .query_row(
            "SELECT token FROM shadow_clone WHERE rowid_guard = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| RehearsalError::Io {
            code: "live-db-shadow-binding-unreadable",
        })?;
    if token.as_deref() != Some(expected_token) {
        return Err(RehearsalError::Io {
            code: "live-db-shadow-binding-mismatch",
        });
    }
    Ok(())
}

/// The reset-freshness proof: the live db's own `engine_ownership` identity
/// must equal the one recorded when `initialize_fresh_store` created it. A
/// stale same-clone copy (the moved-aside store or the backup restored over
/// `engine.db`) shares the shadow token but NOT this identity.
pub(crate) fn verify_live_reset_identity(
    db: &Path,
    expected_uuid: &str,
) -> Result<(), RehearsalError> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| {
        RehearsalError::Io {
            code: "live-db-open-read-only-failed",
        }
    })?;
    let uuid: Option<String> = conn
        .query_row(
            "SELECT engine_uuid FROM engine_ownership WHERE rowid_guard = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| RehearsalError::Io {
            code: "live-db-identity-unreadable",
        })?;
    if uuid.as_deref() != Some(expected_uuid) {
        return Err(RehearsalError::Io {
            code: "live-db-reset-identity-mismatch",
        });
    }
    Ok(())
}

/// Harness-only marker writer. Production rehearsal code only validates.
#[cfg(any(test, feature = "harness"))]
pub fn write_rehearsal_token_for_harness(root: &Path, token: &str) -> Result<(), FenceError> {
    if !valid_token(token.as_bytes()) {
        return Err(FenceError::TokenMalformed);
    }
    let parent = root.join(".dohc").join("engine");
    std::fs::create_dir_all(&parent).map_err(|_| FenceError::TokenUnreadable)?;
    std::fs::write(parent.join("CUTOVER_REHEARSAL_TOKEN"), token)
        .map_err(|_| FenceError::TokenUnreadable)
}

fn valid_token(token: &[u8]) -> bool {
    token.len() as u64 == TOKEN_LEN
        && token
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
