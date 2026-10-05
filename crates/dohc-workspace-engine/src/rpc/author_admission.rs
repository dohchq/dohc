use crate::EngineService;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::wire::Request;
use serde_json::Value;

fn refused() -> WireError {
    WireError::new(ErrorCode::Forbidden, "person-author-refused")
}

// A human author, or anyone acting on a person's behalf.
fn names_person(declared: &Value) -> bool {
    let kind = declared.get("kind").or_else(|| declared.get("actorKind"));
    kind.and_then(Value::as_str) == Some("human") || declared.get("onBehalfOf").is_some()
}

fn author_key(method: &str) -> Option<&'static str> {
    match method {
        "capture.setAuthor" => Some("author"),
        "workspace.open" => Some("captureAuthor"),
        "ydoc.recordUpdate" | "collections.setFieldsBatch" => Some("attribution"),
        _ if method.starts_with("versionedText.") || method.starts_with("versionedBinary.") => {
            Some("author")
        }
        _ => None,
    }
}

impl EngineService {
    /// Desktop main is the engine's one ordinary caller. It names the person
    /// an edit is by, read from its own account when the edit arrives. A
    /// configured live host serves other people's callers, so nothing it
    /// sends names a person. Capture records outside disk edits, so only a
    /// declared agent run authors capture, never a person.
    pub(super) fn ensure_admissible_author(&self, request: &Request) -> Result<(), WireError> {
        let method = request.method.as_str();
        let capture_author = matches!(method, "capture.setAuthor" | "workspace.open");
        let Some(key) = author_key(method) else {
            return Ok(());
        };
        let Some(declared) = request.params.get(key).filter(|value| !value.is_null()) else {
            return Ok(());
        };
        if capture_author && declared.get("kind").and_then(Value::as_str) != Some("agent") {
            return Err(refused());
        }
        if self.configured_live_host.get().is_some() && names_person(declared) {
            return Err(refused());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(method: &str, params: Value) -> Request {
        Request {
            id: 1,
            method: method.into(),
            workspace: None,
            params,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
        }
    }

    fn person_claims() -> Vec<Request> {
        vec![
            request(
                "collections.setFieldsBatch",
                json!({"attribution":{"actorKind":"automation","onBehalfOf":"alice","depth":1,"run":{"claimId":"claim","automationName":"Stamp"}}}),
            ),
            request(
                "ydoc.recordUpdate",
                json!({"actorOriginId":"alice", "attribution":{"actorKind":"human", "onBehalfOf":"alice", "depth":0}}),
            ),
            request(
                "ydoc.recordUpdate",
                json!({"actorOriginId":"agent", "attribution":{"actorKind":"agent", "onBehalfOf":"alice", "depth":1}}),
            ),
            request(
                "versionedText.write",
                json!({"author":{"kind":"human", "humanId":"alice"}}),
            ),
            request(
                "versionedText.delete",
                json!({"author":{"kind":"automation", "automationId":"a", "onBehalfOf":"alice", "depth":1}}),
            ),
            request(
                "versionedBinary.write",
                json!({"author":{"kind":"agent", "agentId":"agent", "onBehalfOf":"alice"}}),
            ),
        ]
    }

    fn attributed_parameters(root: &std::path::Path) -> Vec<String> {
        let mut found = Vec::new();
        let mut pending = vec![root.to_owned()];
        while let Some(path) = pending.pop() {
            if path.is_dir() {
                pending.extend(
                    std::fs::read_dir(path)
                        .unwrap()
                        .map(|entry| entry.unwrap().path()),
                );
                continue;
            }
            if path.extension().is_none_or(|extension| extension != "rs") {
                continue;
            }
            let source = std::fs::read_to_string(path).unwrap();
            let mut parameter = None;
            for line in source.lines() {
                let line = line.trim();
                if let Some((visibility, declaration)) = line.split_once("struct ")
                    && (visibility.is_empty() || visibility.starts_with("pub"))
                {
                    parameter = declaration
                        .split(|c: char| c.is_whitespace() || c == '{' || c == '<')
                        .next();
                }
                if line.starts_with('}') {
                    parameter = None;
                }
                if let Some(name) = parameter
                    && line.split_whitespace().any(|token| token == "attribution:")
                {
                    found.push(name.to_owned());
                }
                if line.ends_with('}') {
                    parameter = None;
                }
            }
        }
        found
    }

    #[test]
    fn every_rpc_parameter_with_attribution_has_author_admission() {
        let rpc = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/rpc");
        let listed = [
            ("YdocRecordUpdateParams", "ydoc.recordUpdate"),
            ("SetBatchSubmission", "collections.setFieldsBatch"),
        ];
        let found = attributed_parameters(&rpc);
        for name in &found {
            let (_, method) = listed
                .iter()
                .find(|(parameter, _)| *parameter == name)
                .unwrap_or_else(|| panic!("list the method that carries attribution in {name}"));
            assert_eq!(author_key(method), Some("attribution"), "{method}");
        }
        assert_eq!(found.len(), listed.len());
    }

    #[test]
    fn attribution_listing_handles_nested_visibility_and_ignores_struct_literals() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let nested = scratch.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("params.rs"), "pub(super) struct Qualified {\n    pub(crate) attribution: Author,\n}\nfn facts() {\n    let facts = Facts {\n        attribution: None,\n    };\n}\n").unwrap();
        assert_eq!(attributed_parameters(scratch.path()), vec!["Qualified"]);
    }

