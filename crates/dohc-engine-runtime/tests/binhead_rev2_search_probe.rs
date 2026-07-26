//! BINHEAD (rev2) permanent regression, ported from the convergence reviewer's
//! probe: the FTS file-index rebuild is a reader of `snapshots` that BINHEAD did
//! not originally own, and whose in-code comment once claimed "all snapshots rows
//! are text". This proves the rebuild (a) does not crash when a binary snapshot
//! is present and (b) does NOT index the binary head — matching the TS oracle's
//! `deleteFileSearchIndex` on a binary write. The exclusion is now explicit
//! (`content_kind IS NOT 'binary'`) in the candidate CTE, backstopped by the
//! INNER `JOIN blobs` that drops NULL-blob binary rows.

use dohc_engine_domain::{
    DomainError, VersionedTextStore, WriteBinaryFile, WriteText, write_binary_file_in_tx,
};
use dohc_engine_runtime::search::{ensure_search_index_for_version, search_workspace};
use dohc_engine_storage::{EngineStore, NoFaults, Preimage, hex_sha256, put_binary_blob};
use dohc_engine_testkit::ScratchDir;

const WS: &str = "ws-1";
const V: &str = "v-main";

#[test]
fn binary_head_is_excluded_from_file_fts_and_rebuild_does_not_crash() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let db = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db, 1).expect("open");

    let mut vt = VersionedTextStore::new(&mut store);
    vt.ensure_main_version(WS, V, 1, &NoFaults)
        .expect("ensure version");
    // A text file with a distinctive needle — proves the rebuild completes.
    vt.write_text(
        &WriteText {
            workspace_id: WS.to_owned(),
            version_id: V.to_owned(),
            object_id: "obj-note".to_owned(),
            path: "note.md".to_owned(),
            text: "findabletextneedle".to_owned(),
            moment_id: "m-note".to_owned(),
            metadata_origin: "test".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 2,
            request_id: None,
        },
        &NoFaults,
    )
    .expect("write text");

    // A binary head at a .md path the FILE policy WOULD index if it leaked.
    let bytes = b"\x00binary payload uniquebinaryname\xff";
    let sha = hex_sha256(bytes);
    store
        .write_with(&NoFaults, |tx| {
            put_binary_blob(tx, bytes).map_err(DomainError::from)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: V.to_owned(),
                    object_id: "obj-asset".to_owned(),
                    path: "uniquebinaryname.md".to_owned(),
                    binary_sha256: sha,
                    moment_id: "bin-job".to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: Some(Preimage::Absent),
                    now_ms: 3,
                },
            )
        })
        .expect("write binary head");

    // Rebuild the index over BOTH snapshots (a binary row is now present).
    store
        .write_with(&NoFaults, |tx| {
            ensure_search_index_for_version(tx, &root, WS, V, 4, &NoFaults)
                .expect("rebuild did not crash on the binary snapshot");
            Ok::<_, DomainError>(())
        })
        .expect("commit rebuild");

    let text_hits = store
        .read_with(|conn| search_workspace(conn, &root, WS, V, "findabletextneedle", Some(100), 9))
        .expect("text search");
    assert!(
        text_hits.iter().any(|r| r.path == "note.md"),
        "the text file must still index/search after a binary snapshot exists"
    );

    // The binary head must NOT be searchable by its path (TS deletes its FTS row;
    // the Rust rebuild excludes it explicitly via `content_kind IS NOT 'binary'`).
    let bin_hits = store
        .read_with(|conn| search_workspace(conn, &root, WS, V, "uniquebinaryname", Some(100), 9))
        .expect("binary search");
    assert!(
        !bin_hits.iter().any(|r| r.path == "uniquebinaryname.md"),
        "a binary head must not appear in the file search index, got {bin_hits:?}"
    );
}
