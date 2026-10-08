use dohc_engine_domain::{AgentDeclaration, MAX_AUTHOR_JSON_BYTES, MAX_MOMENT_AUTHORS};
use serde_json::{Value, json};

use crate::ReplicationEnvelope;

/// Retain public author snapshots and declared agents from a received file moment.
pub(super) fn received_authors(envelope: &ReplicationEnvelope) -> Option<String> {
    if envelope.op_kind != "moment.append" {
        return None;
    }
    let raw = envelope.payload.get("authors")?.as_array()?;
    if raw.len() > MAX_MOMENT_AUTHORS {
        return None;
    }
    let mut authors = Vec::new();
    for value in raw {
        let kind = value.get("kind").and_then(Value::as_str);
        if kind == Some("unattributed") && value.as_object().is_some_and(|object| object.len() == 1)
        {
            authors.push(value.clone());
            continue;
        }
        if matches!(kind, Some("human" | "link")) {
            let (id_field, label_field) = if kind == Some("human") {
                ("humanId", "humanName")
            } else {
                ("publicPrincipalId", "label")
            };
            let author = json!({"kind": kind, id_field: value.get(id_field), label_field: value.get(label_field)});
            if let Ok(parsed) = serde_json::from_value::<
                dohc_engine_collab::live_update_application::LiveAuthorEntry,
            >(author.clone())
                && parsed.validate().is_ok()
                && (kind != Some("human")
                    || author[id_field]
                        .as_str()
                        .is_some_and(|id| crate::outbound::relay_person_id(id).is_some()))
            {
                authors.push(author);
            }
            continue;
        }
        if kind != Some("agent") {
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
        if let Some(name) = value.get("agentName").and_then(Value::as_str) {
            let snapshot = dohc_engine_collab::live_update_application::LiveAuthorEntry::Agent {
                agent_id: author["agentId"].as_str()?.to_owned(),
                agent_name: Some(name.to_owned()),
                on_behalf_of: None,
                depth: None,
            };
            if snapshot.validate().is_ok() {
                author["agentName"] = json!(name);
            }
        }
        authors.push(author);
    }
    if authors.is_empty() {
        return None;
    }
    let json = serde_json::to_string(&authors).ok()?;
    (json.len() <= MAX_AUTHOR_JSON_BYTES).then_some(json)
}
