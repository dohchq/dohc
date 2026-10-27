use super::*;
use super::super::ydoc::YdocSession;
use dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent;
use dohc_engine_collab::live_update_application::{ImportedOwnerActivation, ImportedOwnerSource};

fn session(id: &str) -> YdocSession {
    let source: ImportedOwnerSource = serde_json::from_value(json!({
        "version":1,"relayDatabaseNamespace":"relay","workspaceId":"w","mainVersionId":"main",
        "objectId":"note","lineageClaimId":"a".repeat(64),"currentPath":"note.md","replicationEpoch":"epoch",
        "streamIdentity":"stream","committedCursor":1,"baseOriginId":"peer","baseOriginSeq":0,
        "baseRelaySeq":1,"sourceMomentId":"source","sourceDigest":"b".repeat(64),"sourceByteLength":0,
        "nativeHeadSequence":0,"fullStateDigest":"a".repeat(64),"fullStateByteLength":0
    })).unwrap();
    let captured = ImportedOwnerActivation { activation_id: "activation".into(), source,
        baseline_bytes: Vec::new(), full_state: Vec::new(), restore_generation: None };
    let key = DocKey::new("w", "main", "note").unwrap();
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let mut session = YdocSession::imported_owner(WorkspaceHandle("workspace-handle".into()),
        key.clone(), &captured, leases.acquire(&key).unwrap()).unwrap();
    session.conversion_consent = Some(Arc::new(MarkdownConversionConsent::new(key, id.into(),
        Some("a".repeat(64)), None, "b".repeat(64), Some("b".repeat(64)))));
    session
}

fn binding() -> LiveObjectBinding {
    LiveObjectBinding { workspace_id: "w".into(), main_version_id: "main".into(), object_id: "note".into(),
        lineage_claim_id: "a".repeat(64), current_path: "note.md".into(), selector_paths: vec!["note.md".into()],
        restore_fence_generation: 0 }
}

#[test]
fn markdown_owner_consent_uses_only_the_forwarded_session_and_keeps_its_grant_until_commit() {
    let workspace = WorkspaceHandle("workspace-handle".into());
    let sessions = Mutex::new(HashMap::from([
        ("owner".into(), session("owner")), ("local-mcp".into(), session("local-mcp")),
    ]));
    let grant = forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("owner")).unwrap();
    assert!(Arc::ptr_eq(&grant, lock(&sessions)["owner"].conversion_consent.as_ref().unwrap()));
    assert!(forwarded_owner_consent(&sessions, Some(&workspace), &binding(), None).is_none());
    assert!(forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("missing")).is_none());
    // A dropped failed attempt leaves the same grant in that session.
    drop(grant);
    let grant = forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("owner")).unwrap();
    assert!(!grant.is_consumed());
    lock(&sessions).remove("owner");
    assert!(forwarded_owner_consent(&sessions, Some(&workspace), &binding(), Some("owner")).is_none());
    assert!(!lock(&sessions)["local-mcp"].conversion_consent.as_ref().unwrap().is_consumed());
    grant.committed();
    assert!(grant.is_consumed());
}

#[test]
fn markdown_owner_consent_rejects_workspace_document_lineage_and_restore_mismatches() {
    let workspace = WorkspaceHandle("workspace-handle".into());
    let sessions = Mutex::new(HashMap::from([("owner".into(), session("owner"))]));
    let original = binding();
    assert!(forwarded_owner_consent(&sessions, Some(&WorkspaceHandle("elsewhere".into())),
        &original, Some("owner")).is_none());
    assert!(forwarded_owner_consent(&sessions, None, &original, Some("owner")).is_none());
    for changed in [
        LiveObjectBinding { workspace_id: "other".into(), ..original.clone() },
        LiveObjectBinding { main_version_id: "other".into(), ..original.clone() },
        LiveObjectBinding { object_id: "other".into(), ..original.clone() },
        LiveObjectBinding { lineage_claim_id: "c".repeat(64), ..original.clone() },
        LiveObjectBinding { restore_fence_generation: 1, ..original.clone() },
    ] {
        assert!(forwarded_owner_consent(&sessions, Some(&workspace), &changed, Some("owner")).is_none());
    }
    let grant = forwarded_owner_consent(&sessions, Some(&workspace), &original, Some("owner")).unwrap();
    assert!(grant.permits_audited(&DocKey::new("w", "main", "note").unwrap(),
        Some(&"a".repeat(64)), 0, Some(&"b".repeat(64)), Some(&"b".repeat(64))));
    grant.committed();
    assert!(forwarded_owner_consent(&sessions, Some(&workspace), &original, Some("owner")).is_none());
}
