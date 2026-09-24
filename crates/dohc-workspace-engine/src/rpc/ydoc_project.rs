//! `ydoc.project`: the file a document settles to, from its Y.Doc updates
//! alone. It opens no workspace, so a host that holds only a document's
//! updates, such as the relay, derives the bytes an owner device writes.

use super::request::parse;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use dohc_engine_collab::ContentKind;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_sync::{SyncError, project_ydoc_updates};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectParams {
    content_kind: String,
    updates_base64: Vec<String>,
}

fn invalid(message: &'static str) -> WireError {
    WireError::new(ErrorCode::InvalidParams, message)
}

pub(super) async fn project(
    workspace: Option<&WorkspaceHandle>,
    params: Value,
) -> Result<Value, WireError> {
    if workspace.is_some() {
        return Err(invalid("ydoc.project takes no workspace"));
    }
    let params: ProjectParams = parse(params)?;
    let content_kind =
        ContentKind::parse(&params.content_kind).map_err(|_| invalid("unknown content kind"))?;
    let updates = params
        .updates_base64
        .iter()
        .map(|update| STANDARD.decode(update))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid("a ydoc update is not base64"))?;
    // Applying and projecting is CPU work, kept off the request threads. A
    // panic ends only this task.
    let projection = tokio::task::spawn_blocking(move || {
        project_ydoc_updates(updates.iter().map(Vec::as_slice), content_kind)
    })
    .await
    .map_err(|_| WireError::new(ErrorCode::Internal, "ydoc projection failed"))?
    .map_err(|error| match error {
        SyncError::InvalidInput { reason } => invalid(reason),
        SyncError::ProjectionTooLarge { .. } => {
            WireError::new(ErrorCode::PayloadTooLarge, error.to_string())
        }
        other => {
            eprintln!("engine: ydoc projection failed: {other}");
            WireError::new(ErrorCode::Internal, "ydoc projection failed")
        }
    })?;
    // Base64 keeps the reply within one frame: JSON escapes a control
    // character in six bytes.
    Ok(json!({
        "contentBase64": STANDARD.encode(projection.content),
        "sourceStateVectorSha256": projection.source_state_vector_sha256,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_collab::Ydoc;

    fn imported(markdown: &str) -> Ydoc {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
            .expect("import");
        doc
    }

    async fn call(params: Value) -> Result<Value, WireError> {
        project(None, params).await
    }

    fn params(kind: &str, updates: &[Vec<u8>]) -> Value {
        json!({
            "contentKind": kind,
            "updatesBase64": updates.iter().map(|update| STANDARD.encode(update)).collect::<Vec<_>>(),
        })
    }

    #[tokio::test]
    async fn returns_what_the_settle_writes() {
        let doc = imported("# Plan\n\nSome *emphasis*.\n");
        let base = doc.encode_full_state();
        let edit = doc.richdoc_append_paragraph("Appended");
        let updates = vec![base, edit];
        let expected =
            project_ydoc_updates(updates.iter().map(Vec::as_slice), ContentKind::Richdoc)
                .expect("projection");
        let result = call(params("richdoc", &updates)).await.expect("projected");
        let content = STANDARD
            .decode(result["contentBase64"].as_str().expect("content"))
            .expect("base64");
        assert_eq!(String::from_utf8(content).expect("utf-8"), expected.content);
        assert!(
            expected.content.contains("Appended"),
            "{}",
            expected.content
        );
        assert_eq!(
            result["sourceStateVectorSha256"],
            json!(expected.source_state_vector_sha256)
        );
    }

    #[tokio::test]
    async fn refuses_input_it_cannot_project_with_a_reason() {
        // The last edit of a lineage, without the edits it builds on.
        let doc = imported("One");
        let _two = doc.richdoc_append_paragraph("Two");
        let dependent = doc.richdoc_append_paragraph("Three");
        let base = imported("Base").encode_full_state();
        for (params, message) in [
            (
                params("scene", std::slice::from_ref(&base)),
                "a scene projection",
            ),
            (
                params("markdown", std::slice::from_ref(&base)),
                "unknown content kind",
            ),
            (params("richdoc", &[]), "there are no ydoc updates"),
            (
                params("richdoc", &[vec![1, 2, 3]]),
                "a ydoc update is malformed",
            ),
            (params("richdoc", &[dependent]), "missing a dependency"),
            (
                json!({"contentKind": "richdoc", "updatesBase64": ["%%"]}),
                "not base64",
            ),
            (
                json!({"contentKind": "richdoc", "updatesBase64": [], "extra": true}),
                "invalid parameters",
            ),
        ] {
            let error = call(params).await.expect_err(message);
            assert_eq!(error.code, ErrorCode::InvalidParams, "{message}");
            assert!(error.message.contains(message), "{}", error.message);
        }
        let handle = WorkspaceHandle("workspace".to_owned());
        let error = project(Some(&handle), params("richdoc", &[base]))
            .await
            .expect_err("workspace");
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

    #[tokio::test]
    async fn refuses_a_file_above_the_live_editing_limit() {
        let limit = dohc_engine_collab::limits::MAX_PUBLIC_MARKDOWN_BYTES;
        let at_limit = imported(&"x".repeat(limit - 1)).encode_full_state();
        call(params("richdoc", &[at_limit]))
            .await
            .expect("at the limit");
        let above = imported(&"x".repeat(limit + 1)).encode_full_state();
        let error = call(params("richdoc", &[above])).await.expect_err("above");
        assert_eq!(error.code, ErrorCode::PayloadTooLarge);
        assert!(
            error.message.contains("MAX_PUBLIC_MARKDOWN_BYTES"),
            "{}",
            error.message
        );
    }
}
