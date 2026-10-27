use crate::{
    Failure, Method, Outcome, PreparationRequest, Proof, RefusalReason, Request, Result,
    wire::{Blob, Pipe, valid_sha},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Write};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Response {
    Refused { id: u64, reason: RefusalReason },
    Constructed(Reply),
    Proved(Reply),
    Expired(Reply),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    id: u64,
    source_sha256: String,
    source_byte_length: usize,
    projection_sha256: String,
    state_sha256: String,
    delta: Blob,
}
pub(super) struct Session<R, W> {
    pipe: Pipe<R, W>,
    manifest: Value,
    id: u64,
}
impl<R: Read, W: Write> Session<R, W> {
    pub fn prepare(&mut self, request: &PreparationRequest) -> Result {
        let PreparationRequest::Witness(request) = request else {
            let PreparationRequest::Projection(request) = request else { unreachable!() };
            return self.execute(request);
        };
        self.id += 1;
        self.pipe.control(&json!({"id": self.id, "method": "check-markdown-witness",
            "source": Blob::of(&request.source), "sourceSha256": request.source_sha256,
            "projectionSha256": request.projection_sha256}))?;
        self.pipe.blob(1, &request.source)?;
        self.pipe.control(&json!({"id": self.id, "end": true}))?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct WitnessReply {
            id: u64,
            kind: String,
            source_sha256: String,
            projection_sha256: String,
            keeps_meaning: bool,
        }
        let reply: WitnessReply = self.pipe.json()?;
        if reply.id != self.id || reply.kind != "witness-checked"
            || reply.source_sha256 != request.source_sha256
            || reply.projection_sha256 != request.projection_sha256 {
            return Err(Failure::Crashed);
        }
        Ok(Outcome::WitnessChecked {
            source_sha256: reply.source_sha256,
            projection_sha256: reply.projection_sha256,
            checker_identity: crate::wire::sha(&serde_json::to_vec(&self.manifest).map_err(|_| Failure::Unavailable)?),
            keeps_meaning: reply.keeps_meaning,
        })
    }
    pub fn new(reader: R, writer: W, manifest: Value) -> Self {
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
        let h: Hello =
            serde_json::from_value(self.pipe.json()?).map_err(|_| Failure::Unavailable)?;
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
        let constructed = r.method != Method::Prove;
        let method = match r.method {
            Method::Construct => "construct",
            Method::ConstructFold => "construct-fold",
            Method::Prove => "prove",
        };
        let source = Blob::of(&r.source);
        let checkpoint = Blob::of(&r.checkpoint);
        self.pipe.control(&json!({"id": self.id, "method": method, "document": r.document, "currentPath": r.current_path, "source": source, "checkpoint": checkpoint}))?;
        self.pipe.blob(1, &r.source)?;
        self.pipe.blob(2, &r.checkpoint)?;
        self.pipe.control(&json!({"id": self.id, "end": true}))?;
        let checkpoint_sha256 = checkpoint.sha256;
        let mut expired = false;
        let reply = match (self.pipe.json()?, r.method) {
            (Response::Refused { id, reason }, _) if id == self.id => {
                return Ok(Outcome::Refused {
                    reason,
                    checkpoint_sha256,
                });
            }
            (Response::Constructed(reply), Method::Construct)
            | (Response::Constructed(reply), Method::ConstructFold)
            | (Response::Proved(reply), Method::Prove) => reply,
            (Response::Expired(reply), Method::Prove) => {
                expired = true;
                reply
            }
            _ => return Err(Failure::Crashed),
        };
        if reply.id != self.id
            || reply.source_byte_length != source.length
            || reply.source_sha256 != source.sha256
            || !valid_sha(&reply.projection_sha256)
            || !valid_sha(&reply.state_sha256)
        {
            return Err(Failure::Crashed);
        }
        let delta = self.pipe.receive(3, reply.delta)?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct End {
            id: u64,
            end: bool,
        }
        let end: End = self.pipe.json()?;
        if end.id != self.id || !end.end || (!constructed && !delta.is_empty()) {
            return Err(Failure::Crashed);
        }
        let proof = Proof {
            source_sha256: reply.source_sha256,
            source_byte_length: reply.source_byte_length,
            projection_sha256: reply.projection_sha256,
            state_sha256: reply.state_sha256,
        };
        Ok(if constructed {
            Outcome::Constructed {
                proof,
                delta,
                checkpoint_sha256,
            }
        } else if expired {
            Outcome::Expired {
                proof,
                checkpoint_sha256,
            }
        } else {
            Outcome::Proved {
                proof,
                checkpoint_sha256,
            }
        })
    }
}
