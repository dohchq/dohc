use crate::EngineService;
use base64::Engine as _;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::wire::{Request, WorkspaceHandle};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorContext {
    workspace_id: String,
    person_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdmitParams {
    host_credential: String,
    person_id: String,
}

fn refused() -> WireError {
    WireError::new(ErrorCode::Forbidden, "author-context-required")
}

// HMAC-SHA256 with the provisioned 64-byte profile secret as its key.
fn signature(secret: &str, payload: &[u8]) -> Vec<u8> {
    let mut inner_key = [0x36; 64];
    let mut outer_key = [0x5c; 64];
    for (index, byte) in secret.bytes().enumerate() {
        inner_key[index] ^= byte;
        outer_key[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_key);
    inner.update(payload);
    let mut outer = Sha256::new();
    outer.update(outer_key);
    outer.update(inner.finalize());
    outer.finalize().to_vec()
}

impl EngineService {
    pub fn provision_author_context_secret(&self, secret: String) -> Result<(), WireError> {
        if secret.len() != 64 || !secret.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-author-context-secret",
            ));
        }
        self.author_context_secret
            .set(secret)
            .map_err(|_| refused())
    }

    pub(super) fn admit_author_context(
        &self,
        handle: Option<&WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AdmitParams = super::request::parse(params)?;
        let secret = self.author_context_secret.get().ok_or_else(refused)?;
        if !bool::from(secret.as_bytes().ct_eq(params.host_credential.as_bytes())) {
            return Err(refused());
        }
        if params.person_id.is_empty()
            || params.person_id.len() > dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES
            || params.person_id.chars().any(char::is_control)
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-person-id",
            ));
        }
        let context = AuthorContext {
            workspace_id: self.open(handle)?.workspace_id.clone(),
            person_id: params.person_id,
        };
        let payload = serde_json::to_vec(&context)
            .map_err(|_| WireError::new(ErrorCode::Internal, "author-context-encode-failed"))?;
        let encoding = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let token = format!(
            "{}.{}",
            encoding.encode(&payload),
            encoding.encode(signature(secret, &payload))
        );
        Ok(json!({"authorContext": token}))
    }

    fn resolve_author_context(&self, token: &str, workspace_id: &str) -> Result<String, WireError> {
        if token.len() > 4096 {
            return Err(refused());
        }
        let (payload, stamp) = token.split_once('.').ok_or_else(refused)?;
        let encoding = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let payload = encoding.decode(payload).map_err(|_| refused())?;
        let stamp = encoding.decode(stamp).map_err(|_| refused())?;
        let secret = self.author_context_secret.get().ok_or_else(refused)?;
        if !bool::from(signature(secret, &payload).ct_eq(&stamp)) {
            return Err(refused());
        }
        let context: AuthorContext = serde_json::from_slice(&payload).map_err(|_| refused())?;
        if context.workspace_id != workspace_id
            || context.person_id.is_empty()
            || context.person_id.len() > dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES
            || context.person_id.chars().any(char::is_control)
        {
            return Err(refused());
        }
        Ok(context.person_id)
    }

    pub(super) fn stamp_local_authorship(&self, request: &mut Request) -> Result<(), WireError> {
        let supports_author = request.method.starts_with("versionedText.")
            || request.method.starts_with("versionedBinary.")
            || request.method == "capture.setAuthor"
            || request.method == "workspace.open";
        let live_update = request.method == "ydoc.recordUpdate";
        if !supports_author && !live_update {
            return Ok(());
        }
        let Some(params) = request.params.as_object_mut() else {
            return Ok(());
        };
        let token = params.remove("authorContext");
        let person = match token {
            Some(Value::String(token)) => {
                let workspace_id = if request.method == "workspace.open" {
                    params
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .ok_or_else(refused)?
                        .to_owned()
                } else {
                    self.open(request.workspace.as_ref())?.workspace_id.clone()
                };
                Some(self.resolve_author_context(&token, &workspace_id)?)
            }
            Some(_) => return Err(refused()),
            None => None,
        };
        if live_update {
            if params.get("seed").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            let attribution = params.get("attribution");
            let kind = attribution
                .and_then(|value| value.get("actorKind"))
                .and_then(Value::as_str);
            if person.is_none() {
                if matches!(kind, Some("human" | "agent"))
                    || attribution.is_some_and(|value| value.get("onBehalfOf").is_some())
                {
                    return Err(refused());
                }
                return Ok(());
            }
            let person = person.ok_or_else(refused)?;
            match kind {
                None => {
                    if attribution.is_some() || params.get("actorOriginId").is_some() {
                        return Err(refused());
                    }
                    params.insert("actorOriginId".into(), json!(person));
                    params.insert(
                        "attribution".into(),
                        json!({"actorKind":"human", "onBehalfOf":person, "depth":0}),
                    );
                }
                Some("human") => return Err(refused()),
                Some("agent" | "automation") => {
                    let attribution = params
                        .get_mut("attribution")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(refused)?;
                    attribution.insert("onBehalfOf".into(), json!(person));
                }
                _ => return Err(refused()),
            }
        } else {
            let author_key = if request.method == "workspace.open" {
                "captureAuthor"
            } else {
                "author"
            };
            if let Some(author) = params
                .get_mut(author_key)
                .filter(|author| !author.is_null())
            {
                let author = author.as_object_mut().ok_or_else(refused)?;
                author.remove("authorContext");
                let kind = author.get("kind").and_then(Value::as_str);
                match person {
                    None if matches!(kind, Some("human" | "agent"))
                        || author.contains_key("onBehalfOf") =>
                    {
                        return Err(refused());
                    }
                    Some(person) => match kind {
                        Some("human") => {
                            *author = serde_json::Map::from_iter([
                                ("kind".into(), json!("human")),
                                ("humanId".into(), json!(person)),
                            ]);
                        }
                        Some("agent" | "automation") => {
                            author.insert("onBehalfOf".into(), json!(person));
                        }
                        _ => return Err(refused()),
                    },
                    None => {}
                }
            } else if let Some(person) = person {
                params.insert(author_key.into(), json!({"kind":"human", "humanId":person}));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn token(service: &EngineService, workspace: &str, person: &str) -> String {
        let payload = serde_json::to_vec(&AuthorContext {
            workspace_id: workspace.into(),
            person_id: person.into(),
        })
        .unwrap();
        let encoding = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}",
            encoding.encode(&payload),
            encoding.encode(signature(
                service.author_context_secret.get().unwrap(),
                &payload
            ))
        )
    }
    #[test]
    fn profile_host_context_matches_typescript_encoding() {
        let service = EngineService::new();
        service
            .provision_author_context_secret("a".repeat(64))
            .unwrap();
        // JSON.stringify({workspaceId:"workspace",personId:"alice"}) with
        // createHmac("sha256", "a".repeat(64)) and base64url on the host.
        let host_token = "eyJ3b3Jrc3BhY2VJZCI6IndvcmtzcGFjZSIsInBlcnNvbklkIjoiYWxpY2UifQ.k9frBJAz_6bdaYT1D7rJB84fgMERh9fehkZECfpjLsE";
        assert_eq!(
            service
                .resolve_author_context(host_token, "workspace")
                .unwrap(),
            "alice"
        );
        assert_eq!(token(&service, "workspace", "alice"), host_token);
    }

    #[test]
    fn signatures_use_standard_hmac_sha256() {
        assert_eq!(
            dohc_engine_storage::hex(&signature(&"a".repeat(64), b"body")),
            "cbeec3a0761ed7c931e1afc6a0aa9863defc93372b60911aaaa523c426dde73c"
        );
    }
    #[test]
    fn immutable_context_survives_restart_and_keeps_original_person() {
        let first = EngineService::new();
        first
            .provision_author_context_secret("a".repeat(64))
            .unwrap();
        let alice = token(&first, "workspace", "alice");
        let bob = token(&first, "workspace", "bob");
        let restarted = EngineService::new();
        restarted
            .provision_author_context_secret("a".repeat(64))
            .unwrap();
        assert_eq!(
            restarted
                .resolve_author_context(&alice, "workspace")
                .unwrap(),
            "alice"
        );
        assert_eq!(
            restarted.resolve_author_context(&bob, "workspace").unwrap(),
            "bob"
        );
        assert!(
            restarted
                .resolve_author_context(&alice, "other-workspace")
                .is_err()
        );
        let forged = alice.replacen(&alice[..1], "z", 1);
        assert!(
            restarted
                .resolve_author_context(&forged, "workspace")
                .is_err()
        );
        for invalid in [
            String::new(),
            "bad\nsubject".into(),
            "x".repeat(dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES + 1),
        ] {
            assert!(
                restarted
                    .resolve_author_context(&token(&first, "workspace", &invalid), "workspace")
                    .is_err()
            );
        }
        let ordinary = EngineService::new();
        assert!(
            ordinary
                .resolve_author_context(&alice, "workspace")
                .is_err()
        );
        ordinary
            .provision_author_context_secret("b".repeat(64))
            .unwrap();
        assert!(
            ordinary
                .resolve_author_context(&alice, "workspace")
                .is_err()
        );
    }
    #[test]
    fn ordinary_client_person_claims_are_rejected() {
        let service = EngineService::new();
        for (method, params) in [
            (
                "versionedText.write",
                json!({"author":{"kind":"agent","agentId":"agent"}}),
            ),
            (
                "capture.setAuthor",
                json!({"author":{"kind":"agent","agentId":"agent"}}),
            ),
            (
                "workspace.open",
                json!({"captureAuthor":{"kind":"agent","agentId":"agent"}}),
            ),
            (
                "ydoc.recordUpdate",
                json!({"attribution":{"actorKind":"human"}, "actorOriginId":"alice"}),
            ),
            (
                "ydoc.recordUpdate",
                json!({"attribution":{"actorKind":"agent", "onBehalfOf":"alice"}, "actorOriginId":"agent"}),
            ),
            (
                "versionedText.write",
                json!({"author":{"kind":"human","humanId":"alice"}}),
            ),
            (
                "versionedText.write",
                json!({"author":{"kind":"agent","agentId":"agent","onBehalfOf":"alice"}}),
            ),
        ] {
            let mut request = Request {
                id: 1,
                method: method.into(),
                workspace: None,
                params,
                deadline_ms: None,
                idempotency_key: None,
                progress: false,
            };
            assert!(service.stamp_local_authorship(&mut request).is_err());
        }
    }
}
