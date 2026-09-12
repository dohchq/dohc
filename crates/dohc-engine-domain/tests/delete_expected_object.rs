use dohc_engine_domain::{
    DeleteTextFile, DomainError, NoFaults, RenameTextFile, VersionedTextStore, WriteText,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, engine_db_path};

fn write(object: &str, path: &str, moment: &str) -> WriteText {
    WriteText {
        workspace_id: "ws".into(),
        version_id: "main".into(),
        object_id: object.into(),
        path: path.into(),
        text: "response".into(),
        moment_id: moment.into(),
        metadata_origin: "user".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 1,
        request_id: None,
    }
}

fn delete(path: &str) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: "ws".into(),
        version_id: "main".into(),
        path: path.into(),
        moment_id: "delete-response".into(),
        request_id: Some("moderation-item".into()),
        metadata_origin: "user".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 3,
    }
}

#[test]
fn expected_object_refuses_replaced_path_and_deletes_renamed_object() {
    let dir = ScratchDir::new().unwrap();
    let db = engine_db_path(&dir).unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    let mut files = VersionedTextStore::new(&mut store);
    files
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    files
        .write_text(
            &write("accepted", "response.md", "accepted-moment"),
            &NoFaults,
        )
        .unwrap();
    files
        .rename_text_file(
            &RenameTextFile {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                from_path: "response.md".into(),
                to_path: "renamed.md".into(),
                moment_id: "rename-response".into(),
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
    files
        .write_text(
            &write("unrelated", "response.md", "replacement-moment"),
            &NoFaults,
        )
        .unwrap();
    assert!(matches!(
        files.delete_text_file_expected_object(&delete("response.md"), Some("accepted"), &NoFaults),
        Err(DomainError::FileNotFound)
    ));
    assert_eq!(
        files
            .read_text("ws", "main", "response.md")
            .unwrap()
            .unwrap()
            .object_id,
        "unrelated"
    );
    let deleted = files
        .delete_text_file_expected_object(&delete("renamed.md"), Some("accepted"), &NoFaults)
        .unwrap();
    assert_eq!(deleted.before.object_id, "accepted");
    assert_eq!(deleted.before.text, "response");
    assert!(
        files
            .read_text("ws", "main", "renamed.md")
            .unwrap()
            .is_none()
    );
    drop(files);
    drop(store);

    let mut reopened = EngineStore::open(&db, 4).unwrap();
    let mut files = VersionedTextStore::new(&mut reopened);
    files
        .write_text(
            &write("later-object", "renamed.md", "later-moment"),
            &NoFaults,
        )
        .unwrap();
    let replay = files
        .delete_text_file_expected_object(&delete("renamed.md"), Some("accepted"), &NoFaults)
        .unwrap();
    assert!(replay.deduped);
    assert_eq!(replay.moment.moment_id, deleted.moment.moment_id);
    assert_eq!(
        files
            .read_text("ws", "main", "renamed.md")
            .unwrap()
            .unwrap()
            .object_id,
        "later-object"
    );
    assert!(matches!(
        files.delete_text_file_expected_object(&delete("renamed.md"), Some("unrelated"), &NoFaults),
        Err(DomainError::IdempotencyKeyReuseMismatch)
    ));
    assert!(matches!(
        files.delete_text_file(&delete("renamed.md"), &NoFaults),
        Err(DomainError::IdempotencyKeyReuseMismatch)
    ));
    assert_eq!(
        files
            .read_text("ws", "main", "response.md")
            .unwrap()
            .unwrap()
            .object_id,
        "unrelated"
    );
}