    #[test]
    fn capture_is_authored_only_by_a_declared_agent() {
        let service = EngineService::new();
        for (method, key) in [
            ("capture.setAuthor", "author"),
            ("workspace.open", "captureAuthor"),
        ] {
            for author in [
                json!({"kind":"human", "humanId":"alice"}),
                json!({"kind":"automation", "automationId":"a", "depth":1}),
                json!({"humanId":"alice"}),
            ] {
                let refused = service
                    .ensure_admissible_author(&request(method, json!({ key: author })))
                    .unwrap_err();
                assert_eq!(
                    refused.message, "person-author-refused",
                    "{method} {author}"
                );
            }
            for author in [
                json!({"kind":"agent", "agentId":"agent", "onBehalfOf":"alice"}),
                Value::Null,
            ] {
                assert!(
                    service
                        .ensure_admissible_author(&request(method, json!({ key: author })))
                        .is_ok()
                );
            }
        }
    }

    #[test]
    fn desktop_main_names_the_person() {
        let service = EngineService::new();
        for claim in person_claims() {
            assert!(
                service.ensure_admissible_author(&claim).is_ok(),
                "{}",
                claim.params
            );
        }
    }

    #[tokio::test]
    async fn a_configured_live_host_names_nobody() {
        let workspace = dohc_engine_testkit::ScratchDir::new().unwrap();
        let config = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "relay",
            "host": {"hostId": "host", "hostEpoch": 1, "instanceId": "instance", "connectionId": "connection"},
            "workspaces": [{"root": workspace.path(), "workspaceId": "configured", "maxRegistrations": 4}],
            "ingress": {"aggregateBytes": 512 * 1024 * 1024, "applicationWorkingReserveBytes": 8 * 1024 * 1024,
                "maxUploads": 2, "uploadDeadlineMs": 30_000}
        }))
        .unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(config).await.unwrap();
        let mut ctx = dohc_engine_protocol::transport::RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let discovery = service
            .configured_live_hosts(&ctx, &request("liveApplication.hosts", json!({})))
            .unwrap();
        let handle: dohc_engine_protocol::wire::WorkspaceHandle =
            serde_json::from_value(discovery["workspaces"][0]["workspaceHandle"].clone()).unwrap();
        for claim in person_claims() {
            let refused = service.ensure_admissible_author(&claim).unwrap_err();
            assert_eq!(refused.code, ErrorCode::Forbidden, "{}", claim.params);
            assert_eq!(refused.message, "person-author-refused");
        }
        for neutral in [
            request(
                "ydoc.recordUpdate",
                json!({"actorOriginId":"agent", "attribution":{"actorKind":"agent", "depth":1}}),
            ),
            request("versionedText.write", json!({"text":"neutral"})),
        ] {
            assert!(service.ensure_admissible_author(&neutral).is_ok());
        }
        service.workspace_close(Some(handle)).await.unwrap();
    }
}
