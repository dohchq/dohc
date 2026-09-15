use dohc_engine_domain::{
    DeleteTextFile, DomainError, NoFaults, RenameTextFile, VersionedTextStore, WriteText,
    write_history_text_in_tx,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, engine_db_path};

fn write(object: &str, moment: &str, text: &str) -> WriteText {
    WriteText {
        workspace_id: "ws".into(),
        version_id: "main".into(),
        object_id: object.into(),
        path: "response.md".into(),
        text: text.into(),
        moment_id: moment.into(),
        metadata_origin: "restore".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 1,
        request_id: None,
    }
}

#[test]
fn history_restore_cannot_steal_a_live_object_or_a_replacement_path() {
    let dir = ScratchDir::new().unwrap();
    let db = engine_db_path(&dir).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    {
        let mut files = VersionedTextStore::new(&mut store);
        files
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        files
            .write_text(&write("accepted", "create", "response"), &NoFaults)
            .unwrap();
        files
            .write_text(&write("ignored", "edit", "edited"), &NoFaults)
            .unwrap();
        files
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    from_path: "response.md".into(),
                    to_path: "renamed.md".into(),
                    moment_id: "rename".into(),
                    request_id: None,
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                },
                &NoFaults,
            )
            .unwrap();
    }
    let restore = write("untrusted-object", "restore", "response");
    let refused = store.write_with(&NoFaults, |tx| {
        write_history_text_in_tx(tx, &restore, "edit")
    });
    assert!(matches!(refused, Err(DomainError::InvalidInput { .. })));
    {
        let mut files = VersionedTextStore::new(&mut store);
        assert_eq!(
            files
                .read_text("ws", "main", "renamed.md")
                .unwrap()
                .unwrap()
                .text,
            "edited"
        );
        assert!(
            files
                .read_text("ws", "main", "response.md")
                .unwrap()
                .is_none()
        );
        files
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    path: "renamed.md".into(),
                    moment_id: "delete".into(),
                    request_id: None,
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 3,
                },
                &NoFaults,
            )
            .unwrap();
        files
            .write_text(&write("replacement", "replace", "replacement"), &NoFaults)
            .unwrap();
    }
    let refused = store.write_with(&NoFaults, |tx| {
        write_history_text_in_tx(tx, &restore, "edit")
    });
    assert!(matches!(refused, Err(DomainError::InvalidInput { .. })));
    let replacement = VersionedTextStore::new(&mut store)
        .read_text("ws", "main", "response.md")
        .unwrap()
        .unwrap();
    assert_eq!(replacement.object_id, "replacement");
    assert_eq!(replacement.text, "replacement");
}
