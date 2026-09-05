//! Binds a workspace root to its engine database.
//!
//! The first full open of a root mints a random token, writes it to
//! `.dohc/engine/ROOT_BINDING`, and stamps it into `engine.db`. Every later
//! open compares the two, so an `engine.db` copied under another root is
//! refused instead of adopted. The storage fingerprint fence independently
//! rejects foreign databases before any migration runs.

use std::path::{Path, PathBuf};

pub const ROOT_BINDING_RELATIVE_PATH: &str = ".dohc/engine/ROOT_BINDING";
const TOKEN_HEX_LEN: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum RootBindingError {
    #[error("workspace root is unavailable")]
    RootUnavailable,
    #[error("workspace root has no engine binding")]
    Unbound,
    #[error("root binding is malformed")]
    Malformed,
    #[error("root binding could not be read")]
    Unreadable,
    #[error("root binding could not be written")]
    Unwritable,
    #[error("engine database is bound to another root")]
    DatabaseMismatch,
}

/// Canonicalize a root without creating anything.
pub fn canonical_root(root: &Path) -> Result<PathBuf, RootBindingError> {
    std::fs::canonicalize(root).map_err(|_| RootBindingError::RootUnavailable)
}

/// The root's binding token, or `None` when the root has never been bound.
pub fn read_root_binding(root: &Path) -> Result<Option<String>, RootBindingError> {
    let marker = root.join(ROOT_BINDING_RELATIVE_PATH);
    let token = match std::fs::read(&marker) {
        Ok(token) => token,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(RootBindingError::Unreadable),
    };
    if !valid_token(&token) {
        return Err(RootBindingError::Malformed);
    }
    String::from_utf8(token)
        .map(Some)
        .map_err(|_| RootBindingError::Malformed)
}

/// Mint and record a binding for a root that has none.
pub fn write_new_root_binding(root: &Path) -> Result<String, RootBindingError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| RootBindingError::Unwritable)?;
    let token = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    write_root_binding(root, &token)?;
    Ok(token)
}

/// Record `token` as the root's binding. A test that hand-builds a store
/// before the first open uses this so the open finds a matching binding.
pub fn write_root_binding(root: &Path, token: &str) -> Result<(), RootBindingError> {
    if !valid_token(token.as_bytes()) {
        return Err(RootBindingError::Malformed);
    }
    let marker = root.join(ROOT_BINDING_RELATIVE_PATH);
    let parent = marker.parent().ok_or(RootBindingError::Unwritable)?;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(parent)
        .map_err(|_| RootBindingError::Unwritable)?;
    std::fs::write(marker, token).map_err(|_| RootBindingError::Unwritable)
}

fn valid_token(token: &[u8]) -> bool {
    token.len() == TOKEN_HEX_LEN
        && token
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_testkit::ScratchDir;

    #[test]
    fn an_unbound_root_reads_as_none_and_a_new_binding_reads_back() {
        let scratch = ScratchDir::new().expect("scratch");
        assert_eq!(read_root_binding(scratch.path()).expect("read"), None);
        let token = write_new_root_binding(scratch.path()).expect("write");
        assert_eq!(token.len(), TOKEN_HEX_LEN);
        assert_eq!(
            read_root_binding(scratch.path()).expect("read"),
            Some(token)
        );
    }

    #[test]
    fn a_hand_forged_binding_is_malformed() {
        let scratch = ScratchDir::new().expect("scratch");
        let engine = scratch.join(".dohc").join("engine");
        std::fs::create_dir_all(&engine).expect("engine dir");
        std::fs::write(engine.join("ROOT_BINDING"), "manually-forged").expect("forged");
        assert!(matches!(
            read_root_binding(scratch.path()),
            Err(RootBindingError::Malformed)
        ));
    }
}
