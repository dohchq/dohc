//! `ydoc.project`: the file a document settles to, from its Y.Doc updates
//! alone. It opens no workspace, so a host that holds only a document's
//! updates, such as the relay, derives the bytes an owner device writes.

use super::request::parse;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use dohc_engine_collab::ContentKind;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_sync::{UpdateProjectionError, project_ydoc_updates};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;

/// Projections the engine runs at once, across every caller.
const MAX_CONCURRENT_PROJECTIONS: usize = 2;
static PROJECTIONS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(MAX_CONCURRENT_PROJECTIONS)));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectParams {
    content_kind: String,
    updates_base64: Vec<String>,
}

fn invalid(message: &'static str) -> WireError {
    WireError::new(ErrorCode::InvalidParams, message)
}

fn failed() -> WireError {
    WireError::new(ErrorCode::Internal, "ydoc projection failed")
}

/// Run `work` on its own thread while it holds one of `slots`. A caller that
/// stops waiting, on a cancel or a deadline, leaves the permit with the work,
/// so an abandoned projection counts against the bound until it ends. A plain
/// thread, unlike `spawn_blocking`, does not hold the process open at
/// shutdown, so the engine still exits when its host closes stdin. A panic
/// ends only this thread.
async fn run_bounded<T: Send + 'static>(
    slots: &Arc<Semaphore>,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, WireError> {
    let permit = Arc::clone(slots)
        .acquire_owned()
        .await
        .map_err(|_| failed())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("ydoc-project".to_owned())
        .spawn(move || {
            let _permit = permit;
            let _ = sender.send(work());
        })
        .map_err(|_| failed())?;
    receiver.await.map_err(|_| failed())
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
    let projection = run_bounded(&PROJECTIONS, move || {
        project_ydoc_updates(updates.iter().map(Vec::as_slice), content_kind)
    })
    .await?
    .map_err(|error| match error {
        UpdateProjectionError::Invalid(reason) => invalid(reason),
        UpdateProjectionError::TooLarge(message) => {
            WireError::new(ErrorCode::PayloadTooLarge, message)
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

    #[tokio::test]
    async fn abandoned_work_keeps_its_slot_until_it_ends() {
        let slots = Arc::new(Semaphore::new(1));
        let (started, running) = tokio::sync::oneshot::channel();
        let (finish, finished) = std::sync::mpsc::channel::<()>();
        let caller = tokio::spawn({
            let slots = Arc::clone(&slots);
            async move {
                run_bounded(&slots, move || {
                    let _ = started.send(());
                    finished.recv().ok();
                })
                .await
            }
        });
        running.await.expect("work started");
        // The caller gives up, as a cancel or a deadline does.
        caller.abort();
        assert!(caller.await.expect_err("aborted").is_cancelled());
        assert_eq!(
            slots.available_permits(),
            0,
            "the work still holds its slot"
        );
        finish.send(()).expect("finish");
        let _slot = slots
            .acquire()
            .await
            .expect("the slot returns when the work ends");
    }
}
