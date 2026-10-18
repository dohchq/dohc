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
        Ok(Self {
            root: root.canonicalize()?,
        })
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
            .get("relay")
            .and_then(|v| v.as_object())
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
        params.insert("storeMode".into(), json!("passive"));
        params.insert("captureMode".into(), json!("none"));
        params.insert("recoverRunningDispatches".into(), json!(false));
        Ok(())
    }
}
