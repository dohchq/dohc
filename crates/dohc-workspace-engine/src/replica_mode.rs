//! RPC confinement for the relay's passive child. OS isolation is applied separately.

use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    wire::Request,
};
use serde_json::json;
use std::path::{Path, PathBuf};

pub(crate) struct ReplicaMode {
    root: PathBuf,
}

impl ReplicaMode {
    pub(crate) fn new(root: &Path) -> std::io::Result<Self> {
        let root = root.canonicalize()?;
        if root.to_str().is_none() {
            return Err(std::io::Error::other("replica store path must be UTF-8"));
        }
        Ok(Self { root })
    }

    pub(crate) fn guard(&self, request: &mut Request) -> Result<(), WireError> {
        if !matches!(
            request.method.as_str(),
            "engine.ping"
                | "workspace.open"
                | "sync.adoptJoinIdentity"
                | "sync.pull"
                | "sync.commitCursor"
                | "replica.frontiers"
                | "replica.applyJournalPage"
                | "replica.cut"
        ) {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "replica-method-refused",
            ));
        }
        if request.method != "workspace.open" {
            return Ok(());
        }
        let refused = || WireError::new(ErrorCode::InvalidParams, "replica-open-refused");
        let params = request.params.as_object_mut().ok_or_else(refused)?;
        let root = params
            .get("rootDir")
            .and_then(|v| v.as_str())
            .ok_or_else(refused)?;
        if Path::new(root).canonicalize().map_err(|_| refused())? != self.root {
            return Err(refused());
        }
        let relay = params
            .get_mut("relay")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(refused)?;
        if relay
            .keys()
            .any(|k| !matches!(k.as_str(), "socketPath" | "bearerToken"))
        {
            return Err(refused());
        }
        let socket = relay
            .get("socketPath")
            .and_then(|v| v.as_str())
            .ok_or_else(refused)?;
        let socket = Path::new(socket);
        if !socket.is_absolute()
            || socket.file_name() != Some(std::ffi::OsStr::new("relay.sock"))
            || socket.parent().and_then(|p| p.canonicalize().ok()).as_ref() != Some(&self.root)
        {
            return Err(refused());
        }
        relay.insert("socketPath".into(), json!(self.root.join("relay.sock")));
        params.insert("rootDir".into(), json!(self.root));
        params.insert("storeMode".into(), json!("passive"));
        params.insert("captureMode".into(), json!("none"));
        params.insert("recoverRunningDispatches".into(), json!(false));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // APFS refuses non-UTF-8 names, so no root this check refuses can exist on Apple hosts.
    #[test]
    #[cfg(all(unix, not(target_vendor = "apple")))]
    fn refuses_non_utf8_root_before_json_serialization() {
        use std::os::unix::ffi::OsStrExt;
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let path = root
            .path()
            .join(std::ffi::OsStr::from_bytes(b"replica-\xff"));
        std::fs::create_dir(&path).unwrap();
        assert!(ReplicaMode::new(&path).is_err());
    }

    #[test]
    fn guard_uses_canonical_startup_paths() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let alias = root.path().join(".");
        let mut request: Request = serde_json::from_value(json!({"id":1,"method":"workspace.open",
            "params":{"rootDir":alias,"relay":{"socketPath":alias.join("relay.sock"),"bearerToken":"lease"}}})).unwrap();
        let mode = ReplicaMode::new(root.path()).unwrap();
        mode.guard(&mut request).unwrap();
        assert_eq!(request.params["rootDir"], json!(mode.root));
        assert_eq!(
            request.params["relay"]["socketPath"],
            json!(mode.root.join("relay.sock"))
        );
    }
}
