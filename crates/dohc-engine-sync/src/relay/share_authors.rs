use dohc_engine_domain::{AgentDeclaration, MAX_AUTHOR_JSON_BYTES, MAX_MOMENT_AUTHORS};
use serde_json::{Value, json};

use crate::ReplicationEnvelope;

/// Independently rebuild the declared-agent projection for a received file moment.
pub(super) fn declared_agent_authors(envelope: &ReplicationEnvelope) -> Option<String> {
    if envelope.op_kind != "moment.append" {
        return None;
    }
    let raw = envelope.payload.get("authors")?.as_array()?;
    if raw.len() > MAX_MOMENT_AUTHORS {
        return None;
    }
    let mut authors = Vec::new();
    for value in raw {
        if value.get("kind").and_then(Value::as_str) != Some("agent") {
            continue;
        }
        let declaration = serde_json::from_value::<AgentDeclaration>(json!({
            "agentId": value.get("agentId"),
            "onBehalfOf": value.get("onBehalfOf"),
            "depth": value.get("depth").cloned().unwrap_or_else(|| json!(0)),
        }));
        let Ok(declaration) = declaration else {
            continue;
        };
        if declaration.validate().is_err() {
            continue;
        }
        let mut author = json!({"kind": "agent", "agentId": declaration.agent_id});
        if let Some(principal) = declaration.on_behalf_of
            && crate::outbound::relay_person_id(&principal).is_some()
        {
            author["onBehalfOf"] = json!(principal);
        }
        if declaration.depth > 0 {
            author["depth"] = json!(declaration.depth);
        }
        authors.push(author);
    }
    if authors.is_empty() {
        return None;
    }
    let json = serde_json::to_string(&authors).ok()?;
    (json.len() <= MAX_AUTHOR_JSON_BYTES).then_some(json)
}
