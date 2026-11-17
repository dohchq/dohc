use dohc_engine_collab::{
    fresh_successor_base, hex_sha256, ContentKind, DocKey, SuccessorIdentity,
    SuccessorIdentityInput,
};

/// Raw HTML inside a list item reads as text the editor keeps, and the
/// successor writes the chosen bytes back as they were.
#[test]
fn outside_html_blocks_seed_a_richdoc_successor_as_written() {
    for source in [
        "- parent\n\n  </custom >\n  - child",
        "- parent\n\n  </custom\t>\n  - child",
        "- parent\n\n  </custom> \n  - child",
        "- parent\n\n  <my_tag>\n  - child",
        "- parent\n\n  <meta>text\n  - child",
    ] {
        let key = DocKey::new("workspace", "main", "object").unwrap();
        let identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: "claim",
            predecessor_state_vector_sha256: "vector",
            artifact_op_kind: "conflict.resolve",
            artifact_id: "conflict",
            artifact_preimage_sha256: "preimage",
            content_kind: ContentKind::Richdoc,
            result_sha256: &hex_sha256(source.as_bytes()),
        });
        let result = fresh_successor_base(&identity, source);
        assert!(result.is_ok(), "{source:?}: {result:?}");
    }
}
