//! Pre-cutover shadow-build fence.
//!
//! A writable root must contain `.dohc/engine/SHADOW_CLONE` whose complete
//! contents are exactly 64 lowercase hexadecimal ASCII bytes (a harness-issued
//! random 32-byte token, without whitespace or newline). The marker is checked
//! before the runtime is allowed to create/open `engine.db`. The storage open
//! ritual then independently rejects TS-v1/foreign fingerprints before any
//! persistent database setting or migration can run.

use std::path::{Path, PathBuf};

pub const SHADOW_MARKER_RELATIVE_PATH: &str = ".dohc/engine/SHADOW_CLONE";
pub const SHADOW_TOKEN_HEX_LEN: u64 = 64;

#[derive(Debug, thiserror::Error)]
pub enum ShadowFenceError {
    #[error("shadow workspace root is unavailable")]
    RootUnavailable,
    #[error("shadow clone marker is missing")]
    MarkerMissing,
    #[error("shadow clone marker is malformed")]
    MarkerMalformed,
    #[error("shadow clone marker could not be read")]
    MarkerUnreadable,
    #[error("engine database is not bound to this shadow clone")]
    DatabaseTokenMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedShadowRoot {
    pub root: PathBuf,
    pub token: String,
}

/// Validate and canonicalize a clone-marked root without creating any files.
pub fn validate_shadow_root(root: &Path) -> Result<ValidatedShadowRoot, ShadowFenceError> {
    let canonical = std::fs::canonicalize(root).map_err(|_| ShadowFenceError::RootUnavailable)?;
    let marker = canonical.join(SHADOW_MARKER_RELATIVE_PATH);
    let metadata = match std::fs::metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ShadowFenceError::MarkerMissing);
        }
        Err(_) => return Err(ShadowFenceError::MarkerUnreadable),
    };
    if !metadata.is_file() || metadata.len() != SHADOW_TOKEN_HEX_LEN {
        return Err(ShadowFenceError::MarkerMalformed);
    }
    let token = std::fs::read(&marker).map_err(|_| ShadowFenceError::MarkerUnreadable)?;
    if !valid_token(&token) {
        return Err(ShadowFenceError::MarkerMalformed);
    }
    let token = String::from_utf8(token).map_err(|_| ShadowFenceError::MarkerMalformed)?;
    Ok(ValidatedShadowRoot {
        root: canonical,
        token,
    })
}

/// Harness-only helper for a clone tool or integration test. Production daemon
/// code only calls [`validate_shadow_root`]; it never manufactures markers.
#[cfg(any(test, feature = "harness"))]
pub fn write_shadow_marker_for_harness(root: &Path, token: &str) -> Result<(), ShadowFenceError> {
    if !valid_token(token.as_bytes()) {
        return Err(ShadowFenceError::MarkerMalformed);
    }
    let parent = root.join(".dohc").join("engine");
    std::fs::create_dir_all(&parent).map_err(|_| ShadowFenceError::MarkerUnreadable)?;
    std::fs::write(parent.join("SHADOW_CLONE"), token)
        .map_err(|_| ShadowFenceError::MarkerUnreadable)
}

fn valid_token(token: &[u8]) -> bool {
    token.len() as u64 == SHADOW_TOKEN_HEX_LEN
        && token
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_testkit::ScratchDir;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn root_without_shadow_marker_is_refused() {
        let scratch = ScratchDir::new().expect("scratch");
        assert!(matches!(
            validate_shadow_root(scratch.path()),
            Err(ShadowFenceError::MarkerMissing)
        ));
    }

    #[test]
    fn root_with_harness_marker_is_accepted() {
        let scratch = ScratchDir::new().expect("scratch");
        write_shadow_marker_for_harness(scratch.path(), TOKEN).expect("marker");
        assert_eq!(
            validate_shadow_root(scratch.path())
                .expect("valid root")
                .root,
            std::fs::canonicalize(scratch.path()).expect("canonical")
        );
    }

    #[test]
    fn real_looking_root_with_hand_forged_wrong_shape_is_refused() {
        let scratch = ScratchDir::new().expect("scratch");
        let real_looking = scratch.join("my-real-workspace");
        let engine = real_looking.join(".dohc").join("engine");
        std::fs::create_dir_all(&engine).expect("engine dir");
        std::fs::write(engine.join("SHADOW_CLONE"), "manually-forged").expect("forged marker");
        assert!(matches!(
            validate_shadow_root(&real_looking),
            Err(ShadowFenceError::MarkerMalformed)
        ));
    }
}
