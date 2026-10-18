use crate::{
    Failure, Method, Outcome, Proof, Request, Result,
    wire::{Blob, Pipe, sha},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::process::{ChildStdin, ChildStdout};
pub(super) struct Session {
    pipe: Pipe<ChildStdout, ChildStdin>,
    manifest: Value,
    id: u64,
}
impl Session {
    pub fn new(reader: ChildStdout, writer: ChildStdin, manifest: Value) -> Self {
        Self {
            pipe: Pipe::new(reader, writer),
            manifest,
            id: 1,
        }
    }
    pub fn hello(&mut self) -> std::result::Result<(), Failure> {
        self.pipe.control(&json!({"id": 1, "method": "hello"}))?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Hello {
            id: u64,
            kind: String,
            protocol_version: u32,
            schema_version: u32,
            runtime: Value,
        }
        let h: Hello = self.pipe.json()?;
        let mut runtime = self.manifest["runtime"].clone();
        runtime
            .as_object_mut()
            .ok_or(Failure::Unavailable)?
            .remove("sha256");
        if h.id != 1
            || h.kind != "hello"
            || h.protocol_version != 1
            || h.schema_version != 1
            || h.runtime != runtime
        {
            return Err(Failure::Unavailable);
        }
        Ok(())
    }
    pub fn execute(&mut self, r: &Request) -> Result {
        self.id += 1;
        let method = match r.method {
            Method::Construct => "construct",
            Method::Prove => "prove",
        };
        self.pipe.control(&json!({"id": self.id, "method": method, "document": r.document, "currentPath": r.current_path, "source": Blob::of(&r.source), "checkpoint": Blob::of(&r.checkpoint)}))?;
        self.pipe.blob(1, &r.source)?;
        self.pipe.blob(2, &r.checkpoint)?;
        self.pipe.control(&json!({"id": self.id, "end": true}))?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Success {
            id: u64,
            kind: String,
            source_sha256: String,
            source_byte_length: usize,
            projection_sha256: String,
            state_sha256: String,
            delta: Blob,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Refusal {
            id: u64,
            kind: String,
            reason: String,
        }
        let response: Value = self.pipe.json()?;
        if response["kind"] == "refused" {
            let refused: Refusal =
                serde_json::from_value(response).map_err(|_| Failure::Crashed)?;
            if refused.id != self.id || refused.kind != "refused" || refused.reason.len() > 128 {
                return Err(Failure::Crashed);
            }
            return Ok(Outcome::Refused(refused.reason));
        }
        let Success {
            id,
            kind,
            source_sha256,
            source_byte_length,
            projection_sha256,
            state_sha256,
            delta,
        } = serde_json::from_value(response).map_err(|_| Failure::Crashed)?;
        let constructed = matches!(r.method, Method::Construct);
        if kind != if constructed { "constructed" } else { "proved" } {
            return Err(Failure::Crashed);
        }
        if id != self.id || source_byte_length != r.source.len() || source_sha256 != sha(&r.source)
        {
            return Err(Failure::Crashed);
        }
        let delta = self.pipe.receive(3, delta)?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct End {
            id: u64,
            end: bool,
        }
        let end: End = self.pipe.json()?;
        if end.id != id || !end.end || (!constructed && !delta.is_empty()) {
            return Err(Failure::Crashed);
        }
        let proof = Proof {
            source_sha256,
            source_byte_length,
            projection_sha256,
            state_sha256,
        };
        Ok(if constructed {
            Outcome::Constructed { proof, delta }
        } else {
            Outcome::Proved(proof)
        })
    }
}
